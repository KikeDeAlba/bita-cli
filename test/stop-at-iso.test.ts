import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../src/db/open.ts'
import { findEntryById, insertEntry } from '../src/db/entries.ts'
import { parseInstant } from '../src/domain/duration-input.ts'
import { UsageError } from '../src/errors.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

function run(dir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, BITA_DB_PATH: join(dir, 'bita.db'), BITA_CONFIG_PATH: join(dir, 'config.json'), KIT_NO_EVENTS: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('parseInstant takes HH:MM or an ISO timestamp with a zone, never a bare one', () => {
  const reference = new Date('2026-10-20T18:00:00Z')
  assert.equal(parseInstant('2026-10-20T10:15:30Z', reference, '--at').toISOString(), '2026-10-20T10:15:30.000Z')
  assert.equal(parseInstant('2026-10-20T10:15:30.250-07:00', reference, '--at').toISOString(), '2026-10-20T17:15:30.250Z')
  assert.equal(parseInstant('2026-10-20T10:15+0530', reference, '--at').toISOString(), '2026-10-20T04:45:00.000Z')
  const clock = parseInstant('09:30', reference, '--at')
  assert.equal(clock.getHours(), 9)
  assert.equal(clock.getMinutes(), 30)
  assert.throws(() => parseInstant('2026-10-20T10:15:30', reference, '--at'), UsageError)
  assert.throws(() => parseInstant('yesterday', reference, '--at'), UsageError)
  assert.throws(() => parseInstant('2026-10-20', reference, '--at'), UsageError)
})

test('stop --at stops at the exact ISO instant and refuses one before the start or in the future', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-stop-iso-'))
  try {
    const started = new Date(Date.now() - 30 * 60_000)
    const db = openDatabase(join(dir, 'bita.db'))
    const entry = insertEntry(db, { description: 'Work', projectId: null, startedAt: started.toISOString(), source: 'timer', now: started.toISOString() })
    db.close()

    const before = run(dir, ['stop', String(entry.id), '--at', new Date(started.getTime() - 60_000).toISOString(), '--json'])
    assert.notEqual(before.status, 0)
    assert.match(before.stdout + before.stderr, /before #\d+ started/)

    const future = run(dir, ['stop', String(entry.id), '--at', new Date(Date.now() + 5 * 60_000).toISOString(), '--json'])
    assert.notEqual(future.status, 0)
    assert.match(future.stdout + future.stderr, /future/)

    const bare = run(dir, ['stop', String(entry.id), '--at', '2026-10-20T10:00:00', '--json'])
    assert.notEqual(bare.status, 0)

    const at = new Date(started.getTime() + 12 * 60_000 + 345).toISOString()
    const ok = run(dir, ['stop', String(entry.id), '--at', at, '--json'])
    assert.equal(ok.status, 0, ok.stderr)
    const after = openDatabase(join(dir, 'bita.db'))
    assert.equal(findEntryById(after, entry.id)?.stoppedAt, at)
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('start --at accepts an ISO instant too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-start-iso-'))
  try {
    const at = new Date(Date.now() - 10 * 60_000).toISOString()
    const out = run(dir, ['start', 'Earlier', '--at', at, '--json'])
    assert.equal(out.status, 0, out.stderr)
    const envelope = JSON.parse(out.stdout) as { data: { start: string } }
    assert.equal(envelope.data.start, at)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
