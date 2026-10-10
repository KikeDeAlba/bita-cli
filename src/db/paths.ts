import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DB_PATH_ENV_VAR = 'BITA_DB_PATH'
export const DOCS_DIR_ENV_VAR = 'BITA_DOCS_DIR'
export const MEMORY_DB_PATH = ':memory:'

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DB_PATH_ENV_VAR]
  if (override) return override
  const dataHome = env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'bita', 'bita.db')
}

export function docsRoot(env: NodeJS.ProcessEnv = process.env, databaseLocation?: string): string {
  const override = env[DOCS_DIR_ENV_VAR]
  if (override) return override
  if (databaseLocation && databaseLocation !== MEMORY_DB_PATH) {
    return join(dirname(databaseLocation), 'docs')
  }
  const dataHome = env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'bita', 'docs')
}
