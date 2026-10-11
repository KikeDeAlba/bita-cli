import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { insertProject } from '../src/db/projects.ts'
import { parseCommandArgs } from '../src/cli/args.ts'
import { applyMerge, planMerge } from '../src/cli/commands/merge.ts'
import { buildReport, type ReportOptions } from '../src/cli/commands/report.ts'

const NOW = '2026-09-27T20:00:00.000Z'
const TEST_TZ = 'America/Mazatlan'

function setup(): DatabaseSync {
  const db = openMemoryDatabase()
  insertProject(db, { id: 1, name: 'Apartados', clientName: 'Viva', createdAt: NOW })
  insertProject(db, { id: 2, name: 'CoDi', createdAt: NOW })
  return db
}

function seed(db: DatabaseSync, startedAt: string, minutes: number, projectId: number | null = 1, running = false) {
  return insertEntry(db, {
    description: `bloque ${startedAt}`,
    projectId,
    startedAt,
    stoppedAt: running ? null : new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
    source: 'timer',
    now: NOW,
  })
}

function report(db: DatabaseSync, argv: string[], options: ReportOptions = {}, beginningOfWeek = 1) {
  const ctx = { db, timezone: TEST_TZ, beginningOfWeek, now: new Date(NOW) }
  return buildReport(ctx, parseCommandArgs(argv, {}), options).data
}

test('every day of the range is present, the empty ones with zero', () => {
  const db = setup()
  seed(db, '2026-09-22T16:00:00.000Z', 60)
  seed(db, '2026-09-25T16:00:00.000Z', 30, 2)

  const data = report(db, ['--last-days', '7'])
  assert.deepEqual(data.range, { fromDay: '2026-09-21', toDay: '2026-09-27', timezone: TEST_TZ, weekStartsOn: 1 })
  assert.deepEqual(data.days.map((day) => day.day), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
  ])
  assert.deepEqual(data.days.map((day) => day.totalSeconds), [0, 3600, 0, 0, 1800, 0, 0])
  assert.deepEqual(data.days[0]?.projects, [])
  assert.equal(data.totalSeconds, 5400)
  assert.equal(data.entryCount, 2)
  assert.equal(data.activeDays, 2)
  assert.deepEqual(data.projects, [
    { projectId: 1, name: 'Apartados', clientName: 'Viva', totalSeconds: 3600, entryCount: 1 },
    { projectId: 2, name: 'CoDi', clientName: null, totalSeconds: 1800, entryCount: 1 },
  ])
  assert.equal(data.entries, undefined)
  db.close()
})

test('a merged entry across two days counts each block on its own day', () => {
  const db = setup()
  const first = seed(db, '2026-09-23T17:00:00.000Z', 60)
  const second = seed(db, '2026-09-24T17:00:00.000Z', 30)
  const ctx = { db, timezone: TEST_TZ, now: new Date(NOW) }
  applyMerge(ctx, planMerge(ctx, { ids: [first.id, second.id] }))

  const data = report(db, ['--last-days', '7'], { entries: true })
  const byDay = Object.fromEntries(data.days.map((day) => [day.day, day.totalSeconds]))
  assert.equal(byDay['2026-09-23'], 3600)
  assert.equal(byDay['2026-09-24'], 1800)
  assert.equal(data.entryCount, 1)
  assert.equal(data.projects[0]?.entryCount, 1)
  assert.equal(data.projects[0]?.totalSeconds, 5400)
  assert.deepEqual(
    data.entries?.map((entry) => [entry.id, entry.localDay, entry.seconds, entry.blockIds]),
    [
      [first.id, '2026-09-23', 3600, [first.id]],
      [first.id, '2026-09-24', 1800, [second.id]],
    ],
  )
  db.close()
})

test('weeks follow beginningOfWeek and are clipped to the range', () => {
  const db = setup()
  seed(db, '2026-09-21T16:00:00.000Z', 60)
  seed(db, '2026-09-27T16:00:00.000Z', 30, 2)
  const argv = ['--from', '2026-09-21', '--to', '2026-09-27']

  const monday = report(db, argv, {}, 1)
  assert.equal(monday.range.weekStartsOn, 1)
  assert.deepEqual(monday.weeks, [
    {
      fromDay: '2026-09-21',
      toDay: '2026-09-27',
      totalSeconds: 5400,
      projects: [
        { projectId: 1, seconds: 3600 },
        { projectId: 2, seconds: 1800 },
      ],
    },
  ])

  const sunday = report(db, argv, {}, 0)
  assert.equal(sunday.range.weekStartsOn, 0)
  assert.deepEqual(sunday.weeks, [
    { fromDay: '2026-09-21', toDay: '2026-09-26', totalSeconds: 3600, projects: [{ projectId: 1, seconds: 3600 }] },
    { fromDay: '2026-09-27', toDay: '2026-09-27', totalSeconds: 1800, projects: [{ projectId: 2, seconds: 1800 }] },
  ])
  db.close()
})

