import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ConflictError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { ConfluenceClient, type AttachmentInfo } from '../../confluence/client.ts'
import { adfImage, displaySize, pngSize, storageImage } from '../../confluence/fragments.ts'
import { addRefToPage } from '../../db/page-refs.ts'
import { findPage } from '../../db/pages.ts'
import { findProjectById, listProjects } from '../../db/projects.ts'
import type { ProjectRow } from '../../db/rows.ts'
import { mapsOfProject } from '../../db/confluence-map.ts'
import { markdownToStorage, storageToMarkdown } from '../../confluence/convert.ts'
import { resolveConflict, syncProject, syncStatus, type ProjectSyncReport } from '../../confluence/sync.ts'
import { atlassianRuntime } from '../../atlassian/runtime.ts'
import {
  chooseSite,
  credentialsFor,
  forgetSiteToken,
  loadAtlassianConfig,
  projectSiteHint,
  type AtlassianCredentials,
} from '../../atlassian/sites.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { renderPageDiagrams } from './diagrams.ts'
import { runSiteAdd, SITE_OPTIONS } from './atlassian.ts'

const ACTIONS = new Set(['login', 'status', 'logout', 'attach', 'publish-diagrams', 'page', 'sync', 'conflict'])

const OPTIONS = {
  ...SITE_OPTIONS,
  to: { type: 'string' as const },
  comment: { type: 'string' as const },
  project: { type: 'string' as const },
  space: { type: 'string' as const },
  parent: { type: 'string' as const },
  title: { type: 'string' as const },
  file: { type: 'string' as const },
  body: { type: 'string' as const },
  message: { type: 'string' as const },
  cql: { type: 'string' as const },
  limit: { type: 'string' as const },
  keep: { type: 'string' as const },
  markdown: { type: 'boolean' as const, default: false },
  storage: { type: 'boolean' as const, default: false },
  all: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
}

export async function loadCredentials(choice: { site?: string | undefined; projectSite?: string | null | undefined } = {}): Promise<AtlassianCredentials> {
  return credentialsFor(chooseSite(await loadAtlassianConfig(), choice))
}

async function clientFor(args: ParsedArgs, projectSite: string | null = null): Promise<ConfluenceClient> {
  const credentials = await loadCredentials({ site: readString(args, 'site'), projectSite })
  return new ConfluenceClient(credentials, atlassianRuntime().fetch)
}

async function siteOfProjectFlag(args: ParsedArgs): Promise<string | null> {
  const project = readString(args, 'project')
  if (project === undefined) return null
  const ctx = createLocalContext(args)
  try {
    return projectSiteHint(ctx.db, await loadAtlassianConfig(), { project })
  } finally {
    ctx.db.close()
  }
}

function confluencePageId(raw: string | undefined, usage: string): string {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new UsageError(usage)
  return raw
}

async function runStatus(args: ParsedArgs, json: boolean): Promise<number> {
  const credentials = await loadCredentials({ site: readString(args, 'site'), projectSite: await siteOfProjectFlag(args) })
  const user = await new ConfluenceClient(credentials, atlassianRuntime().fetch).currentUser()
  const data = { siteUrl: credentials.siteUrl, email: credentials.email, displayName: user.displayName, ok: true }
  if (json) {
    writeJson(successEnvelope('confluence status', data))
    return 0
  }
  writeOut(`${credentials.siteUrl}: ${user.displayName} (${credentials.email}), token OK.`)
  return 0
}

async function runLogout(args: ParsedArgs, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const entry = chooseSite(config, { site: readString(args, 'site') })
  const removed = await forgetSiteToken(config, entry.site, entry.email)
  if (json) {
    writeJson(successEnvelope('confluence logout', { site: entry.site, email: entry.email, removed }))
    return 0
  }
  writeOut(removed ? `Removed the Atlassian token for ${entry.email} on ${entry.site} from the credential store.` : 'There was no token to remove.')
  return 0
}

export interface PlacedImage {
  attachment: AttachmentInfo
  adf: Record<string, unknown> | null
  storage: string
  width: number | null
  height: number | null
}

async function attachImage(client: ConfluenceClient, pageId: string, path: string, comment?: string): Promise<PlacedImage> {
  const attachment = await client.attach(pageId, path, comment)
  const size = attachment.mediaType === 'image/png' ? displaySize(pngSize(await readFile(path))) : null
  return {
    attachment,
    adf: adfImage(pageId, attachment, size),
    storage: storageImage(attachment.filename, size),
    width: size?.width ?? null,
    height: size?.height ?? null,
  }
}

