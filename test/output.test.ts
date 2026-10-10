import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorEnvelope, successEnvelope } from '../src/cli/output.ts'
import { SCHEMA_VERSION } from '../src/config/constants.ts'
import { renderTable } from '../src/cli/table.ts'

test('a success envelope is versioned and self describing', () => {
  const envelope = successEnvelope('summary', { groups: [] }, { entryCount: 0 })

  assert.equal(envelope.schemaVersion, SCHEMA_VERSION)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.command, 'summary')
  assert.deepEqual(envelope.data, { groups: [] })
  assert.equal(envelope.meta?.['entryCount'], 0)
})

test('an error envelope carries a machine readable code and a hint', () => {
  const envelope = errorEnvelope('tag', {
    code: 'PARTIAL_TAG_FAILURE',
    message: '1 of 2 entries were not updated.',
    hint: 'toggl tag --ids 2 --apply',
  })

  assert.equal(envelope.ok, false)
  assert.equal(envelope.error?.code, 'PARTIAL_TAG_FAILURE')
  assert.match(envelope.error?.hint ?? '', /toggl tag/)
})

test('both envelopes survive a json round trip', () => {
  const parsed = JSON.parse(JSON.stringify(successEnvelope('entries', [1, 2, 3])))

  assert.deepEqual(parsed.data, [1, 2, 3])
})

test('renders a table with a header and a separator', () => {
  const output = renderTable(
    [{ header: 'ID' }, { header: 'TIME', align: 'right' }],
    [
      ['1', '1h 30m'],
      ['22', '45m'],
    ],
  )
  const lines = output.split('\n')

  assert.equal(lines.length, 4)
  assert.match(lines[0] ?? '', /^ID/)
  assert.match(lines[1] ?? '', /^--/)
  assert.ok((lines[2] ?? '').includes('1h 30m'))
})
