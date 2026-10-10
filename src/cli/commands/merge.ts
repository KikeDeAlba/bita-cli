import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { inTransaction } from '../../db/open.ts'
import { findEntryWithProject, listSegments } from '../../db/entries.ts'
import { pagesOfEntry } from '../../db/page-links.ts'
import { findPage } from '../../db/pages.ts'
import { listTouches } from '../../db/touches.ts'
import { writeMerge } from '../../db/merge.ts'
import type { EntryWithProjectRow } from '../../db/rows.ts'
import { enrichEntry, normalizeDescription } from '../../domain/enrich.ts'
import { formatDuration } from '../../domain/duration.ts'
import { findDocForEntry } from '../../db/docs.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { emitHooks } from '../../hooks/emit.ts'

const OPTIONS = {
  into: { type: 'string' as const },
  title: { type: 'string' as const },
  project: { type: 'string' as const },
  ids: { type: 'string' as const },
  'dry-run': { type: 'boolean' as const, default: false },
}

const USAGE = 'Usage: bita merge <entryIds...> [--into <id>] [--title "..."] [--project X] [--dry-run]'

export interface MergeContext {
  db: DatabaseSync
  timezone: string
  now: Date
}

export interface MergeRequest {
  ids: number[]
  intoId?: number | undefined
  title?: string | undefined
  projectId?: number | undefined
}

export interface MergeSegment {
  id: number
  previousTitle: string
  localDay: string
  startLocal: string
  durationSeconds: number
  durationHuman: string
}

export interface MergePlan {
  targetId: number
  sourceIds: number[]
  title: string
  projectId: number | null
  projectName: string | null
  segments: MergeSegment[]
  pages: { pageId: number; title: string }[]
  touchedFiles: number
  totalSeconds: number
  totalHuman: string
}

function readId(value: string): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${value}" is not an entry id.`)
  return id
}

export function readMergeIds(args: ParsedArgs): number[] {
  const fromFlag = (readString(args, 'ids') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const ids: number[] = []
  for (const raw of [...args.positionals, ...fromFlag]) {
    const id = readId(raw)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

function requireMergeable(db: DatabaseSync, id: number): EntryWithProjectRow {
  const row = findEntryWithProject(db, id)
  if (!row) throw new UsageError(`No entry with id ${id}.`)
  if (row.mergedInto !== null) {
    throw new ConflictError(
      `#${id} is already part of #${row.mergedInto}.`,
      'ENTRY_MERGED',
      `Merge #${row.mergedInto} instead; it carries #${id} with it.`,
    )
  }
  if (row.stoppedAt === null) {
    throw new ConflictError(`#${id} is still running.`, 'ENTRY_RUNNING', `bita stop ${id} first.`)
  }
  if (row.registered) {
    throw new ConflictError(
      `#${id} already reached ${row.issueKey ?? 'Jira'}.`,
      'ENTRY_REGISTERED',
      'Only pending entries can be merged: the worklogs in Jira would no longer match.',
    )
  }
  return row
}

export function planMerge(ctx: MergeContext, request: MergeRequest): MergePlan {
  const ids = [...request.ids]
  if (request.intoId !== undefined && !ids.includes(request.intoId)) ids.push(request.intoId)
  if (ids.length < 2) throw new UsageError(`Merging needs at least two entries. ${USAGE}`)

  const rows = ids.map((id) => requireMergeable(ctx.db, id))
  const segmentsOf = new Map(rows.map((row) => [row.id, listSegments(ctx.db, row.id)]))
  for (const [id, segments] of segmentsOf) {
    const registered = segments.find((segment) => segment.registered)
    if (registered) {
      throw new ConflictError(
        `#${registered.id}, part of #${id}, already reached ${registered.issueKey ?? 'Jira'}.`,
        'ENTRY_REGISTERED',
        'Only pending entries can be merged: the worklogs in Jira would no longer match.',
      )
    }
  }

  const chronological = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id)
  const target = request.intoId === undefined
    ? chronological[0]!
    : rows.find((row) => row.id === request.intoId)!

  let projectId: number | null
  if (request.projectId !== undefined) {
    projectId = request.projectId
  } else {
    const distinct = [...new Set(rows.map((row) => row.projectId).filter((id) => id !== null))]
    if (distinct.length > 1) {
      const names = [...new Set(rows.map((row) => row.projectName ?? '(no project)'))].join(', ')
      throw new ConflictError(
        `The entries belong to different projects: ${names}.`,
        'PROJECT_MISMATCH',
        'Pass --project <name|id> to say where the merged entry goes.',
      )
    }
    projectId = target.projectId ?? distinct[0] ?? null
  }
  const projectName = projectId === null
    ? null
    : (rows.find((row) => row.projectId === projectId)?.projectName ?? null)

  const title = normalizeDescription(
    request.title ??
      (normalizeDescription(target.description).length > 0
        ? target.description
        : (chronological.find((row) => normalizeDescription(row.description).length > 0)?.description ?? '')),
  )
  if (title.length === 0) {
    throw new UsageError('None of the entries has a title yet; pass --title "..." for the merged one.')
  }

  const allRows = rows.flatMap((row) => [row, ...(segmentsOf.get(row.id) ?? [])])
  allRows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id)

  const segments: MergeSegment[] = allRows.map((row) => {
    const enriched = enrichEntry(row, ctx.timezone, ctx.now)
    return {
      id: row.id,
      previousTitle: enriched.description,
      localDay: enriched.localDay,
      startLocal: enriched.startLocal,
      durationSeconds: enriched.durationSeconds,
      durationHuman: enriched.durationHuman,
    }
  })

  const pageIds = new Set<number>()
  const touched = new Set<string>()
  for (const row of rows) {
    for (const link of pagesOfEntry(ctx.db, row.id)) pageIds.add(link.pageId)
    for (const path of listTouches(ctx.db, row.id)) touched.add(path)
  }
  const pages = [...pageIds].map((pageId) => ({ pageId, title: findPage(ctx.db, pageId)?.title ?? '' }))

  const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)

  return {
    targetId: target.id,
    sourceIds: rows.filter((row) => row.id !== target.id).map((row) => row.id),
    title,
    projectId,
    projectName,
    segments,
    pages,
    touchedFiles: touched.size,
    totalSeconds,
    totalHuman: formatDuration(totalSeconds),
  }
}

