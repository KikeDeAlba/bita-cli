import { readConfig } from '../../state/config.ts'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { readSetting, resolveTimezone, writeSetting } from '../../db/settings.ts'
import { listRunning, listRunningDrafts } from '../../db/entries.ts'
import { queryAll, queryOne } from '../../db/query.ts'
import { runTouched } from '../hooks/touched.ts'
import { CHECKPOINT_STALE_MINUTES, CHECKPOINT_TOUCH_THRESHOLD } from '../../config/constants.ts'
import { formatDuration } from '../../domain/duration.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { currentRepoIdentity } from './repo.ts'
import { resolveMappedProject } from '../resolve-project.ts'

const RULE = [
  'Registro de tiempo (bita): este repositorio esta mapeado a un proyecto.',
  'Si el trabajo que empieza va a dejar un artefacto (un commit, un archivo, un recurso desplegado,',
  'una migracion, una MR, una causa raiz diagnosticada) propone arrancar el cronometro en una linea,',
  'justo antes de la primera edicion, y arrancalo solo con un si explicito:',
  '  bita start "<titulo corto>"',
  'No lo propongas para preguntas, lecturas, busquedas ni arreglos de una linea.',
  'Pueden correr varios cronometros a la vez: si empiezas algo distinto, arranca otro en vez de',
  'parar el que hay. Al terminar: bita stop <id>.',
  'bita solo lleva el tiempo. Documentar el trabajo es de inkwell (inkwell note save <id>),',
  'volcar las horas a Jira es de tally, y Jira o Confluence directos son de atl.',
].join('\n')

async function runPromptSubmit(): Promise<string | undefined> {
  const db = openDatabase(databasePath())
  try {
    const now = new Date()
    const timezone = resolveTimezone(db)
    const drafts = listRunningDrafts(db).map((row) => enrichEntry(row, timezone, now))
    if (drafts.length === 0) return undefined

    const lines = drafts.map(
      (draft) =>
        `  #${draft.id} lleva ${draft.durationHuman}${draft.projectName ? ` en ${draft.projectName}` : ' y aun sin proyecto'}`,
    )

    const additionalContext = [
      'Registro de tiempo (bita): hay un cronometro corriendo SIN TITULO.',
      ...lines,
      '',
      'Si el mensaje del usuario dice en que se va a trabajar, rellenalo AHORA,',
      'antes de ponerte a explorar o a planear:',
      '  bita amend --draft --title "<titulo corto>" --project <nombre o id>',
      '',
      'El titulo es lo que identifica la entrada despues: corto y reconocible.',
      'Un repo NO es un proyecto: los proyectos son grupos con varios',
      'repos dentro, asi que resuelve el proyecto por el grupo, no por el repo.',
      'Si el mensaje todavia no dice en que se trabaja, no inventes nada y sigue.',
    ].join('\n')

    return additionalContext
  } finally {
    db.close()
  }
}

const CHECKPOINT_KEY_PREFIX = 'checkpoint.entry.'

function touchesSince(db: ReturnType<typeof openDatabase>, entryId: number, since: string): number {
  return (
    queryOne<{ total: number }>(
      db.prepare('SELECT COUNT(*) AS total FROM entry_touches WHERE entry_id = ? AND first_seen_at > ?'),
      entryId,
      since,
    )?.total ?? 0
  )
}

function forgetStoppedCheckpoints(db: ReturnType<typeof openDatabase>, keep: readonly string[]): void {
  const wanted = new Set(keep)
  const stale = queryAll<{ key: string }>(db.prepare(`SELECT key FROM settings WHERE key LIKE '${CHECKPOINT_KEY_PREFIX}%'`))
    .map((row) => row.key)
    .filter((key) => !wanted.has(key))
  if (stale.length === 0) return
  db.prepare(`DELETE FROM settings WHERE key IN (${stale.map(() => '?').join(', ')})`).run(...stale)
}

