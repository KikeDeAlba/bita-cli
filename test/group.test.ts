import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupEntries } from '../src/domain/group.ts'
import { makeEntry, TEST_TZ } from './helpers/entries.ts'

const options = { timezone: TEST_TZ }

test('turns same project and description into one task with one worklog per entry', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, start: '2026-09-16T16:00:00Z', durationSeconds: 5400 }),
      makeEntry({ id: 2, start: '2026-09-16T19:00:00Z', durationSeconds: 3600 }),
      makeEntry({ id: 3, start: '2026-09-16T23:00:00Z', durationSeconds: 3600 }),
    ],
    options,
  )

  assert.equal(groups.length, 1)
  const group = groups[0]
  assert.equal(group?.summary, 'ajustar pipeline')
  assert.equal(group?.totalHuman, '3h 30m')
  assert.equal(group?.worklogs.length, 3)
  assert.deepEqual(
    group?.worklogs.map((worklog) => worklog.timeSpent),
    ['1h 30m', '1h', '1h'],
  )
  assert.deepEqual(group?.entryIds, [1, 2, 3])
})

test('keeps each worklog anchored to the real start of its entry', () => {
  const groups = groupEntries([makeEntry({ id: 1, start: '2026-09-16T16:00:00Z' })], options)

  assert.equal(groups[0]?.worklogs[0]?.startedJira, '2026-09-16T09:00:00.000-0700')
})

test('does not split a task that spans several days', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, start: '2026-09-15T16:00:00Z', durationSeconds: 3600 }),
      makeEntry({ id: 2, start: '2026-09-17T16:00:00Z', durationSeconds: 3600 }),
    ],
    options,
  )

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]?.days, ['2026-09-15', '2026-09-17'])
})

test('separates different projects with the same description', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, projectId: 1, projectName: 'A' }),
      makeEntry({ id: 2, projectId: 2, projectName: 'B' }),
    ],
    options,
  )

  assert.equal(groups.length, 2)
})

test('keeps case differences apart by default and merges them on request', () => {
  const entries = [
    makeEntry({ id: 1, description: 'Ajustar Pipeline' }),
    makeEntry({ id: 2, description: 'ajustar pipeline' }),
  ]

  assert.equal(groupEntries(entries, options).length, 2)
  assert.equal(groupEntries(entries, { ...options, caseInsensitive: true }).length, 1)
})

test('splits a task that goes over the eight hour cap and numbers the parts', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, start: '2026-09-14T15:00:00Z', durationSeconds: 5 * 3600 }),
      makeEntry({ id: 2, start: '2026-09-15T15:00:00Z', durationSeconds: 5 * 3600 }),
      makeEntry({ id: 3, start: '2026-09-16T15:00:00Z', durationSeconds: 2 * 3600 }),
    ],
    options,
  )

  assert.equal(groups.length, 2)
  const summaries = groups.map((group) => group.summary).sort()
  assert.deepEqual(summaries, ['ajustar pipeline (1/2)', 'ajustar pipeline (2/2)'])

  for (const group of groups) {
    assert.ok(group.totalSeconds <= 8 * 3600)
    assert.equal(group.splitReason, 'max-task-hours')
    assert.equal(group.partCount, 2)
  }

  const total = groups.reduce((sum, group) => sum + group.totalSeconds, 0)
  assert.equal(total, 12 * 3600)
})

test('never puts one entry in two tasks when it fits within the cap', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, durationSeconds: 5 * 3600 }),
      makeEntry({ id: 2, start: '2026-09-16T22:00:00Z', durationSeconds: 5 * 3600 }),
    ],
    options,
  )

  const allIds = groups.flatMap((group) => group.entryIds)
  assert.equal(allIds.length, new Set(allIds).size)
  assert.equal(groups.length, 2)
})

test('slices a single entry that alone exceeds the cap', () => {
  const groups = groupEntries(
    [makeEntry({ id: 1, start: '2026-09-16T13:00:00Z', durationSeconds: 10 * 3600 })],
    options,
  )

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.totalSeconds, 8 * 3600)
  assert.equal(groups[1]?.totalSeconds, 2 * 3600)
  assert.ok(groups.every((group) => group.worklogs.every((worklog) => worklog.partial)))
  assert.equal(groups[0]?.worklogs[0]?.startedJira, '2026-09-16T06:00:00.000-0700')
  assert.equal(groups[1]?.worklogs[0]?.startedJira, '2026-09-16T14:00:00.000-0700')
})

test('honours a custom cap', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, durationSeconds: 2 * 3600 }),
      makeEntry({ id: 2, start: '2026-09-16T20:00:00Z', durationSeconds: 2 * 3600 }),
    ],
    { ...options, maxTaskSeconds: 2 * 3600 },
  )

  assert.equal(groups.length, 2)
})

test('sums seconds rather than rounded hours', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, durationSeconds: 1810 }),
      makeEntry({ id: 2, start: '2026-09-16T18:00:00Z', durationSeconds: 1810 }),
    ],
    options,
  )

  assert.equal(groups[0]?.totalSeconds, 3620)
  assert.equal(groups[0]?.totalHuman, '1h')
})

test('groups carry their kind and meetings carry the meeting they come from', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 10, description: 'Revisión de descargas', kind: 'in-person-meeting', start: '2026-10-08T17:13:00Z', durationSeconds: 1620 }),
      makeEntry({ id: 11, description: 'ajustar pipeline', start: '2026-10-08T19:00:00Z', durationSeconds: 3600 }),
    ],
    options,
  )
  const meeting = groups.find((group) => group.entryIds.includes(10))
  const work = groups.find((group) => group.entryIds.includes(11))

  assert.equal(meeting?.kind, 'in-person-meeting')
  assert.deepEqual(meeting?.meeting, { entryId: 10, startedAt: meeting?.firstStart, durationSeconds: 1620, mode: 'in-person' })
  assert.equal(meeting?.meetings?.length, 1)
  assert.equal(work?.kind, null)
  assert.equal(work?.meeting, undefined)
  assert.equal('meetings' in (work ?? {}), false)
})

test('a meeting and a work block with the same title are separate groups', () => {
  const groups = groupEntries(
    [
      makeEntry({ id: 1, description: 'Sincronizar catálogo', kind: 'remote-meeting', start: '2026-10-08T16:00:00Z' }),
      makeEntry({ id: 2, description: 'Sincronizar catálogo', start: '2026-10-08T18:00:00Z' }),
      makeEntry({ id: 3, description: 'Sincronizar catálogo', start: '2026-10-09T18:00:00Z' }),
    ],
    options,
  )

  assert.equal(groups.length, 2)
  const meeting = groups.find((group) => group.kind === 'remote-meeting')
  const work = groups.find((group) => group.kind === null)
  assert.deepEqual(meeting?.entryIds, [1])
  assert.equal(meeting?.meeting?.mode, 'remote')
  assert.deepEqual(work?.entryIds, [2, 3])
  assert.notEqual(meeting?.key, work?.key)
  assert.equal(work?.key, '789\u0000Sincronizar catálogo')
})

test('kinds that are not meetings group apart but carry no meeting', () => {
  const groups = groupEntries([makeEntry({ id: 1, kind: 'review' }), makeEntry({ id: 2, start: '2026-09-16T19:00:00Z' })], options)
  assert.equal(groups.length, 2)
  const review = groups.find((group) => group.kind === 'review')
  assert.equal(review?.meeting, undefined)
})
