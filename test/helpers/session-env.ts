import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalContext } from '../../src/cli/local-context.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'bita-session-env-'))
process.env['BITA_CONFIG_PATH'] = join(sandbox, 'config.json')
process.env['KIT_NO_EVENTS'] = '1'
for (const key of ['BITA_WRAPPER_ID', 'BITA_HARNESS', 'BITA_SESSION_PROJECT', 'BITA_CHILD']) delete process.env[key]

export const SESSION_SANDBOX = sandbox

export async function openContext(path: string): Promise<LocalContext> {
  const { createLocalContext } = await import('../../src/cli/local-context.ts')
  return createLocalContext({ values: { 'db-path': path }, positionals: [] })
}

export function addProject(db: DatabaseSync, id: number, name: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name, new Date().toISOString())
}
