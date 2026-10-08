import { LEGACY_ENTRY_DOC_SECTIONS } from '../../config/constants.ts'
import { findDocByRelPath, listDocsForEntry } from '../../db/docs.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import {
  countEntryDocIndex,
  docCorpusTotals,
  docCountsByProject,
  listDocCalendarRows,
  listEntryDocIndex,
  listSearchCandidates,
  type DocIndexFilter,
  type EntryDocIndexRow,
} from '../../db/index-docs.ts'
import { findProjectById, listProjects } from '../../db/projects.ts'
import type { EntryDocRow } from '../../db/docs.ts'
import type { EntryWithProjectRow } from '../../db/rows.ts'
import { resolveDateRange, type ResolvedRange } from '../../domain/date-range.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { localDay } from '../../domain/timezone.ts'
import { inspectDocFile, type DocFileState } from '../../docs/inspect.ts'
import { parseDocument, sectionStates, type DocSectionState } from '../../docs/markdown.ts'
import { projectSlug } from '../../docs/slug.ts'
import { scanDocuments, type ScanOptions } from '../../docs/search.ts'
import { searchPages } from '../../docs/page-search.ts'
import { NotFoundError, UsageError } from '../../errors.ts'
import {
  BASE_OPTIONS,
  RANGE_OPTIONS,
  hasExplicitRange,
  parseCommandArgs,
  readBoolean,
  readInteger,
  readRangeInput,
  readString,
  type ParsedArgs,
} from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { copyFile } from 'node:fs/promises'
import { migratePages, undoMigration } from '../../docs/migrate-pages.ts'
import { pageTree, runDocsPage } from './docs-page.ts'
import { runDiagrams } from './diagrams.ts'
import { DOCS_GIT_SUBCOMMANDS, runDocsGit } from './docs-git.ts'
import { readConfig } from '../../state/config.ts'
import { atlassianOf } from './project.ts'

const OPTIONS = {
  project: { type: 'string' as const },
  months: { type: 'boolean' as const, default: false },
  pages: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
  yes: { type: 'boolean' as const, default: false },
  undo: { type: 'boolean' as const, default: false },
  all: { type: 'boolean' as const, default: false },
  'with-doc': { type: 'boolean' as const, default: false },
  limit: { type: 'string' as const },
  offset: { type: 'string' as const },
  'no-sections': { type: 'boolean' as const, default: false },
  'no-verify': { type: 'boolean' as const, default: false },
  'no-markdown': { type: 'boolean' as const, default: false },
  path: { type: 'string' as const },
  section: { type: 'string' as const },
  context: { type: 'string' as const },
  'max-matches': { type: 'string' as const },
  'case-sensitive': { type: 'boolean' as const, default: false },
  'max-scan-docs': { type: 'string' as const },
  'max-scan-bytes': { type: 'string' as const },
}

const SUBCOMMANDS = new Set(['tree', 'ls', 'show', 'search', 'page', 'migrate', 'diagrams', ...DOCS_GIT_SUBCOMMANDS])

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 30

export async function runDocs(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'tree'
  if (!SUBCOMMANDS.has(first)) {
    throw new UsageError(`Usage: bita docs <${[...SUBCOMMANDS].join('|')}>`)
  }

  if (first === 'page') return await runDocsPage(argv.slice(1))
  if (first === 'migrate') return await runMigrate(argv.slice(1))
  if (first === 'diagrams') return await runDiagrams(argv.slice(1))
  if (DOCS_GIT_SUBCOMMANDS.has(first)) return await runDocsGit(first, argv.slice(1))

  const args = parseCommandArgs(argv.slice(1), OPTIONS, { ...BASE_OPTIONS, ...RANGE_OPTIONS })
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    if (first === 'tree') return await runTree(ctx, args, json)
    if (first === 'ls') return await runList(ctx, args, json)
    if (first === 'show') return await runShow(ctx, args, json)
    return await runSearch(ctx, args, json)
  } finally {
    ctx.db.close()
  }
}

