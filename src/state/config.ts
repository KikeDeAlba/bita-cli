import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DEFAULT_STORY_THEMES, type StoryTheme } from '../config/constants.ts'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'bita')
export const CONFIG_PATH_ENV_VAR = 'BITA_CONFIG_PATH'
export const CONFIG_PATH = process.env[CONFIG_PATH_ENV_VAR] ?? path.join(CONFIG_DIR, 'config.json')

export type HierarchyStrategy = 'epic-story-subtask' | 'story-subtask' | 'flat-task'

export type EpicMode = 'fixed' | 'per-run' | 'flat'

export const NO_EPIC = ''

export interface StoryRef {
  key: string
  summary: string
  verifiedAt: string
}

export interface ProjectMapping {
  projectName: string
  jiraProjectKey: string
  hierarchy?: HierarchyStrategy
  epicResolved?: boolean
  storiesByEpic?: Record<string, Record<string, StoryRef>>
  storyIssueTypeName?: string
  workIssueTypeName?: string
  parentKey?: string
  issueTypeName?: string
  issueTypeId?: string
  doneTransition?: { id: string; name: string }
  timetrackingAvailable?: boolean
  verifiedAt?: string
}

export type RepoSlugSource = 'remote' | 'path' | 'basename'

export interface ScopeMapping {
  projectId: number
  projectName: string
  workspaceId?: number
  slugSource: RepoSlugSource
  verifiedAt?: string
}

export interface JiraConfig {
  cloudId?: string
  siteUrl?: string
  accountId?: string
  email?: string
}

export interface AppConfig {
  version: number
  workspaceId?: number
  timezone?: string
  jira?: JiraConfig
  defaults?: { issueTypeName?: string; pendingTagName?: string; storyThemes?: StoryTheme[] }
  projectMapping: Record<string, ProjectMapping>
  scopeMapping: Record<string, ScopeMapping>
}

export function emptyConfig(): AppConfig {
  return { version: 1, projectMapping: {}, scopeMapping: {} }
}

export const LEGACY_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'toggl-track-cli',
  'config.json',
)

interface LegacyProjectMapping extends ProjectMapping {
  togglProjectName?: string
  stories?: Record<string, StoryRef>
}

interface LegacyScopeMapping extends ScopeMapping {
  togglProjectId?: number
  togglProjectName?: string
  workspaceId?: number
}

export function migrateLegacyKeys(parsed: Partial<AppConfig>): Partial<AppConfig> {
  const projectMapping: Record<string, ProjectMapping> = {}
  for (const [key, value] of Object.entries(parsed.projectMapping ?? {})) {
    const legacy = value as LegacyProjectMapping
    const { togglProjectName, stories, ...rest } = legacy
    const migrated: ProjectMapping = { ...rest, projectName: rest.projectName ?? togglProjectName ?? '' }
    if (stories && Object.keys(stories).length > 0) {
      const epicKey = rest.parentKey ?? NO_EPIC
      migrated.storiesByEpic = {
        ...rest.storiesByEpic,
        [epicKey]: { ...stories, ...rest.storiesByEpic?.[epicKey] },
      }
    }
    projectMapping[key] = migrated
  }

  const legacyScopes = (parsed as { repoMapping?: Record<string, unknown> }).repoMapping
  const scopeMapping: Record<string, ScopeMapping> = {}
  for (const [key, value] of Object.entries(parsed.scopeMapping ?? legacyScopes ?? {})) {
    const legacy = value as LegacyScopeMapping
    const { togglProjectId, togglProjectName, workspaceId, ...rest } = legacy
    scopeMapping[key] = {
      ...rest,
      projectId: rest.projectId ?? togglProjectId ?? 0,
      projectName: rest.projectName ?? togglProjectName ?? '',
    }
  }

  const { repoMapping: _dropped, ...withoutLegacy } = parsed as Partial<AppConfig> & {
    repoMapping?: unknown
  }
  return { ...withoutLegacy, projectMapping, scopeMapping }
}

export async function readConfig(configPath = CONFIG_PATH): Promise<AppConfig> {
  try {
    let raw: string
    try {
      raw = await readFile(configPath, 'utf8')
    } catch {
      raw = await readFile(LEGACY_CONFIG_PATH, 'utf8')
    }
    const parsed = migrateLegacyKeys(JSON.parse(raw) as Partial<AppConfig>)
    return {
      version: parsed.version ?? 1,
      ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
      ...(parsed.jira !== undefined ? { jira: parsed.jira } : {}),
      ...(parsed.defaults !== undefined ? { defaults: parsed.defaults } : {}),
      projectMapping: parsed.projectMapping ?? {},
      scopeMapping: parsed.scopeMapping ?? {},
    }
  } catch {
    return emptyConfig()
  }
}

