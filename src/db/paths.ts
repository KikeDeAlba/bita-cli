import { dirname, join } from 'node:path'
import { bitaDirs } from '../state/dirs.ts'

export const DB_PATH_ENV_VAR = 'BITA_DB_PATH'
export const DOCS_DIR_ENV_VAR = 'BITA_DOCS_DIR'
export const MEMORY_DB_PATH = ':memory:'

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DB_PATH_ENV_VAR]
  if (override) return override
  return join(bitaDirs({ env }).data, 'bita.db')
}

export function docsRoot(env: NodeJS.ProcessEnv = process.env, databaseLocation?: string): string {
  const override = env[DOCS_DIR_ENV_VAR]
  if (override) return override
  if (databaseLocation && databaseLocation !== MEMORY_DB_PATH) {
    return join(dirname(databaseLocation), 'docs')
  }
  return join(bitaDirs({ env }).data, 'docs')
}