function selectedProject(ctx: LocalContext, args: ParsedArgs): { id: number | null; name: string | null } | null {
  const raw = readString(args, 'project')
  if (raw === undefined) return null
  if (raw === '_no-project' || raw === '-') return { id: null, name: null }

  const project = resolveProjectArg(ctx.db, raw)
  return { id: project.id, name: project.name }
}

function rangeFor(ctx: LocalContext, args: ParsedArgs): ResolvedRange | null {
  if (!hasExplicitRange(args)) return null
  return resolveDateRange(readRangeInput(args), {
    timezone: ctx.timezone,
    beginningOfWeek: ctx.beginningOfWeek,
    now: ctx.now,
  })
}

function filterFor(
  project: { id: number | null } | null,
  range: ResolvedRange | null,
  onlyWithDoc: boolean,
): DocIndexFilter {
  return {
    ...(project ? { projectId: project.id } : {}),
    ...(range ? { fromUtc: `${range.queryStartDate}T00:00:00.000Z`, toUtc: `${range.queryEndDate}T00:00:00.000Z` } : {}),
    ...(onlyWithDoc ? { onlyWithDoc: true } : {}),
  }
}

function boundedInteger(args: ParsedArgs, name: string, fallback: number): number {
  const value = readInteger(args, name)
  if (value === undefined) return fallback
  if (value < 0) throw new UsageError(`Invalid value for --${name}: "${value}". Expected zero or more.`)
  return value
}

interface DocView {
  relPath: string
  path: string
  docTitle: string
  kind: string
  source: string
  sectionCount: number
  byteSize: number
  createdAt: string
  recordedAt: string
  repoSlug: string | null
  branch: string | null
  headSha: string | null
  appendixCount: number
  sections: DocSectionState[] | null
  file: DocFileState
}

interface FileTally {
  verified: number
  ok: number
  changed: number
  missing: number
  unverified: number
}

function emptyTally(): FileTally {
  return { verified: 0, ok: 0, changed: 0, missing: 0, unverified: 0 }
}

function tally(counts: FileTally, state: DocFileState): void {
  counts[state.status] += 1
  if (state.status !== 'unverified') counts.verified += 1
}

async function viewOf(
  ctx: LocalContext,
  doc: EntryDocRow,
  appendixCount: number,
  options: { verify: boolean; sections: boolean },
): Promise<DocView> {
  const { state, raw } = await inspectDocFile(ctx.docsRoot, doc, { verify: options.verify })
  const parsed = raw === null ? null : parseDocument(raw)

  return {
    relPath: doc.relPath,
    path: state.path,
    docTitle: doc.title,
    kind: doc.kind,
    source: doc.source,
    sectionCount:
      parsed === null
        ? doc.sectionCount
        : sectionStates(parsed, LEGACY_ENTRY_DOC_SECTIONS).filter((s) => s.state === 'written').length,
    byteSize: state.byteSize ?? doc.byteSize,
    createdAt: doc.createdAt,
    recordedAt: doc.recordedAt,
    repoSlug: doc.repoSlug,
    branch: doc.branch,
    headSha: doc.headSha,
    appendixCount,
    sections: options.sections && parsed !== null ? sectionStates(parsed, LEGACY_ENTRY_DOC_SECTIONS) : null,
    file: state,
  }
}

function entryView(ctx: LocalContext, row: EntryWithProjectRow): Record<string, unknown> {
  const entry = enrichEntry(row, ctx.timezone, ctx.now)
  return {
    entryId: entry.id,
    projectId: entry.projectId,
    projectName: entry.projectName,
    projectSlug: projectSlug(entry.projectName),
    title: entry.description,
    localDay: entry.localDay,
    month: entry.localDay.slice(0, 7),
    startLocal: entry.startLocal,
    durationSeconds: entry.durationSeconds,
    durationHuman: entry.durationHuman,
    running: entry.running,
    registered: entry.registered,
    issueKey: entry.issueKey,
  }
}

function warningsFor(counts: FileTally): string[] {
  const warnings: string[] = []
  if (counts.missing > 0) {
    warnings.push(`${counts.missing} document${counts.missing === 1 ? ' is' : 's are'} recorded but the file is gone.`)
  }
  if (counts.changed > 0) {
    warnings.push(`${counts.changed} document${counts.changed === 1 ? ' was' : 's were'} edited outside bita.`)
  }
  return warnings
}

