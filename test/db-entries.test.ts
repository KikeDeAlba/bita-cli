import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import {
  countRunning,
  deleteEntry,
  findEntryByExternalId,
  insertEntry,
  listEntriesStartedBetween,
  listPendingEntries,
  listRunning,
  stopEntry,
  updateEntry,
} from '../src/db/entries.ts'
import { insertProject, listProjects, nextLocalProjectId } from '../src/db/projects.ts'
import { findLink, linkEntry, unlinkEntry } from '../src/db/jira-links.ts'

const NOW = '2026-09-19T12:00:00.000Z'

function seedProject(db: ReturnType<typeof openMemoryDatabase>, name = 'Pharma STI') {
  return insertProject(db, { name, createdAt: NOW })
}

test('keeps several timers running at once', () => {
  const db = openMemoryDatabase()
  const project = seedProject(db)

  insertEntry(db, {
    description: 'deploy',
    projectId: project.id,
    startedAt: '2026-09-19T10:00:00.000Z',
    source: 'timer',
    now: NOW,
  })
  insertEntry(db, {
    description: 'code review',
    projectId: project.id,
    startedAt: '2026-09-19T10:30:00.000Z',
    source: 'timer',
    now: NOW,
  })

  assert.equal(countRunning(db), 2)
  const running = listRunning(db)
  assert.deepEqual(
    running.map((entry) => entry.description),
    ['deploy', 'code review'],
  )
  assert.equal(running[0]?.projectName, 'Pharma STI')
  db.close()
})

test('stops one timer without touching the others', () => {
  const db = openMemoryDatabase()
  const project = seedProject(db)
  const first = insertEntry(db, {
    description: 'deploy',
    projectId: project.id,
    startedAt: '2026-09-19T10:00:00.000Z',
    source: 'timer',
    now: NOW,
  })
  insertEntry(db, {
    description: 'code review',
    projectId: project.id,
    startedAt: '2026-09-19T10:30:00.000Z',
    source: 'timer',
    now: NOW,
  })

  assert.equal(stopEntry(db, first.id, '2026-09-19T11:00:00.000Z', NOW), true)
  assert.equal(countRunning(db), 1)
  assert.equal(listRunning(db)[0]?.description, 'code review')
  db.close()
})

test('reports nothing changed when stopping an entry that already stopped', () => {
  const db = openMemoryDatabase()
  const entry = insertEntry(db, {
    description: 'deploy',
    projectId: null,
    startedAt: '2026-09-19T10:00:00.000Z',
    stoppedAt: '2026-09-19T11:00:00.000Z',
    source: 'manual',
    now: NOW,
  })
  assert.equal(stopEntry(db, entry.id, '2026-09-19T12:00:00.000Z', NOW), false)
  db.close()
})

test('treats an entry without a jira link as pending', () => {
  const db = openMemoryDatabase()
  const project = seedProject(db)
  const pending = insertEntry(db, {
    description: 'pending work',
    projectId: project.id,
    startedAt: '2026-09-19T10:00:00.000Z',
    stoppedAt: '2026-09-19T11:00:00.000Z',
    source: 'manual',
    now: NOW,
  })
  const registered = insertEntry(db, {
    description: 'registered work',
    projectId: project.id,
    startedAt: '2026-09-18T10:00:00.000Z',
    stoppedAt: '2026-09-18T11:00:00.000Z',
    source: 'manual',
    now: NOW,
  })
  linkEntry(db, { entryId: registered.id, issueKey: 'DD-1896', linkedAt: NOW })

  const ids = listPendingEntries(db).map((entry) => entry.id)
  assert.deepEqual(ids, [pending.id])

  assert.equal(findLink(db, registered.id)?.issueKey, 'DD-1896')
  assert.equal(unlinkEntry(db, registered.id), true)
  assert.equal(listPendingEntries(db).length, 2)
  db.close()
})

test('drops the jira link when its entry is deleted', () => {
  const db = openMemoryDatabase()
  const entry = insertEntry(db, {
    description: 'work',
    projectId: null,
    startedAt: '2026-09-19T10:00:00.000Z',
    stoppedAt: '2026-09-19T11:00:00.000Z',
    source: 'manual',
    now: NOW,
  })
  linkEntry(db, { entryId: entry.id, issueKey: 'DD-1', linkedAt: NOW })
  assert.equal(deleteEntry(db, entry.id), true)
  assert.equal(findLink(db, entry.id), undefined)
  db.close()
})

test('selects entries by the instant they started', () => {
  const db = openMemoryDatabase()
  for (const startedAt of [
    '2026-09-17T10:00:00.000Z',
    '2026-09-18T10:00:00.000Z',
    '2026-09-19T10:00:00.000Z',
  ]) {
    insertEntry(db, {
      description: 'work',
      projectId: null,
      startedAt,
      stoppedAt: '2026-09-19T23:00:00.000Z',
      source: 'manual',
      now: NOW,
    })
  }
  const found = listEntriesStartedBetween(db, '2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z')
  assert.equal(found.length, 1)
  assert.equal(found[0]?.startedAt, '2026-09-18T10:00:00.000Z')
  db.close()
})

