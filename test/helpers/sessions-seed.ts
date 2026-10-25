import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db/open.ts'
import { insertProject } from '../../src/db/projects.ts'
import { insertEntry } from '../../src/db/entries.ts'
import { insertEntrySession, linkSession, markSessionEnded } from '../../src/db/sessions.ts'
import type { HarnessId } from '../../src/harness/types.ts'

export const BITA_BIN = join(import.meta.dirname, '..', '..', 'src', 'bin', 'bita.ts')

export interface SeedSession {
  cwd: string
  startedAt: string
  harness?: HarnessId
  sessionId?: string | null
  transcriptPath?: string | null
  wrapperPid?: number
  description?: string
  projectId?: number | null
  ended?: boolean
}

export interface SeededDb {
  root: string
  dbPath: string
  alpha: number
  beta: number
  dir(name: string): string
  add(seed: SeedSession): { entryId: number; rowId: number }
  cleanup(): void
}

export function seededDb(): SeededDb {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bita-contract-')))
  const dbPath = join(root, 'bita.db')
  const db = openDatabase(dbPath)
  const alpha = insertProject(db, { name: 'Alpha', clientName: null, createdAt: '2026-09-01T00:00:00Z' }).id
  const beta = insertProject(db, { name: 'Beta', clientName: null, createdAt: '2026-09-01T00:00:00Z' }).id
  db.close()
  let counter = 0
  return {
    root,
    dbPath,
    alpha,
    beta,
    dir(name) {
      const path = join(root, name)
      mkdirSync(path, { recursive: true })
      return path
    },
    add(seed) {
      counter += 1
      const handle = openDatabase(dbPath)
      try {
        const entry = insertEntry(handle, {
          description: seed.description ?? `entry ${counter}`,
          projectId: seed.projectId === undefined ? alpha : seed.projectId,
          startedAt: seed.startedAt,
          stoppedAt: seed.ended === false ? null : seed.startedAt,
          source: 'session',
          now: seed.startedAt,
        })
        const row = insertEntrySession(handle, {
          entryId: entry.id,
          wrapperId: `w-${counter}`,
          wrapperPid: seed.wrapperPid ?? 4000 + counter,
          harness: seed.harness ?? 'claude',
          cwd: seed.cwd,
          startedAt: seed.startedAt,
        })
        const sessionId = seed.sessionId === undefined ? `s-${counter}` : seed.sessionId
        if (sessionId !== null) linkSession(handle, row.id, sessionId, seed.transcriptPath ?? null)
        if (seed.ended !== false) markSessionEnded(handle, row.id, seed.startedAt, 'exit')
        return { entryId: entry.id, rowId: row.id }
      } finally {
        handle.close()
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    },
  }
}

export interface BitaRun {
  status: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown>
}

export function runBita(box: Pick<SeededDb, 'root' | 'dbPath'>, cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): BitaRun {
  const run = spawnSync(process.execPath, [BITA_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: box.root,
      BITA_DB_PATH: box.dbPath,
      BITA_CONFIG_PATH: join(box.root, 'config.json'),
      KIT_NO_EVENTS: '1',
      KIT_REGISTRY_DIR: join(box.root, 'registry'),
      TZ: 'UTC',
      ...extraEnv,
    },
  })
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
  } catch {
    json = {}
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json }
}
