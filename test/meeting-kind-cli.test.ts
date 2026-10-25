import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runBita, seededDb } from './helpers/sessions-seed.ts'

type Entry = { id: number; kind: string | null; running: boolean; description: string }

test('a meeting timer shows its kind in start, ls and entries, and keeps it after stop', () => {
  const box = seededDb()
  try {
    const here = box.dir('meeting')
    const started = runBita(box, here, ['start', 'Daily', '--kind', 'meeting', '--json'])
    assert.equal(started.status, 0, started.stderr)
    const entry = started.json['data'] as Entry
    assert.equal(entry.kind, 'meeting')
    assert.equal(entry.running, true)

    const running = runBita(box, here, ['ls', '--json'])
    assert.equal(running.status, 0, running.stderr)
    assert.deepEqual((running.json['data'] as Entry[]).map((row) => [row.id, row.kind]), [[entry.id, 'meeting']])

    const stopped = runBita(box, here, ['stop', String(entry.id), '--json'])
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.deepEqual((stopped.json['data'] as Entry[]).map((row) => row.kind), ['meeting'])

    const listed = runBita(box, here, ['entries', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const rows = listed.json['data'] as Entry[]
    assert.deepEqual(rows.map((row) => [row.id, row.kind, row.running]), [[entry.id, 'meeting', false]])

    const one = runBita(box, here, ['entries', 'get', String(entry.id), '--json'])
    assert.equal((one.json['data'] as Entry).kind, 'meeting')
  } finally {
    box.cleanup()
  }
})

test('--kind is normalized to lowercase and the human output of ls and entries mentions meeting', () => {
  const box = seededDb()
  try {
    const here = box.dir('meeting-case')
    const started = runBita(box, here, ['start', 'Retro', '--kind', '  Meeting ', '--json'])
    assert.equal(started.status, 0, started.stderr)
    assert.equal((started.json['data'] as Entry).kind, 'meeting')
    const human = runBita(box, here, ['entries', 'get', String((started.json['data'] as Entry).id)])
    assert.match(human.stdout, /Kind\s*: meeting/)
  } finally {
    box.cleanup()
  }
})

test('start --kind rejects malformed kinds and the reserved none, and creates no entry', () => {
  const box = seededDb()
  try {
    const here = box.dir('meeting-bad')
    for (const kind of ['Meeting!', 'two words', '1meeting', '', 'none', 'm'.repeat(41)]) {
      const run = runBita(box, here, ['start', 'x', `--kind=${kind}`, '--json'])
      assert.equal(run.status, 2, `"${kind}": ${run.stdout}${run.stderr}`)
      assert.equal((run.json['error'] as { code: string }).code, 'USAGE_ERROR')
    }
    assert.deepEqual(runBita(box, here, ['ls', '--json']).json['data'], [])
  } finally {
    box.cleanup()
  }
})

test('amend --kind none clears a meeting kind and the cleared entry lists with a null kind', () => {
  const box = seededDb()
  try {
    const here = box.dir('meeting-clear')
    const id = (runBita(box, here, ['start', 'Sync', '--kind', 'meeting', '--json']).json['data'] as Entry).id
    const cleared = runBita(box, here, ['amend', String(id), '--kind', 'none', '--json'])
    assert.equal(cleared.status, 0, cleared.stderr)
    assert.equal((runBita(box, here, ['ls', '--json']).json['data'] as Entry[])[0]?.kind, null)
  } finally {
    box.cleanup()
  }
})

test('the legacy remote-meeting and in-person-meeting kinds still start and list as they were written', () => {
  const box = seededDb()
  try {
    const here = box.dir('meeting-legacy')
    for (const kind of ['remote-meeting', 'in-person-meeting']) {
      const run = runBita(box, here, ['start', kind, '--kind', kind, '--json'])
      assert.equal(run.status, 0, run.stderr)
      assert.equal((run.json['data'] as Entry).kind, kind)
    }
    const kinds = (runBita(box, here, ['ls', '--json']).json['data'] as Entry[]).map((row) => row.kind).sort()
    assert.deepEqual(kinds, ['in-person-meeting', 'remote-meeting'])
  } finally {
    box.cleanup()
  }
})