async function runTree(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const wantsMonths = readBoolean(args, 'months')
  const includesEmpty = readBoolean(args, 'all')
  const counts = docCountsByProject(ctx.db)

  const months = wantsMonths ? monthsByProject(ctx) : new Map<number | null, MonthCount[]>()

  const projects = counts.map((row) => ({
    projectId: row.projectId,
    projectName: row.projectName,
    projectSlug: projectSlug(row.projectName),
    active: row.active,
    entryCount: row.entryCount,
    docCount: row.docCount,
    appendixCount: row.appendixCount,
    firstDay: row.minStartedAt === null ? null : localDay(row.minStartedAt, ctx.timezone),
    lastDay: row.maxStartedAt === null ? null : localDay(row.maxStartedAt, ctx.timezone),
    lastDocAt: row.lastRecordedAt,
    ...(wantsMonths ? { months: months.get(row.projectId) ?? [] } : {}),
  }))

  if (includesEmpty) {
    const seen = new Set(counts.map((row) => row.projectId))
    for (const project of listProjects(ctx.db, false)) {
      if (seen.has(project.id)) continue
      projects.push({
        projectId: project.id,
        projectName: project.name,
        projectSlug: projectSlug(project.name),
        active: project.active,
        entryCount: 0,
        docCount: 0,
        appendixCount: 0,
        firstDay: null,
        lastDay: null,
        lastDocAt: null,
        ...(wantsMonths ? { months: [] } : {}),
      })
    }
  }

  const wantsPages = readBoolean(args, 'pages')
  const spaces = wantsPages ? await spacesWithPages(ctx, projects) : null

  const totals = docCorpusTotals(ctx.db)
  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    sections: [...LEGACY_ENTRY_DOC_SECTIONS],
    includesEmpty,
    layout: wantsPages ? 'hierarchical' : 'legacy',
    totals: {
      projectCount: projects.length,
      entryCount: totals.entryCount,
      entriesWithDoc: totals.entriesWithDoc,
      docCount: totals.docCount,
      appendixCount: totals.appendixCount,
      firstEntryDay: totals.minStartedAt === null ? null : localDay(totals.minStartedAt, ctx.timezone),
      lastEntryDay: totals.maxStartedAt === null ? null : localDay(totals.maxStartedAt, ctx.timezone),
    },
  }

  if (json) {
    writeJson(successEnvelope('docs tree', spaces === null ? { projects } : { projects, spaces }, meta))
    return 0
  }

  writeOut(`${meta.totals.entriesWithDoc} of ${meta.totals.entryCount} entries have a document.`)
  for (const project of projects) {
    writeOut(`${String(project.docCount).padStart(4)} / ${String(project.entryCount).padEnd(4)} ${project.projectName ?? 'sin proyecto'}`)
  }
  return 0
}

async function runMigrate(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    if (readBoolean(args, 'undo')) {
      const report = await undoMigration(ctx)
      if (json) {
        writeJson(successEnvelope('docs migrate', report, { root: ctx.docsRoot }))
        return 0
      }
      if (report.batch === null) {
        writeOut('There is no migration to undo.')
        return 0
      }
      writeOut(`Removed ${report.pagesRemoved} page(s) and ${report.filesRemoved} file(s).`)
      for (const kept of report.filesKept) writeOut(`Kept (edited since): ${kept}`)
      return 0
    }

    const apply = readBoolean(args, 'yes') && !readBoolean(args, 'dry-run')
    if (apply) await backupDatabase(ctx)

    const projectRaw = readString(args, 'project')
    const report = await migratePages(ctx, {
      dryRun: !apply,
      ...(projectRaw !== undefined ? { projectId: resolveProjectArg(ctx.db, projectRaw).id } : {}),
      ...(readInteger(args, 'limit') !== undefined ? { limit: readInteger(args, 'limit') as number } : {}),
      siteUrl: (await readConfig()).jira?.siteUrl,
    })

    if (json) {
      writeJson(successEnvelope('docs migrate', report, { root: ctx.docsRoot, applied: apply }))
      return 0
    }

    writeOut(
      apply
        ? `Made ${report.migrated.length} page(s) out of ${report.scanned} document(s).`
        : `Would make ${report.migrated.length} page(s) out of ${report.scanned} document(s). Pass --yes to do it.`,
    )
    for (const page of report.migrated) writeOut(`  ${page.title}  ->  ${page.relPath}`)
    for (const skip of report.skipped) writeOut(`  #${skip.entryId} skipped: ${skip.reason}`)
    return 0
  } finally {
    ctx.db.close()
  }
}

