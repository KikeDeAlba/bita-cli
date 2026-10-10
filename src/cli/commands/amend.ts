import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { findEntryById, findEntryWithProject, updateEntry } from '../../db/entries.ts'
import { findProjectById, findProjectByName } from '../../db/projects.ts'
import { assertNotSegment, resolveEntryId } from '../resolve-entry.ts'
import { parseKindOrClear } from '../../domain/kind.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { emitHooks } from '../../hooks/emit.ts'

const OPTIONS = {
  draft: { type: 'boolean' as const, default: false },
  title: { type: 'string' as const },
  project: { type: 'string' as const },
  kind: { type: 'string' as const },
}

const USAGE = 'Usage: bita amend <id|--draft> [--title "..."] [--project X] [--kind K|none]'

function resolveProject(ctx: LocalContext, raw: string): { id: number; name: string } {
  const asNumber = Number(raw)
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const byId = findProjectById(ctx.db, asNumber)
    if (!byId) throw new UsageError(`No project with id ${asNumber}. Run "bita projects".`)
    return byId
  }
  const byName = findProjectByName(ctx.db, raw)
  if (!byName) throw new UsageError(`No project named "${raw}". Run "bita projects".`)
  return byName
}

export async function runAmend(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  const title = readString(args, 'title')
  const rawProject = readString(args, 'project')
  const rawKind = readString(args, 'kind')
  const kind = rawKind === undefined ? undefined : parseKindOrClear(rawKind)

  if (title === undefined && rawProject === undefined && kind === undefined) {
    throw new UsageError('Nothing to amend. Pass --title, --project or --kind.')
  }

  const ctx = createLocalContext(args)
  let payload
  try {
    const id = resolveEntryId(ctx, args, USAGE)
    const entry = findEntryById(ctx.db, id)
    if (!entry) throw new UsageError(`No entry with id ${id}.`)
    assertNotSegment(entry)

    const project = rawProject === undefined ? null : resolveProject(ctx, rawProject)
    const nextTitle = title?.trim()

    updateEntry(
      ctx.db,
      id,
      {
        ...(nextTitle !== undefined ? { description: nextTitle } : {}),
        ...(project !== null ? { projectId: project.id } : {}),
        ...(kind !== undefined ? { kind } : {}),
      },
      ctx.now.toISOString(),
    )

    const amended = findEntryWithProject(ctx.db, id)
    const changed =
      amended !== undefined &&
      (amended.description !== entry.description || amended.projectId !== entry.projectId || amended.kind !== entry.kind)
    const hooksFired =
      changed && amended
        ? await emitHooks(ctx, [
            {
              event: 'amend',
              entry: enrichEntry(amended, ctx.timezone, ctx.now),
              previousKind: entry.kind,
              previousTitle: entry.description,
              previousProjectId: entry.projectId,
              docPath: null,
            },
          ])
        : 0

    payload = {
      entryId: id,
      title: amended?.description ?? entry.description,
      projectId: amended?.projectId ?? entry.projectId,
      projectName: amended?.projectName ?? null,
      kind: amended ? amended.kind : entry.kind,
      previousTitle: entry.description,
      previousProjectId: entry.projectId,
      previousKind: entry.kind,
      wasDraft: entry.description.trim().length === 0,
      changed,
      hooksFired,
    }
  } finally {
    ctx.db.close()
  }

  if (json) {
    writeJson(successEnvelope('amend', payload))
    return 0
  }

  writeOut(`Amended #${payload.entryId}`)
  if (title !== undefined) writeOut(`Title   : ${payload.title}`)
  if (rawProject !== undefined) writeOut(`Project : ${payload.projectName ?? '(none)'} (${payload.projectId ?? '-'})`)
  if (kind !== undefined) writeOut(`Kind    : ${payload.kind ?? '(none)'}`)
  return 0
}
