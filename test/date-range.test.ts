import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDateRange } from '../src/domain/date-range.ts'
import { UsageError } from '../src/errors.ts'

const TZ = 'America/Mazatlan'

function ctx(iso: string, beginningOfWeek = 1) {
  return { timezone: TZ, beginningOfWeek, now: new Date(iso) }
}

test('widens the queried range so an inclusive end date never loses a day', () => {
  const range = resolveDateRange({ from: '2026-09-15', to: '2026-09-19' }, ctx('2026-09-19T20:00:00Z'))

  assert.equal(range.fromDay, '2026-09-15')
  assert.equal(range.toDay, '2026-09-19')
  assert.equal(range.queryStartDate, '2026-09-14')
  assert.equal(range.queryEndDate, '2026-09-21')
  assert.equal(range.spanDays, 5)
})

test('resolves today in the user timezone, not in utc', () => {
  const range = resolveDateRange({ preset: 'today' }, ctx('2026-09-20T05:00:00Z'))

  assert.equal(range.fromDay, '2026-09-19')
  assert.equal(range.toDay, '2026-09-19')
})

test('resolves yesterday', () => {
  const range = resolveDateRange({ preset: 'yesterday' }, ctx('2026-09-19T20:00:00Z'))

  assert.equal(range.fromDay, '2026-09-18')
  assert.equal(range.toDay, '2026-09-18')
})

test('starts the week on the day the account says', () => {
  const monday = resolveDateRange({ preset: 'week' }, ctx('2026-09-19T20:00:00Z', 1))
  assert.equal(monday.fromDay, '2026-09-14')

  const sunday = resolveDateRange({ preset: 'week' }, ctx('2026-09-19T20:00:00Z', 0))
  assert.equal(sunday.fromDay, '2026-09-13')
})

test('resolves last week as the full previous week', () => {
  const range = resolveDateRange({ preset: 'last-week' }, ctx('2026-09-19T20:00:00Z', 1))

  assert.equal(range.fromDay, '2026-09-07')
  assert.equal(range.toDay, '2026-09-13')
})

test('resolves month as month to date and last-month as the full previous month', () => {
  const monthToDate = resolveDateRange({ preset: 'month' }, ctx('2026-09-19T20:00:00Z'))
  assert.equal(monthToDate.fromDay, '2026-09-01')
  assert.equal(monthToDate.toDay, '2026-09-19')

  const lastMonth = resolveDateRange({ preset: 'last-month' }, ctx('2026-09-19T20:00:00Z'))
  assert.equal(lastMonth.fromDay, '2026-08-01')
  assert.equal(lastMonth.toDay, '2026-08-31')
})

test('supports a rolling window that includes today', () => {
  const range = resolveDateRange({ lastDays: 3 }, ctx('2026-09-19T20:00:00Z'))

  assert.equal(range.fromDay, '2026-09-17')
  assert.equal(range.toDay, '2026-09-19')
})

test('rejects impossible and inverted dates', () => {
  assert.throws(() => resolveDateRange({ from: '2026-02-31' }, ctx('2026-09-19T20:00:00Z')), UsageError)
  assert.throws(() => resolveDateRange({ from: 'yesterday' }, ctx('2026-09-19T20:00:00Z')), UsageError)
  assert.throws(
    () => resolveDateRange({ from: '2026-09-19', to: '2026-09-15' }, ctx('2026-09-19T20:00:00Z')),
    UsageError,
  )
})

test('rejects mixing a preset with explicit dates', () => {
  assert.throws(
    () => resolveDateRange({ preset: 'week', from: '2026-09-01' }, ctx('2026-09-19T20:00:00Z')),
    UsageError,
  )
})
