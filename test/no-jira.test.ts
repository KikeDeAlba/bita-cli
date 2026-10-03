import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { findProjectById, insertProject, listProjects, setProjectJira } from '../src/db/projects.ts'
import { editBacklogItem, findBacklogItemByRef, insertBacklogItem } from '../src/db/backlog.ts'
import { insertPage } from '../src/db/pages.ts'
import { linkEntryToPage, meetingsOfPage } from '../src/db/page-links.ts'
import { collectEntries } from '../src/cli/collect.ts'
import { parseCommandArgs } from '../src/cli/args.ts'
import { groupEntries } from '../src/domain/group.ts'
import { partitionByJira, summarizeNonJira } from '../src/domain/no-jira.ts'
import { makeEntry, TEST_TZ } from './helpers/entries.ts'

const NOW = '2026-10-03T12:00:00.000Z'

function seed() {
  const db = openMemoryDatabase()
  const jira = insertProject(db, { name: 'Dportenis', createdAt: NOW })
  const pet = insertProject(db, { name: 'Can Doo with Pet', jira: false, createdAt: NOW })
  const entry = (projectId: number, description: string, start: string, end: string) =>
    insertEntry(db, { description, projectId, startedAt: start, stoppedAt: end, source: 'timer', now: NOW })
  entry(jira.id, 'cupones de recompra', '2026-10-03T15:00:00.000Z', '2026-10-03T16:00:00.000Z')
  entry(pet.id, 'sitio de Can Doo', '2026-10-03T16:00:00.000Z', '2026-10-03T17:30:00.000Z')
  return { db, jira, pet }
}

function collect(db: ReturnType<typeof openMemoryDatabase>, argv: string[]) {
  return collectEntries(
    { db, timezone: TEST_TZ, beginningOfWeek: 1, now: new Date(NOW) },
    parseCommandArgs([...argv, '--from', '2026-10-03', '--to', '2026-10-03'], {}),
    { includeRunning: false, requireDescription: true, requireProject: false },
  )
}

test('projects go to Jira unless they are created or switched off', () => {
  const { db, jira, pet } = seed()
  assert.equal(jira.jira, true)
  assert.equal(pet.jira, false)
  setProjectJira(db, jira.id, false)
  setProjectJira(db, pet.id, true)
  assert.equal(findProjectById(db, jira.id)?.jira, false)
  assert.deepEqual(
    listProjects(db).map((project) => [project.name, project.jira]),
    [
      ['Can Doo with Pet', true],
      ['Dportenis', false],
    ],
  )
  db.close()
})

test('pending entries of a project outside Jira are set apart, never selected', () => {
  const { db } = seed()
  const pending = collect(db, ['--pending'])
  assert.deepEqual(pending.selected.map((entry) => entry.description), ['cupones de recompra'])
  assert.deepEqual(pending.nonJira.map((entry) => entry.description), ['sitio de Can Doo'])
  assert.equal(pending.excluded.length, 0)

  const all = collect(db, [])
  assert.equal(all.selected.length, 2)
  assert.equal(all.nonJira.length, 0)
  const { jira, nonJira } = partitionByJira(all.selected)
  assert.equal(jira.length, 1)
  assert.equal(nonJira.length, 1)
  db.close()
})

test('groups outside Jira carry no estimate', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, description: 'cupones', durationSeconds: 3000 }),
      makeEntry({ id: 2, description: 'sitio', durationSeconds: 3000, projectId: 3, projectName: 'Can Doo with Pet', jira: false }),
    ],
    { timezone: TEST_TZ },
  )
  const byJira = new Map(groups.map((group) => [group.jira, group]))
  assert.equal(byJira.get(true)?.estimateSeconds, 3600)
  assert.equal(byJira.get(false)?.estimateSeconds, 0)
})

test('the outside-Jira summary adds up per project', () => {
  const summary = summarizeNonJira([
    makeEntry({ id: 1, durationSeconds: 1800, projectId: 3, projectName: 'Can Doo with Pet', jira: false }),
    makeEntry({ id: 2, durationSeconds: 3600, projectId: 3, projectName: 'Can Doo with Pet', jira: false }),
  ])
  assert.equal(summary.entryCount, 2)
  assert.equal(summary.totalSeconds, 5400)
  assert.deepEqual(summary.projects.map((project) => [project.name, project.totalSeconds]), [['Can Doo with Pet', 5400]])
})

test('moving a backlog item to another project gives it that project key', () => {
  const { db, jira } = seed()
  const loose = insertBacklogItem(db, { projectId: null, kind: 'pending', title: 'Confirmar la cola', now: NOW })
  assert.equal(loose.key, 'BL-1')
  insertBacklogItem(db, { projectId: jira.id, kind: 'pending', title: 'Ya existía', now: NOW })
  assert.equal(editBacklogItem(db, loose.id, { projectId: jira.id }, NOW), true)
  const moved = findBacklogItemByRef(db, `${jira.key}-2`)
  assert.equal(moved?.title, 'Confirmar la cola')
  assert.equal(editBacklogItem(db, loose.id, { projectId: jira.id }, NOW), false)
  db.close()
})

test('a page lists the meetings among its entries', () => {
  const { db, jira } = seed()
  const meeting = insertEntry(db, {
    description: 'Reunión presencial',
    projectId: jira.id,
    startedAt: '2026-10-03T18:00:00.000Z',
    stoppedAt: '2026-10-03T18:56:00.000Z',
    source: 'timer',
    kind: 'in-person-meeting',
    now: NOW,
  })
  const pageId = insertPage(db, {
    projectId: jira.id,
    parentId: null,
    slug: 'recompra',
    title: 'Recompra',
    relPath: 'dportenis/recompra.md',
    depth: 0,
    source: 'cli',
    now: NOW,
  })
  linkEntryToPage(db, pageId, meeting.id, '', NOW)
  linkEntryToPage(db, pageId, 1, '', NOW)
  assert.deepEqual(meetingsOfPage(db, pageId), [
    {
      entryId: meeting.id,
      kind: 'in-person-meeting',
      startedAt: '2026-10-03T18:00:00.000Z',
      stoppedAt: '2026-10-03T18:56:00.000Z',
      durationSeconds: 3360,
    },
  ])
  db.close()
})