test('--project keeps only that project', () => {
  const db = setup()
  seed(db, '2026-09-22T16:00:00.000Z', 60)
  seed(db, '2026-09-22T18:00:00.000Z', 30, 2)
  seed(db, '2026-09-23T18:00:00.000Z', 15, null)

  const all = report(db, ['--last-days', '7'])
  assert.equal(all.projects.length, 3)
  assert.deepEqual(all.projects[2], { projectId: null, name: '(no project)', clientName: null, totalSeconds: 900, entryCount: 1 })

  const data = report(db, ['--last-days', '7'], { projectId: 2, entries: true })
  assert.equal(data.totalSeconds, 1800)
  assert.equal(data.entryCount, 1)
  assert.deepEqual(data.projects.map((project) => project.projectId), [2])
  assert.deepEqual(data.days.find((day) => day.day === '2026-09-22')?.projects, [{ projectId: 2, seconds: 1800 }])
  assert.deepEqual(data.entries?.map((entry) => entry.projectId), [2])
  db.close()
})

test('--entries lists each entry with its fields', () => {
  const db = setup()
  const entry = seed(db, '2026-09-22T16:00:00.000Z', 45)

  const data = report(db, ['week'], { entries: true })
  assert.deepEqual(data.entries, [
    {
      id: entry.id,
      title: 'bloque 2026-09-22T16:00:00.000Z',
      projectId: 1,
      start: '2026-09-22T16:00:00.000Z',
      stop: '2026-09-22T16:45:00.000Z',
      localDay: '2026-09-22',
      seconds: 2700,
      kind: null,
      overlapping: false,
      blockIds: [entry.id],
    },
  ])
  db.close()
})

test('overlaps are reported per day and entries are flagged', () => {
  const db = setup()
  const first = seed(db, '2026-09-22T16:00:00.000Z', 60)
  const second = seed(db, '2026-09-22T16:30:00.000Z', 60, 2)
  const alone = seed(db, '2026-09-22T20:00:00.000Z', 30, 2)

  const data = report(db, ['--last-days', '7'], { entries: true })
  assert.deepEqual(data.overlaps, [
    { localDay: '2026-09-22', trackedSeconds: 9000, clockSeconds: 7200, overlapSeconds: 1800 },
  ])
  const flags = Object.fromEntries(data.entries?.map((entry) => [entry.id, entry.overlapping]) ?? [])
  assert.deepEqual(flags, { [first.id]: true, [second.id]: true, [alone.id]: false })
  db.close()
})

test('a running timer counts up to now', () => {
  const db = setup()
  seed(db, '2026-09-27T19:00:00.000Z', 0, 1, true)

  const data = report(db, ['today'], { entries: true })
  assert.equal(data.totalSeconds, 3600)
  assert.equal(data.days[0]?.totalSeconds, 3600)
  assert.equal(data.entries?.[0]?.stop, null)
  db.close()
})

test('an overlap under a minute is neither reported nor flagged', () => {
  const db = setup()
  seed(db, '2026-09-22T16:00:00.000Z', 60)
  seed(db, '2026-09-22T16:59:30.000Z', 30, 2)

  const data = report(db, ['--last-days', '7'], { entries: true })
  assert.deepEqual(data.overlaps, [])
  assert.ok(data.entries?.every((entry) => !entry.overlapping))
  db.close()
})

test('with --project the overlaps still see the whole day', () => {
  const db = setup()
  seed(db, '2026-09-22T16:00:00.000Z', 60)
  const codi = seed(db, '2026-09-22T16:30:00.000Z', 60, 2)

  const data = report(db, ['--last-days', '7'], { projectId: 2, entries: true })
  assert.deepEqual(data.overlaps, [
    { localDay: '2026-09-22', trackedSeconds: 7200, clockSeconds: 5400, overlapSeconds: 1800 },
  ])
  assert.deepEqual(data.entries?.map((entry) => [entry.id, entry.overlapping]), [[codi.id, true]])
  db.close()
})

test('only the day of a merged entry that overlaps is flagged', () => {
  const db = setup()
  const first = seed(db, '2026-09-22T16:00:00.000Z', 60)
  const second = seed(db, '2026-09-23T16:00:00.000Z', 60)
  seed(db, '2026-09-23T16:30:00.000Z', 60, 2)
  const ctx = { db, timezone: TEST_TZ, now: new Date(NOW) }
  applyMerge(ctx, planMerge(ctx, { ids: [first.id, second.id] }))

  const data = report(db, ['--last-days', '7'], { entries: true })
  const merged = data.entries?.filter((entry) => entry.id === first.id).map((entry) => [entry.localDay, entry.overlapping])
  assert.deepEqual(merged, [
    ['2026-09-22', false],
    ['2026-09-23', true],
  ])
  db.close()
})
