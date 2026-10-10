import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDatabase } from '../src/db/open.ts'
import {
  findEntryWithProject,
  insertEntry,
  listEntriesStartedBetween,
  listSegments,
  updateEntry,
} from '../src/db/entries.ts'
import { insertProject } from '../src/db/projects.ts'
import { listTouches, recordTouch } from '../src/db/touches.ts'
import { applyMerge, planMerge, type MergeContext } from '../src/cli/commands/merge.ts'
import { applyDeletions, assertPlanIsSafe, planDeletions } from '../src/cli/commands/delete.ts'
import { collapseSegments } from '../src/cli/logical-entry.ts'
import { enrichEntries } from '../src/domain/enrich.ts'

const NOW = '2026-09-27T20:00:00.000Z'
const TEST_TZ = 'America/Mazatlan'

function context(db: DatabaseSync): MergeContext {
  return { db, timezone: TEST_TZ, now: new Date(NOW) }
}

function seed(
  db: DatabaseSync,
  description: string,
  startedAt: string,
  minutes: number,
  projectId: number | null = 1,
  running = false,
) {
  return insertEntry(db, {
    description,
    projectId,
    startedAt,
    stoppedAt: running ? null : new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
    source: 'timer',
    now: NOW,
  })
}

function project(db: DatabaseSync, id: number, name: string): void {
  insertProject(db, { id, name, createdAt: NOW })
}

test('merging keeps every block as a segment of the oldest entry', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const first = seed(db, 'Remediación auth', '2026-09-27T15:00:00.000Z', 40)
  const second = seed(db, 'auth admin', '2026-09-27T16:00:00.000Z', 30)
  const third = seed(db, '', '2026-09-27T17:00:00.000Z', 20)

  const plan = planMerge(context(db), { ids: [third.id, second.id, first.id] })
  assert.equal(plan.targetId, first.id)
  assert.equal(plan.title, 'Remediación auth')
  assert.equal(plan.totalSeconds, 90 * 60)
  assert.deepEqual(plan.segments.map((segment) => segment.id), [first.id, second.id, third.id])

  const outcome = applyMerge(context(db), plan)
  assert.deepEqual(outcome.segmentIds, [second.id, third.id])
  assert.equal(findEntryWithProject(db, third.id)?.description, 'Remediación auth')
  assert.equal(findEntryWithProject(db, third.id)?.mergedInto, first.id)
  db.close()
})

test('entries collapse the merged blocks into one logical entry', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const first = seed(db, 'Remediación auth', '2026-09-27T15:00:00.000Z', 40)
  const second = seed(db, 'otra cosa', '2026-09-27T16:00:00.000Z', 30)
  applyMerge(context(db), planMerge(context(db), { ids: [first.id, second.id] }))

  const rows = listEntriesStartedBetween(db, '2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
  const enriched = enrichEntries(rows, TEST_TZ, new Date(NOW))

  const collapsed = collapseSegments(enriched)
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0]?.durationSeconds, 70 * 60)
  assert.equal(collapsed[0]?.segments.length, 2)
  db.close()
})

test('touches move to the survivor, keeping the earliest sighting', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const first = seed(db, 'Remediación auth', '2026-09-27T15:00:00.000Z', 40)
  const second = seed(db, 'Remediación auth', '2026-09-27T16:00:00.000Z', 30)
  recordTouch(db, first.id, '/repo/a.ts', '2026-09-27T15:10:00.000Z')
  recordTouch(db, second.id, '/repo/a.ts', '2026-09-27T15:05:00.000Z')
  recordTouch(db, second.id, '/repo/b.ts', '2026-09-27T16:10:00.000Z')

  const plan = planMerge(context(db), { ids: [first.id, second.id] })
  assert.equal(plan.touchedFiles, 2)
  const outcome = applyMerge(context(db), plan)

  assert.equal(outcome.touchesMoved, 2)
  assert.deepEqual(listTouches(db, first.id).sort(), ['/repo/a.ts', '/repo/b.ts'])
  assert.deepEqual(listTouches(db, second.id), [])
  db.close()
})

