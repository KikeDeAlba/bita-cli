import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessId } from '../src/harness/types.ts'

const { openDatabase } = await import('../src/db/open.ts')
const { insertProject } = await import('../src/db/projects.ts')
const { insertEntry } = await import('../src/db/entries.ts')
const { findResumableByEntry, findResumableByRow, insertEntrySession, listSessions, linkSession, listResumableSessions, markSessionEnded } = await import('../src/db/sessions.ts')

const root = mkdtempSync(join(tmpdir(), 'bita-resumable-'))
test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

interface Seed {
  harness?: HarnessId
  sessionId?: string | null
  cwd?: string
  startedAt: string
  description?: string
  projectId?: number | null
  ended?: boolean
}

let counter = 0

function setup(): { db: DatabaseSync; projectId: number; add(seed: Seed): { entryId: number; rowId: number } } {
  counter += 1
  const db = openDatabase(join(root, `db-${counter}.db`))
  const projectId = insertProject(db, { name: 'Alpha', clientName: null, createdAt: '2026-09-01T00:00:00Z' }).id
  return {
    db,
    projectId,
    add(seed) {
      counter += 1
      const entry = insertEntry(db, {
        description: seed.description ?? `entry ${counter}`,
        projectId: seed.projectId === undefined ? projectId : seed.projectId,
        startedAt: seed.startedAt,
        stoppedAt: seed.startedAt,
        source: 'session',
        now: seed.startedAt,
      })
      const row = insertEntrySession(db, {
        entryId: entry.id,
        wrapperId: `w-${counter}`,
        wrapperPid: 1,
        harness: seed.harness ?? 'claude',
        cwd: seed.cwd ?? '/work/a',
        startedAt: seed.startedAt,
      })
      const sessionId = seed.sessionId === undefined ? `s-${counter}` : seed.sessionId
      if (sessionId !== null) linkSession(db, row.id, sessionId, null)
      if (seed.ended !== false) markSessionEnded(db, row.id, seed.startedAt, 'exit')
      return { entryId: entry.id, rowId: row.id }
    },
  }
}

test('lists the sessions of the cwd newest first with entry and project data', () => {
  const { db, projectId, add } = setup()
  const first = add({ sessionId: 'a', startedAt: '2026-09-10T10:00:00Z', description: 'first' })
  const second = add({ sessionId: 'b', startedAt: '2026-09-12T10:00:00Z', description: 'second', projectId: null })
  const list = listResumableSessions(db, '/work/a')
  assert.deepEqual(list.map((item) => item.sessionId), ['b', 'a'])
  assert.deepEqual(list[0], {
    rowId: second.rowId,
    entryId: second.entryId,
    harness: 'claude',
    sessionId: 'b',
    cwd: '/work/a',
    startedAt: '2026-09-12T10:00:00.000Z',
    endedAt: '2026-09-12T10:00:00.000Z',
    description: 'second',
    projectId: null,
    projectName: null,
  })
  assert.equal(list[1]?.entryId, first.entryId)
  assert.equal(list[1]?.projectId, projectId)
  assert.equal(list[1]?.projectName, 'Alpha')
  db.close()
})

test('keeps only the latest row per harness and session id', () => {
  const { db, add } = setup()
  add({ sessionId: 'dup', startedAt: '2026-09-10T10:00:00Z', description: 'original' })
  add({ sessionId: 'dup', startedAt: '2026-09-11T10:00:00Z', description: 'resumed' })
  const latest = add({ sessionId: 'dup', startedAt: '2026-09-12T10:00:00Z', description: 'resumed again' })
  add({ sessionId: 'dup', harness: 'codex', startedAt: '2026-09-09T10:00:00Z', description: 'same id other harness' })
  const list = listResumableSessions(db, '/work/a')
  assert.deepEqual(list.map((item) => item.description), ['resumed again', 'same id other harness'])
  assert.equal(list[0]?.entryId, latest.entryId)
  db.close()
})