async function backupDatabase(ctx: LocalContext): Promise<void> {
  if (ctx.databasePath === ':memory:') return
  const stamp = ctx.now.toISOString().replace(/[:.]/g, '-')
  await copyFile(ctx.databasePath, `${ctx.databasePath}.bak-${stamp}`)
}

export function withPagedProjects(
  projects: readonly SpaceProject[],
  pagedProjectIds: readonly (number | null)[],
  lookup: (projectId: number) => { name: string; active: boolean } | undefined,
): SpaceProject[] {
  const spaces = [...projects]
  const known = new Set(projects.map((project) => project.projectId))

  for (const projectId of pagedProjectIds) {
    if (known.has(projectId)) continue
    known.add(projectId)
    const project = projectId === null ? undefined : lookup(projectId)
    spaces.push({
      projectId,
      projectName: project?.name ?? null,
      projectSlug: projectSlug(project?.name ?? null),
      active: project?.active ?? true,
      entryCount: 0,
    })
  }
  return spaces
}

export interface SpaceProject {
  projectId: number | null
  projectName: string | null
  projectSlug: string
  active: boolean
  entryCount: number
}

async function spacesWithPages(ctx: LocalContext, projects: readonly SpaceProject[]): Promise<unknown[]> {
  const config = await readConfig()
  const pageCtx = { ...ctx, siteUrl: config.jira?.siteUrl }
  const roots = pageTree(pageCtx)

  const byProject = new Map<number | null, ReturnType<typeof pageTree>>()
  for (const page of roots) {
    const list = byProject.get(page.projectId) ?? []
    list.push(page)
    byProject.set(page.projectId, list)
  }

  const countPages = (list: ReturnType<typeof pageTree>): number =>
    list.reduce((total, page) => total + 1 + countPages(page.children ?? []), 0)

  const catalogue = listProjects(ctx.db, false)
  const spaces = withPagedProjects(projects, [...byProject.keys()], (id) =>
    catalogue.find((row) => row.id === id),
  )

  return spaces.map((project) => {
    const pages = byProject.get(project.projectId) ?? []
    const row = project.projectId === null ? undefined : catalogue.find((candidate) => candidate.id === project.projectId) ?? findProjectById(ctx.db, project.projectId)
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      projectSlug: project.projectSlug,
      active: project.active,
      entryCount: project.entryCount,
      pageCount: countPages(pages),
      atlassian: row ? atlassianOf(row, config) : null,
      pages,
    }
  })
}

interface MonthCount {
  month: string
  entryCount: number
  docCount: number
}

function monthsByProject(ctx: LocalContext): Map<number | null, MonthCount[]> {
  const byProject = new Map<number | null, Map<string, MonthCount>>()

  for (const row of listDocCalendarRows(ctx.db)) {
    const month = localDay(row.startedAt, ctx.timezone).slice(0, 7)
    const buckets = byProject.get(row.projectId) ?? new Map<string, MonthCount>()
    const bucket = buckets.get(month) ?? { month, entryCount: 0, docCount: 0 }
    bucket.entryCount += 1
    if (row.hasDoc) bucket.docCount += 1
    buckets.set(month, bucket)
    byProject.set(row.projectId, buckets)
  }

  const months = new Map<number | null, MonthCount[]>()
  for (const [projectId, buckets] of byProject) {
    months.set(
      projectId,
      [...buckets.values()].sort((left, right) => right.month.localeCompare(left.month)),
    )
  }
  return months
}

