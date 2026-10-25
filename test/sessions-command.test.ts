import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HarnessId } from '../src/harness/types.ts'

const { openDatabase } = await import('../src/db/open.ts')
const { insertProject } = await import('../src/db/projects.ts')
const { insertEntry } = await import('../src/db/entries.ts')
const { insertEntrySession, linkSession, listSessionDirectories, listSessions, markSessionEnded } = await import('../src/db/sessions.ts')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bita-sessions-')))
const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

interface Seed {
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

let counter = 0

function fixture(): { dbPath: string; alpha: number; beta: number; add(seed: Seed): { entryId: number; rowId: number } } {
  counter += 1
  const dbPath = join(root, `db-${counter}.db`)
  const db = openDatabase(dbPath)
  const alpha = insertProject(db, { name: 'Alpha', clientName: null, createdAt: '2026-09-01T00:00:00Z' }).id
  const beta = insertProject(db, { name: 'Beta', clientName: null, createdAt: '2026-09-01T00:00:00Z' }).id
  db.close()
  return {
    dbPath,
    alpha,
    beta,
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
  }
}

function bita(dbPath: string, cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: root, BITA_DB_PATH: dbPath, BITA_CONFIG_PATH: join(root, 'config.json'), KIT_NO_EVENTS: '1', KIT_REGISTRY_DIR: join(root, 'registry'), TZ: 'UTC' },
  })
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
  } catch {
    json = {}
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json }
}

