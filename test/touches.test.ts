import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { listTouches, recordTouch, touchesByEntry } from '../src/db/touches.ts'

const NOW = '2026-09-19T12:00:00.000Z'

function seedEntry(db: ReturnType<typeof openMemoryDatabase>) {
  return insertEntry(db, {
    description: 'work',
    projectId: null,
    startedAt: '2026-09-19T10:00:00.000Z',
    source: 'timer',
    now: NOW,
  })
}

test('records the same path twice without duplicating it', () => {
  const db = openMemoryDatabase()
  const entry = seedEntry(db)

  recordTouch(db, entry.id, 'src/a.ts', NOW)
  recordTouch(db, entry.id, 'src/a.ts', '2026-09-19T13:00:00.000Z')
  recordTouch(db, entry.id, 'src/b.ts', NOW)

  assert.deepEqual(listTouches(db, entry.id), ['src/a.ts', 'src/b.ts'])
  db.close()
})

test('keeps the first time a path was seen', () => {
  const db = openMemoryDatabase()
  const entry = seedEntry(db)

  recordTouch(db, entry.id, 'src/a.ts', NOW)
  recordTouch(db, entry.id, 'src/a.ts', '2026-09-19T13:00:00.000Z')

  const rows = db.prepare('SELECT first_seen_at FROM entry_touches').all() as {
    first_seen_at: string
  }[]
  assert.equal(rows[0]?.first_seen_at, NOW)
  db.close()
})

test('groups the paths of several entries at once', () => {
  const db = openMemoryDatabase()
  const first = seedEntry(db)
  const second = seedEntry(db)

  recordTouch(db, first.id, 'src/a.ts', NOW)
  recordTouch(db, second.id, 'src/b.ts', NOW)

  const byEntry = touchesByEntry(db, [first.id, second.id])
  assert.deepEqual(byEntry.get(first.id), ['src/a.ts'])
  assert.deepEqual(byEntry.get(second.id), ['src/b.ts'])
  db.close()
})

test('drops the paths when the entry goes away', () => {
  const db = openMemoryDatabase()
  const entry = seedEntry(db)
  recordTouch(db, entry.id, 'src/a.ts', NOW)

  db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id)
  assert.deepEqual(listTouches(db, entry.id), [])
  db.close()
})
