import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../src/db/open.ts'
import { findEntryById, insertEntry, listRunning } from '../src/db/entries.ts'
import { listTouches } from '../src/db/touches.ts'
import { runTouched } from '../src/cli/hooks/touched.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

function env(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_CONFIG_PATH: join(dir, 'config.json'),
    KIT_NO_EVENTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  }
}

function run(dir: string, cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: env(dir) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function mappedRepo(dir: string): string {
  const repo = join(dir, 'work', 'app')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo, env: env(dir) })
  assert.equal(run(dir, repo, ['project', 'add', 'Apps', '--json']).status, 0)
  assert.equal(run(dir, repo, ['project', 'add', 'Web', '--json']).status, 0)
  assert.equal(run(dir, repo, ['scope', 'set', '.', '1', '--json']).status, 0)
  return repo
}

test('touching a file of another project never splits, stops or creates entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-touched-'))
  try {
    const repo = mappedRepo(dir)
    const db = openDatabase(join(dir, 'bita.db'))
    const web = insertEntry(db, { description: 'Web work', projectId: 2, startedAt: ago(120), source: 'timer', now: ago(120) })
    const other = insertEntry(db, { description: 'More web', projectId: 2, startedAt: ago(60), source: 'timer', now: ago(60) })
    db.close()

    const out = run(dir, repo, ['hook', 'touched', '--file', join(repo, 'index.ts')])
    assert.equal(out.status, 0, out.stderr)

    const after = openDatabase(join(dir, 'bita.db'))
    try {
      assert.deepEqual(
        listRunning(after).map((entry) => [entry.id, entry.projectId]),
        [
          [web.id, 2],
          [other.id, 2],
        ],
      )
      assert.deepEqual(listTouches(after, web.id), [])
      assert.deepEqual(listTouches(after, other.id), [])
    } finally {
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a draft without project gets the touch but not the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-touched-'))
  try {
    const repo = mappedRepo(dir)
    const db = openDatabase(join(dir, 'bita.db'))
    const web = insertEntry(db, { description: 'Web work', projectId: 2, startedAt: ago(120), source: 'timer', now: ago(120) })
    const draft = insertEntry(db, { description: '', projectId: null, startedAt: ago(10), source: 'timer', now: ago(10) })
    db.close()

    const file = join(repo, 'index.ts')
    assert.equal(run(dir, repo, ['hook', 'touched', '--file', file]).status, 0)

    const after = openDatabase(join(dir, 'bita.db'))
    try {
      assert.equal(listRunning(after).length, 2)
      assert.equal(findEntryById(after, draft.id)?.projectId, null)
      assert.deepEqual(listTouches(after, draft.id), [file])
      assert.deepEqual(listTouches(after, web.id), [])
    } finally {
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the preferred entry gets the touch over the oldest running one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-touched-'))
  const previousConfig = process.env['BITA_CONFIG_PATH']
  process.env['BITA_CONFIG_PATH'] = join(dir, 'config.json')
  try {
    const dbPath = join(dir, 'bita.db')
    const db = openDatabase(dbPath)
    const first = insertEntry(db, { description: 'First', projectId: null, startedAt: ago(30), source: 'timer', now: ago(30) })
    const session = insertEntry(db, { description: '', projectId: null, startedAt: ago(5), source: 'timer', now: ago(5) })
    db.close()

    const file = join(dir, 'notes.txt')
    const preferred = await runTouched(file, { dbPath, preferredEntryId: session.id })
    assert.deepEqual(preferred, { decision: 'record', entryId: session.id })
    const fallback = await runTouched(file, { dbPath, preferredEntryId: 9999 })
    assert.deepEqual(fallback, { decision: 'record', entryId: first.id })

    const after = openDatabase(dbPath)
    try {
      assert.equal(listRunning(after).length, 2)
      assert.deepEqual(listTouches(after, session.id), [file])
    } finally {
      after.close()
    }
  } finally {
    if (previousConfig === undefined) delete process.env['BITA_CONFIG_PATH']
    else process.env['BITA_CONFIG_PATH'] = previousConfig
    rmSync(dir, { recursive: true, force: true })
  }
})
