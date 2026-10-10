import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClockTime, parseDurationSeconds } from '../src/domain/duration-input.ts'
import { UsageError } from '../src/errors.ts'

test('parses the duration forms a human would type', () => {
  assert.equal(parseDurationSeconds('45m', '--duration'), 2700)
  assert.equal(parseDurationSeconds('2h', '--duration'), 7200)
  assert.equal(parseDurationSeconds('1h30m', '--duration'), 5400)
  assert.equal(parseDurationSeconds('90m', '--duration'), 5400)
})

test('rejects a duration it cannot read rather than guessing', () => {
  assert.throws(() => parseDurationSeconds('', '--duration'), UsageError)
  assert.throws(() => parseDurationSeconds('a while', '--duration'), UsageError)
  assert.throws(() => parseDurationSeconds('0m', '--duration'), UsageError)
  assert.throws(() => parseDurationSeconds('30s', '--duration'), UsageError)
})

test('reads a clock time against the reference day', () => {
  const reference = new Date('2026-09-19T20:00:00Z')
  const at = parseClockTime('09:30', reference, '--from')

  assert.equal(at.getHours(), 9)
  assert.equal(at.getMinutes(), 30)
  assert.equal(at.getSeconds(), 0)
})

test('accepts a full timestamp as well', () => {
  const at = parseClockTime('2026-09-18T13:58:37Z', new Date(), '--from')

  assert.equal(at.toISOString(), '2026-09-18T13:58:37.000Z')
})

test('rejects an impossible clock time', () => {
  const reference = new Date('2026-09-19T20:00:00Z')

  assert.throws(() => parseClockTime('25:00', reference, '--from'), UsageError)
  assert.throws(() => parseClockTime('12:99', reference, '--from'), UsageError)
  assert.throws(() => parseClockTime('noon', reference, '--from'), UsageError)
})
