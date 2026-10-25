import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { POSIX_ONLY } from './helpers/fake-bin.ts'
import { runBita, seededDb } from './helpers/sessions-seed.ts'

const LS_KEYS = ['cwd', 'endedAt', 'entry', 'entryId', 'harness', 'id', 'open', 'resumable', 'sessionId', 'startedAt', 'transcriptPath', 'wrapperPid']
const ENTRY_KEYS = ['description', 'projectId', 'projectName']
const DIRS_KEYS = ['cwd', 'lastUsedAt', 'projectId', 'projectName', 'sessions']

type Row = Record<string, unknown>

function kind(value: unknown): string {
  return value === null ? 'null' : typeof value
}

function shape(row: Row): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, kind(value)]))
}

function ids(result: { json: Row }): number[] {
  return (result.json['data'] as Array<{ id: number }>).map((row) => row.id)
}

test('sessions ls --json carries exactly the contract keys and types, for finished, open and unlinked rows', () => {
  const box = seededDb()
  try {
    const here = box.dir('shape')
    box.add({ cwd: here, sessionId: 'sid-1', transcriptPath: '/t/1.jsonl', wrapperPid: 11, startedAt: '2026-09-10T10:00:00Z' })
    box.add({ cwd: here, sessionId: null, wrapperPid: 22, projectId: null, ended: false, harness: 'opencode', startedAt: '2026-09-11T10:00:00Z' })
    const result = runBita(box, here, ['sessions', 'ls', '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(Object.keys(result.json).sort(), ['command', 'data', 'generatedAt', 'ok', 'schemaVersion'])
    assert.equal(result.json['ok'], true)
    const data = result.json['data'] as Row[]
    assert.equal(data.length, 2)
    for (const row of data) {
      assert.deepEqual(Object.keys(row).sort(), LS_KEYS)
      assert.deepEqual(Object.keys(row['entry'] as Row).sort(), ENTRY_KEYS)
    }
    const [open, finished] = data as [Row, Row]
    assert.deepEqual(shape(finished), {
      id: 'number', entryId: 'number', harness: 'string', sessionId: 'string', wrapperPid: 'number', cwd: 'string',
      transcriptPath: 'string', startedAt: 'string', endedAt: 'string', open: 'boolean', resumable: 'boolean', entry: 'object',
    })
    assert.deepEqual(shape(finished['entry'] as Row), { description: 'string', projectId: 'number', projectName: 'string' })
    assert.deepEqual(shape(open), {
      id: 'number', entryId: 'number', harness: 'string', sessionId: 'null', wrapperPid: 'number', cwd: 'string',
      transcriptPath: 'null', startedAt: 'string', endedAt: 'null', open: 'boolean', resumable: 'boolean', entry: 'object',
    })
    assert.equal((open['entry'] as Row)['projectId'], null)
    assert.equal((open['entry'] as Row)['projectName'], null)
    assert.equal(open['open'], true)
    assert.equal(open['resumable'], false)
    assert.equal(finished['open'], false)
    assert.equal(finished['resumable'], true)
    for (const row of data) {
      assert.match(row['startedAt'] as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  } finally {
    box.cleanup()
  }
})

test('sessions ls --json prints an empty array and exit 0 when nothing matches', () => {
  const box = seededDb()
  try {
    const here = box.dir('empty')
    for (const args of [['sessions', 'ls', '--json'], ['sessions', 'ls', '--all', '--open', '--json'], ['sessions', 'dirs', '--json']]) {
      const result = runBita(box, here, args)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(result.json['data'], [], args.join(' '))
    }
  } finally {
    box.cleanup()
  }
})

test('sessions dirs --json carries exactly the contract keys and types, with a null project when the latest entry has none', () => {
  const box = seededDb()
  try {
    const a = box.dir('dirs-shape-a')
    const b = box.dir('dirs-shape-b')
    box.add({ cwd: a, startedAt: '2026-09-10T10:00:00Z' })
    box.add({ cwd: b, projectId: null, startedAt: '2026-09-11T10:00:00Z' })
    const result = runBita(box, a, ['sessions', 'dirs', '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.json['command'], 'sessions dirs')
    const data = result.json['data'] as Row[]
    assert.equal(data.length, 2)
    for (const row of data) assert.deepEqual(Object.keys(row).sort(), DIRS_KEYS)
    assert.deepEqual(shape(data[0] as Row), { cwd: 'string', lastUsedAt: 'string', sessions: 'number', projectId: 'null', projectName: 'null' })
    assert.deepEqual(shape(data[1] as Row), { cwd: 'string', lastUsedAt: 'string', sessions: 'number', projectId: 'number', projectName: 'string' })
  } finally {
    box.cleanup()
  }
})

test('sessions ls combines --open, --cwd, --harness and --limit', () => {
  const box = seededDb()
  try {
    const a = box.dir('combo-a')
    const b = box.dir('combo-b')
    const oldA = box.add({ cwd: a, harness: 'codex', ended: false, sessionId: null, startedAt: '2026-09-10T10:00:00Z' })
    const midA = box.add({ cwd: a, harness: 'codex', ended: false, sessionId: null, startedAt: '2026-09-11T10:00:00Z' })
    const newA = box.add({ cwd: a, harness: 'codex', ended: false, sessionId: null, startedAt: '2026-09-12T10:00:00Z' })
    const claudeA = box.add({ cwd: a, harness: 'claude', ended: false, sessionId: null, startedAt: '2026-09-13T10:00:00Z' })
    const doneA = box.add({ cwd: a, harness: 'codex', startedAt: '2026-09-14T10:00:00Z' })
    const openB = box.add({ cwd: b, harness: 'codex', ended: false, sessionId: null, startedAt: '2026-09-15T10:00:00Z' })
    const ls = (...args: string[]) => runBita(box, a, ['sessions', 'ls', ...args, '--json'])

    assert.deepEqual(ids(ls('--open', '--cwd', a, '--harness', 'codex')), [newA.rowId, midA.rowId, oldA.rowId])
    assert.deepEqual(ids(ls('--open', '--cwd', a, '--harness', 'codex', '--limit', '2')), [newA.rowId, midA.rowId])
    assert.deepEqual(ids(ls('--open', '--cwd', b, '--harness', 'codex', '--limit', '5')), [openB.rowId])
    assert.deepEqual(ids(ls('--open', '--all', '--harness', 'codex', '--limit', '1')), [openB.rowId])
    assert.deepEqual(ids(ls('--open', '--harness', 'claude')), [claudeA.rowId])
    assert.deepEqual(ids(ls('--cwd', a, '--harness', 'codex', '--limit', '1')), [doneA.rowId])
    assert.deepEqual(ids(ls('--cwd', b, '--harness', 'claude')), [])
    assert.deepEqual(ids(ls('--all', '--limit', '3')), [openB.rowId, doneA.rowId, claudeA.rowId])
    assert.deepEqual(ids(ls('--limit', '1')), [doneA.rowId])
    for (const run of [ls('--open', '--harness', 'gemini'), ls('--open', '--cwd', box.dir('combo-none'))]) {
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(run.json['data'], [])
    }
  } finally {
    box.cleanup()
  }
})

test('sessions ls --cwd resolves relative paths and symlinks, and an unknown directory is empty rather than an error', { skip: POSIX_ONLY }, () => {
  const box = seededDb()
  try {
    const real = box.dir('real')
    const link = join(box.root, 'link')
    symlinkSync(real, link)
    const row = box.add({ cwd: real, startedAt: '2026-09-10T10:00:00Z' })
    const other = box.dir('other')
    assert.deepEqual(ids(runBita(box, other, ['sessions', 'ls', '--cwd', link, '--json'])), [row.rowId])
    assert.deepEqual(ids(runBita(box, other, ['sessions', 'ls', '--cwd', '../real', '--json'])), [row.rowId])
    assert.deepEqual(ids(runBita(box, link, ['sessions', 'ls', '--json'])), [row.rowId])
    const missing = runBita(box, other, ['sessions', 'ls', '--cwd', join(box.root, 'nope'), '--json'])
    assert.equal(missing.status, 0, missing.stderr)
    assert.deepEqual(missing.json['data'], [])
  } finally {
    box.cleanup()
  }
})

test('sessions ls and dirs reject invalid --limit values with a usage error', () => {
  const box = seededDb()
  try {
    const here = box.dir('limits')
    for (const limit of ['0', '-1', 'abc', '1.5', '']) {
      for (const sub of ['ls', 'dirs']) {
        const run = runBita(box, here, ['sessions', sub, '--limit', limit, '--json'])
        assert.equal(run.status, 2, `${sub} --limit "${limit}": ${run.stdout}`)
        assert.equal(run.json['ok'], false)
        assert.equal((run.json['error'] as Row)['code'], 'USAGE_ERROR')
      }
    }
  } finally {
    box.cleanup()
  }
})

test('sessions dirs --limit larger than the data returns everything, and every cwd appears once', () => {
  const box = seededDb()
  try {
    const a = box.dir('dl-a')
    const b = box.dir('dl-b')
    box.add({ cwd: a, startedAt: '2026-09-10T10:00:00Z' })
    box.add({ cwd: a, startedAt: '2026-09-11T10:00:00Z', ended: false })
    box.add({ cwd: b, startedAt: '2026-09-09T10:00:00Z' })
    const run = runBita(box, a, ['sessions', 'dirs', '--limit', '500', '--json'])
    const data = run.json['data'] as Array<{ cwd: string; sessions: number }>
    assert.deepEqual(data.map((row) => [row.cwd, row.sessions]), [[a, 2], [b, 1]])
  } finally {
    box.cleanup()
  }
})

test('sessions ls keeps the envelope of a failure when the harness is unknown', () => {
  const box = seededDb()
  try {
    const run = runBita(box, box.dir('badharness'), ['sessions', 'ls', '--harness', 'nope', '--json'])
    assert.equal(run.status, 2)
    assert.equal(run.json['ok'], false)
    assert.match(String((run.json['error'] as Row)['message']), /Unknown harness "nope"/)
  } finally {
    box.cleanup()
  }
})
