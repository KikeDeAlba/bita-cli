import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { decideAttachment, type RunningSnapshot } from '../src/domain/attach.ts'

const MIN_SPLIT = 300

function running(overrides: Partial<RunningSnapshot> & { id: number }): RunningSnapshot {
  return { projectId: null, isDraft: true, elapsedSeconds: 3600, ...overrides }
}

function decide(
  entries: RunningSnapshot[],
  projectId: number | null,
  wrote = true,
): ReturnType<typeof decideAttachment> {
  return decideAttachment({ running: entries, projectId, wrote, minSplitSeconds: MIN_SPLIT })
}

test('does nothing when no timer is running', () => {
  assert.deepEqual(decide([], 1), { kind: 'ignore', reason: 'no-timer' })
})

test('assigns the project to a draft that has none', () => {
  const decision = decide([running({ id: 5 })], 42)
  assert.deepEqual(decision, { kind: 'assign', entryId: 5, projectId: 42 })
})

test('just records the file when a running timer already has that project', () => {
  const decision = decide([running({ id: 5, projectId: 42, isDraft: false })], 42)
  assert.deepEqual(decision, { kind: 'record', entryId: 5 })
})

test('two repositories of the same project never split', () => {
  const entries = [running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: 7200 })]
  assert.equal(decide(entries, 42).kind, 'record')
  assert.equal(decide(entries, 42).kind, 'record')
})

test('splits when a different project is written to after the minimum dwell', () => {
  const entries = [running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: MIN_SPLIT })]
  assert.deepEqual(decide(entries, 99), { kind: 'split', stopEntryId: 5, projectId: 99 })
})

test('does not split a timer that has barely started', () => {
  const entries = [running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: MIN_SPLIT - 1 })]
  assert.deepEqual(decide(entries, 99), { kind: 'record', entryId: 5 })
})

test('reading another project never splits, however long the timer has run', () => {
  const entries = [running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: 86_400 })]
  assert.deepEqual(decide(entries, 99, false), { kind: 'ignore', reason: 'unknown-project' })
})

test('reading still assigns the project to a draft that has none', () => {
  const decision = decide([running({ id: 5 })], 42, false)
  assert.deepEqual(decision, { kind: 'assign', entryId: 5, projectId: 42 })
})

test('records against the oldest timer when the project cannot be resolved', () => {
  const decision = decide([running({ id: 5, projectId: 7, isDraft: false })], null)
  assert.deepEqual(decision, { kind: 'record', entryId: 5 })
})

test('ignores an unresolvable project when only reading', () => {
  const decision = decide([running({ id: 5, projectId: 7, isDraft: false })], null, false)
  assert.deepEqual(decision, { kind: 'ignore', reason: 'unknown-project' })
})

test('prefers the timer that already holds the project over splitting', () => {
  const entries = [
    running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: 7200 }),
    running({ id: 6, projectId: 99, isDraft: false, elapsedSeconds: 7200 }),
  ]
  assert.deepEqual(decide(entries, 42), { kind: 'record', entryId: 5 })
})

test('splits from the most recently started timer, not the oldest', () => {
  const entries = [
    running({ id: 5, projectId: 42, isDraft: false, elapsedSeconds: 7200 }),
    running({ id: 6, projectId: 99, isDraft: false, elapsedSeconds: 7200 }),
  ]
  assert.deepEqual(decide(entries, 7), { kind: 'split', stopEntryId: 6, projectId: 7 })
})
