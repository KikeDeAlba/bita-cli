import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assetRelPath } from '../../docs/diagrams.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import {
  ancestorsOf,
  childrenOf,
  deletePage,
  descendantsOf,
  findPage,
  insertPage,
  listPages,
  movePage,
  renamePage,
  requirePage,
  uniqueSiblingSlug,
  type DocPageRow,
} from '../../db/pages.ts'
import {
  entriesOfPage,
  issuesOfPage,
  linkEntryToPage,
  linkIssueToPage,
  meetingsOfPage,
  talliesByPage,
  unlinkEntryFromPage,
  unlinkIssueFromPage,
  worklogIssuesOfPage,
  type PageIssueRole,
  type PageMeeting,
  type StatusCategory,
} from '../../db/page-links.ts'
import { listProjects } from '../../db/projects.ts'
import { formatDuration } from '../../domain/duration.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { issueUrl } from '../../domain/jira.ts'
import { inspectDocFile } from '../../docs/inspect.ts'
import { MAX_PAGE_DEPTH, pageRelPath } from '../../docs/layout.ts'
import { outline, parseDocument, type DocHeading, type ParsedDocument } from '../../docs/markdown.ts'
import { backlogHeadings } from '../../docs/backlog-extract.ts'
import { listBacklogItems } from '../../db/backlog.ts'
import { PAGE_SPLIT_BYTES, PAGE_SPLIT_SECTIONS } from '../../config/constants.ts'
import { recordPageDoc, movePageFile, pageCommitIntent, pageFilePaths } from '../../docs/page-record.ts'
import {
  commitDocs,
  pageHistory,
  pathAtRev,
  readBlob,
  requireDocsRepo,
  resolveRev,
  revisionDiff,
  worktreeDiff,
} from '../../docs/git.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { projectSlug, titleSlug } from '../../docs/slug.ts'
import { readRaw } from '../../docs/store.ts'
import { readConfig } from '../../state/config.ts'
import { NotFoundError, UsageError } from '../../errors.ts'
import { assertNotSegment } from '../resolve-entry.ts'
import { enrichLogical } from '../logical-entry.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { addRefToPage, refsOfPage, removeRefFromPage, REF_KINDS, type RefKind } from '../../db/page-refs.ts'
import { classifyUrl } from '../../domain/refs.ts'

const SUBCOMMANDS = new Set([
  'ls',
  'show',
  'new',
  'write',
  'rename',
  'move',
  'link',
  'unlink',
  'rm',
  'ref',
  'asset',
  'history',
  'diff',
  'restore',
])

const OPTIONS = {
  project: { type: 'string' as const },
  parent: { type: 'string' as const },
  position: { type: 'string' as const },
  slug: { type: 'string' as const },
  path: { type: 'string' as const },
  md: { type: 'string' as const },
  body: { type: 'string' as const },
  section: { type: 'string' as const },
  entry: { type: 'string' as const },
  issue: { type: 'string' as const },
  role: { type: 'string' as const },
  summary: { type: 'string' as const },
  status: { type: 'string' as const },
  'status-category': { type: 'string' as const },
  url: { type: 'string' as const },
  title: { type: 'string' as const },
  kind: { type: 'string' as const },
  'from-entries': { type: 'boolean' as const, default: false },
  'from-entry': { type: 'string' as const },
  recursive: { type: 'boolean' as const, default: false },
  'keep-doc': { type: 'boolean' as const, default: false },
  'no-markdown': { type: 'boolean' as const, default: false },
  create: { type: 'boolean' as const, default: false },
  tree: { type: 'boolean' as const, default: false },
  rev: { type: 'string' as const },
  limit: { type: 'string' as const },
}

export interface PageContext extends LocalContext {
  siteUrl: string | undefined
}

const ROLES: readonly PageIssueRole[] = ['epic', 'story', 'task', 'subtask']
const CATEGORIES: readonly StatusCategory[] = ['', 'new', 'indeterminate', 'done']

