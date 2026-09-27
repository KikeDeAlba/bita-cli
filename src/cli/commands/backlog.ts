import { readFile } from 'node:fs/promises'
import { NotFoundError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { inTransaction } from '../../db/open.ts'
import { findEntryWithProject, listRunning } from '../../db/entries.ts'
import { pagesOfEntry } from '../../db/page-links.ts'
import { listPages, requirePage, type DocPageRow } from '../../db/pages.ts'
import {
  BACKLOG_KINDS,
  deleteBacklogItem,
  editBacklogItem,
  findBacklogItem,
  insertBacklogItem,
  listBacklogItems,
  setBacklogStatus,
  type BacklogItemRow,
  type BacklogKind,
  type BacklogStatus,
} from '../../db/backlog.ts'
import { parseDocument } from '../../docs/markdown.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { readRaw } from '../../docs/store.ts'
import { recordPageDoc } from '../../docs/page-record.ts'
import { splitBacklog, type ExtractedItem } from '../../docs/backlog-extract.ts'

const ACTIONS = new Set(['ls', 'add', 'resolve', 'reopen', 'edit', 'rm', 'extract'])

const OPTIONS = {
  kind: { type: 'string' as const },
  title: { type: 'string' as const },
  md: { type: 'string' as const },
  body: { type: 'string' as const },
  project: { type: 'string' as const },
  page: { type: 'string' as const },
  entry: { type: 'string' as const },
  status: { type: 'string' as const },
  resolution: { type: 'string' as const },
  'dry-run': { type: 'boolean' as const, default: false },
}

const USAGE = `Usage: bita backlog <${[...ACTIONS].join('|')}> [options]`

const KIND_LABEL: Record<BacklogKind, string> = { pending: 'pendiente', finding: 'hallazgo' }

function readPositiveId(raw: string | undefined, what: string): number {
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0) throw new UsageError(`Name the ${what} by id.`)
  return id
}

function readKind(args: ParsedArgs, required: boolean): BacklogKind | undefined {
  const raw = readString(args, 'kind')
  if (raw === undefined) {
    if (required) throw new UsageError('Pass --kind pending|finding.')
    return undefined
  }
  if (!BACKLOG_KINDS.includes(raw as BacklogKind)) {
    throw new UsageError(`Unknown kind "${raw}". Use pending or finding.`)
  }
  return raw as BacklogKind
}

function readStatus(args: ParsedArgs): BacklogStatus | 'all' {
  const raw = readString(args, 'status') ?? 'open'
  if (raw !== 'open' && raw !== 'resolved' && raw !== 'all') {
    throw new UsageError(`Unknown status "${raw}". Use open, resolved or all.`)
  }
  return raw
}

async function readBody(args: ParsedArgs): Promise<string | undefined> {
  const file = readString(args, 'md')
  if (file !== undefined) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      throw new UsageError(`Could not read the markdown at ${file}: ${String(error)}`)
    }
  }
  return readString(args, 'body')
}

function requireItem(ctx: LocalContext, id: number): BacklogItemRow {
  const item = findBacklogItem(ctx.db, id)
  if (!item) throw new NotFoundError(`No backlog item #${id}.`, 'BACKLOG_ITEM_NOT_FOUND')
  return item
}

interface Placement {
  projectId: number | null
  pageId: number | null
  entryId: number | null
}

function placementFor(ctx: LocalContext, args: ParsedArgs): Placement {
  const rawEntry = readString(args, 'entry')
  const rawPage = readString(args, 'page')
  const rawProject = readString(args, 'project')

  let entryId: number | null = null
  let pageId: number | null = null
  let projectId: number | null = null

  if (rawEntry !== undefined) {
    const entry = findEntryWithProject(ctx.db, readPositiveId(rawEntry, 'entry'))
    if (!entry) throw new NotFoundError(`No entry #${rawEntry}.`, 'ENTRY_NOT_FOUND')
    entryId = entry.id
    projectId = entry.projectId
    pageId = pagesOfEntry(ctx.db, entry.id)[0]?.pageId ?? null
  }

  if (rawPage !== undefined) {
    const page = requirePage(ctx.db, readPositiveId(rawPage, 'page'))
    pageId = page.id
    projectId = page.projectId
  }

  if (rawProject !== undefined) projectId = resolveProjectArg(ctx.db, rawProject).id

  if (entryId === null && rawPage === undefined && rawProject === undefined) {
    const running = listRunning(ctx.db)
    if (running.length === 1) {
      const only = running[0]!
      entryId = only.id
      projectId = only.projectId
      pageId = pagesOfEntry(ctx.db, only.id)[0]?.pageId ?? null
    } else {
      throw new UsageError(
        running.length === 0
          ? 'No timer is running; pass --project, --page or --entry to say where this belongs.'
          : `${running.length} timers are running; pass --entry <id>, --page or --project.`,
      )
    }
  }

  if (projectId === null && pageId === null) {
    throw new UsageError('The item needs a project: pass --project, or a --page or --entry that has one.')
  }
  return { projectId, pageId, entryId }
}