async function runList(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const project = selectedProject(ctx, args)
  const range = rangeFor(ctx, args)
  const onlyWithDoc = readBoolean(args, 'with-doc')
  const verify = !readBoolean(args, 'no-verify')
  const wantsSections = !readBoolean(args, 'no-sections')
  const limit = boundedInteger(args, 'limit', DEFAULT_LIST_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)

  const filter = filterFor(project, range, onlyWithDoc)
  const { rows, total } = selectRows(ctx, filter, range, limit, offset)

  const counts = emptyTally()
  const data: Record<string, unknown>[] = []
  const months = new Map<string, number>()
  let withDoc = 0

  for (const row of rows) {
    const entry = entryView(ctx, row.entry)
    const month = String(entry['month'])
    months.set(month, (months.get(month) ?? 0) + 1)

    if (row.doc === null) {
      data.push({ ...entry, doc: null })
      continue
    }

    withDoc += 1
    const view = await viewOf(ctx, row.doc, row.appendixCount, { verify, sections: wantsSections })
    tally(counts, view.file)
    data.push({ ...entry, doc: view })
  }

  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    project: project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) },
    range: range === null ? null : { fromDay: range.fromDay, toDay: range.toDay, preset: range.preset },
    page: { limit, offset, returned: data.length, total, hasMore: limit > 0 && offset + data.length < total },
    counts: { withDoc, withoutDoc: data.length - withDoc },
    files: counts,
    months: [...months.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((left, right) => right.month.localeCompare(left.month)),
    warnings: warningsFor(counts),
  }

  if (json) {
    writeJson(successEnvelope('docs ls', data, meta))
    return 0
  }

  for (const row of data) {
    const doc = row['doc'] as DocView | null
    writeOut(`${String(row['localDay'])}  #${String(row['entryId'])}  ${doc ? doc.relPath : '(sin nota)'}`)
  }
  return 0
}

function selectRows(
  ctx: LocalContext,
  filter: DocIndexFilter,
  range: ResolvedRange | null,
  limit: number,
  offset: number,
): { rows: EntryDocIndexRow[]; total: number } {
  if (range === null) {
    return {
      rows: listEntryDocIndex(ctx.db, { ...filter, limit, offset }),
      total: countEntryDocIndex(ctx.db, filter),
    }
  }

  const inRange = listEntryDocIndex(ctx.db, { ...filter, limit: 0 }).filter((row) => {
    const day = localDay(row.entry.startedAt, ctx.timezone)
    return day >= range.fromDay && day <= range.toDay
  })

  const page = limit > 0 ? inRange.slice(offset, offset + limit) : inRange.slice(offset)
  return { rows: page, total: inRange.length }
}

