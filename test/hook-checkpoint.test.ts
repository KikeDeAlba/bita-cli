import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { recordTouch } from '../src/db/touches.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

function hook(dir: string, event: string): string {
  const run = spawnSync(process.execPath, [bin, 'hook', event], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, BITA_DB_PATH: join(dir, 'bita.db'), BITA_CONFIG_PATH: join(dir, 'config.json'), KIT_NO_EVENTS: '1' },
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}

test('checkpoint reminds about a busy timer once, pointing to inkwell, and then stays quiet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-checkpoint-'))
  const db = openDatabase(join(dir, 'bita.db'))
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const entry = insertEntry(db, { description: 'Wire kit', projectId: null, startedAt: ago(10), source: 'timer', now: ago(10) })
  for (const file of ['a.ts', 'b.ts', 'c.ts']) recordTouch(db, entry.id, join(dir, file), ago(5))
  db.close()

  const first = hook(dir, 'checkpoint')
  const context = (JSON.parse(first) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  assert.match(context, new RegExp(`#${entry.id} "Wire kit"`))
  assert.match(context, new RegExp(`inkwell note save ${entry.id}`))
  assert.doesNotMatch(context, /bita (docs|note|backlog)/)

  assert.equal(hook(dir, 'checkpoint'), '')
})

test('checkpoint says nothing without a titled running timer, and forgets stopped ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-checkpoint-'))
  const db = openDatabase(join(dir, 'bita.db'))
  const now = new Date().toISOString()
  insertEntry(db, { description: '', projectId: null, startedAt: now, source: 'timer', now })
  db.prepare("INSERT INTO settings (key, value) VALUES ('checkpoint.entry.999', ?)").run(now)
  db.close()

  assert.equal(hook(dir, 'checkpoint'), '')
  const after = openDatabase(join(dir, 'bita.db'))
  assert.equal(after.prepare("SELECT COUNT(*) AS total FROM settings WHERE key LIKE 'checkpoint.entry.%'").get()?.['total'], 0)
  after.close()
})

test('an unknown hook event, like the retired ref hook, is a quiet no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-checkpoint-'))
  assert.equal(hook(dir, 'ref'), '')
})

test('timer flags that moved to inkwell fail with a pointer to it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-checkpoint-'))
  const run = spawnSync(process.execPath, [bin, 'stop', '1', '--did', 'x', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, BITA_DB_PATH: join(dir, 'bita.db'), BITA_CONFIG_PATH: join(dir, 'config.json') },
  })
  assert.equal(run.status, 2)
  const envelope = JSON.parse(run.stdout) as { error: { code: string; message: string } }
  assert.equal(envelope.error.code, 'USAGE_ERROR')
  assert.match(envelope.error.message, /inkwell note save/)
})
