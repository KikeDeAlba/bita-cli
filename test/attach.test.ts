import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { decideAttachment, type RunningSnapshot } from '../src/domain/attach.ts'

function running(id: number, projectId: number | null = null): RunningSnapshot {
  return { id, projectId }
}

function decide(
  entries: RunningSnapshot[],
  projectId: number | null,
  preferredEntryId: number | null = null,
): ReturnType<typeof decideAttachment> {
  return decideAttachment({ running: entries, projectId, preferredEntryId })
}

test('does nothing when no timer is running', () => {
  assert.deepEqual(decide([], 1), { kind: 'ignore', reason: 'no-timer' })
})

test('does nothing when the preferred entry is not running and nothing else is', () => {
  assert.deepEqual(decide([], 1, 9), { kind: 'ignore', reason: 'no-timer' })
})

test('the preferred running entry wins over a timer of the same project', () => {
  const entries = [running(5, 42), running(6, 99)]
  assert.deepEqual(decide(entries, 42, 6), { kind: 'record', entryId: 6 })
})

test('a preferred entry that is no longer running falls back to the usual rules', () => {
  const entries = [running(5, 42)]
  assert.deepEqual(decide(entries, 42, 9), { kind: 'record', entryId: 5 })
})

test('records against the timer that already has the project', () => {
  const entries = [running(5, 99), running(6, 42)]
  assert.deepEqual(decide(entries, 42), { kind: 'record', entryId: 6 })
})

test('records against the oldest timer when the project cannot be resolved', () => {
  const entries = [running(5, 7), running(6, 8)]
  assert.deepEqual(decide(entries, null), { kind: 'record', entryId: 5 })
})

test('records against a draft without project and never assigns one', () => {
  const decision = decide([running(5)], 42)
  assert.deepEqual(decision, { kind: 'record', entryId: 5 })
})

test('another project never splits, however many timers run', () => {
  const entries = [running(5, 42), running(6, 99)]
  assert.deepEqual(decide(entries, 7), { kind: 'ignore', reason: 'unknown-project' })
})

test('no decision ever stops, creates or reassigns an entry', () => {
  const cases: Array<[RunningSnapshot[], number | null, number | null]> = [
    [[], 1, null],
    [[running(1, 2)], 3, null],
    [[running(1, 2)], null, null],
    [[running(1)], 3, null],
    [[running(1, 2), running(2, 3)], 4, 2],
  ]
  for (const [entries, projectId, preferred] of cases) {
    assert.ok(['record', 'ignore'].includes(decide(entries, projectId, preferred).kind))
  }
})