test('a newer open row does not hide the finished one, and ties resolve to the higher row id', () => {
  const { db, add } = setup()
  const finished = add({ sessionId: 'x', startedAt: '2026-09-10T10:00:00Z', description: 'finished' })
  add({ sessionId: 'x', startedAt: '2026-09-11T10:00:00Z', ended: false, description: 'running' })
  assert.deepEqual(listResumableSessions(db, '/work/a').map((item) => item.entryId), [finished.entryId])

  add({ sessionId: 'tie', startedAt: '2026-09-12T10:00:00Z', description: 'tie one' })
  const tie = add({ sessionId: 'tie', startedAt: '2026-09-12T10:00:00Z', description: 'tie two' })
  const ties = listResumableSessions(db, '/work/a').filter((item) => item.sessionId === 'tie')
  assert.equal(ties.length, 1)
  assert.equal(ties[0]?.entryId, tie.entryId)
  db.close()
})

test('filters by cwd and excludes open rows and rows without a session id', () => {
  const { db, add } = setup()
  add({ sessionId: 'here', startedAt: '2026-09-10T10:00:00Z' })
  add({ sessionId: 'there', cwd: '/work/b', startedAt: '2026-09-10T11:00:00Z' })
  add({ sessionId: 'open', startedAt: '2026-09-10T12:00:00Z', ended: false })
  add({ sessionId: null, startedAt: '2026-09-10T13:00:00Z' })
  assert.deepEqual(listResumableSessions(db, '/work/a').map((item) => item.sessionId), ['here'])
  assert.deepEqual(listResumableSessions(db, '/work/b').map((item) => item.sessionId), ['there'])
  assert.deepEqual(listResumableSessions(db, '/work/c'), [])
  assert.deepEqual(listResumableSessions(db, '/work/a/'), [])
  db.close()
})

test('honors the limit', () => {
  const { db, add } = setup()
  for (let day = 10; day < 15; day += 1) add({ startedAt: `2026-09-${day}T10:00:00Z` })
  assert.equal(listResumableSessions(db, '/work/a').length, 5)
  const limited = listResumableSessions(db, '/work/a', 2)
  assert.equal(limited.length, 2)
  assert.equal(limited[0]?.startedAt, '2026-09-14T10:00:00.000Z')
  db.close()
})

test('findResumableByEntry finds an entry of any cwd and rejects open, unlinked and unknown ones', () => {
  const { db, add } = setup()
  const other = add({ sessionId: 'far', cwd: '/somewhere/else', harness: 'gemini', startedAt: '2026-09-10T10:00:00Z', description: 'far away' })
  const found = findResumableByEntry(db, other.entryId)
  assert.equal(found?.cwd, '/somewhere/else')
  assert.equal(found?.harness, 'gemini')
  assert.equal(found?.sessionId, 'far')
  assert.equal(found?.description, 'far away')
  assert.equal(found?.projectName, 'Alpha')

  const open = add({ sessionId: 'o', startedAt: '2026-09-10T11:00:00Z', ended: false })
  const unlinked = add({ sessionId: null, startedAt: '2026-09-10T12:00:00Z' })
  assert.equal(findResumableByEntry(db, open.entryId), undefined)
  assert.equal(findResumableByEntry(db, unlinked.entryId), undefined)
  assert.equal(findResumableByEntry(db, 424_242), undefined)
  db.close()
})

test('findResumableByEntry returns the row of that entry even when a later resume exists', () => {
  const { db, add } = setup()
  const original = add({ sessionId: 'dup', startedAt: '2026-09-10T10:00:00Z', description: 'original' })
  add({ sessionId: 'dup', startedAt: '2026-09-11T10:00:00Z', description: 'later' })
  assert.equal(findResumableByEntry(db, original.entryId)?.description, 'original')
  db.close()
})

test('findResumableByRow only resumes a row that sessions ls marks resumable', () => {
  const { db, add } = setup()
  const older = add({ sessionId: 'dup', startedAt: '2026-09-10T10:00:00Z' })
  const latest = add({ sessionId: 'dup', startedAt: '2026-09-11T10:00:00Z' })
  const running = add({ sessionId: 'run', startedAt: '2026-09-12T10:00:00Z', ended: false })
  const unlinked = add({ sessionId: null, startedAt: '2026-09-13T10:00:00Z' })
  const listed = new Map(listSessions(db, { cwd: null, open: false, harness: null, limit: 50 }).map((row) => [row.id, row.resumable]))
  for (const row of [older, latest, running, unlinked]) {
    assert.equal(findResumableByRow(db, row.rowId) !== undefined, listed.get(row.rowId), `row ${row.rowId}`)
  }
  assert.equal(findResumableByRow(db, older.rowId), undefined)
  assert.equal(findResumableByRow(db, latest.rowId)?.entryId, latest.entryId)
  db.close()
})