async function runAttach(args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: bita confluence attach <confluencePageId> <files...>'
  const pageId = confluencePageId(args.positionals[0], usage)
  const files = args.positionals.slice(1)
  if (files.length === 0) throw new UsageError(usage)
  for (const file of files) if (!existsSync(file)) throw new UsageError(`No file at ${file}.`)

  const client = await clientFor(args, await siteOfProjectFlag(args))
  const placed: PlacedImage[] = []
  for (const file of files) placed.push(await attachImage(client, pageId, file, readString(args, 'comment')))

  if (json) {
    writeJson(successEnvelope('confluence attach', placed, { confluencePageId: pageId }))
    return 0
  }
  for (const item of placed) writeOut(`${item.attachment.filename} → ${item.attachment.attachmentId}`)
  return 0
}

async function runPublishDiagrams(args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: bita confluence publish-diagrams <bitaPageId> --to <confluencePageId>'
  const bitaPageId = Number(args.positionals[0])
  if (!Number.isInteger(bitaPageId) || bitaPageId <= 0) throw new UsageError(usage)
  const pageId = confluencePageId(readString(args, 'to'), usage)

  const ctx = createLocalContext(args)
  try {
    const bitaPage = findPage(ctx.db, bitaPageId)
    const owner = bitaPage?.projectId ? findProjectById(ctx.db, bitaPage.projectId) : undefined
    const client = await clientFor(args, owner?.atlassianSite ?? null)
    const { diagrams, results } = await renderPageDiagrams(ctx, bitaPageId, { force: readBoolean(args, 'force') })
    const failed = results.filter((result) => result.state === 'failed' || result.state === 'missing-source')
    if (failed.length > 0) {
      const names = failed.map((result) => `${result.kind} ${result.name}${result.error ? ` (${result.error})` : ''}`)
      throw new ConflictError(
        `Some diagrams could not be rendered: ${names.join('; ')}.`,
        'DIAGRAM_RENDER_FAILED',
        'Fix them and run "bita docs diagrams render" first; nothing was uploaded.',
      )
    }

    const published = []
    for (const [at, result] of results.entries()) {
      const block = diagrams.blocks[at]!
      const image = await attachImage(client, pageId, result.imagePath, `bita: ${block.kind} ${block.name}`)
      const source = await client.attach(pageId, result.sourcePath, `bita: source of ${block.imageFile}`)
      published.push({
        index: block.index,
        kind: block.kind,
        name: block.name,
        line: block.line,
        image,
        source,
      })
    }

    const page = await client.pageStorage(pageId)
    if (page.webUrl) {
      addRefToPage(ctx.db, bitaPageId, {
        url: page.webUrl,
        title: page.title,
        kind: 'confluence',
        source: 'manual',
        now: ctx.now.toISOString(),
      })
    }

    const data = { bitaPageId, confluencePageId: pageId, confluenceTitle: page.title, confluenceUrl: page.webUrl, diagrams: published }
    if (json) {
      writeJson(successEnvelope('confluence publish-diagrams', data))
      return 0
    }
    if (published.length === 0) writeOut(`Page #${bitaPageId} has no diagrams to publish.`)
    for (const item of published) {
      writeOut(`#${item.index} ${item.kind} ${item.name}: ${item.image.attachment.filename} + ${item.source.filename}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

async function bodyFrom(args: ParsedArgs): Promise<{ storage: string; markdown: string | null } | null> {
  const file = readString(args, 'file')
  const raw = file !== undefined ? await readFile(file, 'utf8') : readString(args, 'body')
  if (raw === undefined) return null
  if (readBoolean(args, 'storage')) return { storage: raw, markdown: null }
  return { storage: markdownToStorage(raw), markdown: raw }
}

function pageView(page: Awaited<ReturnType<ConfluenceClient['page']>>, withMarkdown: boolean) {
  return {
    id: page.id,
    title: page.title,
    version: page.version,
    spaceId: page.spaceId,
    parentId: page.parentId,
    status: page.status,
    url: page.webUrl,
    storage: page.storage,
    ...(withMarkdown ? { markdown: storageToMarkdown(page.storage) } : {}),
  }
}

async function runPage(args: ParsedArgs, json: boolean): Promise<number> {
  const [action, target] = args.positionals
  const usage = 'Usage: bita confluence page <get|create|update|search|children> ...'
  if (action === undefined) throw new UsageError(usage)
  const client = await clientFor(args, await siteOfProjectFlag(args))

  if (action === 'get') {
    const id = confluencePageId(target, 'Usage: bita confluence page get <id> [--markdown]')
    const page = await client.page(id)
    const data = pageView(page, readBoolean(args, 'markdown'))
    if (json) writeJson(successEnvelope('confluence page get', data))
    else writeOut(readBoolean(args, 'markdown') ? (data.markdown ?? '') : page.storage)
    return 0
  }

  if (action === 'create') {
    const title = readString(args, 'title')
    const body = await bodyFrom(args)
    if (title === undefined || body === null) {
      throw new UsageError('Usage: bita confluence page create --space KEY|--parent ID --title T (--file F|--body S)')
    }
    const parentId = readString(args, 'parent')
    const spaceKey = readString(args, 'space')
    let spaceId: string
    if (parentId !== undefined) {
      const parent = await client.page(confluencePageId(parentId, 'Pass --parent <confluencePageId>.'))
      if (parent.spaceId === null) throw new ConflictError(`Confluence did not say which space page ${parentId} is in.`, 'CONFLUENCE_SPACE')
      spaceId = parent.spaceId
    } else if (spaceKey !== undefined) {
      spaceId = (await client.spaceByKey(spaceKey)).id
    } else {
      throw new UsageError('Pass --space KEY or --parent ID.')
    }
    const page = await client.createPage({ spaceId, parentId: parentId ?? null, title, storage: body.storage })
    const data = pageView(page, false)
    if (json) writeJson(successEnvelope('confluence page create', data))
    else writeOut(`Created ${page.id}: ${page.title}${page.webUrl ? `  ${page.webUrl}` : ''}`)
    return 0
  }

  if (action === 'update') {
    const id = confluencePageId(target, 'Usage: bita confluence page update <id> (--file F|--body S) [--title T] [--message M]')
    const body = await bodyFrom(args)
    if (body === null) throw new UsageError('Pass --file <markdown> or --body <markdown>.')
    const current = await client.page(id)
    const page = await client.updatePage({
      id,
      title: readString(args, 'title') ?? current.title,
      storage: body.storage,
      version: current.version + 1,
      message: readString(args, 'message'),
    })
    const data = pageView(page, false)
    if (json) writeJson(successEnvelope('confluence page update', data))
    else writeOut(`Updated ${page.id} to version ${page.version}.`)
    return 0
  }

  if (action === 'search') {
    const cql = readString(args, 'cql') ?? target
    if (cql === undefined) throw new UsageError('Usage: bita confluence page search --cql "<CQL>" [--limit N]')
    const hits = await client.search(cql, readInteger(args, 'limit') ?? 25)
    if (json) writeJson(successEnvelope('confluence page search', hits, { cql }))
    else for (const hit of hits) writeOut(`${hit.id}  ${hit.title}${hit.space ? `  (${hit.space})` : ''}`)
    return 0
  }

  if (action === 'children') {
    const id = confluencePageId(target, 'Usage: bita confluence page children <id>')
    const children = await client.children(id)
    if (json) writeJson(successEnvelope('confluence page children', children, { parentId: id }))
    else for (const child of children) writeOut(`${child.id}  ${child.title}`)
    return 0
  }

  throw new UsageError(usage)
}

function syncTargets(ctx: LocalContext, args: ParsedArgs, raw: string | undefined): ProjectRow[] {
  if (raw !== undefined) return [resolveProjectArg(ctx.db, raw)]
  if (!readBoolean(args, 'all')) throw new UsageError('Usage: bita confluence sync <project>|--all [--dry-run]')
  return listProjects(ctx.db).filter(
    (project) => project.confluenceRef !== null && (project.syncPull || project.syncPush),
  )
}

function syncCounts(report: ProjectSyncReport): string {
  return `pulled ${report.pulled.length}, pushed ${report.pushed.length}, created ${report.created.length}, conflicts ${report.conflicts.length}, skipped ${report.skipped.length}`
}

async function runSync(args: ParsedArgs, json: boolean): Promise<number> {
  if (args.positionals[0] === 'status') return runSyncStatus(args, json)
  const dryRun = readBoolean(args, 'dry-run')
  const ctx = createLocalContext(args)
  try {
    const targets = syncTargets(ctx, args, args.positionals[0])
    const config = await loadAtlassianConfig()
    const reports: ProjectSyncReport[] = []
    for (const project of targets) {
      if (project.confluenceRef === null || (!project.syncPull && !project.syncPush)) {
        reports.push({
          project: project.name,
          pulled: [],
          pushed: [],
          created: [],
          conflicts: [],
          skipped: [{ title: project.name, reason: project.confluenceRef === null ? 'no Confluence page or space set' : 'pull and push are off' }],
        })
        continue
      }
      const entry = chooseSite(config, { site: readString(args, 'site'), projectSite: project.atlassianSite })
      const client = new ConfluenceClient(await credentialsFor(entry), atlassianRuntime().fetch)
      reports.push(await syncProject(ctx, client, project, entry.site, { dryRun }))
    }

    if (json) {
      writeJson(successEnvelope('confluence sync', reports, { dryRun }))
      return 0
    }
    if (reports.length === 0) writeOut('No project syncs with Confluence. Turn it on with "bita project atlassian <project> --pull on".')
    for (const report of reports) {
      writeOut(`${report.project}: ${syncCounts(report)}${dryRun ? ' (dry run)' : ''}`)
      for (const conflict of report.conflicts) writeOut(`  conflict #${conflict.pageId ?? '-'} ${conflict.title}: ${conflict.reason ?? ''}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

async function runSyncStatus(args: ParsedArgs, json: boolean): Promise<number> {
  const raw = args.positionals[1]
  if (raw === undefined) throw new UsageError('Usage: bita confluence sync status <project>')
  const ctx = createLocalContext(args)
  try {
    const project = resolveProjectArg(ctx.db, raw)
    let client: ConfluenceClient | null = null
    if (!readBoolean(args, 'offline') && mapsOfProject(ctx.db, project.id).length > 0) {
      client = await clientFor(args, project.atlassianSite)
    }
    const mappings = await syncStatus(ctx, client, project)
    if (json) {
      writeJson(successEnvelope('confluence sync status', mappings, { project: project.name, lastSyncAt: project.lastSyncAt, offline: client === null }))
      return 0
    }
    if (mappings.length === 0) writeOut(`${project.name} has no pages tied to Confluence yet.`)
    for (const mapping of mappings) {
      writeOut(`#${mapping.pageId} ${mapping.title} <-> ${mapping.confluenceId}  ${mapping.state}  ${mapping.direction}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

async function runConflict(args: ParsedArgs, json: boolean): Promise<number> {
  const [action, target] = args.positionals
  const ctx = createLocalContext(args)
  try {
    if (action === 'ls' || action === 'list') {
      const projects = target !== undefined ? [resolveProjectArg(ctx.db, target)] : listProjects(ctx.db, true)
      const conflicts = projects.flatMap((project) =>
        mapsOfProject(ctx.db, project.id, 'conflict').map((map) => ({
          pageId: map.pageId,
          title: findPage(ctx.db, map.pageId)?.title ?? '',
          project: project.name,
          confluenceId: map.confluenceId,
          site: map.site,
          since: map.syncedAt,
        })),
      )
      if (json) writeJson(successEnvelope('confluence conflict ls', conflicts))
      else if (conflicts.length === 0) writeOut('No conflicts.')
      else for (const conflict of conflicts) writeOut(`#${conflict.pageId} ${conflict.title} (${conflict.project}) <-> ${conflict.confluenceId}`)
      return 0
    }

    if (action === 'resolve') {
      const pageId = Number(target)
      const keep = readString(args, 'keep')
      if (!Number.isInteger(pageId) || pageId <= 0 || (keep !== 'local' && keep !== 'remote' && keep !== 'both')) {
        throw new UsageError('Usage: bita confluence conflict resolve <pageId> --keep local|remote|both')
      }
      const page = findPage(ctx.db, pageId)
      const owner = page?.projectId ? findProjectById(ctx.db, page.projectId) : undefined
      const client = await clientFor(args, owner?.atlassianSite ?? null)
      const resolved = await resolveConflict(ctx, client, pageId, keep)
      if (json) writeJson(successEnvelope('confluence conflict resolve', resolved))
      else writeOut(`#${pageId} ${resolved.title}: ${resolved.reason ?? 'resolved'}.`)
      return 0
    }

    throw new UsageError('Usage: bita confluence conflict <ls [project]|resolve <pageId> --keep local|remote|both>')
  } finally {
    ctx.db.close()
  }
}

export async function runConfluence(argv: string[]): Promise<number> {
  const action = argv[0]
  if (action === undefined || !ACTIONS.has(action)) {
    throw new UsageError(`Usage: bita confluence <${[...ACTIONS].join('|')}>`)
  }
  const args = parseCommandArgs(argv.slice(1), OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  if (action === 'login') return runSiteAdd(args, json, 'confluence login')
  if (action === 'status') return runStatus(args, json)
  if (action === 'logout') return runLogout(args, json)
  if (action === 'attach') return runAttach(args, json)
  if (action === 'page') return runPage(args, json)
  if (action === 'sync') return runSync(args, json)
  if (action === 'conflict') return runConflict(args, json)
  return runPublishDiagrams(args, json)
}