function runCheckpoint(): string | undefined {
  const db = openDatabase(databasePath())
  try {
    const now = new Date()
    const timezone = resolveTimezone(db)
    const running = listRunning(db).filter((entry) => entry.description.trim().length > 0)
    forgetStoppedCheckpoints(db, running.map((entry) => `${CHECKPOINT_KEY_PREFIX}${entry.id}`))
    if (running.length === 0) return undefined

    const stale = running.flatMap((entry) => {
      const since = readSetting(db, `${CHECKPOINT_KEY_PREFIX}${entry.id}`) ?? entry.startedAt
      const touched = touchesSince(db, entry.id, since)
      const minutes = (now.getTime() - Date.parse(since)) / 60_000
      if (touched < CHECKPOINT_TOUCH_THRESHOLD && minutes < CHECKPOINT_STALE_MINUTES) return []
      return [{ entry, since, touched }]
    })
    if (stale.length === 0) return undefined

    for (const { entry } of stale) writeSetting(db, `${CHECKPOINT_KEY_PREFIX}${entry.id}`, now.toISOString())

    const lines = stale.map(({ entry, since, touched }) => {
      const elapsed = formatDuration(Math.round((now.getTime() - Date.parse(since)) / 1000))
      const files = touched === 1 ? '1 archivo tocado' : `${touched} archivos tocados`
      const enriched = enrichEntry(entry, timezone, now)
      return `  #${entry.id} "${enriched.description}" lleva ${elapsed} y ${files} desde el ultimo aviso`
    })

    const first = stale[0]?.entry.id ?? '<id>'
    return [
      'Registro de tiempo (bita): un cronometro lleva rato corriendo.',
      ...lines,
      '',
      'Si acabas de cerrar un paso, terminar una verificacion o encontrar algo no obvio, dejalo',
      `escrito en la nota de la entrada con inkwell: inkwell note save ${first} --section "Qué se hizo" --md -`,
      `Si el trabajo ya termino, paralo: bita stop ${first}.`,
      'Si no hay nada que valga la pena contar, sigue sin escribir nada.',
    ].join('\n')
  } finally {
    db.close()
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

export async function runHook(argv: string[]): Promise<number> {
  const event = argv[0] ?? 'session-start'

  if (event === 'checkpoint') {
    try {
      const additionalContext = runCheckpoint()
      if (additionalContext) {
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
          })}\n`,
        )
      }
      return 0
    } catch {
      return 0
    }
  }

  if (event === 'prompt-submit') {
    try {
      const additionalContext = await runPromptSubmit()
      if (additionalContext) {
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
          })}\n`,
        )
      }
      return 0
    } catch {
      return 0
    }
  }

  if (event === 'touched') {
    try {
      const flagIndex = argv.indexOf('--file')
      const file = flagIndex === -1 ? undefined : argv[flagIndex + 1]
      if (file) await runTouched(file)
    } catch {
      return 0
    }
    return 0
  }

  if (event === 'codex') return runAgentHook(CODEX_EVENTS)
  if (event === 'gemini') return runAgentHook(GEMINI_EVENTS)

  if (event !== 'session-start') return 0

  const additionalContext = await runSessionStartContext()
  if (additionalContext) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
      })}\n`,
    )
  }
  return 0
}

type CodexHookInput = {
  hook_event_name?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
  cwd?: unknown
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function inputRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function touchedFiles(input: unknown): string[] {
  const record = inputRecord(input)
  const paths = ['filePath', 'file_path', 'path', 'filename', 'file']
    .map((key) => stringValue(record[key]))
    .filter((path): path is string => path !== undefined)
  const command = stringValue(record.command)
  if (command) {
    for (const match of command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      const path = stringValue(match[1])
      if (path) paths.push(path)
    }
  }
  return [...new Set(paths)]
}

type LifecycleEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse'

const CODEX_EVENTS: Record<string, LifecycleEvent> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
}

const GEMINI_EVENTS: Record<string, LifecycleEvent> = {
  SessionStart: 'SessionStart',
  BeforeAgent: 'UserPromptSubmit',
  AfterTool: 'PostToolUse',
}

async function runAgentHook(events: Record<string, LifecycleEvent>): Promise<number> {
  let input: CodexHookInput
  try {
    input = JSON.parse(await readStdin()) as CodexHookInput
  } catch {
    return 0
  }

  const event = stringValue(input.hook_event_name)
  const lifecycle = event === undefined ? undefined : events[event]
  if (lifecycle === 'SessionStart') {
    const additionalContext = await runSessionStartContext()
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      )
    }
    return 0
  }

  if (lifecycle === 'UserPromptSubmit') {
    const additionalContext = await runPromptSubmit()
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      )
    }
    return 0
  }

  if (lifecycle !== 'PostToolUse') return 0

  const toolInput = inputRecord(input.tool_input)
  for (const file of touchedFiles(toolInput)) {
    try {
      await runTouched(file)
    } catch {
      return 0
    }
  }

  try {
    const additionalContext = runCheckpoint()
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      )
    }
  } catch {
    return 0
  }
  return 0
}

async function runSessionStartContext(): Promise<string | undefined> {
  try {
    const identity = await currentRepoIdentity()
    if (!identity) return undefined

    const config = await readConfig()
    const mapping = resolveMappedProject(identity.slug, config)
    if (!mapping) return undefined

    const db = openDatabase(databasePath())
    let state: string
    try {
      const now = new Date()
      const timezone = resolveTimezone(db)
      const running = listRunning(db).map((row) => enrichEntry(row, timezone, now))
      state =
        running.length === 0
          ? 'No hay ningun cronometro corriendo.'
          : [
              `Cronometros CORRIENDO (${running.length}):`,
              ...running.map(
                (entry) =>
                  `  #${entry.id} "${entry.description}" (${entry.durationHuman}${entry.projectName ? `, ${entry.projectName}` : ''})`,
              ),
            ].join('\n')
    } finally {
      db.close()
    }

    return [RULE, '', `Proyecto de este repositorio: ${mapping.projectName}.`, state].join('\n')
  } catch {
    return undefined
  }
}
