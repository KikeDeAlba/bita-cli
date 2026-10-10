import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, NotFoundError, UsageError } from '../errors.ts'
import {
  normalizeSiteUrl,
  readConfig,
  writeConfig,
  type AppConfig,
  type AtlassianSiteConfig,
} from '../state/config.ts'
import { deleteToken, readToken, storeToken } from '../state/credentials.ts'
import { findProjectById, findProjectByKey, findProjectByName } from '../db/projects.ts'
import { atlassianRuntime } from './runtime.ts'

export interface AtlassianCredentials {
  siteUrl: string
  email: string
  token: string
}

export const SITE_LOGIN_HINT =
  'Run "bita atlassian site add --site https://<name>.atlassian.net --email <you@company.com>" in a terminal, or pipe the token: pbpaste | bita atlassian site add --site <url> --email <you@company.com> --token-stdin'

export function requireSiteUrl(raw: string): string {
  const site = normalizeSiteUrl(raw)
  if (site === null) {
    throw new UsageError(`"${raw}" is not an Atlassian site. Expected something like https://gruposti.atlassian.net.`)
  }
  return site
}

export function siteAccount(site: string, email: string): string {
  return `${site}|${email}`
}

export function sitesOf(config: AppConfig): AtlassianSiteConfig[] {
  return config.atlassian?.sites ?? []
}

export function findSite(config: AppConfig, raw: string): AtlassianSiteConfig | undefined {
  const site = normalizeSiteUrl(raw)
  if (site === null) return undefined
  return sitesOf(config).find((entry) => entry.site === site)
}

export async function readSiteToken(site: string, email: string): Promise<string | null> {
  const store = await atlassianRuntime().credentials()
  return (await readToken(siteAccount(site, email), store)) ?? (await readToken(email, store))
}

export async function storeSiteToken(site: string, email: string, token: string): Promise<void> {
  await storeToken(siteAccount(site, email), token, await atlassianRuntime().credentials())
}

export async function forgetSiteToken(config: AppConfig, site: string, email: string): Promise<boolean> {
  const store = await atlassianRuntime().credentials()
  const removed = await deleteToken(siteAccount(site, email), store)
  const sharedEmail = sitesOf(config).some((entry) => entry.site !== site && entry.email === email)
  const legacy = sharedEmail ? false : await deleteToken(email, store)
  return removed || legacy
}

export async function loadAtlassianConfig(): Promise<AppConfig> {
  return readConfig(atlassianRuntime().configPath)
}

export async function saveAtlassianConfig(config: AppConfig): Promise<void> {
  await writeConfig(config, atlassianRuntime().configPath)
}

export function upsertSite(config: AppConfig, entry: AtlassianSiteConfig): AppConfig {
  const sites = sitesOf(config)
  const index = sites.findIndex((existing) => existing.site === entry.site)
  const next = index === -1 ? [...sites, entry] : sites.map((existing, at) => (at === index ? { ...existing, ...entry } : existing))
  const first = next[0]
  const jira =
    config.jira?.siteUrl && config.jira.email
      ? config.jira
      : first
        ? { ...config.jira, siteUrl: first.site, email: first.email }
        : config.jira
  return { ...config, ...(jira !== undefined ? { jira } : {}), atlassian: { sites: next } }
}

export function dropSite(config: AppConfig, site: string): AppConfig {
  const sites = sitesOf(config).filter((entry) => entry.site !== site)
  const legacySite = config.jira?.siteUrl ? normalizeSiteUrl(config.jira.siteUrl) : null
  let jira = config.jira
  if (legacySite === site) {
    const { siteUrl: _site, email: _email, ...rest } = config.jira ?? {}
    const first = sites[0]
    jira = first ? { ...rest, siteUrl: first.site, email: first.email } : rest
  }
  return { ...config, ...(jira !== undefined ? { jira } : {}), atlassian: { sites } }
}

export interface SiteChoice {
  site?: string | undefined
  projectSite?: string | null | undefined
}

export function chooseSite(config: AppConfig, choice: SiteChoice = {}): AtlassianSiteConfig {
  const sites = sitesOf(config)
  if (choice.site !== undefined) {
    const site = requireSiteUrl(choice.site)
    const found = sites.find((entry) => entry.site === site)
    if (!found) throw new NotFoundError(`There is no login for ${site}.`, 'ATLASSIAN_SITE_NOT_FOUND', SITE_LOGIN_HINT)
    return found
  }
  if (choice.projectSite) {
    const found = sites.find((entry) => entry.site === choice.projectSite)
    if (found) return found
    throw new NotFoundError(
      `The project works against ${choice.projectSite}, but there is no login for it.`,
      'ATLASSIAN_SITE_NOT_FOUND',
      SITE_LOGIN_HINT,
    )
  }
  const first = sites[0]
  if (!first) throw new ConflictError('There is no Atlassian site yet.', 'ATLASSIAN_LOGIN_REQUIRED', SITE_LOGIN_HINT)
  return first
}

export async function credentialsFor(entry: AtlassianSiteConfig): Promise<AtlassianCredentials> {
  const token = await readSiteToken(entry.site, entry.email)
  if (token === null) {
    throw new ConflictError(
      `The credential store has no Atlassian token for ${entry.email} on ${entry.site}.`,
      'ATLASSIAN_LOGIN_REQUIRED',
      SITE_LOGIN_HINT,
    )
  }
  return { siteUrl: entry.site, email: entry.email, token }
}

export async function resolveCredentials(choice: SiteChoice = {}): Promise<AtlassianCredentials> {
  return credentialsFor(chooseSite(await loadAtlassianConfig(), choice))
}

export function projectSiteHint(
  db: DatabaseSync,
  config: AppConfig,
  hint: { project?: string | undefined; issueKey?: string | undefined },
): string | null {
  if (hint.project !== undefined) {
    const raw = hint.project
    const asNumber = Number(raw)
    const project =
      (Number.isInteger(asNumber) && asNumber > 0 ? findProjectById(db, asNumber) : undefined) ??
      findProjectByName(db, raw) ??
      findProjectByKey(db, raw)
    if (project?.atlassianSite) return project.atlassianSite
    const viaJira = siteOfJiraKey(db, config, raw)
    if (viaJira) return viaJira
  }
  if (hint.issueKey !== undefined) {
    const jiraKey = hint.issueKey.split('-')[0]
    if (jiraKey) return siteOfJiraKey(db, config, jiraKey)
  }
  return null
}

function siteOfJiraKey(db: DatabaseSync, config: AppConfig, jiraKey: string): string | null {
  for (const [projectId, mapping] of Object.entries(config.projectMapping)) {
    if (mapping.jiraProjectKey.toUpperCase() !== jiraKey.toUpperCase()) continue
    const project = findProjectById(db, Number(projectId))
    if (project?.atlassianSite) return project.atlassianSite
  }
  return null
}