function itemView(item: BacklogItemRow) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    body: item.body,
    resolution: item.resolution,
    projectId: item.projectId,
    projectName: item.projectName,
    pageId: item.pageId,
    pageTitle: item.pageTitle,
    entryId: item.entryId,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    resolvedAt: item.resolvedAt,
  }
}

function renderItems(items: BacklogItemRow[]): string {
  return renderTable(
    [
      { header: 'ID', align: 'right' },
      { header: 'KIND' },
      { header: 'STATE' },
      { header: 'PROJECT' },
      { header: 'PAGE' },
      { header: 'TITLE' },
    ],
    items.map((item) => [
      String(item.id),
      KIND_LABEL[item.kind],
      item.status === 'open' ? 'abierto' : 'resuelto',
      item.projectName ?? '(no project)',
      item.pageTitle ?? '',
      item.title,
    ]),
  )
}

function reportItem(command: string, item: BacklogItemRow, json: boolean, verb: string): number {
  if (json) {
    writeJson(successEnvelope(command, itemView(item)))
    return 0
  }
  writeOut(`${verb} #${item.id} (${KIND_LABEL[item.kind]}): ${item.title}`)
  return 0
}

function runList(ctx: LocalContext, args: ParsedArgs, json: boolean): number {
  const rawProject = readString(args, 'project')
  const rawPage = readString(args, 'page')
  const status = readStatus(args)
  const kind = readKind(args, false)
  const items = listBacklogItems(ctx.db, {
    projectId: rawProject === undefined ? undefined : resolveProjectArg(ctx.db, rawProject).id,
    pageId: rawPage === undefined ? undefined : readPositiveId(rawPage, 'page'),
    kind,
    status,
  })

  const all = listBacklogItems(ctx.db, { status: 'all' })
  const counts = {
    pending: all.filter((item) => item.status === 'open' && item.kind === 'pending').length,
    finding: all.filter((item) => item.status === 'open' && item.kind === 'finding').length,
    resolved: all.filter((item) => item.status === 'resolved').length,
  }

  if (json) {
    writeJson(
      successEnvelope('backlog ls', items.map(itemView), {
        filter: { status, kind: kind ?? null, projectId: items[0]?.projectId ?? null },
        counts,
      }),
    )
    return 0
  }
  if (items.length === 0) {
    writeOut('Nothing in the backlog for that filter.')
    return 0
  }
  writeOut(renderItems(items))
  writeOut('')
  writeOut(`${counts.pending} pendientes y ${counts.finding} hallazgos abiertos, ${counts.resolved} resueltos.`)
  return 0
}

async function runAdd(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const kind = readKind(args, true)!
  const title = readString(args, 'title')?.trim()
  if (title === undefined || title.length === 0) throw new UsageError('Pass --title "...".')
  const body = await readBody(args)
  const placement = placementFor(ctx, args)
  const item = insertBacklogItem(ctx.db, {
    ...placement,
    kind,
    title,
    body: body ?? '',
    now: ctx.now.toISOString(),
  })
  return reportItem('backlog add', item, json, 'Added')
}

function runStatus(ctx: LocalContext, args: ParsedArgs, positional: string[], json: boolean, status: BacklogStatus): number {
  const id = readPositiveId(positional[0], 'item')
  requireItem(ctx, id)
  setBacklogStatus(ctx.db, id, status, readString(args, 'resolution'), ctx.now.toISOString())
  const item = requireItem(ctx, id)
  return reportItem(`backlog ${status === 'resolved' ? 'resolve' : 'reopen'}`, item, json, status === 'resolved' ? 'Resolved' : 'Reopened')
}

async function runEdit(ctx: LocalContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const id = readPositiveId(positional[0], 'item')
  requireItem(ctx, id)
  const rawPage = readString(args, 'page')
  const title = readString(args, 'title')
  if (title !== undefined && title.trim().length === 0) throw new UsageError('The title cannot be empty.')
  const changed = editBacklogItem(
    ctx.db,
    id,
    {
      title,
      body: await readBody(args),
      kind: readKind(args, false),
      pageId: rawPage === undefined ? undefined : rawPage === '-' ? null : requirePage(ctx.db, readPositiveId(rawPage, 'page')).id,
    },
    ctx.now.toISOString(),
  )
  if (!changed) throw new UsageError('Nothing to edit. Pass --title, --md, --body, --kind or --page.')
  return reportItem('backlog edit', requireItem(ctx, id), json, 'Edited')
}