export async function runDocsPage(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'ls'
  if (!SUBCOMMANDS.has(first)) {
    throw new UsageError(`Usage: bita docs page <${[...SUBCOMMANDS].join('|')}>`)
  }

  const positional: string[] = []
  const flags: string[] = []
  for (const token of argv.slice(1)) {
    if (token.startsWith('-') || flags.length > 0) flags.push(token)
    else positional.push(token)
  }

  const args = parseCommandArgs(flags, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const base = createLocalContext(args)
  const ctx: PageContext = { ...base, siteUrl: (await readConfig()).jira?.siteUrl }

  try {
    if (first === 'ls') return runList(ctx, args, json)
    if (first === 'show') return await runShow(ctx, args, positional, json)
    if (first === 'new') return await runNew(ctx, args, positional, json)
    if (first === 'write') return await runWrite(ctx, args, positional, json)
    if (first === 'rename') return await runRename(ctx, args, positional, json)
    if (first === 'move') return await runMove(ctx, args, positional, json)
    if (first === 'link') return await runLink(ctx, args, positional, json)
    if (first === 'unlink') return await runUnlink(ctx, args, positional, json)
    if (first === 'ref') return await runRef(ctx, args, positional, json)
    if (first === 'asset') return await runAsset(ctx, args, positional, json)
    if (first === 'history') return await runHistory(ctx, args, positional, json)
    if (first === 'diff') return await runPageDiff(ctx, args, positional, json)
    if (first === 'restore') return await runRestore(ctx, args, positional, json)
    return await runRemove(ctx, args, positional, json)
  } finally {
    ctx.db.close()
  }
}

function pageIdArg(positional: string[], args: ParsedArgs, ctx: PageContext): DocPageRow {
  const raw = positional[0]
  if (raw !== undefined) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${raw}" is not a page id.`)
    return requirePage(ctx.db, id)
  }

  const path = readString(args, 'path')
  if (path === undefined) throw new UsageError('Name the page by id, or pass --path.')

  const page = listPages(ctx.db).find((candidate) => candidate.relPath === path)
  if (!page) throw new NotFoundError(`No page at "${path}".`, 'PAGE_NOT_FOUND')
  return page
}

function parentArg(ctx: PageContext, args: ParsedArgs): DocPageRow | null {
  const raw = readString(args, 'parent')
  if (raw === undefined || raw === '-') return null

  const id = Number(raw)
  if (Number.isInteger(id) && id > 0) return requirePage(ctx.db, id)

  const page = listPages(ctx.db).find((candidate) => candidate.relPath === raw)
  if (!page) throw new NotFoundError(`No page "${raw}".`, 'PAGE_NOT_FOUND')
  return page
}

async function bodyFrom(args: ParsedArgs): Promise<string | undefined> {
  const file = readString(args, 'md')
  if (file !== undefined) return await readFile(file, 'utf8')
  return readString(args, 'body')
}

function projectNameOf(ctx: PageContext, projectId: number | null): string | null {
  if (projectId === null) return null
  return listProjects(ctx.db).find((project) => project.id === projectId)?.name ?? null
}

function relPathFor(ctx: PageContext, projectId: number | null, parent: DocPageRow | null, slug: string): string {
  const ancestors = parent ? [...ancestorsOf(ctx.db, parent.id).map((row) => row.slug), parent.slug] : []
  return pageRelPath({ projectName: projectNameOf(ctx, projectId), ancestorSlugs: ancestors, slug })
}

interface PageView {
  pageId: number
  parentId: number | null
  projectId: number | null
  projectName: string | null
  projectSlug: string
  slug: string
  title: string
  relPath: string
  depth: number
  position: number
  status: string
  entryCount: number
  durationSeconds: number
  durationHuman: string
  issues: ReturnType<typeof issueViews>
  sectionCount: number
  headingCount: number
  byteSize: number
  recordedAt: string
  childCount: number
  meetings: PageMeeting[]
  children?: PageView[]
}

function issueViews(ctx: PageContext, pageId: number, siteUrl: string | undefined) {
  return issuesOfPage(ctx.db, pageId).map((issue) => ({
    issueKey: issue.issueKey,
    role: issue.role,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    url: issue.url ?? issueUrl(siteUrl, issue.issueKey),
    refreshedAt: issue.refreshedAt,
  }))
}

