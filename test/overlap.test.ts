import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { describeOverlap, findOverlaps, unionSeconds } from '../src/domain/overlap.ts'
import { makeEntry, TEST_TZ } from './helpers/entries.ts'

const NOW = new Date('2026-09-19T23:00:00.000Z')

test('measures a single interval as its own length', () => {
  assert.equal(unionSeconds([{ from: 0, to: 3_600_000 }]), 3600)
})

test('counts shared clock time once when intervals overlap', () => {
  assert.equal(
    unionSeconds([
      { from: 0, to: 3_600_000 },
      { from: 1_800_000, to: 5_400_000 },
    ]),
    5400,
  )
})

test('keeps disjoint intervals apart instead of bridging the gap', () => {
  assert.equal(
    unionSeconds([
      { from: 0, to: 3_600_000 },
      { from: 7_200_000, to: 10_800_000 },
    ]),
    7200,
  )
})

test('swallows an interval fully contained in another', () => {
  assert.equal(
    unionSeconds([
      { from: 0, to: 7_200_000 },
      { from: 1_800_000, to: 3_600_000 },
    ]),
    7200,
  )
})

test('stays silent when nothing overlaps', () => {
  const entries = [
    makeEntry({ id: 1, start: '2026-09-19T16:00:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 2, start: '2026-09-19T18:00:00Z', durationSeconds: 3600 }),
  ]
  assert.deepEqual(findOverlaps(entries, NOW), [])
})

test('reports the day where two timers ran at the same time', () => {
  const entries = [
    makeEntry({ id: 1, start: '2026-09-19T16:00:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 2, start: '2026-09-19T16:30:00Z', durationSeconds: 3600 }),
  ]
  const [overlap] = findOverlaps(entries, NOW)

  assert.equal(overlap?.localDay, '2026-09-19')
  assert.equal(overlap?.trackedSeconds, 7200)
  assert.equal(overlap?.clockSeconds, 5400)
  assert.equal(overlap?.overlapSeconds, 1800)
  assert.match(describeOverlap(overlap!), /2026-09-19: 2h tracked over 1h 30m of clock time/)
})

test('ignores an overlap shorter than a minute', () => {
  const entries = [
    makeEntry({ id: 1, start: '2026-09-19T16:00:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 2, start: '2026-09-19T16:59:30Z', durationSeconds: 3600 }),
  ]
  assert.deepEqual(findOverlaps(entries, NOW), [])
})

test('keeps each local day on its own account', () => {
  const entries = [
    makeEntry({ id: 1, start: '2026-09-18T16:00:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 2, start: '2026-09-18T16:30:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 3, start: '2026-09-19T16:00:00Z', durationSeconds: 3600 }),
    makeEntry({ id: 4, start: '2026-09-19T16:30:00Z', durationSeconds: 3600 }),
  ]
  const overlaps = findOverlaps(entries, NOW)
  assert.deepEqual(
    overlaps.map((entry) => entry.localDay),
    ['2026-09-18', '2026-09-19'],
  )
  assert.equal(TEST_TZ, 'America/Mazatlan')
})

test('measures a still running timer up to now', () => {
  const entries = [
    makeEntry({ id: 1, start: '2026-09-19T16:00:00Z', durationSeconds: 7200 }),
    makeEntry({ id: 2, start: '2026-09-19T17:00:00Z', durationSeconds: 3600, running: true }),
  ]
  const [overlap] = findOverlaps(entries, new Date('2026-09-19T18:00:00.000Z'))
  assert.equal(overlap?.clockSeconds, 7200)
  assert.equal(overlap?.overlapSeconds, 3600)
})
