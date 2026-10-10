import { ConflictError, NotFoundError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { promptHidden, promptText } from '../prompt.ts'
import { readStdin } from '../stdin.ts'
import { atlassianRuntime } from '../../atlassian/runtime.ts'
import { checkSite, type SiteStatus } from '../../atlassian/check.ts'
import {
  dropSite,
  findSite,
  forgetSiteToken,
  loadAtlassianConfig,
  readSiteToken,
  requireSiteUrl,
  saveAtlassianConfig,
  sitesOf,
  storeSiteToken,
  upsertSite,
} from '../../atlassian/sites.ts'
import type { AppConfig, AtlassianSiteConfig } from '../../state/config.ts'
import { projectsUsingSite, setProjectAtlassian } from '../../db/projects.ts'

const SITE_ACTIONS = new Set(['add', 'ls', 'list', 'test', 'rm', 'remove'])

export const SITE_OPTIONS = {
  site: { type: 'string' as const },
  email: { type: 'string' as const },
  'token-stdin': { type: 'boolean' as const, default: false },
  check: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
}

export interface SiteView {
  site: string
  email: string
  tokenStored: boolean
  jira: boolean | null
  confluence: boolean | null
  projects: string[]
  status: SiteStatus
  displayName?: string | null
  checkedAt?: string | null
}

export async function runAtlassian(argv: string[]): Promise<number> {
  const [scope, action, ...rest] = argv
  if (scope !== 'site' || action === undefined || !SITE_ACTIONS.has(action)) {
    throw new UsageError('Usage: bita atlassian site <add|ls|test|rm>')
  }
  const args = parseCommandArgs(rest, SITE_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  if (action === 'add') return runSiteAdd(args, json, 'atlassian site add')
  if (action === 'ls' || action === 'list') return runSiteList(args, json)
  if (action === 'test') return runSiteTest(args, json)
  return runSiteRemove(args, json)
}

function projectNamesBySite(args: ParsedArgs, sites: readonly AtlassianSiteConfig[]): Map<string, string[]> {
  const ctx = createLocalContext(args)
  try {
    return new Map(sites.map((entry) => [entry.site, projectsUsingSite(ctx.db, entry.site).map((project) => project.name)]))
  } finally {
    ctx.db.close()
  }
}

export async function runSiteAdd(args: ParsedArgs, json: boolean, command: string): Promise<number> {
  const config = await loadAtlassianConfig()
  const fromStdin = readBoolean(args, 'token-stdin')
  if (!fromStdin && !process.stdin.isTTY) {
    throw new ConflictError(
      'Adding a site asks for the API token, which needs a terminal or --token-stdin.',
      'CONFIRMATION_REQUIRED',
      'Copy the token and run: pbpaste | bita atlassian site add --site https://<name>.atlassian.net --email <you@company.com> --token-stdin',
    )
  }

  const rawSite =
    readString(args, 'site') ??
    args.positionals[0] ??
    (command === 'confluence login' ? sitesOf(config)[0]?.site : undefined) ??
    (fromStdin ? undefined : await promptText('Atlassian site (https://….atlassian.net): '))
  if (!rawSite) throw new UsageError('Pass --site https://<name>.atlassian.net.')
  const site = requireSiteUrl(rawSite)

  const suggested = readString(args, 'email') ?? findSite(config, site)?.email ?? config.jira?.email
  const email = fromStdin
    ? (suggested ?? '')
    : (await promptText(suggested ? `Atlassian e-mail [${suggested}]: ` : 'Atlassian e-mail: ')) || suggested || ''
  if (email.length === 0) throw new UsageError('An e-mail is needed: pass --email.')

  const token = fromStdin
    ? (await readStdin()).trim()
    : await promptHidden('API token (https://id.atlassian.com/manage-profile/security/api-tokens): ')
  if (token.length === 0) throw new UsageError('An API token is needed.')
  if (/\s/.test(token)) throw new UsageError('The token has spaces or line breaks in it; copy only the token.')

  const check = await checkSite({ siteUrl: site, email, token }, atlassianRuntime().fetch)
  if (check.status === 'auth_failed') {
    throw new ConflictError(`${site} refused the token for ${email}.`, 'ATLASSIAN_AUTH', check.errors.join(' '))
  }
  if (check.status === 'unreachable') {
    throw new ConflictError(`Could not reach Jira or Confluence on ${site}.`, 'ATLASSIAN_UNREACHABLE', check.errors.join(' '))
  }

  await storeSiteToken(site, email, token)
  const entry: AtlassianSiteConfig = {
    site,
    email,
    jira: check.jira,
    confluence: check.confluence,
    ...(check.displayName !== null ? { displayName: check.displayName } : {}),
    checkedAt: new Date().toISOString(),
  }
  await saveAtlassianConfig(upsertSite(config, entry))

  const data = { site, email, displayName: check.displayName, jira: check.jira, confluence: check.confluence, status: check.status }
  if (json) {
    writeJson(successEnvelope(command, data))
    return 0
  }
  writeOut(`Logged in to ${site} as ${check.displayName ?? email} (${email}). The token lives in the system credential store.`)
  writeOut(`Jira: ${check.jira ? 'yes' : 'no'}, Confluence: ${check.confluence ? 'yes' : 'no'}.`)
  return 0
}

async function viewOf(
  entry: AtlassianSiteConfig,
  projects: string[],
  check: boolean,
): Promise<{ view: SiteView; updated: AtlassianSiteConfig }> {
  const token = await readSiteToken(entry.site, entry.email)
  if (!check) {
    return {
      view: {
        site: entry.site,
        email: entry.email,
        tokenStored: token !== null,
        jira: entry.jira ?? null,
        confluence: entry.confluence ?? null,
        projects,
        status: 'unknown',
        displayName: entry.displayName ?? null,
        checkedAt: entry.checkedAt ?? null,
      },
      updated: entry,
    }
  }

  if (token === null) {
    return {
      view: { site: entry.site, email: entry.email, tokenStored: false, jira: null, confluence: null, projects, status: 'auth_failed', displayName: entry.displayName ?? null, checkedAt: entry.checkedAt ?? null },
      updated: entry,
    }
  }

  const result = await checkSite({ siteUrl: entry.site, email: entry.email, token }, atlassianRuntime().fetch)
  const checkedAt = new Date().toISOString()
  const reachable = result.status === 'ok'
  const updated: AtlassianSiteConfig = reachable
    ? { ...entry, jira: result.jira, confluence: result.confluence, ...(result.displayName ? { displayName: result.displayName } : {}), checkedAt }
    : entry
  return {
    view: {
      site: entry.site,
      email: entry.email,
      tokenStored: true,
      jira: reachable ? result.jira : (entry.jira ?? null),
      confluence: reachable ? result.confluence : (entry.confluence ?? null),
      projects,
      status: result.status,
      displayName: result.displayName ?? entry.displayName ?? null,
      checkedAt: reachable ? checkedAt : (entry.checkedAt ?? null),
    },
    updated,
  }
}

async function runSiteList(args: ParsedArgs, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const sites = sitesOf(config)
  const projects = projectNamesBySite(args, sites)
  const check = readBoolean(args, 'check')

  const views: SiteView[] = []
  const updated: AtlassianSiteConfig[] = []
  for (const entry of sites) {
    const result = await viewOf(entry, projects.get(entry.site) ?? [], check)
    views.push(result.view)
    updated.push(result.updated)
  }
  if (check && sites.length > 0) await saveAtlassianConfig({ ...config, atlassian: { sites: updated } })

  if (json) {
    writeJson(successEnvelope('atlassian site ls', views, { checked: check }))
    return 0
  }
  if (views.length === 0) {
    writeOut('No Atlassian sites yet. Add one with "bita atlassian site add".')
    return 0
  }
  for (const view of views) {
    const products = [view.jira ? 'jira' : null, view.confluence ? 'confluence' : null].filter(Boolean).join('+') || '?'
    writeOut(
      `${view.site}  ${view.email}  ${view.tokenStored ? 'token' : 'no token'}  ${products}  ${view.status}${view.projects.length > 0 ? `  [${view.projects.join(', ')}]` : ''}`,
    )
  }
  return 0
}

function siteArg(args: ParsedArgs, config: AppConfig, usage: string): AtlassianSiteConfig {
  const raw = args.positionals[0] ?? readString(args, 'site')
  if (raw === undefined) throw new UsageError(usage)
  const entry = findSite(config, raw)
  if (!entry) throw new NotFoundError(`There is no site ${raw}.`, 'ATLASSIAN_SITE_NOT_FOUND', 'Run "bita atlassian site ls" to see them.')
  return entry
}

async function runSiteTest(args: ParsedArgs, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const entry = siteArg(args, config, 'Usage: bita atlassian site test <site>')
  const projects = projectNamesBySite(args, [entry]).get(entry.site) ?? []
  const { view, updated } = await viewOf(entry, projects, true)
  await saveAtlassianConfig(upsertSite(config, updated))

  if (json) {
    writeJson(successEnvelope('atlassian site test', view))
    return 0
  }
  writeOut(`${view.site}: ${view.status}${view.displayName ? ` as ${view.displayName}` : ''} (Jira ${view.jira ? 'yes' : 'no'}, Confluence ${view.confluence ? 'yes' : 'no'})`)
  return view.status === 'ok' ? 0 : 1
}

async function runSiteRemove(args: ParsedArgs, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const entry = siteArg(args, config, 'Usage: bita atlassian site rm <site> [--force]')
  const force = readBoolean(args, 'force')

  const ctx = createLocalContext(args)
  let released: string[] = []
  try {
    const users = projectsUsingSite(ctx.db, entry.site)
    if (users.length > 0 && !force) {
      throw new ConflictError(
        `${entry.site} is the site of ${users.map((project) => project.name).join(', ')}.`,
        'ATLASSIAN_SITE_IN_USE',
        'Point those projects at another site with "bita project atlassian <project> --site <site>", or pass --force to clear it.',
      )
    }
    for (const project of users) setProjectAtlassian(ctx.db, project.id, { site: null })
    released = users.map((project) => project.name)
  } finally {
    ctx.db.close()
  }

  const tokenRemoved = await forgetSiteToken(config, entry.site, entry.email)
  await saveAtlassianConfig(dropSite(config, entry.site))

  const data = { site: entry.site, email: entry.email, tokenRemoved, releasedProjects: released }
  if (json) {
    writeJson(successEnvelope('atlassian site rm', data))
    return 0
  }
  writeOut(`Removed ${entry.site}${tokenRemoved ? ' and its token' : ''}.`)
  if (released.length > 0) writeOut(`These projects no longer name a site: ${released.join(', ')}.`)
  return 0
}