function pageView(
  ctx: PageContext,
  page: DocPageRow,
  tallies: ReturnType<typeof talliesByPage>,
  siteUrl: string | undefined,
): PageView {
  const tally = tallies.get(page.id)
  const seconds = tally?.durationSeconds ?? 0
  return {
    pageId: page.id,
    parentId: page.parentId,
    projectId: page.projectId,
    projectName: projectNameOf(ctx, page.projectId),
    projectSlug: projectSlug(projectNameOf(ctx, page.projectId)),
    slug: page.slug,
    title: page.title,
    relPath: page.relPath,
    depth: page.depth,
    position: page.position,
    status: page.status,
    entryCount: tally?.entryCount ?? 0,
    durationSeconds: seconds,
    durationHuman: formatDuration(seconds),
    issues: issueViews(ctx, page.id, siteUrl),
    sectionCount: page.sectionCount,
    headingCount: page.headingCount,
    byteSize: page.byteSize,
    recordedAt: page.recordedAt,
    childCount: childrenOf(ctx.db, page.id).length,
    meetings: meetingsOfPage(ctx.db, page.id),
  }
}

export function pageTree(ctx: PageContext, projectId?: number | null): PageView[] {
  const tallies = talliesByPage(ctx.db)
  const siteUrl = ctx.siteUrl
  const all = listPages(ctx.db, projectId)
  const views = new Map<number, PageView>()
  for (const page of all) views.set(page.id, { ...pageView(ctx, page, tallies, siteUrl), children: [] })

  const roots: PageView[] = []
  for (const page of all) {
    const view = views.get(page.id)
    if (!view) continue
    const parent = page.parentId === null ? undefined : views.get(page.parentId)
    if (parent) parent.children?.push(view)
    else roots.push(view)
  }
  return roots
}

function runList(ctx: PageContext, args: ParsedArgs, json: boolean): number {
  const projectRaw = readString(args, 'project')
  const projectId = projectRaw === undefined ? undefined : resolveProjectArg(ctx.db, projectRaw).id
  const asTree = readBoolean(args, 'tree')

  const data = asTree
    ? { pages: pageTree(ctx, projectId) }
    : {
        pages: listPages(ctx.db, projectId).map((page) =>
          pageView(ctx, page, talliesByPage(ctx.db), ctx.siteUrl),
        ),
      }

  if (json) {
    writeJson(successEnvelope('docs page ls', data, { root: ctx.docsRoot, timezone: ctx.timezone }))
    return 0
  }

  const flat = asTree ? flatten(data.pages) : data.pages
  if (flat.length === 0) {
    writeOut('No pages yet.')
    return 0
  }
  for (const page of flat) {
    const indent = '  '.repeat(page.depth)
    writeOut(`${String(page.pageId).padStart(5)}  ${indent}${page.title}  (${page.durationHuman})`)
  }
  return 0
}

function flatten(pages: PageView[]): PageView[] {
  const out: PageView[] = []
  const walk = (list: PageView[]): void => {
    for (const page of list) {
      out.push(page)
      if (page.children) walk(page.children)
    }
  }
  walk(pages)
  return out
}

async function runShow(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const siteUrl = ctx.siteUrl
  const absolutePath = resolveDocPath(ctx.docsRoot, page.relPath)
  const raw = await readRaw(absolutePath)
  const revision = await revisionText(ctx, page, readString(args, 'rev'))
  const parsed = raw === null ? null : parseDocument(raw)
  const headings: DocHeading[] = parsed === null ? [] : outline(parsed)
  const inspected = await inspectDocFile(ctx.docsRoot, page)
  const file = inspected.state

  const entries = entriesOfPage(ctx.db, page.id).flatMap((link) => {
    const entry = findEntryWithProject(ctx.db, link.entryId)
    if (!entry) return []
    const rich = enrichLogical(ctx.db, entry, ctx.timezone, ctx.now)
    return [
      {
        entryId: entry.id,
        title: entry.description,
        summary: link.summary,
        localDay: rich.localDay,
        startLocal: rich.startLocal,
        durationSeconds: rich.durationSeconds,
        durationHuman: rich.durationHuman,
        running: rich.running,
        registered: rich.registered,
        issueKey: rich.issueKey,
        segments: rich.segments,
      },
    ]
  })

  const data = {
    ...pageView(ctx, page, talliesByPage(ctx.db), siteUrl),
    ancestors: ancestorsOf(ctx.db, page.id).map((row) => ({
      pageId: row.id,
      title: row.title,
      slug: row.slug,
    })),
    children: childrenOf(ctx.db, page.id).map((row) => ({
      pageId: row.id,
      title: row.title,
      slug: row.slug,
      relPath: row.relPath,
    })),
    doc: {
      path: absolutePath,
      relPath: page.relPath,
      markdown: readBoolean(args, 'no-markdown') ? null : raw,
      frontMatter: parsed === null ? {} : Object.fromEntries(parsed.frontMatter),
      frontMatterValid: parsed?.frontMatterValid ?? false,
      preamble: parsed?.preamble ?? '',
      outline: headings,
      file,
    },
    entries,
    worklogIssues: worklogIssuesOfPage(ctx.db, page.id),
    refs: refViews(ctx, page.id),
    backlog: listBacklogItems(ctx.db, { pageId: page.id, status: 'all' }).map((item) => ({
      id: item.id,
      key: item.key,
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: item.body,
      resolution: item.resolution,
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt,
    })),
    ...(revision ? { rev: revision.sha, revPath: revision.path, markdown: revision.markdown } : {}),
  }

  if (json) {
    writeJson(
      successEnvelope('docs page show', data, {
        root: ctx.docsRoot,
        timezone: ctx.timezone,
        jira: { siteUrl: siteUrl ?? null },
      }),
    )
    return 0
  }

  if (revision) {
    writeOut(revision.markdown)
    return 0
  }
  writeOut(`#${page.id}  ${page.title}`)
  writeOut(page.relPath)
  if (headings.length > 0) writeOut(headings.map((heading) => `  ${'  '.repeat(heading.level - 2)}${heading.heading}`).join('\n'))
  return 0
}