export function applyMerge(ctx: MergeContext, plan: MergePlan) {
  return inTransaction(ctx.db, () =>
    writeMerge(ctx.db, {
      targetId: plan.targetId,
      sourceIds: plan.sourceIds,
      description: plan.title,
      projectId: plan.projectId,
      now: ctx.now.toISOString(),
    }),
  )
}

function renderPlan(plan: MergePlan): string {
  return renderTable(
    [
      { header: 'ID', align: 'right' },
      { header: 'DAY' },
      { header: 'START' },
      { header: 'WAS' },
      { header: 'TIME', align: 'right' },
    ],
    plan.segments.map((segment) => [
      segment.id === plan.targetId ? `${segment.id}*` : String(segment.id),
      segment.localDay,
      segment.startLocal.slice(11, 16),
      segment.previousTitle || '(no title)',
      segment.durationHuman,
    ]),
  )
}

export async function runMerge(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS)
  const json = readBoolean(args, 'json')
  const dryRun = readBoolean(args, 'dry-run')
  const ids = readMergeIds(args)
  const rawInto = readString(args, 'into')
  const ctx = createLocalContext(args)

  try {
    const rawProject = readString(args, 'project')
    const request: MergeRequest = {
      ids,
      intoId: rawInto === undefined ? undefined : readId(rawInto),
      title: readString(args, 'title'),
      projectId: rawProject === undefined ? undefined : resolveProjectArg(ctx.db, rawProject).id,
    }
    const plan = planMerge(ctx, request)

    if (dryRun) {
      if (json) {
        writeJson(successEnvelope('merge', { ...plan, dryRun: true }))
        return 0
      }
      writeOut(renderPlan(plan))
      writeOut('')
      writeOut(`Would become #${plan.targetId} "${plan.title}" (${plan.projectName ?? 'no project'}), ${plan.totalHuman} in ${plan.segments.length} worklogs.`)
      writeOut('Nothing was merged: --dry-run.')
      return 0
    }

    const outcome = applyMerge(ctx, plan)
    const survivor = findEntryWithProject(ctx.db, plan.targetId)
    const stored = findDocForEntry(ctx.db, plan.targetId)
    const hooksFired = survivor
      ? await emitHooks(ctx, [
          {
            event: 'merge',
            entry: enrichEntry(survivor, ctx.timezone, ctx.now),
            docPath: stored ? resolveDocPath(ctx.docsRoot, stored.relPath) : null,
            mergedIds: plan.sourceIds,
          },
        ])
      : 0

    if (json) {
      writeJson(successEnvelope('merge', { ...plan, ...outcome, dryRun: false }, { hooksFired }))
      return 0
    }

    writeOut(renderPlan(plan))
    writeOut('')
    writeOut(`#${plan.targetId} "${plan.title}" now carries ${plan.segments.length} blocks, ${plan.totalHuman} in total.`)
    if (plan.pages.length > 0) {
      writeOut(`Pages: ${plan.pages.map((page) => `#${page.pageId} ${page.title}`).join(', ')}`)
    }
    writeOut(`Jira will get one task with ${plan.segments.length} worklogs.`)
    return 0
  } finally {
    ctx.db.close()
  }
}