test('edits only the fields it is given', () => {
  const db = openMemoryDatabase()
  const entry = insertEntry(db, {
    description: 'old title',
    projectId: null,
    startedAt: '2026-09-19T10:00:00.000Z',
    stoppedAt: '2026-09-19T11:00:00.000Z',
    source: 'manual',
    now: NOW,
  })
  assert.equal(updateEntry(db, entry.id, { description: 'new title' }, NOW), true)
  assert.equal(updateEntry(db, entry.id, {}, NOW), false)

  const [updated] = listEntriesStartedBetween(
    db,
    '2026-09-19T00:00:00.000Z',
    '2026-09-20T00:00:00.000Z',
  )
  assert.equal(updated?.description, 'new title')
  assert.equal(updated?.stoppedAt, '2026-09-19T11:00:00.000Z')
  db.close()
})

test('preserves an imported toggl id without letting it drive the local id', () => {
  const db = openMemoryDatabase()
  const imported = insertEntry(db, {
    description: 'imported work',
    projectId: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    stoppedAt: '2026-09-01T11:00:00.000Z',
    source: 'import',
    externalId: 3_912_447_881,
    now: NOW,
  })
  assert.equal(imported.id, 1)
  assert.equal(findEntryByExternalId(db, 3_912_447_881)?.id, imported.id)
  db.close()
})

test('keeps imported project ids and still hands out small ids to new projects', () => {
  const db = openMemoryDatabase()
  insertProject(db, { id: 213_456_789, name: 'Imported', externalId: 213_456_789, createdAt: NOW })
  assert.equal(nextLocalProjectId(db), 1)

  const local = insertProject(db, { name: 'Local', createdAt: NOW })
  assert.equal(local.id, 1)
  assert.deepEqual(
    listProjects(db).map((project) => project.name),
    ['Imported', 'Local'],
  )
  db.close()
})

test('normalises every stored instant to utc so range comparisons stay textual', () => {
  const db = openMemoryDatabase()
  const entry = insertEntry(db, {
    description: 'offset stamp',
    projectId: null,
    startedAt: '2026-09-19T08:34:44-07:00',
    stoppedAt: '2026-09-19T09:34:44-07:00',
    source: 'import',
    now: NOW,
  })

  assert.equal(entry.startedAt, '2026-09-19T15:34:44.000Z')
  assert.equal(entry.stoppedAt, '2026-09-19T16:34:44.000Z')

  const sameDay = listEntriesStartedBetween(
    db,
    '2026-09-19T00:00:00.000Z',
    '2026-09-20T00:00:00.000Z',
  )
  assert.deepEqual(
    sameDay.map((row) => row.id),
    [entry.id],
  )

  const beforeItStarted = listEntriesStartedBetween(
    db,
    '2026-09-19T00:00:00.000Z',
    '2026-09-19T10:00:00.000Z',
  )
  assert.deepEqual(beforeItStarted, [])
  db.close()
})

test('rejects an instant it cannot parse instead of storing it', () => {
  const db = openMemoryDatabase()
  assert.throws(
    () =>
      insertEntry(db, {
        description: 'broken',
        projectId: null,
        startedAt: 'yesterday afternoon',
        source: 'manual',
        now: NOW,
      }),
    /not a valid instant/,
  )
  db.close()
})

test('refuses two projects whose names differ only in case', () => {
  const db = openMemoryDatabase()
  insertProject(db, { name: 'Pharma STI', createdAt: NOW })
  assert.throws(() => insertProject(db, { name: 'pharma sti', createdAt: NOW }), /UNIQUE/i)
  db.close()
})

test('stores the kind of an entry, clears it and carries it to merged segments', () => {
  const db = openMemoryDatabase()
  const meeting = insertEntry(db, {
    description: 'sprint planning',
    projectId: null,
    startedAt: '2026-09-19T10:00:00.000Z',
    source: 'timer',
    kind: 'remote-meeting',
    now: NOW,
  })
  assert.equal(meeting.kind, 'remote-meeting')

  const plain = insertEntry(db, {
    description: 'deploy',
    projectId: null,
    startedAt: '2026-09-19T11:00:00.000Z',
    source: 'timer',
    now: NOW,
  })
  assert.equal(plain.kind, null)

  const segment = insertEntry(db, {
    description: 'sprint planning',
    projectId: null,
    startedAt: '2026-09-19T08:00:00.000Z',
    stoppedAt: '2026-09-19T09:00:00.000Z',
    source: 'timer',
    now: NOW,
  })
  db.prepare('UPDATE entries SET merged_into = ? WHERE id = ?').run(meeting.id, segment.id)

  updateEntry(db, meeting.id, { kind: 'in-person-meeting' }, NOW)
  const kinds = db.prepare('SELECT id, kind FROM entries ORDER BY id').all() as { id: number; kind: string | null }[]
  assert.deepEqual(
    kinds.map((row) => ({ ...row })),
    [
      { id: meeting.id, kind: 'in-person-meeting' },
      { id: plain.id, kind: null },
      { id: segment.id, kind: 'in-person-meeting' },
    ],
  )

  updateEntry(db, meeting.id, { kind: null }, NOW)
  assert.equal(listRunning(db).find((entry) => entry.id === meeting.id)?.kind, null)
  db.close()
})