test('merging a merged entry flattens its blocks into the new survivor', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const a = seed(db, 'A', '2026-09-27T15:00:00.000Z', 10)
  const b = seed(db, 'B', '2026-09-27T16:00:00.000Z', 10)
  const c = seed(db, 'C', '2026-09-27T17:00:00.000Z', 10)
  applyMerge(context(db), planMerge(context(db), { ids: [b.id, c.id] }))

  const plan = planMerge(context(db), { ids: [a.id, b.id], title: 'Todo junto' })
  assert.equal(plan.segments.length, 3)
  applyMerge(context(db), plan)

  assert.deepEqual(listSegments(db, a.id).map((row) => row.id), [b.id, c.id])
  assert.equal(findEntryWithProject(db, c.id)?.description, 'Todo junto')
  db.close()
})

test('renaming the survivor renames its blocks, so they keep grouping together', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const a = seed(db, 'A', '2026-09-27T15:00:00.000Z', 10)
  const b = seed(db, 'B', '2026-09-27T16:00:00.000Z', 10)
  applyMerge(context(db), planMerge(context(db), { ids: [a.id, b.id] }))

  updateEntry(db, a.id, { description: 'Renombrado' }, NOW)
  assert.equal(findEntryWithProject(db, b.id)?.description, 'Renombrado')
  db.close()
})

test('running, already merged and cross-project entries are refused; legacy jira links are not', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  project(db, 2, 'Pharma')
  const a = seed(db, 'A', '2026-09-27T15:00:00.000Z', 10)
  const b = seed(db, 'B', '2026-09-27T16:00:00.000Z', 10)
  const running = seed(db, 'R', '2026-09-27T17:00:00.000Z', 0, 1, true)
  const registered = seed(db, 'J', '2026-09-27T14:00:00.000Z', 10)
  const elsewhere = seed(db, 'P', '2026-09-27T13:00:00.000Z', 10, 2)
  db.prepare('INSERT INTO jira_links (entry_id, issue_key, linked_at) VALUES (?, ?, ?)').run(registered.id, 'VBAA-1', NOW)

  assert.throws(() => planMerge(context(db), { ids: [a.id] }), /at least two/)
  assert.throws(() => planMerge(context(db), { ids: [a.id, running.id] }), /still running/)
  assert.equal(planMerge(context(db), { ids: [a.id, registered.id] }).segments.length, 2)
  assert.throws(() => planMerge(context(db), { ids: [a.id, elsewhere.id] }), /different projects/)
  assert.equal(planMerge(context(db), { ids: [a.id, elsewhere.id], projectId: 2 }).projectId, 2)

  applyMerge(context(db), planMerge(context(db), { ids: [a.id, b.id] }))
  assert.throws(() => planMerge(context(db), { ids: [b.id, elsewhere.id] }), /already part of/)
  db.close()
})

test('deleting a block is refused, deleting the survivor takes every block', () => {
  const db = openMemoryDatabase()
  project(db, 1, 'Apartados')
  const a = seed(db, 'A', '2026-09-27T15:00:00.000Z', 10)
  const b = seed(db, 'B', '2026-09-27T16:00:00.000Z', 20)
  applyMerge(context(db), planMerge(context(db), { ids: [a.id, b.id] }))

  const ctx = { db, timezone: TEST_TZ, now: new Date(NOW) }
  assert.throws(() => assertPlanIsSafe(planDeletions(ctx, [b.id])), /merged entry/)

  const plan = planDeletions(ctx, [a.id])
  assert.equal(plan.targets[0]?.durationSeconds, 30 * 60)
  applyDeletions(db, plan.targets)
  assert.equal(findEntryWithProject(db, b.id), undefined)
  db.close()
})
