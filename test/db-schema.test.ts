import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LATEST_VERSION } from '../src/db/schema.ts'
import { migrate, openDatabase, openMemoryDatabase, readSchemaVersion } from '../src/db/open.ts'
import { DB_PATH_ENV_VAR, databasePath } from '../src/db/paths.ts'
import { SCHEMA_VERSION } from '../src/config/constants.ts'

test('brings a fresh database up to the latest schema version', () => {
  const db = openMemoryDatabase()
  assert.equal(readSchemaVersion(db), LATEST_VERSION)
  db.close()
})

test('applies migrations only once', () => {
  const db = openMemoryDatabase()
  const before = readSchemaVersion(db)
  assert.equal(migrate(db), before)
  db.close()
})

test('refuses a database written by a newer build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-schema-'))
  const path = join(dir, 'bita.db')
  const db = openDatabase(path)
  db.exec(`PRAGMA user_version = ${LATEST_VERSION + 9}`)
  db.close()

  assert.throws(() => openDatabase(path), /newer version/)
  rmSync(dir, { recursive: true, force: true })
})

test('enforces foreign keys so a link cannot outlive its entry', () => {
  const db = openMemoryDatabase()
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO jira_links (entry_id, issue_key, linked_at) VALUES (?, ?, ?)')
        .run(999, 'DD-1', '2026-09-19T00:00:00.000Z'),
    /FOREIGN KEY/i,
  )
  db.close()
})

test('rejects an entry that stops before it starts', () => {
  const db = openMemoryDatabase()
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO entries (description, started_at, stopped_at, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'backwards',
          '2026-09-19T10:00:00.000Z',
          '2026-09-19T09:00:00.000Z',
          'manual',
          '2026-09-19T10:00:00.000Z',
          '2026-09-19T10:00:00.000Z',
        ),
    /CHECK/i,
  )
  db.close()
})

test('replaces the dead notes table with one that points at documents', () => {
  const db = openMemoryDatabase()
  assert.ok(LATEST_VERSION >= 4)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name)

  assert.equal(tables.includes('notes'), false)
  assert.equal(tables.includes('entry_docs'), true)
  db.close()
})

test('the page tables arrive without disturbing entry_docs', () => {
  const db = openMemoryDatabase()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name)

  assert.equal(tables.includes('doc_pages'), true)
  assert.equal(tables.includes('page_entries'), true)
  assert.equal(tables.includes('page_issues'), true)
  assert.equal(tables.includes('entry_docs'), true)
  db.close()
})

test('the JSON envelope version is not the schema version', () => {
  assert.equal(SCHEMA_VERSION, 3)
})

test('reads the database location from the environment', () => {
  assert.equal(databasePath({ [DB_PATH_ENV_VAR]: '/tmp/custom.db' }), '/tmp/custom.db')
  assert.equal(databasePath({ XDG_DATA_HOME: '/data' }), '/data/bita/bita.db')
})

test('version 9 adds a nullable kind to every entry, existing ones included', () => {
  const db = openMemoryDatabase()
  const columns = db.prepare('PRAGMA table_info(entries)').all() as { name: string; notnull: number }[]
  const kind = columns.find((column) => column.name === 'kind')
  assert.ok(kind)
  assert.equal(kind.notnull, 0)
  assert.ok(LATEST_VERSION >= 9)
  db.close()
})
