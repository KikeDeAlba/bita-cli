import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { UsageError } from '../errors.ts'
import { parseHooks, type HookConfig } from '../hooks/hooks.ts'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'bita')
export const CONFIG_PATH_ENV_VAR = 'BITA_CONFIG_PATH'
export const CONFIG_PATH = process.env[CONFIG_PATH_ENV_VAR] ?? path.join(CONFIG_DIR, 'config.json')

export type RepoSlugSource = 'remote' | 'path' | 'basename'

export interface ScopeMapping {
  projectId: number
  projectName: string
  workspaceId?: number
  slugSource: RepoSlugSource
  verifiedAt?: string
}

export interface AppConfig {
  version: number
  timezone?: string
  scopeMapping: Record<string, ScopeMapping>
  hooks?: HookConfig[]
  [key: string]: unknown
}

export function emptyConfig(): AppConfig {
  return { version: 1, scopeMapping: {} }
}

export const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.config', 'toggl-track-cli', 'config.json')

interface LegacyScopeMapping extends ScopeMapping {
  togglProjectId?: number
  togglProjectName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function migrateScopes(raw: unknown): Record<string, ScopeMapping> {
  const scopeMapping: Record<string, ScopeMapping> = {}
  if (!isRecord(raw)) return scopeMapping
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const { togglProjectId, togglProjectName, workspaceId: _workspace, ...rest } = value as unknown as LegacyScopeMapping
    scopeMapping[key] = {
      ...rest,
      projectId: rest.projectId ?? togglProjectId ?? 0,
      projectName: rest.projectName ?? togglProjectName ?? '',
    }
  }
  return scopeMapping
}

export function parseConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) return emptyConfig()
  const { repoMapping, scopeMapping, hooks: rawHooks, version, ...rest } = raw
  const hooks = parseHooks(rawHooks)
  return {
    ...rest,
    version: typeof version === 'number' ? version : 1,
    scopeMapping: migrateScopes(scopeMapping ?? repoMapping),
    ...(hooks.length > 0 ? { hooks } : {}),
  }
}

async function readRaw(configPath: string): Promise<{ path: string; text: string } | null> {
  for (const candidate of [configPath, LEGACY_CONFIG_PATH]) {
    try {
      return { path: candidate, text: await readFile(candidate, 'utf8') }
    } catch {
      continue
    }
  }
  return null
}

export async function readConfig(configPath = CONFIG_PATH): Promise<AppConfig> {
  try {
    return await readConfigForUpdate(configPath)
  } catch {
    return emptyConfig()
  }
}

export async function readConfigForUpdate(configPath = CONFIG_PATH): Promise<AppConfig> {
  const raw = await readRaw(configPath)
  if (raw === null) return emptyConfig()
  try {
    return parseConfig(JSON.parse(raw.text) as unknown)
  } catch (error) {
    throw new UsageError(`${raw.path} is not valid JSON, so bita will not rewrite it: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function writeConfig(config: AppConfig, configPath = CONFIG_PATH): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function setScopeMapping(slug: string, mapping: ScopeMapping, configPath = CONFIG_PATH): Promise<AppConfig> {
  const config = await readConfigForUpdate(configPath)
  config.scopeMapping[slug] = mapping
  await writeConfig(config, configPath)
  return config
}

export async function unsetScopeMapping(slug: string, configPath = CONFIG_PATH): Promise<boolean> {
  const config = await readConfigForUpdate(configPath)
  if (!(slug in config.scopeMapping)) return false
  delete config.scopeMapping[slug]
  await writeConfig(config, configPath)
  return true
}
