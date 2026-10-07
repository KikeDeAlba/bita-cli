import { CONFIG_PATH } from '../state/config.ts'
import { securityRunner, type SecurityRunner } from '../state/keychain.ts'

export type Fetch = typeof globalThis.fetch

export interface AtlassianRuntime {
  fetch: Fetch
  security: SecurityRunner
  configPath: string
}

let current: AtlassianRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  security: securityRunner,
  configPath: CONFIG_PATH,
}

export function atlassianRuntime(): AtlassianRuntime {
  return current
}

export function setAtlassianRuntime(overrides: Partial<AtlassianRuntime>): () => void {
  const previous = current
  current = { ...current, ...overrides }
  return () => {
    current = previous
  }
}
