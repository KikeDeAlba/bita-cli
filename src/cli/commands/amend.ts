import { readFile } from 'node:fs/promises'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { findEntryById, findEntryWithProject, listRunningDrafts, updateEntry } from '../../db/entries.ts'
import { findProjectById, findProjectByName } from '../../db/projects.ts'
import { recordEntryDoc } from '../../docs/record.ts'
import { currentRepoIdentity } from './repo.ts'
import { assertNotSegment } from '../resolve-entry.ts'
import { parseKindOrClear } from '../../domain/kind.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { emitHooks } from '../../hooks/emit.ts'

const OPTIONS = {
  draft: { type: 'boolean' as const, default: false },
  title: { type: 'string' as const },
  project: { type: 'string' as const },
  'note-json': { type: 'string' as const },
  'note-md': { type: 'string' as const },
  section: { type: 'string' as const },
  kind: { type: 'string' as const },
}

async function readMarkdown(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new UsageError(`Could not read the markdown at ${path}: ${String(error)}`)
  }
}

async function readLegacyBody(path: string): Promise<string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new UsageError(`Could not read the note at ${path}: ${String(error)}`)
  }
  const body = (raw as { body?: unknown })?.body
  if (typeof body !== 'string') throw new UsageError('The note needs a "body" string.')
  return body
}

function resolveTarget(ctx: LocalContext, args: import('../args.ts').ParsedArgs): number {
  if (readBoolean(args, 'draft')) {
    const drafts = listRunningDrafts(ctx.db)
    const only = drafts[0]
    if (!only) {
      throw new UsageError('No running draft to amend. Start one with "bita start".')
    }
    if (drafts.length > 1) {
      const ids = drafts.map((entry) => `#${entry.id}`).join(', ')
      throw new UsageError(`${drafts.length} running drafts (${ids}); name the one you mean.`)
    }
    return only.id
  }

  const [raw] = args.positionals
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new UsageError('Usage: bita amend <id|--draft> [--title "..."] [--project X]')
  }
  return id
}

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
  const notePath = readString(args, 'note-json')
  const markdownPath = readString(args, 'note-md')
  const rawKind = readString(args, 'kind')
  const kind = rawKind === undefined ? undefined : parseKindOrClear(rawKind)

  if (
    title === undefined &&
    rawProject === undefined &&
    notePath === undefined &&
    markdownPath === undefined &&
    kind === undefined
  ) {
    throw new UsageError('Nothing to amend. Pass --title, --project, --kind or --note-md.')
  }

  const ctx = createLocalContext(args)
  let payload
  try {
    const id = resolveTarget(ctx, args)
    const entry = findEntryById(ctx.db, id)
    if (!entry) throw new UsageError(`No entry with id ${id}.`)
    assertNotSegment(entry)

    const project = rawProject === undefined ? null : resolveProject(ctx, rawProject)

    updateEntry(
      ctx.db,
      id,
      {
        ...(title !== undefined ? { description: title.trim() } : {}),
        ...(project !== null ? { projectId: project.id } : {}),
        ...(kind !== undefined ? { kind } : {}),
      },
      new Date().toISOString(),
    )

    let section: { heading: string; body: string } | undefined
    if (notePath !== undefined) {
      section = { heading: 'Resumen', body: await readLegacyBody(notePath) }
    }
    if (markdownPath !== undefined) {
      section = { heading: readString(args, 'section') ?? 'Qué se hizo', body: await readMarkdown(markdownPath) }
    }

    const wasDraft = entry.description.trim().length === 0
    const amended = findEntryWithProject(ctx.db, id)
    const identity = await currentRepoIdentity()
    const recorded = amended
      ? await recordEntryDoc(ctx, amended, {
          source: 'manual',
          identity: identity
            ? {
                slug: identity.slug,
                ...(identity.branch !== undefined ? { branch: identity.branch } : {}),
                ...(identity.headSha !== undefined ? { headSha: identity.headSha } : {}),
              }
            : null,
          create: section !== undefined || (wasDraft && title !== undefined),
          ...(section ? { section } : {}),
        })
      : null

    const kindChanged = kind !== undefined && kind !== entry.kind
    const hooksFired =
      kindChanged && amended
        ? await emitHooks(ctx, [
            {
              event: 'amend',
              entry: enrichEntry(amended, ctx.timezone, ctx.now),
              previousKind: entry.kind,
              docPath: recorded?.path ?? null,
            },
          ])
        : 0

    payload = {
      entryId: id,
      title: title ?? entry.description,
      projectId: project?.id ?? entry.projectId,
      projectName: project?.name ?? null,
      kind: amended?.kind ?? entry.kind,
      previousKind: entry.kind,
      docPath: recorded?.path ?? null,
      renamedFrom: recorded?.renamedFrom ?? null,
      wasDraft,
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
  if (payload.projectName) writeOut(`Project : ${payload.projectName} (${payload.projectId})`)
  if (kind !== undefined) writeOut(`Kind    : ${payload.kind ?? '(none)'}`)
  if (payload.docPath) writeOut(`Document: ${payload.docPath}`)
  if (payload.renamedFrom) writeOut(`Moved   : it was ${payload.renamedFrom}`)
  return 0
}
