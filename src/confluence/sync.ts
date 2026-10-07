import { ConflictError, NotFoundError } from '../errors.ts'
import type { ProjectRow } from '../db/rows.ts'
import {
  ancestorsOf,
  descendantsOf,
  findPage,
  insertPage,
  listPages,
  renamePage,
  requirePage,
  uniqueSiblingSlug,
  type DocPageRow,
} from '../db/pages.ts'
import { findMapByPage, findMapByRemote, mapsOfProject, saveMap, setMapState, type PageMapRow } from '../db/confluence-map.ts'
import { findProjectById, setProjectLastSync } from '../db/projects.ts'
import { MAX_PAGE_DEPTH, pageRelPath } from '../docs/layout.ts'
import { checksumOf, documentBody, parseDocument } from '../docs/markdown.ts'
import { movePageFile, recordPageDoc } from '../docs/page-record.ts'
import { resolveDocPath } from '../docs/paths.ts'
import type { DocsContext } from '../docs/record.ts'
import { titleSlug } from '../docs/slug.ts'
import { readRaw } from '../docs/store.ts'
import { confluenceRefView } from '../atlassian/project-view.ts'
import type { ConfluenceClient, ConfluencePage } from './client.ts'
import { markdownToStorage, storageToMarkdown } from './convert.ts'

export interface SyncItem {
  pageId?: number
  confluenceId?: string
  title: string
  reason?: string
}

export interface ProjectSyncReport {
  project: string
  pulled: SyncItem[]
  pushed: SyncItem[]
  created: SyncItem[]
  conflicts: SyncItem[]
  skipped: SyncItem[]
}

export interface SyncOptions {
  dryRun: boolean
}

export type SyncDirection = 'pull' | 'push' | 'none' | 'conflict'

export interface MappingStatus {
  pageId: number
  title: string
  confluenceId: string
  confluenceTitle: string | null
  state: 'synced' | 'conflict'
  direction: SyncDirection
}

export const SYNC_MESSAGE = 'bita sync'

function item(page: { id?: number; title: string } | null, confluenceId: string | undefined, title: string, reason?: string): SyncItem {
  return {
    ...(page?.id !== undefined ? { pageId: page.id } : {}),
    ...(confluenceId !== undefined ? { confluenceId } : {}),
    title,
    ...(reason !== undefined ? { reason } : {}),
  }
}

function isGone(error: unknown): boolean {
  return error instanceof ConflictError && error.code === 'CONFLUENCE_HTTP' && /HTTP 404/.test(error.message)
}