function dir(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

test('listSessions returns every field of the contract, newest first, open and resumable flags included', () => {
  const f = fixture()
  const here = dir('ls-fields')
  const older = f.add({ cwd: here, sessionId: 'sid-a', transcriptPath: '/t/a.jsonl', wrapperPid: 111, description: 'older', startedAt: '2026-09-10T10:00:00Z' })
  const open = f.add({ cwd: here, sessionId: null, wrapperPid: 222, description: 'running', projectId: f.beta, harness: 'codex', ended: false, startedAt: '2026-09-11T10:00:00Z' })
  const db = openDatabase(f.dbPath)
  try {
    const sessions = listSessions(db, { cwd: here, open: false, harness: null, limit: 50 })
    assert.deepEqual(sessions, [
      {
        id: open.rowId,
        entryId: open.entryId,
        harness: 'codex',
        sessionId: null,
        wrapperPid: 222,
        cwd: here,
        transcriptPath: null,
        startedAt: '2026-09-11T10:00:00.000Z',
        endedAt: null,
        open: true,
        resumable: false,
        entry: { description: 'running', projectId: f.beta, projectName: 'Beta' },
      },
      {
        id: older.rowId,
        entryId: older.entryId,
        harness: 'claude',
        sessionId: 'sid-a',
        wrapperPid: 111,
        cwd: here,
        transcriptPath: '/t/a.jsonl',
        startedAt: '2026-09-10T10:00:00.000Z',
        endedAt: '2026-09-10T10:00:00.000Z',
        open: false,
        resumable: true,
        entry: { description: 'older', projectId: f.alpha, projectName: 'Alpha' },
      },
    ])
  } finally {
    db.close()
  }
})

test('listSessions filters by cwd, open, harness and limit, and only the latest row of a session is resumable', () => {
  const f = fixture()
  const here = dir('ls-filters-a')
  const there = dir('ls-filters-b')
  const first = f.add({ cwd: here, sessionId: 'dup', startedAt: '2026-09-10T10:00:00Z' })
  const again = f.add({ cwd: here, sessionId: 'dup', startedAt: '2026-09-11T10:00:00Z' })
  const gemini = f.add({ cwd: here, harness: 'gemini', startedAt: '2026-09-12T10:00:00Z' })
  const open = f.add({ cwd: there, ended: false, startedAt: '2026-09-13T10:00:00Z' })
  const db = openDatabase(f.dbPath)
  try {
    const all = (filter: Partial<Parameters<typeof listSessions>[1]>) =>
      listSessions(db, { cwd: null, open: false, harness: null, limit: 50, ...filter }).map((session) => session.id)
    assert.deepEqual(all({ cwd: here }), [gemini.rowId, again.rowId, first.rowId])
    assert.deepEqual(all({}), [open.rowId, gemini.rowId, again.rowId, first.rowId])
    assert.deepEqual(all({ open: true }), [open.rowId])
    assert.deepEqual(all({ open: true, cwd: here }), [])
    assert.deepEqual(all({ harness: 'gemini' }), [gemini.rowId])
    assert.deepEqual(all({ limit: 2 }), [open.rowId, gemini.rowId])
    const flags = listSessions(db, { cwd: here, open: false, harness: null, limit: 50 }).map((session) => [session.id, session.resumable])
    assert.deepEqual(flags, [
      [gemini.rowId, true],
      [again.rowId, true],
      [first.rowId, false],
    ])
  } finally {
    db.close()
  }
})

test('listSessionDirectories groups by cwd, most recent first, with the latest project and the count', () => {
  const f = fixture()
  const a = dir('dirs-a')
  const b = dir('dirs-b')
  f.add({ cwd: a, startedAt: '2026-09-10T10:00:00Z', projectId: f.beta })
  f.add({ cwd: a, startedAt: '2026-09-14T10:00:00Z', projectId: f.alpha })
  f.add({ cwd: a, startedAt: '2026-09-15T10:00:00Z', projectId: null })
  f.add({ cwd: b, startedAt: '2026-09-16T10:00:00Z', projectId: f.beta, ended: false })
  const db = openDatabase(f.dbPath)
  try {
    assert.deepEqual(listSessionDirectories(db), [
      { cwd: b, lastUsedAt: '2026-09-16T10:00:00.000Z', sessions: 1, projectId: f.beta, projectName: 'Beta' },
      { cwd: a, lastUsedAt: '2026-09-15T10:00:00.000Z', sessions: 3, projectId: f.alpha, projectName: 'Alpha' },
    ])
    assert.deepEqual(listSessionDirectories(db, 1).map((row) => row.cwd), [b])
  } finally {
    db.close()
  }
})

test('bita sessions ls --json filters by the current directory by default, and --all and --cwd change it', () => {
  const f = fixture()
  const here = dir('cli-here')
  const there = dir('cli-there')
  const mine = f.add({ cwd: here, sessionId: 'mine', startedAt: '2026-09-10T10:00:00Z' })
  const other = f.add({ cwd: there, sessionId: 'other', startedAt: '2026-09-11T10:00:00Z' })

  const local = bita(f.dbPath, here, 'sessions', 'ls', '--json')
  assert.equal(local.status, 0, local.stderr)
  assert.equal(local.json['ok'], true)
  assert.equal(local.json['command'], 'sessions ls')
  assert.equal(local.json['schemaVersion'], 3)
  assert.deepEqual((local.json['data'] as Array<{ id: number }>).map((row) => row.id), [mine.rowId])

  const all = bita(f.dbPath, here, 'sessions', 'ls', '--all', '--json')
  assert.deepEqual((all.json['data'] as Array<{ id: number }>).map((row) => row.id), [other.rowId, mine.rowId])

  const elsewhere = bita(f.dbPath, here, 'sessions', '--cwd', '../cli-there', '--json')
  assert.deepEqual((elsewhere.json['data'] as Array<{ id: number }>).map((row) => row.id), [other.rowId])

  const bare = bita(f.dbPath, here, 'sessions')
  assert.equal(bare.status, 0, bare.stderr)
  assert.match(bare.stdout, /resumable/)
  assert.match(bare.stdout, /Alpha/)
})

test('bita sessions ls --open lists the running sessions with their wrapper pid', () => {
  const f = fixture()
  const here = dir('cli-open')
  f.add({ cwd: here, startedAt: '2026-09-10T10:00:00Z' })
  const running = f.add({ cwd: here, ended: false, sessionId: null, wrapperPid: 31337, harness: 'opencode', startedAt: '2026-09-11T10:00:00Z' })
  const result = bita(f.dbPath, here, 'sessions', 'ls', '--open', '--all', '--harness', 'opencode', '--json')
  assert.equal(result.status, 0, result.stderr)
  const data = result.json['data'] as Array<Record<string, unknown>>
  assert.equal(data.length, 1)
  assert.equal(data[0]?.['id'], running.rowId)
  assert.equal(data[0]?.['wrapperPid'], 31337)
  assert.equal(data[0]?.['open'], true)
  assert.equal(data[0]?.['resumable'], false)
})

test('bita sessions ls rejects bad flags', () => {
  const f = fixture()
  const here = dir('cli-bad')
  for (const args of [['--all', '--cwd', '.'], ['--harness', 'nope'], ['--limit', '0'], ['extra']]) {
    const result = bita(f.dbPath, here, 'sessions', 'ls', ...args, '--json')
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`)
  }
  assert.equal(bita(f.dbPath, here, 'sessions', 'nope').status, 2)
})

test('bita sessions dirs --json returns the directories, with --limit', () => {
  const f = fixture()
  const a = dir('cli-dirs-a')
  const b = dir('cli-dirs-b')
  f.add({ cwd: a, startedAt: '2026-09-10T10:00:00Z' })
  f.add({ cwd: b, startedAt: '2026-09-11T10:00:00Z', projectId: f.beta })
  const result = bita(f.dbPath, a, 'sessions', 'dirs', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json['command'], 'sessions dirs')
  assert.deepEqual(result.json['data'], [
    { cwd: b, lastUsedAt: '2026-09-11T10:00:00.000Z', sessions: 1, projectId: f.beta, projectName: 'Beta' },
    { cwd: a, lastUsedAt: '2026-09-10T10:00:00.000Z', sessions: 1, projectId: f.alpha, projectName: 'Alpha' },
  ])
  const limited = bita(f.dbPath, a, 'sessions', 'dirs', '--limit', '1', '--json')
  assert.deepEqual((limited.json['data'] as Array<{ cwd: string }>).map((row) => row.cwd), [b])
})