async function runShow(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const relPath = readString(args, 'path')
  const verify = !readBoolean(args, 'no-verify')
  const wantsMarkdown = !readBoolean(args, 'no-markdown')

  const { entry, primary } = locate(ctx, args, relPath)

  if (primary === undefined) {
    const meta = { root: ctx.docsRoot, timezone: ctx.timezone, warnings: [] as string[] }
    const data = { ...entryView(ctx, entry), doc: null, appendices: [] }
    if (json) writeJson(successEnvelope('docs show', data, meta))
    else writeOut(`No document recorded for entry #${entry.id}.`)
    return 0
  }

  const { state, raw } = await inspectDocFile(ctx.docsRoot, primary, { verify })
  const parsed = raw === null ? null : parseDocument(raw)
  const appendices = listDocsForEntry(ctx.db, entry.id).filter((doc) => doc.kind === 'appendix')

  const appendixViews = []
  for (const appendix of appendices) {
    const inspected = await inspectDocFile(ctx.docsRoot, appendix, { verify })
    appendixViews.push({
      relPath: appendix.relPath,
      path: inspected.state.path,
      title: appendix.title,
      sectionCount: appendix.sectionCount,
      byteSize: inspected.state.byteSize ?? appendix.byteSize,
      file: inspected.state,
    })
  }

  const counts = emptyTally()
  tally(counts, state)

  const data = {
    ...entryView(ctx, entry),
    doc: {
      kind: primary.kind,
      relPath: primary.relPath,
      path: state.path,
      docTitle: parsed?.title ?? primary.title,
      frontMatter: parsed === null ? {} : Object.fromEntries(parsed.frontMatter),
      frontMatterValid: parsed?.frontMatterValid ?? false,
      preamble: parsed?.preamble ?? '',
      sections: parsed === null ? null : sectionStates(parsed, LEGACY_ENTRY_DOC_SECTIONS),
      sectionCount: primary.sectionCount,
      byteSize: state.byteSize ?? primary.byteSize,
      markdown: wantsMarkdown ? raw : null,
      source: primary.source,
      createdAt: primary.createdAt,
      recordedAt: primary.recordedAt,
      repoSlug: primary.repoSlug,
      branch: primary.branch,
      headSha: primary.headSha,
      file: state,
    },
    appendices: appendixViews,
  }

  const meta = { root: ctx.docsRoot, timezone: ctx.timezone, sections: [...LEGACY_ENTRY_DOC_SECTIONS], warnings: warningsFor(counts) }

  if (json) {
    writeJson(successEnvelope('docs show', data, meta))
    return 0
  }

  if (raw === null) {
    writeOut(`The document was recorded at ${state.path}, but the file is gone.`)
    return 0
  }
  writeOut(raw)
  return 0
}

function locate(
  ctx: LocalContext,
  args: ParsedArgs,
  relPath: string | undefined,
): { entry: EntryWithProjectRow; primary: EntryDocRow | undefined } {
  if (relPath !== undefined) {
    const doc = findDocByRelPath(ctx.db, relPath)
    if (!doc) {
      throw new NotFoundError(`No document at "${relPath}".`, 'DOC_NOT_FOUND', 'Run "bita docs ls" to see them.')
    }
    const entry = findEntryWithProject(ctx.db, doc.entryId)
    if (!entry) throw new UsageError(`No entry #${doc.entryId}.`)
    return { entry, primary: doc }
  }

  const raw = args.positionals[0]
  const entryId = Number(raw)
  if (raw === undefined || !Number.isInteger(entryId) || entryId <= 0) {
    throw new UsageError('Usage: bita docs show <entryId> | --path <relPath>')
  }

  const entry = findEntryWithProject(ctx.db, entryId)
  if (!entry) throw new UsageError(`No entry #${entryId}.`)

  const docs = listDocsForEntry(ctx.db, entryId)
  return { entry, primary: docs.find((doc) => doc.kind === 'note') ?? docs[0] }
}

async function runSearch(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const query = args.positionals[0]
  if (query === undefined || query.trim().length === 0) {
    throw new UsageError('Usage: bita docs search "<text>" [--project X]')
  }

  const project = selectedProject(ctx, args)
  const section = readString(args, 'section')
  const limit = boundedInteger(args, 'limit', DEFAULT_SEARCH_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)
  const scanOptions = searchScanOptions(args, section)

  if (readBoolean(args, 'pages')) return await runPageSearch(ctx, args, json, { query, project, section, limit, offset, scanOptions })

  const candidates = listSearchCandidates(ctx.db, filterFor(project, null, true))
  const result = await scanDocuments(ctx.docsRoot, candidates, query, scanOptions)

  const page = limit > 0 ? result.documents.slice(offset, offset + limit) : result.documents.slice(offset)
  const data = page.map((found) => ({
    entryId: found.candidate.entryId,
    projectId: found.candidate.projectId,
    projectName: found.candidate.projectName,
    projectSlug: projectSlug(found.candidate.projectName),
    title: found.candidate.description,
    docTitle: found.candidate.doc.title,
    localDay: localDay(found.candidate.startedAt, ctx.timezone),
    month: localDay(found.candidate.startedAt, ctx.timezone).slice(0, 7),
    relPath: found.candidate.doc.relPath,
    path: found.file.path,
    matchCount: found.matchCount,
    matches: found.matches,
    byteSize: found.file.byteSize ?? found.candidate.doc.byteSize,
    recordedAt: found.candidate.doc.recordedAt,
    file: found.file,
  }))

  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    query,
    caseSensitive: readBoolean(args, 'case-sensitive'),
    section: section ?? null,
    project: project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) },
    page: { limit, offset, returned: data.length, hasMore: limit > 0 && offset + data.length < result.documents.length },
    documentsWithMatches: result.documents.length,
    totalMatches: result.documents.reduce((sum, found) => sum + found.matchCount, 0),
    scanned: result.scanned,
    truncated: result.truncated,
    warnings: result.scanned.missing > 0 ? [`${result.scanned.missing} recorded document(s) are gone from disk.`] : [],
  }

  if (json) {
    writeJson(successEnvelope('docs search', data, meta))
    return 0
  }

  if (data.length === 0) {
    writeOut(`Nothing matches "${query}".`)
    return 0
  }
  for (const found of data) {
    writeOut(`${found.localDay}  #${found.entryId}  ${found.matchCount}x  ${found.relPath}`)
    for (const match of found.matches) writeOut(`    ${match.snippet.replace(/\n/g, ' ')}`)
  }
  return 0
}

