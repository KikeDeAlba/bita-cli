import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LATEST_VERSION, MIGRATIONS } from '../src/db/schema.ts'
import { DatabaseSync } from 'node:sqlite'
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
  if (process.platform !== 'win32') assert.equal(databasePath({ XDG_DATA_HOME: '/data' }), '/data/bita/bita.db')
  else assert.equal(databasePath({ LOCALAPPDATA: 'C:\\Data' }), 'C:\\Data\\bita\\bita.db')
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

test('version 14 links sessions to entries, checks their states and cascades on delete', () => {
  const db = openMemoryDatabase()
  const at = '2026-10-20T10:00:00.000Z'
  const entry = Number(
    db
      .prepare(`INSERT INTO entries (description, started_at, source, created_at, updated_at) VALUES ('', ?, 'session', ?, ?)`)
      .run(at, at, at).lastInsertRowid,
  )
  const insert = db.prepare(
    `INSERT INTO entry_sessions (entry_id, wrapper_id, wrapper_pid, harness, cwd, started_at, ended_at, finalized_at, outcome)
     VALUES (?, 'w', 1, ?, '/tmp', ?, ?, ?, ?)`,
  )
  assert.throws(() => insert.run(entry, 'cursor', at, null, null, null), /CHECK/)
  assert.throws(() => insert.run(entry, 'claude', at, '2026-10-20T09:00:00.000Z', null, null), /CHECK/)
  assert.throws(() => insert.run(entry, 'claude', at, null, at, null), /CHECK/)
  assert.throws(() => insert.run(entry, 'claude', at, null, at, 'lost'), /CHECK/)
  assert.throws(() => insert.run(999, 'claude', at, null, null, null), /FOREIGN KEY/i)
  insert.run(entry, 'claude', at, null, null, null)
  assert.throws(() => insert.run(entry, 'codex', at, null, null, null), /UNIQUE/)

  db.prepare('DELETE FROM entries WHERE id = ?').run(entry)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entry_sessions').get() as { n: number }).n, 0)
  db.close()
})

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break
    for (const statement of migration.statements) db.exec(statement)
    migration.run?.(db)
    db.exec(`PRAGMA user_version = ${migration.version}`)
  }
  return db
}

test('version 15 lets antigravity sessions in and keeps the sessions already recorded', () => {
  const db = databaseAt(14)
  const at = '2026-10-20T10:00:00.000Z'
  const end = '2026-10-20T11:00:00.000Z'
  const entry = (description: string) =>
    Number(
      db
        .prepare(`INSERT INTO entries (description, started_at, source, created_at, updated_at) VALUES (?, ?, 'session', ?, ?)`)
        .run(description, at, at, at).lastInsertRowid,
    )
  const first = entry('one')
  const second = entry('two')
  const third = entry('three')
  const insert = db.prepare(
    `INSERT INTO entry_sessions (entry_id, wrapper_id, wrapper_pid, harness, session_id, transcript_path, cwd, started_at, ended_at, end_reason, finalized_at, outcome, error)
     VALUES (?, ?, 42, ?, ?, ?, '/repo', ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(first, 'w1', 'claude', 's1', '/t/s1.jsonl', at, end, 'exit', end, 'summarized', null)
  insert.run(second, 'w2', 'gemini', null, null, at, null, null, null, null, null)
  assert.throws(() => insert.run(third, 'w3', 'antigravity', null, null, at, null, null, null, null, null), /CHECK/)
  const before = db.prepare('SELECT * FROM entry_sessions ORDER BY id').all()

  assert.equal(migrate(db), LATEST_VERSION)
  assert.ok(LATEST_VERSION >= 15)
  assert.deepEqual(db.prepare('SELECT * FROM entry_sessions ORDER BY id').all(), before)
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entry_sessions' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((row) => row.name)
  assert.deepEqual(indexes, ['entry_sessions_open', 'entry_sessions_session', 'entry_sessions_wrapper'])
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'entry_sessions_next'").get() as { n: number }).n, 0)

  insert.run(third, 'w3', 'antigravity', 'conv', null, at, null, null, null, null, null)
  const row = db.prepare('SELECT id, harness FROM entry_sessions WHERE entry_id = ?').get(third) as { id: number; harness: string }
  assert.equal(row.harness, 'antigravity')
  assert.ok(row.id > 2)
  assert.throws(() => insert.run(entry('four'), 'w4', 'cursor', null, null, at, null, null, null, null, null), /CHECK/)
  assert.throws(() => insert.run(third, 'w5', 'claude', null, null, at, null, null, null, null, null), /UNIQUE/)
  db.prepare('DELETE FROM entries WHERE id = ?').run(first)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entry_sessions WHERE entry_id = ?').get(first) as { n: number }).n, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('version 16 lets a session have no entry and keeps the sessions already recorded', () => {
  const db = databaseAt(15)
  const at = '2026-10-20T10:00:00.000Z'
  const end = '2026-10-20T11:00:00.000Z'
  const entry = (description: string) =>
    Number(
      db
        .prepare(`INSERT INTO entries (description, started_at, source, created_at, updated_at) VALUES (?, ?, 'session', ?, ?)`)
        .run(description, at, at, at).lastInsertRowid,
    )
  const first = entry('one')
  const second = entry('two')
  const insert = db.prepare(
    `INSERT INTO entry_sessions (entry_id, wrapper_id, wrapper_pid, harness, session_id, transcript_path, cwd, started_at, ended_at, end_reason, finalized_at, outcome, error)
     VALUES (?, ?, 42, ?, ?, ?, '/repo', ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(first, 'w1', 'claude', 's1', '/t/s1.jsonl', at, end, 'exit', end, 'summarized', null)
  insert.run(second, 'w2', 'antigravity', null, null, at, null, null, null, null, null)
  assert.throws(() => insert.run(null, 'w3', 'codex', null, null, at, null, null, null, null, null), /NOT NULL/)
  const before = db.prepare('SELECT * FROM entry_sessions ORDER BY id').all()

  assert.equal(migrate(db), LATEST_VERSION)
  assert.ok(LATEST_VERSION >= 16)
  assert.deepEqual(db.prepare('SELECT * FROM entry_sessions ORDER BY id').all(), before)
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entry_sessions' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((row) => row.name)
  assert.deepEqual(indexes, ['entry_sessions_open', 'entry_sessions_session', 'entry_sessions_wrapper'])
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'entry_sessions_next'").get() as { n: number }).n, 0)

  insert.run(null, 'w3', 'codex', 'free-1', null, at, null, null, null, null, null)
  insert.run(null, 'w4', 'gemini', null, null, at, null, null, null, null, null)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entry_sessions WHERE entry_id IS NULL').get() as { n: number }).n, 2)
  assert.throws(() => insert.run(second, 'w5', 'claude', null, null, at, null, null, null, null, null), /UNIQUE/)
  assert.throws(() => insert.run(null, 'w6', 'cursor', null, null, at, null, null, null, null, null), /CHECK/)
  db.prepare('DELETE FROM entries WHERE id = ?').run(first)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entry_sessions WHERE entry_id = ?').get(first) as { n: number }).n, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})
