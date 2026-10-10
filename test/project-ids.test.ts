import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { deleteProject, insertProject } from '../src/db/projects.ts'

const NOW = '2026-10-10T12:00:00.000Z'

test('a deleted project id is never handed out again', () => {
  const db = openMemoryDatabase()
  const first = insertProject(db, { name: 'Uno', createdAt: NOW })
  const second = insertProject(db, { name: 'Dos', createdAt: NOW })
  assert.deepEqual([first.id, second.id], [1, 2])
  assert.equal(deleteProject(db, second.id), true)
  const third = insertProject(db, { name: 'Tres', createdAt: NOW })
  assert.equal(third.id, 3)
  assert.equal(deleteProject(db, third.id), true)
  assert.equal(deleteProject(db, first.id), true)
  assert.equal(insertProject(db, { name: 'Cuatro', createdAt: NOW }).id, 4)
})

test('explicit and external ids keep working', () => {
  const db = openMemoryDatabase()
  const imported = insertProject(db, { id: 200_000_000, name: 'Importado', createdAt: NOW })
  assert.equal(imported.id, 200_000_000)
  assert.equal(insertProject(db, { name: 'Local', createdAt: NOW }).id, 1)
})
