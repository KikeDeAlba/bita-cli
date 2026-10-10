import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'bita-stop-hooks-'))
const events = join(dir, 'events.ndjson')
const config = join(dir, 'config.json')
process.env['BITA_CONFIG_PATH'] = config
process.chdir(dir)
writeFileSync(
  config,
  JSON.stringify({
    version: 1,
    projectMapping: {},
    scopeMapping: {},
    hooks: [{ on: ['start', 'stop'], when: { kind: ['in-person-meeting'] }, command: ['/bin/sh', '-c', `cat >> ${events}`] }],
  }),
)

const { runStart, runStop } = await import('../src/cli/commands/timer.ts')
const { openDatabase } = await import('../src/db/open.ts')

const db = join(dir, 'bita.db')
const common = ['--db-path', db, '--docs-dir', join(dir, 'docs'), '--json']

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return await run()
  } finally {
    process.stdout.write = write
  }
}

async function receivedEvents(count: number): Promise<{ event: string; entry: { id: number }; pageIds: number[] }[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(events)) {
      const lines = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length >= count) return lines.map((line) => JSON.parse(line))
    }
    await sleep(25)
  }
  throw new Error(`expected ${count} hook events`)
}

function runningIds(): number[] {
  const handle = openDatabase(db)
  try {
    return (handle.prepare('SELECT id FROM entries WHERE stopped_at IS NULL ORDER BY id').all() as { id: number }[]).map(
      (row) => row.id,
    )
  } finally {
    handle.close()
  }
}

test('stop no longer takes --did, and a plain stop fires the hook', async () => {
  await quietly(() => runStart(['Reunión presencial', '--kind', 'in-person-meeting', ...common]))
  const [started] = await receivedEvents(1)
  assert.equal(started?.event, 'start')
  assert.deepEqual(started?.pageIds, [])
  const id = started?.entry.id ?? 0

  await assert.rejects(
    () => quietly(() => runStop([String(id), '--did', 'Se revisó la iniciativa.', ...common])),
    /Unknown option '--did'/,
  )
  assert.deepEqual(runningIds(), [id])

  await quietly(() => runStop([String(id), ...common]))
  assert.deepEqual(runningIds(), [])
  const all = await receivedEvents(2)
  assert.equal(all[1]?.event, 'stop')
  assert.equal(all[1]?.entry.id, id)
  assert.deepEqual(all[1]?.pageIds, [])
})