function searchScanOptions(args: ParsedArgs, section: string | undefined): ScanOptions {
  return {
    caseSensitive: readBoolean(args, 'case-sensitive'),
    ...(section !== undefined ? { section } : {}),
    ...(readInteger(args, 'context') !== undefined ? { context: boundedInteger(args, 'context', 120) } : {}),
    ...(readInteger(args, 'max-matches') !== undefined ? { max: boundedInteger(args, 'max-matches', 5) } : {}),
    ...(readInteger(args, 'max-scan-docs') !== undefined
      ? { maxScanDocs: boundedInteger(args, 'max-scan-docs', 5000) }
      : {}),
    ...(readInteger(args, 'max-scan-bytes') !== undefined
      ? { maxScanBytes: boundedInteger(args, 'max-scan-bytes', 33_554_432) }
      : {}),
  }
}

interface PageSearchRequest {
  query: string
  project: { id: number | null; name: string | null } | null
  section: string | undefined
  limit: number
  offset: number
  scanOptions: ScanOptions
}

async function runPageSearch(ctx: LocalContext, args: ParsedArgs, json: boolean, request: PageSearchRequest): Promise<number> {
  const { query, project, section, limit, offset, scanOptions } = request
  const result = await searchPages(ctx.db, ctx.docsRoot, query, {
    ...scanOptions,
    ...(project !== null ? { projectId: project.id } : {}),
  })

  const data = limit > 0 ? result.hits.slice(offset, offset + limit) : result.hits.slice(offset)
  const meta = {
    root: ctx.docsRoot,
    query,
    caseSensitive: readBoolean(args, 'case-sensitive'),
    section: section ?? null,
    project: project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) },
    page: { limit, offset, returned: data.length, hasMore: limit > 0 && offset + data.length < result.hits.length },
    pagesWithMatches: result.hits.length,
    totalMatches: result.hits.reduce((sum, hit) => sum + hit.matchCount, 0),
    scanned: result.scanned,
    truncated: result.truncated,
    warnings: result.scanned.missing > 0 ? [`${result.scanned.missing} recorded document(s) are gone from disk.`] : [],
  }

  if (json) {
    writeJson(successEnvelope('docs search', data, meta))
    return 0
  }

  if (data.length === 0) {
    writeOut(`No page matches "${query}".`)
    return 0
  }
  for (const hit of data) {
    const trail = [...hit.ancestors.map((ancestor) => ancestor.title), hit.title].join(' / ')
    writeOut(`#${hit.pageId}  ${hit.matchCount}x  ${trail}  (page ${hit.sources.page}, entries ${hit.sources.entries})`)
    for (const match of hit.matches) {
      const origin = match.source === 'entry' ? `entry #${match.entryId}` : 'page'
      writeOut(`    [${origin}] ${`${match.prefix}${match.match}${match.suffix}`.replace(/\n/g, ' ')}`)
    }
  }
  return 0
}