export async function writeConfig(config: AppConfig, configPath = CONFIG_PATH): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export type ProjectMappingUpdate = Omit<ProjectMapping, 'parentKey'> & { parentKey?: string | null }

const BOARD_SCOPED_FIELDS = [
  'storiesByEpic',
  'doneTransition',
  'issueTypeId',
  'timetrackingAvailable',
] as const satisfies readonly (keyof ProjectMapping)[]

export function mergeProjectMapping(
  existing: ProjectMapping | undefined,
  update: ProjectMappingUpdate,
): ProjectMapping {
  const { parentKey, ...fields } = update
  const merged: ProjectMapping = { ...existing, ...fields }

  if (parentKey === null) delete merged.parentKey
  else if (parentKey !== undefined) merged.parentKey = parentKey

  if (existing && existing.jiraProjectKey !== update.jiraProjectKey) {
    for (const field of BOARD_SCOPED_FIELDS) {
      if (!(field in fields)) delete merged[field]
    }
    if (parentKey === undefined) delete merged.parentKey
  }

  return merged
}

export async function setProjectMapping(
  projectId: number,
  update: ProjectMappingUpdate,
  configPath = CONFIG_PATH,
): Promise<AppConfig> {
  const config = await readConfig(configPath)
  const key = String(projectId)
  config.projectMapping[key] = mergeProjectMapping(config.projectMapping[key], update)
  await writeConfig(config, configPath)
  return config
}

export function epicMode(mapping: ProjectMapping): EpicMode {
  if (mapping.parentKey) return 'fixed'
  if (mapping.hierarchy === 'flat-task') return 'flat'
  return 'per-run'
}

export function storiesForEpic(mapping: ProjectMapping, epicKey: string): Record<string, StoryRef> {
  return mapping.storiesByEpic?.[epicKey] ?? {}
}

export function jiraTarget(mapping: ProjectMapping | undefined) {
  if (!mapping) {
    return {
      jiraProjectKey: null,
      epicMode: null,
      hierarchy: 'story-subtask' as HierarchyStrategy,
      jiraEpicKey: null,
      jiraParentKey: null,
      epicResolved: false,
      jiraStories: {},
      jiraStoriesByEpic: {},
    }
  }

  const parentKey = mapping.parentKey ?? null
  return {
    jiraProjectKey: mapping.jiraProjectKey,
    epicMode: epicMode(mapping),
    hierarchy: mapping.hierarchy ?? (parentKey ? 'epic-story-subtask' : 'story-subtask'),
    jiraEpicKey: parentKey,
    jiraParentKey: parentKey,
    epicResolved: mapping.epicResolved ?? false,
    jiraStories: storiesForEpic(mapping, parentKey ?? NO_EPIC),
    jiraStoriesByEpic: mapping.storiesByEpic ?? {},
  }
}

export async function unsetProjectMapping(
  projectId: number,
  configPath = CONFIG_PATH,
): Promise<boolean> {
  const config = await readConfig(configPath)
  const key = String(projectId)
  if (!(key in config.projectMapping)) return false
  delete config.projectMapping[key]
  await writeConfig(config, configPath)
  return true
}

export async function setScopeMapping(
  slug: string,
  mapping: ScopeMapping,
  configPath = CONFIG_PATH,
): Promise<AppConfig> {
  const config = await readConfig(configPath)
  config.scopeMapping[slug] = mapping
  await writeConfig(config, configPath)
  return config
}

export async function unsetScopeMapping(slug: string, configPath = CONFIG_PATH): Promise<boolean> {
  const config = await readConfig(configPath)
  if (!(slug in config.scopeMapping)) return false
  delete config.scopeMapping[slug]
  await writeConfig(config, configPath)
  return true
}

export function storyThemes(config: AppConfig): StoryTheme[] {
  const configured = config.defaults?.storyThemes
  return configured && configured.length > 0 ? configured : [...DEFAULT_STORY_THEMES]
}

export async function setStory(
  projectId: number,
  themeId: string,
  story: StoryRef,
  epicKey: string,
  configPath = CONFIG_PATH,
): Promise<AppConfig> {
  const config = await readConfig(configPath)
  const key = String(projectId)
  const mapping = config.projectMapping[key]
  if (!mapping) throw new Error(`Toggl project ${projectId} is not mapped to a Jira project.`)
  mapping.storiesByEpic = {
    ...mapping.storiesByEpic,
    [epicKey]: { ...mapping.storiesByEpic?.[epicKey], [themeId]: story },
  }
  await writeConfig(config, configPath)
  return config
}
