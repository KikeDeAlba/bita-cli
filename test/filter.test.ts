import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { withinLocalRange } from '../src/domain/filter.ts'
import { makeEntry } from './helpers/entries.ts'

test('keeps an entry whose local day falls inside the range', () => {
  const entry = makeEntry({ start: '2026-09-16T16:00:00Z' })
  assert.equal(withinLocalRange(entry, '2026-09-16', '2026-09-16'), true)
})

test('drops an entry whose local day falls outside the range', () => {
  const entry = makeEntry({ start: '2026-09-16T16:00:00Z' })
  assert.equal(withinLocalRange(entry, '2026-09-17', '2026-09-18'), false)
})

test('judges the range by the local day, not by the utc instant', () => {
  const lateNight = makeEntry({ start: '2026-09-17T05:00:00Z' })
  assert.equal(lateNight.localDay, '2026-09-16')
  assert.equal(withinLocalRange(lateNight, '2026-09-16', '2026-09-16'), true)
  assert.equal(withinLocalRange(lateNight, '2026-09-17', '2026-09-17'), false)
})
