import { readConfig } from '../../state/config.ts'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { resolveTimezone } from '../../db/settings.ts'
import { listRunning, listRunningDrafts } from '../../db/entries.ts'
import { runTouched } from '../hooks/touched.ts'
import { runRefHook } from '../hooks/ref.ts'
import { pagesOfEntry } from '../../db/page-links.ts'
import { checkpointStatus } from '../../db/docs.ts'
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
  'parar el que hay.',
  'Cada cronometro cuelga de una pagina, que documenta el estado actual y se escribe MIENTRAS se',
  'trabaja, no al final:',
  '  bita docs page show <pageId>                    -> lo que dice hoy',
  '  bita docs page write <pageId> --md <archivo>     -> reescribirla',
  'La pagina es un documento formal: nada de secciones Pendiente, Hallazgos ni Proximos pasos.',
  'Lo que falta o lo que se descubrio de paso va al backlog de bita, nunca a Jira:',
  '  bita backlog add --kind pending|finding --title "<una linea>"',
  'Al terminar, actualiza la pagina y para con: bita stop <id> --did "<que paso>"',
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
      'El titulo es la clave de agrupacion y el summary del issue de Jira: corto y',
      'reconocible. Un repo NO es un proyecto: los proyectos son grupos con varios',
      'repos dentro, asi que resuelve el proyecto por el grupo, no por el repo.',
      'Si el mensaje todavia no dice en que se trabaja, no inventes nada y sigue.',
    ].join('\n')

    return additionalContext
  } finally {
    db.close()
  }
}

function runCheckpoint(): string | undefined {
  const db = openDatabase(databasePath())
  try {
    const now = new Date()
    const timezone = resolveTimezone(db)
    const running = listRunning(db).filter((entry) => entry.description.trim().length > 0)
    if (running.length === 0) return undefined

    const status = checkpointStatus(
      db,
      running.map((entry) => entry.id),
    )

    const stale = running.filter((entry) => {
      const state = status.get(entry.id)
      if (!state) return false
      if (state.touchedSinceNote >= CHECKPOINT_TOUCH_THRESHOLD) return true
      const since = state.lastNoteAt ?? entry.startedAt
      return now.getTime() - Date.parse(since) >= CHECKPOINT_STALE_MINUTES * 60_000
    })

    if (stale.length === 0) return undefined

    const lines = stale.map((entry) => {
      const state = status.get(entry.id)
      const since = state?.lastNoteAt ?? entry.startedAt
      const elapsed = formatDuration(Math.round((now.getTime() - Date.parse(since)) / 1000))
      const touched = state?.touchedSinceNote ?? 0
      const files = touched === 1 ? '1 archivo tocado' : `${touched} archivos tocados`
      const enriched = enrichEntry(entry, timezone, now)
      return `  #${entry.id} "${enriched.description}" lleva ${elapsed} y ${files} desde el ultimo checkpoint`
    })

    const first = stale[0]
    const firstPage = first === undefined ? undefined : pagesOfEntry(db, first.id)[0]?.pageId
    const additionalContext = [
      'Registro de tiempo (bita): hay trabajo sin documentar en un cronometro que corre.',
      ...lines,
      '',
      'Si acabas de cerrar un paso, terminar una verificacion, cambiar de enfoque o encontrar algo',
      'no obvio, escribe el checkpoint AHORA en la pagina del cronometro:',
      ...(firstPage === undefined
        ? [
            `  bita note path ${first?.id ?? '<id>'} --create   -> la entrada aun no tiene pagina; su documento`,
            `  bita note save ${first?.id ?? '<id>'}            -> cuando lo hayas editado`,
          ]
        : [
            `  bita docs page show ${firstPage}                 -> lo que dice hoy`,
            `  bita docs page write ${firstPage} --md <archivo> -> la pagina reescrita`,
          ]),
      '',
      'A la seccion que toque, describiendo el estado actual. Un pendiente o un hallazgo no va a la',
      'pagina: bita backlog add --kind pending|finding --title "<una linea>".',
      'Documenta el resultado, no la edicion; los archivos tocados ya se registran solos.',
      'Si no hay nada que valga la pena contar, sigue sin escribir nada.',
      'Escribelo como documentacion tecnica: nada de "se acordo con el usuario", "segun lo',
      'solicitado", primera ni segunda persona. Esto acaba en Jira y Confluence, donde lo leeran otros.',
    ].join('\n')

    return additionalContext
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

  if (event === 'ref') {
    try {
      await runRefHook(await readStdin())
    } catch {
      return 0
    }
    return 0
  }

  if (event === 'codex') return runCodexHook()

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

async function runCodexHook(): Promise<number> {
  let input: CodexHookInput
  try {
    input = JSON.parse(await readStdin()) as CodexHookInput
  } catch {
    return 0
  }

  const event = stringValue(input.hook_event_name)
  if (event === 'SessionStart') {
    const additionalContext = await runSessionStartContext()
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      )
    }
    return 0
  }

  if (event === 'UserPromptSubmit') {
    const additionalContext = await runPromptSubmit()
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      )
    }
    return 0
  }

  if (event !== 'PostToolUse') return 0

  const toolInput = inputRecord(input.tool_input)
  for (const file of touchedFiles(toolInput)) {
    try {
      await runTouched(file)
    } catch {
      return 0
    }
  }

  try {
    await runRefHook(JSON.stringify({
      cwd: stringValue(input.cwd),
      tool_name: stringValue(input.tool_name),
      tool_input: toolInput,
      tool_response: input.tool_response,
    }))
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
