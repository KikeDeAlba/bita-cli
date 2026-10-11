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

type Db = ReturnType<typeof openDatabase>

const RULE = [
  'bita: si el trabajo va a dejar un artefacto (commit, archivo, despliegue, MR, causa raiz),',
  'propon en una linea arrancar el cronometro justo antes de la primera edicion y arrancalo',
  'solo con un si: bita start "<titulo corto>". Nada para preguntas ni lecturas.',
  'Pueden correr varios a la vez; al terminar, bita stop <id>.',
].join('\n')

function promptSubmitContext(db: Db, timezone: string, now: Date): string | undefined {
  const drafts = listRunningDrafts(db).map((row) => enrichEntry(row, timezone, now))
  if (drafts.length === 0) return undefined
  return [
    'bita: hay un cronometro corriendo SIN TITULO.',
    ...drafts.map(
      (draft) => `  #${draft.id} lleva ${draft.durationHuman}${draft.projectName ? ` en ${draft.projectName}` : ', sin proyecto'}`,
    ),
    'En cuanto el mensaje diga en que se trabaja, rellenalo antes de explorar o planear:',
    '  bita amend --draft --title "<titulo corto>" --project <nombre o id>',
    'El proyecto es el grupo de repos, no el repo. Si el mensaje no lo dice, no inventes y sigue.',
  ].join('\n')
}

const CHECKPOINT_KEY_PREFIX = 'checkpoint.entry.'

function touchesSince(db: Db, entryId: number, since: string): number {
  return (
    queryOne<{ total: number }>(
      db.prepare('SELECT COUNT(*) AS total FROM entry_touches WHERE entry_id = ? AND first_seen_at > ?'),
      entryId,
      since,
    )?.total ?? 0
  )
}

function forgetStoppedCheckpoints(db: Db, keep: readonly string[]): void {
  const wanted = new Set(keep)
  const stale = queryAll<{ key: string }>(db.prepare(`SELECT key FROM settings WHERE key LIKE '${CHECKPOINT_KEY_PREFIX}%'`))
    .map((row) => row.key)
    .filter((key) => !wanted.has(key))
  if (stale.length === 0) return
  db.prepare(`DELETE FROM settings WHERE key IN (${stale.map(() => '?').join(', ')})`).run(...stale)
}

function checkpointContext(db: Db, timezone: string, now: Date): string | undefined {
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
    'bita: un cronometro lleva rato corriendo.',
    ...lines,
    `Si cerraste un paso o encontraste algo no obvio, anotalo: inkwell note save ${first} --section "Qué se hizo" --md -`,
    `Si el trabajo termino: bita stop ${first}. Si no hay nada que contar, sigue.`,
  ].join('\n')
}

type Section = 'prompt-submit' | 'checkpoint'

function promptContext(sections: readonly Section[]): string | undefined {
  const db = openDatabase(databasePath())
  try {
    const now = new Date()
    const timezone = resolveTimezone(db)
    const parts = sections.map((section) =>
      section === 'prompt-submit' ? promptSubmitContext(db, timezone, now) : checkpointContext(db, timezone, now),
    )
    const present = parts.filter((part): part is string => part !== undefined)
    return present.length === 0 ? undefined : present.join('\n\n')
  } finally {
    db.close()
  }
}

function writeContext(hookEventName: string, additionalContext: string | undefined): void {
  if (!additionalContext) return
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

const PROMPT_SECTIONS: Readonly<Record<string, readonly Section[]>> = {
  prompt: ['prompt-submit', 'checkpoint'],
  'prompt-submit': ['prompt-submit'],
  checkpoint: ['checkpoint'],
}

export async function runHook(argv: string[]): Promise<number> {
  const event = argv[0] ?? 'session-start'

  const sections = Object.hasOwn(PROMPT_SECTIONS, event) ? PROMPT_SECTIONS[event] : undefined
  if (sections) {
    try {
      writeContext('UserPromptSubmit', promptContext(sections))
    } catch {
      return 0
    }
    return 0
  }

  if (event === 'touched') {
    try {
      const flagIndex = argv.indexOf('--file')
      const flagged = flagIndex === -1 ? undefined : argv[flagIndex + 1]
      const files = flagged ? [flagged] : touchedFilesFromHookInput(await readStdin())
      for (const file of files) await runTouched(file)
    } catch {
      return 0
    }
    return 0
  }

  if (event === 'codex') return runAgentHook(CODEX_EVENTS)
  if (event === 'gemini') return runAgentHook(GEMINI_EVENTS)

  if (event !== 'session-start') return 0

  writeContext('SessionStart', await runSessionStartContext())
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

export function touchedFilesFromHookInput(raw: string): string[] {
  if (raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return touchedFiles(inputRecord(inputRecord(parsed).tool_input))
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
  if (event === undefined || lifecycle === undefined) return 0

  try {
    if (lifecycle === 'SessionStart') {
      writeContext(event, await runSessionStartContext())
      return 0
    }
    if (lifecycle === 'UserPromptSubmit') {
      writeContext(event, promptContext(PROMPT_SECTIONS['prompt'] ?? []))
      return 0
    }
    for (const file of touchedFiles(inputRecord(input.tool_input))) await runTouched(file)
    writeContext(event, promptContext(['checkpoint']))
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
          ? 'Nada corriendo.'
          : [
              `Corriendo (${running.length}):`,
              ...running.map(
                (entry) =>
                  `  #${entry.id} "${entry.description}" (${entry.durationHuman}${entry.projectName ? `, ${entry.projectName}` : ''})`,
              ),
            ].join('\n')
    } finally {
      db.close()
    }

    return [RULE, `Proyecto de este repositorio: ${mapping.projectName}. ${state}`].join('\n')
  } catch {
    return undefined
  }
}
