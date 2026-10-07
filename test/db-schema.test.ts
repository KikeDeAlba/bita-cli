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

test('version 10 lets a project stay out of Jira, every existing one in by default', () => {
  const db = openMemoryDatabase()
  const columns = db.prepare('PRAGMA table_info(projects)').all() as { name: string; dflt_value: string | null; notnull: number }[]
  const jira = columns.find((column) => column.name === 'jira')
  assert.ok(jira)
  assert.equal(jira.notnull, 1)
  assert.equal(jira.dflt_value, '1')
  assert.ok(LATEST_VERSION >= 10)
  db.close()
})

test('version 11 gives projects their Atlassian settings and maps pages to Confluence', () => {
  const db = openMemoryDatabase()
  const columns = db.prepare('PRAGMA table_info(projects)').all() as { name: string; dflt_value: string | null; notnull: number }[]
  const byName = new Map(columns.map((column) => [column.name, column]))
  assert.equal(byName.get('atlassian_via')?.dflt_value, "'mcp'")
  assert.equal(byName.get('sync_pull')?.dflt_value, '0')
  assert.equal(byName.get('sync_push')?.notnull, 1)
  assert.ok(byName.has('atlassian_site'))
  assert.ok(byName.has('confluence_ref'))
  assert.ok(byName.has('confluence_kind'))
  assert.ok(byName.has('last_sync_at'))
  assert.ok(LATEST_VERSION >= 11)

  const now = '2026-10-06T00:00:00.000Z'
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (1, 'P', ?)").run(now)
  assert.throws(() => db.prepare("UPDATE projects SET atlassian_via = 'rest' WHERE id = 1").run(), /CHECK/i)
  assert.throws(() => db.prepare("UPDATE projects SET confluence_kind = 'blog' WHERE id = 1").run(), /CHECK/i)

  db.prepare(
    "INSERT INTO doc_pages (id, project_id, slug, title, rel_path, source, created_at, recorded_at) VALUES (1, 1, 'a', 'A', 'p/a.md', 'cli', ?, ?)",
  ).run(now, now)
  const insert = db.prepare(
    `INSERT INTO confluence_page_map (page_id, site, confluence_id, confluence_version, local_checksum, state, synced_at)
     VALUES (?, 'https://x.atlassian.net', ?, 1, 'sha256:a', ?, ?)`,
  )
  insert.run(1, '100', 'synced', now)
  assert.throws(() => insert.run(1, '101', 'synced', now), /UNIQUE|PRIMARY/i)
  db.prepare("INSERT INTO doc_pages (id, project_id, slug, title, rel_path, source, created_at, recorded_at) VALUES (2, 1, 'b', 'B', 'p/b.md', 'cli', ?, ?)").run(now, now)
  assert.throws(() => insert.run(2, '100', 'synced', now), /UNIQUE/i)
  assert.throws(() => insert.run(2, '102', 'stale', now), /CHECK/i)
  db.prepare('DELETE FROM doc_pages WHERE id = 1').run()
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM confluence_page_map').get() as { n: number }).n, 0)
  db.close()
})