function refViews(ctx: PageContext, pageId: number) {
  return refsOfPage(ctx.db, pageId).map((ref) => ({
    url: ref.url,
    title: ref.title,
    kind: ref.kind,
    source: ref.source,
    firstSeenAt: ref.firstSeenAt,
    lastSeenAt: ref.lastSeenAt,
  }))
}

const REF_ACTIONS = new Set(['add', 'ls', 'rm'])

function readRefUrl(args: ParsedArgs): string {
  const url = readString(args, 'url')?.trim()
  if (url === undefined || url.length === 0) throw new UsageError('Pass --url <https://...>.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`"${url}" is not a URL.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`"${url}" is not an http(s) URL.`)
  }
  return url
}

async function runRef(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const [action, ...rest] = positional
  if (action === undefined || !REF_ACTIONS.has(action)) {
    throw new UsageError('Usage: bita docs page ref <add|ls|rm> <pageId> [--url U] [--title T] [--kind K]')
  }
  const page = pageIdArg(rest, args, ctx)

  if (action === 'add') {
    const url = readRefUrl(args)
    const kindRaw = readString(args, 'kind')
    if (kindRaw !== undefined && !REF_KINDS.includes(kindRaw as RefKind)) {
      throw new UsageError(`Unknown kind "${kindRaw}". Use one of ${REF_KINDS.join(', ')}.`)
    }
    const kind = (kindRaw as RefKind | undefined) ?? classifyUrl(url) ?? 'link'
    addRefToPage(ctx.db, page.id, {
      url,
      title: readString(args, 'title')?.trim() ?? '',
      kind,
      source: 'manual',
      now: ctx.now.toISOString(),
    })
  }

  let removed = false
  if (action === 'rm') removed = removeRefFromPage(ctx.db, page.id, readRefUrl(args))

  const refs = refViews(ctx, page.id)
  if (json) {
    writeJson(
      successEnvelope(`docs page ref ${action}`, { pageId: page.id, title: page.title, refs, ...(action === 'rm' ? { removed } : {}) }),
    )
    return 0
  }
  if (action === 'rm' && !removed) writeOut('That link was not on the page.')
  if (refs.length === 0) {
    writeOut(`#${page.id} ${page.title} has no links.`)
    return 0
  }
  for (const ref of refs) writeOut(`${ref.kind.padEnd(10)} ${ref.title ? `${ref.title}  ` : ''}${ref.url}`)
  return 0
}