export function demoteTitledHeadings(markdown: string): string {
  const lines = markdown.split('\n')
  let fenced = false
  let hasTitle = false
  for (const line of lines) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^#\s/.test(line)) hasTitle = true
  }
  if (!hasTitle) return markdown
  fenced = false
  return lines
    .map((line) => {
      if (/^ {0,3}(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (!fenced && /^#{1,5}\s/.test(line)) return `#${line}`
      return line
    })
    .join('\n')
}

export async function localBody(ctx: DocsContext, page: DocPageRow): Promise<string> {
  const raw = await readRaw(resolveDocPath(ctx.docsRoot, page.relPath))
  return raw === null ? '' : documentBody(parseDocument(raw))
}

export function bodyChecksum(body: string): string {
  return checksumOf(body)
}

export function remoteMarkdown(page: ConfluencePage): string {
  return demoteTitledHeadings(storageToMarkdown(page.storage))
}

async function writeLocal(ctx: DocsContext, page: DocPageRow, remote: ConfluencePage): Promise<string> {
  let current = page
  if (remote.title.trim().length > 0 && remote.title.trim() !== page.title) {
    current = await retitle(ctx, page, remote.title.trim())
  }
  await recordPageDoc(ctx, current, { body: remoteMarkdown(remote) })
  return bodyChecksum(await localBody(ctx, requirePage(ctx.db, page.id)))
}

async function retitle(ctx: DocsContext, page: DocPageRow, title: string): Promise<DocPageRow> {
  const slug = uniqueSiblingSlug(ctx.db, page.projectId, page.parentId, titleSlug(title))
  renamePage(ctx.db, page.id, title, slug, ctx.now.toISOString())
  const renamed = requirePage(ctx.db, page.id)
  await movePageFile(ctx, renamed, relPathFor(ctx, renamed.projectId, renamed.parentId, slug))
  return requirePage(ctx.db, page.id)
}

function relPathFor(ctx: DocsContext, projectId: number | null, parentId: number | null, slug: string): string {
  const parent = parentId === null ? null : requirePage(ctx.db, parentId)
  const ancestors = parent ? [...ancestorsOf(ctx.db, parent.id).map((row) => row.slug), parent.slug] : []
  const projectName = projectId === null ? null : (findProjectById(ctx.db, projectId)?.name ?? null)
  return pageRelPath({ projectName, ancestorSlugs: ancestors, slug })
}

function mapRow(ctx: DocsContext, site: string, pageId: number, remote: { id: string; version: number }, checksum: string, state: 'synced' | 'conflict' = 'synced'): PageMapRow {
  return {
    pageId,
    site,
    confluenceId: remote.id,
    confluenceVersion: remote.version,
    localChecksum: checksum,
    state,
    syncedAt: ctx.now.toISOString(),
  }
}

export interface SyncRoot {
  rootId: string
  spaceId: string
  title: string
}

export function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const DIAGRAM_FENCE = /^(`{3,}|~{3,})\s*(mermaid|drawio)\b[\s\S]*?^\1\s*$/gim

export function hasDiagrams(markdown: string): boolean {
  DIAGRAM_FENCE.lastIndex = 0
  return DIAGRAM_FENCE.test(markdown)
}

export function sameContent(left: string, right: string): boolean {
  const flat = (text: string): string =>
    text
      .replace(DIAGRAM_FENCE, '')
      .replace(/^(`{3,}|~{3,})[^\n]*$/gm, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#\s.*$/m, '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '')
  return flat(left) === flat(right)
}

export async function resolveRoot(client: ConfluenceClient, project: ProjectRow, site: string): Promise<SyncRoot> {
  if (project.confluenceRef === null || project.confluenceKind === null) {
    throw new ConflictError(`${project.name} has no Confluence page or space.`, 'CONFLUENCE_NOT_SET', `Set one with "bita project atlassian ${project.name} --confluence <url|SPACEKEY>".`)
  }
  const view = confluenceRefView(project.confluenceKind, project.confluenceRef, site)
  if (view.kind === 'space') {
    const space = await client.spaceByKey(view.spaceKey ?? project.confluenceRef)
    if (space.homepageId === null) {
      throw new ConflictError(`The space ${space.key} has no home page to sync under.`, 'CONFLUENCE_SPACE')
    }
    const home = await client.page(space.homepageId)
    return { rootId: space.homepageId, spaceId: space.id, title: home.title }
  }
  if (view.pageId === null) {
    throw new ConflictError(`Could not read a page id out of ${project.confluenceRef}.`, 'CONFLUENCE_NOT_SET')
  }
  const root = await client.page(view.pageId)
  if (root.spaceId === null) throw new ConflictError(`Confluence did not say which space page ${view.pageId} is in.`, 'CONFLUENCE_SPACE')
  return { rootId: root.id, spaceId: root.spaceId, title: root.title }
}

export async function syncProject(
  ctx: DocsContext,
  client: ConfluenceClient,
  project: ProjectRow,
  site: string,
  options: SyncOptions,
): Promise<ProjectSyncReport> {
  const report: ProjectSyncReport = { project: project.name, pulled: [], pushed: [], created: [], conflicts: [], skipped: [] }
  const pull = project.syncPull
  const push = project.syncPush
  const dryRun = options.dryRun
  const root = await resolveRoot(client, project, site)

  for (const map of mapsOfProject(ctx.db, project.id)) {
    if (map.site !== site) continue
    const page = requirePage(ctx.db, map.pageId)
    if (map.state === 'conflict') {
      report.conflicts.push(item({ id: page.id, title: page.title }, map.confluenceId, page.title, 'unresolved conflict'))
      continue
    }

    let remote: ConfluencePage
    try {
      remote = await client.page(map.confluenceId)
    } catch (error) {
      if (!isGone(error)) throw error
      report.skipped.push(item({ id: page.id, title: page.title }, map.confluenceId, page.title, 'the Confluence page is gone'))
      continue
    }

    const body = await localBody(ctx, page)
    const localChanged = bodyChecksum(body) !== map.localChecksum
    const remoteChanged = remote.version !== map.confluenceVersion
    const entry = item({ id: page.id, title: page.title }, map.confluenceId, page.title)

    if (localChanged && remoteChanged) {
      if (!dryRun) setMapState(ctx.db, page.id, 'conflict')
      report.conflicts.push({ ...entry, reason: 'changed on both sides' })
      continue
    }

    if (remoteChanged) {
      if (!pull) {
        report.skipped.push({ ...entry, reason: 'changed in Confluence, but pull is off' })
        continue
      }
      if (hasDiagrams(body)) {
        report.skipped.push({ ...entry, reason: 'changed in Confluence, but pulling would drop the diagram sources in bita' })
        continue
      }
      if (!dryRun) {
        const checksum = await writeLocal(ctx, page, remote)
        saveMap(ctx.db, mapRow(ctx, site, page.id, remote, checksum))
      }
      report.pulled.push({ ...entry, title: remote.title || page.title })
      continue
    }

    if (localChanged) {
      if (!push) {
        report.skipped.push({ ...entry, reason: 'changed in bita, but push is off' })
        continue
      }
      if (hasDiagrams(body)) {
        report.skipped.push({ ...entry, reason: 'changed in bita, but pushing would turn its diagrams into code; publish it with publish-diagrams' })
        continue
      }
      if (!dryRun) {
        const updated = await client.updatePage({
          id: remote.id,
          title: page.title,
          storage: markdownToStorage(body),
          version: remote.version + 1,
          message: SYNC_MESSAGE,
        })
        saveMap(ctx.db, mapRow(ctx, site, page.id, updated, bodyChecksum(body)))
      }
      report.pushed.push(entry)
    }
  }

  const anchor = await bindRoot(ctx, client, project, site, root, report, dryRun)
  const claimed = new Set<number>()
  if (anchor !== null) claimed.add(anchor.id)
  await pullUnmapped(ctx, client, project, site, root, anchor, report, dryRun, claimed, pull)
  if (push) await pushUnmapped(ctx, client, project, site, root, anchor, report, dryRun, claimed)

  if (!dryRun) setProjectLastSync(ctx.db, project.id, ctx.now.toISOString())
  return report
}

async function bindRoot(
  ctx: DocsContext,
  client: ConfluenceClient,
  project: ProjectRow,
  site: string,
  root: SyncRoot,
  report: ProjectSyncReport,
  dryRun: boolean,
): Promise<DocPageRow | null> {
  const mapped = findMapByRemote(ctx.db, site, root.rootId)
  if (mapped) {
    const page = findPage(ctx.db, mapped.pageId)
    return page && page.projectId === project.id ? page : null
  }
  const wanted = titleKey(root.title)
  const candidates = listPages(ctx.db, project.id).filter(
    (page) =>
      page.parentId === null &&
      page.status === 'active' &&
      titleKey(page.title) === wanted &&
      findMapByPage(ctx.db, page.id) === undefined,
  )
  const page = candidates.length === 1 ? candidates[0] : undefined
  if (page === undefined) return null
  const remote = await client.page(root.rootId)
  const body = await localBody(ctx, page)
  const same = sameContent(body, documentBody(parseDocument(remoteMarkdown(remote))))
  if (!dryRun) saveMap(ctx.db, mapRow(ctx, site, page.id, remote, bodyChecksum(body), same ? 'synced' : 'conflict'))
  if (!same) report.conflicts.push(item({ id: page.id, title: page.title }, remote.id, page.title, 'exists on both sides'))
  return page
}

function scopeOf(ctx: DocsContext, projectId: number, anchor: DocPageRow | null): DocPageRow[] {
  return anchor === null ? listPages(ctx.db, projectId) : descendantsOf(ctx.db, anchor.id)
}

interface PendingParent {
  bitaId: number | null
  depth: number
  virtual: boolean
}

async function pullUnmapped(
  ctx: DocsContext,
  client: ConfluenceClient,
  project: ProjectRow,
  site: string,
  root: SyncRoot,
  anchor: DocPageRow | null,
  report: ProjectSyncReport,
  dryRun: boolean,
  claimed: Set<number>,
  create: boolean,
): Promise<void> {
  const start: PendingParent = anchor === null
    ? { bitaId: null, depth: 0, virtual: false }
    : { bitaId: anchor.id, depth: anchor.depth + 1, virtual: false }
  const queue: { confluenceId: string; parent: PendingParent }[] = [{ confluenceId: root.rootId, parent: start }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    const children = await client.children(next.confluenceId)
    for (const child of children) {
      if (child.status !== null && child.status !== 'current') continue
      const mapped = findMapByRemote(ctx.db, site, child.id)
      if (mapped) {
        const page = findPage(ctx.db, mapped.pageId)
        if (page && page.projectId === project.id) {
          queue.push({ confluenceId: child.id, parent: { bitaId: page.id, depth: page.depth + 1, virtual: false } })
        }
        continue
      }

      if (next.parent.depth > MAX_PAGE_DEPTH) {
        report.skipped.push(item(null, child.id, child.title, 'too deep for a bita page tree'))
        continue
      }

      if (next.parent.virtual) {
        if (create) report.created.push(item(null, child.id, child.title, 'from Confluence'))
        queue.push({ confluenceId: child.id, parent: { bitaId: null, depth: next.parent.depth + 1, virtual: true } })
        continue
      }

      const twin =
        unmappedSibling(ctx, project.id, next.parent.bitaId, child.title, claimed) ??
        unmappedNamesake(ctx, project.id, anchor, child.title, claimed)
      if (twin) {
        claimed.add(twin.id)
        const remote = await client.page(child.id)
        const body = await localBody(ctx, twin)
        const same = sameContent(body, documentBody(parseDocument(remoteMarkdown(remote))))
        if (!dryRun) saveMap(ctx.db, mapRow(ctx, site, twin.id, remote, bodyChecksum(body), same ? 'synced' : 'conflict'))
        if (!same) report.conflicts.push(item({ id: twin.id, title: twin.title }, child.id, twin.title, 'exists on both sides'))
        queue.push({ confluenceId: child.id, parent: { bitaId: twin.id, depth: twin.depth + 1, virtual: false } })
        continue
      }

      if (dryRun || !create) {
        if (create) report.created.push(item(null, child.id, child.title, 'from Confluence'))
        queue.push({ confluenceId: child.id, parent: { bitaId: null, depth: next.parent.depth + 1, virtual: true } })
        continue
      }

      const remote = await client.page(child.id)
      const pageId = createLocalPage(ctx, project, next.parent.bitaId, next.parent.depth, remote.title || child.title)
      const checksum = await writeLocal(ctx, requirePage(ctx.db, pageId), remote)
      saveMap(ctx.db, mapRow(ctx, site, pageId, remote, checksum))
      report.created.push(item({ id: pageId, title: remote.title }, remote.id, requirePage(ctx.db, pageId).title, 'from Confluence'))
      queue.push({ confluenceId: child.id, parent: { bitaId: pageId, depth: next.parent.depth + 1, virtual: false } })
    }
  }
}

function unmappedSibling(
  ctx: DocsContext,
  projectId: number,
  parentId: number | null,
  title: string,
  claimed: ReadonlySet<number>,
): DocPageRow | undefined {
  const wanted = titleKey(title)
  return listPages(ctx.db, projectId).find(
    (page) =>
      page.parentId === parentId &&
      page.status === 'active' &&
      titleKey(page.title) === wanted &&
      !claimed.has(page.id) &&
      findMapByPage(ctx.db, page.id) === undefined,
  )
}

function unmappedNamesake(
  ctx: DocsContext,
  projectId: number,
  anchor: DocPageRow | null,
  title: string,
  claimed: ReadonlySet<number>,
): DocPageRow | undefined {
  const wanted = titleKey(title)
  const matches = scopeOf(ctx, projectId, anchor).filter(
    (page) =>
      page.status === 'active' &&
      titleKey(page.title) === wanted &&
      !claimed.has(page.id) &&
      findMapByPage(ctx.db, page.id) === undefined,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function createLocalPage(ctx: DocsContext, project: ProjectRow, parentId: number | null, depth: number, title: string): number {
  const slug = uniqueSiblingSlug(ctx.db, project.id, parentId, titleSlug(title))
  return insertPage(ctx.db, {
    projectId: project.id,
    parentId,
    slug,
    title: title.trim(),
    relPath: relPathFor(ctx, project.id, parentId, slug),
    depth,
    source: 'confluence',
    now: ctx.now.toISOString(),
  })
}

async function pushUnmapped(
  ctx: DocsContext,
  client: ConfluenceClient,
  project: ProjectRow,
  site: string,
  root: SyncRoot,
  anchor: DocPageRow | null,
  report: ProjectSyncReport,
  dryRun: boolean,
  claimed: ReadonlySet<number>,
): Promise<void> {
  const planned = new Set<number>(claimed)
  for (const page of scopeOf(ctx, project.id, anchor)) {
    if (page.status !== 'active') continue
    if (claimed.has(page.id) || findMapByPage(ctx.db, page.id)) continue

    let parentRemote: string | null = root.rootId
    if (page.parentId !== null && page.parentId !== anchor?.id) {
      const parentMap = findMapByPage(ctx.db, page.parentId)
      parentRemote = parentMap && parentMap.site === site ? parentMap.confluenceId : null
      if (parentRemote === null && !planned.has(page.parentId)) {
        report.skipped.push(item({ id: page.id, title: page.title }, undefined, page.title, 'its parent page is not in Confluence'))
        continue
      }
    }

    if (dryRun || parentRemote === null) {
      planned.add(page.id)
      report.created.push(item({ id: page.id, title: page.title }, undefined, page.title, 'from bita'))
      continue
    }

    const body = await localBody(ctx, page)
    if (hasDiagrams(body)) {
      report.skipped.push(item({ id: page.id, title: page.title }, undefined, page.title, 'has diagrams; publish it with publish-diagrams'))
      continue
    }
    try {
      const created = await client.createPage({ spaceId: root.spaceId, parentId: parentRemote, title: page.title, storage: markdownToStorage(body) })
      saveMap(ctx.db, mapRow(ctx, site, page.id, created, bodyChecksum(body)))
      report.created.push(item({ id: page.id, title: page.title }, created.id, page.title, 'from bita'))
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error
      report.skipped.push(item({ id: page.id, title: page.title }, undefined, page.title, error.message))
    }
  }
}

export async function resolveConflict(
  ctx: DocsContext,
  client: ConfluenceClient,
  pageId: number,
  keep: 'local' | 'remote' | 'both',
): Promise<SyncItem> {
  const map = findMapByPage(ctx.db, pageId)
  if (!map) throw new NotFoundError(`Page #${pageId} is not tied to Confluence.`, 'CONFLUENCE_NOT_MAPPED')
  const page = requirePage(ctx.db, pageId)
  const remote = await client.page(map.confluenceId)
  const body = await localBody(ctx, page)

  if (keep === 'both') {
    saveMap(ctx.db, mapRow(ctx, map.site, page.id, remote, bodyChecksum(body)))
    return item({ id: page.id, title: page.title }, remote.id, page.title, 'kept both as they are')
  }

  if (hasDiagrams(body)) {
    throw new ConflictError(
      `${page.title} has diagrams, and keeping one side would ${keep === 'local' ? 'turn them into code in Confluence' : 'drop their sources in bita'}.`,
      'CONFLUENCE_DIAGRAMS',
      `Edit the side that is behind by hand, then run "bita confluence conflict resolve ${page.id} --keep both".`,
    )
  }

  if (keep === 'remote') {
    const checksum = await writeLocal(ctx, page, remote)
    saveMap(ctx.db, mapRow(ctx, map.site, page.id, remote, checksum))
    return item({ id: page.id, title: page.title }, remote.id, remote.title || page.title, 'kept Confluence')
  }

  const updated = await client.updatePage({
    id: remote.id,
    title: page.title,
    storage: markdownToStorage(body),
    version: remote.version + 1,
    message: SYNC_MESSAGE,
  })
  saveMap(ctx.db, mapRow(ctx, map.site, page.id, updated, bodyChecksum(body)))
  return item({ id: page.id, title: page.title }, remote.id, page.title, 'kept bita')
}

export async function syncStatus(ctx: DocsContext, client: ConfluenceClient | null, project: ProjectRow): Promise<MappingStatus[]> {
  const statuses: MappingStatus[] = []
  for (const map of mapsOfProject(ctx.db, project.id)) {
    const page = requirePage(ctx.db, map.pageId)
    const localChanged = bodyChecksum(await localBody(ctx, page)) !== map.localChecksum
    let remote: ConfluencePage | null = null
    if (client !== null) {
      try {
        remote = await client.page(map.confluenceId)
      } catch (error) {
        if (!isGone(error)) throw error
      }
    }
    const remoteChanged = remote !== null && remote.version !== map.confluenceVersion
    const direction: SyncDirection =
      map.state === 'conflict' || (localChanged && remoteChanged)
        ? 'conflict'
        : remoteChanged
          ? 'pull'
          : localChanged
            ? 'push'
            : 'none'
    statuses.push({
      pageId: page.id,
      title: page.title,
      confluenceId: map.confluenceId,
      confluenceTitle: remote?.title ?? null,
      state: map.state,
      direction,
    })
  }
  return statuses
}
