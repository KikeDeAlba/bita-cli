import { CONFIG_PATH } from '../state/config.ts'
import { systemCredentialStore, type CredentialStore } from '../state/credentials.ts'

export type Fetch = typeof globalThis.fetch

export interface AtlassianRuntime {
  fetch: Fetch
  credentials: () => Promise<CredentialStore>
  configPath: string
}

let current: AtlassianRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  credentials: systemCredentialStore,
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
