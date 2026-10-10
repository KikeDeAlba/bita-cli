import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDay, toJiraStarted, toLocalIso } from '../src/domain/timezone.ts'
import { elapsedSeconds, formatDuration, toMinutes } from '../src/domain/duration.ts'

const TZ = 'America/Mazatlan'

test('formats the jira started stamp with milliseconds and no colon in the offset', () => {
  const started = toJiraStarted('2026-09-16T16:00:00Z', TZ)

  assert.equal(started, '2026-09-16T09:00:00.000-0700')
  assert.match(started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/)
})

test('keeps the colon in the human readable local iso', () => {
  assert.equal(toLocalIso('2026-09-16T16:00:00Z', TZ), '2026-09-16T09:00:00-07:00')
})

test('follows daylight saving time where the zone observes it', () => {
  const winter = toJiraStarted('2026-01-15T18:00:00Z', 'America/Mexico_City')
  const summer = toJiraStarted('2026-07-15T18:00:00Z', 'America/New_York')

  assert.ok(winter.endsWith('-0600'))
  assert.ok(summer.endsWith('-0400'))
})

test('assigns an entry to the local day of its start', () => {
  assert.equal(localDay('2026-09-20T05:30:00Z', TZ), '2026-09-19')
})

test('formats durations in hours and minutes only', () => {
  assert.equal(formatDuration(0), '0m')
  assert.equal(formatDuration(59), '1m')
  assert.equal(formatDuration(29), '0m')
  assert.equal(formatDuration(2700), '45m')
  assert.equal(formatDuration(3600), '1h')
  assert.equal(formatDuration(9000), '2h 30m')
  assert.equal(formatDuration(32400), '9h')
})

test('never emits day or week units that jira would reinterpret', () => {
  for (const seconds of [28800, 32400, 86400, 200000]) {
    assert.doesNotMatch(formatDuration(seconds), /[dw]/)
  }
})

test('rounds a group total once instead of once per entry', () => {
  const entries = [29, 29, 29]
  const perEntry = entries.reduce((sum, seconds) => sum + toMinutes(seconds), 0)
  const onceAtTheEnd = toMinutes(entries.reduce((sum, seconds) => sum + seconds, 0))

  assert.equal(perEntry, 0)
  assert.equal(onceAtTheEnd, 1)
})

test('treats a negative duration as a running entry measured from its start', () => {
  const now = new Date('2026-09-19T17:00:00Z')
  const seconds = elapsedSeconds({ start: '2026-09-19T16:00:00Z', duration: -1758000000 }, now)

  assert.equal(seconds, 3600)
})
