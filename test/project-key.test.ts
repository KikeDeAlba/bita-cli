import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { migrate, openMemoryDatabase, readSchemaVersion } from '../src/db/open.ts'
import { LATEST_VERSION, MIGRATIONS } from '../src/db/schema.ts'
import { deriveProjectKey, projectKeyCandidates } from '../src/db/project-keys.ts'
import { findProjectById, insertProject, renameProject } from '../src/db/projects.ts'
import { resolveProjectArg } from '../src/cli/project-arg.ts'

const NOW = '2026-09-28T10:00:00.000Z'

test('the latest schema carries the backlog keys', () => {
  assert.ok(LATEST_VERSION >= 8)
})

test('derives a key from the acronym, the initials or the first letters of the name', () => {
  const none = new Set<string>()
  assert.equal(deriveProjectKey('Pharma STI', none), 'STI')
  assert.equal(deriveProjectKey('Venta Asistida - Dportenis', none), 'VAD')
  assert.equal(deriveProjectKey('Recomendador', none), 'REC')
  assert.equal(deriveProjectKey("Daily's", none), 'DAI')
  assert.equal(deriveProjectKey('Facturación', none), 'FAC')
  assert.equal(deriveProjectKey('dp-dashboard', none), 'DD')
})

test('moves on to the next candidate, then to a numeric suffix, when a key is taken', () => {
  assert.equal(deriveProjectKey('STI Retail', new Set(['STI'])), 'STIR')
  assert.equal(deriveProjectKey('VivaFan', new Set(['VIV', 'VIVA'])), 'VIV2')
  assert.equal(deriveProjectKey('!!!', new Set()), 'PRJ')
})

test('never proposes the key reserved for items without a project', () => {
  assert.ok(!projectKeyCandidates('BL').includes('BL'))
})

test('a new project gets a key, and renaming it keeps the key', () => {
  const db = openMemoryDatabase()
  const project = insertProject(db, { name: 'Pharma STI', createdAt: NOW })
  assert.equal(project.key, 'STI')
  renameProject(db, project.id, 'Pharma STI Retail')
  assert.equal(findProjectById(db, project.id)?.key, 'STI')
  db.close()
})

test('a project is found by its key as well as by id and name', () => {
  const db = openMemoryDatabase()
  const sti = insertProject(db, { name: 'Pharma STI', createdAt: NOW })
  assert.equal(resolveProjectArg(db, 'sti').id, sti.id)
  assert.equal(resolveProjectArg(db, String(sti.id)).id, sti.id)
  assert.equal(resolveProjectArg(db, 'Pharma STI').id, sti.id)
  db.close()
})

test('migrating a v7 database gives every project a key and numbers its items in order', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 7)) {
    for (const statement of migration.statements) db.exec(statement)
  }
  db.exec('PRAGMA user_version = 7')

  const project = db.prepare('INSERT INTO projects (id, name, active, created_at) VALUES (?, ?, 1, ?)')
  project.run(10, 'STI Retail', NOW)
  project.run(20, 'Pharma STI', NOW)
  const item = db.prepare(
    `INSERT INTO backlog_items (project_id, kind, title, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)`,
  )
  item.run(20, 'a', NOW, NOW)
  item.run(20, 'b', NOW, NOW)
  item.run(10, 'c', NOW, NOW)

  assert.equal(migrate(db), LATEST_VERSION)
  assert.equal(readSchemaVersion(db), LATEST_VERSION)
  assert.equal(findProjectById(db, 20)?.key, 'STI')
  assert.equal(findProjectById(db, 10)?.key, 'STIR')
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM backlog_items').get()?.['total'], 3)
  assert.throws(() => db.prepare("UPDATE projects SET key = 'sti' WHERE id = 10").run(), /UNIQUE/)
  db.close()
})