function runRemove(ctx: LocalContext, positional: string[], json: boolean): number {
  const id = readPositiveId(positional[0], 'item')
  const item = requireItem(ctx, id)
  deleteBacklogItem(ctx.db, id)
  if (json) {
    writeJson(successEnvelope('backlog rm', { removed: itemView(item) }))
    return 0
  }
  writeOut(`Removed #${id}: ${item.title}`)
  return 0
}

export interface PageExtraction {
  page: DocPageRow
  headings: string[]
  items: ExtractedItem[]
}

export async function planExtraction(ctx: LocalContext, pages: DocPageRow[]): Promise<PageExtraction[]> {
  const plans: PageExtraction[] = []
  for (const page of pages) {
    const raw = await readRaw(resolveDocPath(ctx.docsRoot, page.relPath))
    if (raw === null) continue
    const split = splitBacklog(parseDocument(raw))
    if (split.headings.length === 0) continue
    plans.push({ page, headings: split.headings, items: split.items })
  }
  return plans
}

export async function applyExtraction(ctx: LocalContext, plan: PageExtraction): Promise<number[]> {
  const now = ctx.now.toISOString()
  const created = inTransaction(ctx.db, () =>
    plan.items.map((item) => {
      const row = insertBacklogItem(ctx.db, {
        projectId: plan.page.projectId,
        pageId: plan.page.id,
        kind: item.kind,
        title: item.title,
        body: item.body,
        source: 'extracted',
        now,
      })
      if (item.done) setBacklogStatus(ctx.db, row.id, 'resolved', undefined, now)
      return row.id
    }),
  )
  try {
    await recordPageDoc(ctx, plan.page, { dropSections: plan.headings })
  } catch (error) {
    inTransaction(ctx.db, () => {
      for (const id of created) deleteBacklogItem(ctx.db, id)
    })
    throw error
  }
  return created
}

async function runExtract(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const dryRun = readBoolean(args, 'dry-run')
  const rawPage = readString(args, 'page')
  const rawProject = readString(args, 'project')
  const pages = rawPage !== undefined
    ? [requirePage(ctx.db, readPositiveId(rawPage, 'page'))]
    : listPages(ctx.db, rawProject === undefined ? undefined : resolveProjectArg(ctx.db, rawProject).id)

  const plans = await planExtraction(ctx, pages)
  const results: { pageId: number; title: string; headings: string[]; items: ExtractedItem[]; created: number[] }[] = []

  for (const plan of plans) {
    const created = dryRun ? [] : await applyExtraction(ctx, plan)
    results.push({ pageId: plan.page.id, title: plan.page.title, headings: plan.headings, items: plan.items, created })
  }

  if (json) {
    writeJson(
      successEnvelope('backlog extract', results, {
        dryRun,
        pages: results.length,
        items: results.reduce((sum, result) => sum + result.items.length, 0),
      }),
    )
    return 0
  }

  if (results.length === 0) {
    writeOut('No page has a pending or findings section.')
    return 0
  }
  for (const result of results) {
    writeOut(`#${result.pageId} ${result.title}  (${result.headings.join(', ')})`)
    for (const item of result.items) {
      writeOut(`  ${item.done ? '[x]' : '[ ]'} ${KIND_LABEL[item.kind]}: ${item.title}`)
    }
  }
  writeOut('')
  const total = results.reduce((sum, result) => sum + result.items.length, 0)
  writeOut(
    dryRun
      ? `Would move ${total} items out of ${results.length} pages. Nothing was written: --dry-run.`
      : `Moved ${total} items out of ${results.length} pages into the backlog.`,
  )
  return 0
}

export async function runBacklog(argv: string[]): Promise<number> {
  const action = argv[0] ?? 'ls'
  if (!ACTIONS.has(action)) throw new UsageError(USAGE)

  const positional: string[] = []
  const flags: string[] = []
  for (const token of argv.slice(1)) {
    if (token.startsWith('-') || flags.length > 0) flags.push(token)
    else positional.push(token)
  }

  const args = parseCommandArgs(flags, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)
  try {
    if (action === 'ls') return runList(ctx, args, json)
    if (action === 'add') return await runAdd(ctx, args, json)
    if (action === 'resolve') return runStatus(ctx, args, positional, json, 'resolved')
    if (action === 'reopen') return runStatus(ctx, args, positional, json, 'open')
    if (action === 'edit') return await runEdit(ctx, args, positional, json)
    if (action === 'rm') return runRemove(ctx, positional, json)
    return await runExtract(ctx, args, json)
  } finally {
    ctx.db.close()
  }
}

export function pageBacklog(ctx: LocalContext, pageId: number) {
  return listBacklogItems(ctx.db, { pageId, status: 'all' }).map(itemView)
}