async function runAsset(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const [action, ...rest] = positional
  const name = rest[1]
  if (action !== 'path' || name === undefined) {
    throw new UsageError('Usage: bita docs page asset path <pageId> <file> [--create]')
  }
  const page = pageIdArg(rest.slice(0, 1), args, ctx)
  const relPath = assetRelPath(page.relPath, name)
  const path = resolveDocPath(ctx.docsRoot, relPath)
  if (readBoolean(args, 'create')) await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  const data = { pageId: page.id, title: page.title, relPath, path, exists: existsSync(path) }
  if (json) {
    writeJson(successEnvelope('docs page asset path', data, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(path)
  return 0
}

async function runNew(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const title = positional[0]
  if (title === undefined || title.trim().length === 0) throw new UsageError('A page needs a title.')

  const parent = parentArg(ctx, args)
  const fromEntryRaw = readString(args, 'from-entry')
  const fromEntry = fromEntryRaw === undefined ? null : findEntryWithProject(ctx.db, Number(fromEntryRaw))
  if (fromEntryRaw !== undefined && !fromEntry) {
    throw new NotFoundError(`No entry #${fromEntryRaw}.`, 'ENTRY_NOT_FOUND')
  }

  const projectRaw = readString(args, 'project')
  const projectId = parent
    ? parent.projectId
    : projectRaw !== undefined
      ? resolveProjectArg(ctx.db, projectRaw).id
      : (fromEntry?.projectId ?? null)

  const depth = parent ? parent.depth + 1 : 0
  if (depth > MAX_PAGE_DEPTH) {
    throw new UsageError(`A page tree cannot go deeper than ${MAX_PAGE_DEPTH + 1} levels.`)
  }

  const wanted = readString(args, 'slug') ?? titleSlug(title)
  const slug = uniqueSiblingSlug(ctx.db, projectId, parent?.id ?? null, titleSlug(wanted))
  const relPath = relPathFor(ctx, projectId, parent, slug)

  const id = insertPage(ctx.db, {
    projectId,
    parentId: parent?.id ?? null,
    slug,
    title: title.trim(),
    relPath,
    depth,
    source: 'cli',
    now: ctx.now.toISOString(),
  })

  const page = requirePage(ctx.db, id)
  if (fromEntry) linkEntryToPage(ctx.db, id, fromEntry.id, '', ctx.now.toISOString())
  const recorded = await recordPageDoc(ctx, page)

  return report(ctx, 'docs page new', requirePage(ctx.db, id), json, { path: recorded.path })
}

async function runWrite(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const body = await bodyFrom(args)
  if (body === undefined) throw new UsageError('Pass --md <file> or --body <text>.')

  const heading = readString(args, 'section')
  const write = heading === undefined ? { body } : { section: { heading, body } }
  const recorded = await recordPageDoc(ctx, page, write)
  const written = await readRaw(recorded.path)
  const warnings = written === null ? [] : pageWarnings(parseDocument(written), Buffer.byteLength(written))

  if (!json) for (const warning of warnings) writeErr(`Warning: ${warning.message}`)
  return report(ctx, 'docs page write', requirePage(ctx.db, page.id), json, {
    path: recorded.path,
    changed: recorded.changed,
    warnings,
    sha: recorded.sha,
  })
}

export function pageWarnings(doc: ParsedDocument, bytes: number): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = []
  const backlog = backlogHeadings(doc)
  if (backlog.length > 0) {
    warnings.push({
      code: 'BACKLOG_SECTION_IN_PAGE',
      message: `The page carries ${backlog.map((heading) => `"${heading}"`).join(', ')}. A page describes the current state only: move those items with "bita backlog add" (or "bita backlog extract --page <id>").`,
    })
  }
  const sections = doc.sections.filter((section) => section.body.trim().length > 0).length
  if (sections > PAGE_SPLIT_SECTIONS || bytes > PAGE_SPLIT_BYTES) {
    warnings.push({
      code: 'PAGE_SHOULD_SPLIT',
      message: `The page has ${sections} sections and ${Math.round(bytes / 1024)} KB. Split the parts that stand on their own into child pages with "bita docs page new --parent <id>" and leave this one as the overview.`,
    })
  }
  return warnings
}

async function runRename(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const title = positional[1]
  if (title === undefined || title.trim().length === 0) throw new UsageError('A page needs a title.')

  const wanted = readString(args, 'slug') ?? titleSlug(title)
  const slug = uniqueSiblingSlug(ctx.db, page.projectId, page.parentId, titleSlug(wanted))
  renamePage(ctx.db, page.id, title.trim(), slug, ctx.now.toISOString())

  const renamed = requirePage(ctx.db, page.id)
  const parent = renamed.parentId === null ? null : requirePage(ctx.db, renamed.parentId)
  const toRelPath = relPathFor(ctx, renamed.projectId, parent, slug)
  await movePageFile(ctx, renamed, toRelPath, false)
  await recordPageDoc(ctx, requirePage(ctx.db, page.id), {}, false)
  await commitDocs(
    ctx.docsRoot,
    [...pageFilePaths(page.relPath), ...pageFilePaths(toRelPath)],
    pageCommitIntent(requirePage(ctx.db, page.id), toRelPath, 'rename', {}),
  )

  return report(ctx, 'docs page rename', requirePage(ctx.db, page.id), json)
}

async function runMove(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const parent = parentArg(ctx, args)
  const position = readInteger(args, 'position')
  const projectRaw = readString(args, 'project')

  movePage(ctx.db, page.id, {
    parentId: parent?.id ?? null,
    ...(projectRaw !== undefined ? { projectId: resolveProjectArg(ctx.db, projectRaw).id } : {}),
    ...(position !== undefined ? { position } : {}),
  })

  const moved = requirePage(ctx.db, page.id)
  await movePageFile(ctx, moved, relPathFor(ctx, moved.projectId, parent, moved.slug))

  return report(ctx, 'docs page move', requirePage(ctx.db, page.id), json)
}

async function runLink(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const now = ctx.now.toISOString()

  const entryRaw = readString(args, 'entry')
  if (entryRaw !== undefined) {
    for (const token of entryRaw.split(',')) {
      const id = Number(token.trim())
      if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${token}" is not an entry id.`)
      const entry = findEntryWithProject(ctx.db, id)
      if (!entry) throw new NotFoundError(`No entry #${id}.`, 'ENTRY_NOT_FOUND')
      assertNotSegment(entry)
      linkEntryToPage(ctx.db, page.id, id, readString(args, 'summary') ?? '', now)
    }
  }

  const issueKey = readString(args, 'issue')
  if (issueKey !== undefined) {
    const role = readString(args, 'role') ?? 'task'
    if (!ROLES.includes(role as PageIssueRole)) throw new UsageError(`Unknown role "${role}".`)
    const category = readString(args, 'status-category') ?? ''
    if (!CATEGORIES.includes(category as StatusCategory)) {
      throw new UsageError(`Unknown status category "${category}".`)
    }
    linkIssueToPage(ctx.db, {
      pageId: page.id,
      issueKey,
      role: role as PageIssueRole,
      summary: readString(args, 'summary') ?? '',
      status: readString(args, 'status') ?? '',
      statusCategory: category as StatusCategory,
      url: readString(args, 'url') ?? issueUrl(ctx.siteUrl, issueKey),
      now,
    })
  }

  if (readBoolean(args, 'from-entries')) {
    const siteUrl = ctx.siteUrl
    for (const key of worklogIssuesOfPage(ctx.db, page.id)) {
      linkIssueToPage(ctx.db, { pageId: page.id, issueKey: key, url: issueUrl(siteUrl, key), now })
    }
  }

  if (entryRaw === undefined && issueKey === undefined && !readBoolean(args, 'from-entries')) {
    throw new UsageError('Pass --entry, --issue or --from-entries.')
  }

  if (issueKey !== undefined || readBoolean(args, 'from-entries')) await restampIssues(ctx, page)

  return report(ctx, 'docs page link', requirePage(ctx.db, page.id), json)
}

async function runUnlink(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)

  const entryRaw = readString(args, 'entry')
  if (entryRaw !== undefined) {
    for (const token of entryRaw.split(',')) unlinkEntryFromPage(ctx.db, page.id, Number(token.trim()))
  }

  const issueKey = readString(args, 'issue')
  if (issueKey !== undefined) unlinkIssueFromPage(ctx.db, page.id, issueKey)

  if (entryRaw === undefined && issueKey === undefined) throw new UsageError('Pass --entry or --issue.')

  if (issueKey !== undefined) await restampIssues(ctx, page)

  return report(ctx, 'docs page unlink', requirePage(ctx.db, page.id), json)
}

async function restampIssues(ctx: PageContext, page: DocPageRow): Promise<void> {
  const raw = await readRaw(resolveDocPath(ctx.docsRoot, page.relPath))
  if (raw === null) return
  await recordPageDoc(ctx, page)
}

async function runRemove(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const children = descendantsOf(ctx.db, page.id)

  if (children.length > 0 && !readBoolean(args, 'recursive')) {
    throw new UsageError(
      `Page #${page.id} has ${children.length} page${children.length === 1 ? '' : 's'} under it. Pass --recursive.`,
    )
  }

  const doomed = [...children.reverse(), page]
  for (const target of doomed) deletePage(ctx.db, target.id)

  const data = { removed: doomed.map((target) => ({ pageId: target.id, title: target.title, relPath: target.relPath })) }
  if (json) {
    writeJson(successEnvelope('docs page rm', data, { root: ctx.docsRoot, keptDocuments: true }))
    return 0
  }
  writeOut(`Removed ${doomed.length} page${doomed.length === 1 ? '' : 's'}. The .md files stay on disk.`)
  return 0
}

async function revisionText(
  ctx: PageContext,
  page: DocPageRow,
  rev: string | undefined,
): Promise<{ sha: string; path: string; markdown: string } | null> {
  if (rev === undefined) return null
  await requireDocsRepo(ctx.docsRoot)
  const sha = await resolveRev(ctx.docsRoot, rev)
  const { path } = await pathAtRev(ctx.docsRoot, page.relPath, sha)
  const markdown = await readBlob(ctx.docsRoot, sha, path)
  if (markdown === null) {
    throw new NotFoundError(`Page #${page.id} has no content at ${sha.slice(0, 7)}.`, 'REV_NOT_FOUND')
  }
  return { sha, path, markdown }
}

async function runHistory(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const limit = readInteger(args, 'limit')
  if (limit !== undefined && limit <= 0) throw new UsageError('--limit must be a positive number.')
  const revisions = await pageHistory(ctx.docsRoot, page.relPath, limit)
  const data = { pageId: page.id, path: page.relPath, revisions }

  if (json) {
    writeJson(successEnvelope('docs page history', data, { root: ctx.docsRoot }))
    return 0
  }
  if (revisions.length === 0) {
    writeOut(`Page #${page.id} has no history yet.`)
    return 0
  }
  for (const revision of revisions) {
    writeOut(`${revision.sha.slice(0, 7)}  ${revision.date}  ${revision.source.padEnd(15)} ${revision.subject}`)
  }
  return 0
}

async function runPageDiff(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  await requireDocsRepo(ctx.docsRoot)
  const rev = positional[1] ?? readString(args, 'rev')
  const result = rev === undefined ? await worktreeDiff(ctx.docsRoot, page.relPath) : await revisionDiff(ctx.docsRoot, page.relPath, rev)
  const data = { pageId: page.id, from: result.from, to: result.to, diff: result.diff, hunks: result.hunks }

  if (json) {
    writeJson(successEnvelope('docs page diff', data, { root: ctx.docsRoot }))
    return 0
  }
  if (result.diff.length === 0) writeOut('No changes.')
  else process.stdout.write(result.diff)
  return 0
}

async function runRestore(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const rev = positional[1] ?? readString(args, 'rev')
  if (rev === undefined) throw new UsageError('Usage: bita docs page restore <pageId> <sha>')
  const revision = await revisionText(ctx, page, rev)
  if (revision === null) throw new UsageError('Usage: bita docs page restore <pageId> <sha>')

  const recorded = await recordPageDoc(
    ctx,
    page,
    { body: revision.markdown },
    { source: 'restore', action: `restore ${revision.sha.slice(0, 7)} of`, reason: `restore ${revision.sha.slice(0, 7)}` },
  )
  const written = await readRaw(recorded.path)
  const warnings = written === null ? [] : pageWarnings(parseDocument(written), Buffer.byteLength(written))

  return report(ctx, 'docs page restore', requirePage(ctx.db, page.id), json, {
    path: recorded.path,
    changed: recorded.changed,
    warnings,
    sha: recorded.sha,
    restoredFrom: revision.sha,
  })
}

function report(
  ctx: PageContext,
  command: string,
  page: DocPageRow,
  json: boolean,
  extra: Record<string, unknown> = {},
): number {
  const data = {
    page: pageView(ctx, page, talliesByPage(ctx.db), ctx.siteUrl),
    ...extra,
  }
  if (json) {
    writeJson(successEnvelope(command, data, { root: ctx.docsRoot, timezone: ctx.timezone }))
    return 0
  }
  writeOut(`#${page.id}  ${page.title}`)
  writeOut(resolveDocPath(ctx.docsRoot, page.relPath))
  return 0
}
