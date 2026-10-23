import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { nodeScriptBin } from './helpers/fake-bin.ts'
import { openDatabase } from '../src/db/open.ts'
import { queryAll } from '../src/db/query.ts'
import { startSessionEntry } from '../src/domain/session.ts'
import { createLocalContext } from '../src/cli/local-context.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const fixture = join(import.meta.dirname, 'fixtures', 'harness', 'claude-session.jsonl')

const FAKE_CLAUDE = `process.stdin.resume()
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ is_error: false, structured_output: { title: 'Synthetic title', kind: null, note: { context: 'ctx', done: '- done', decisions: null, findings: null, verification: null, pending: null } } })))
`

interface Row {
  id: number
  description: string
  started_at: string
  stopped_at: string | null
  ended_at: string | null
  outcome: string | null
  end_reason: string | null
}

test('a /clear rotation and a final exit leave two stopped entries with titles and outcomes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-session-e2e-'))
  try {
    mkdirSync(join(dir, 'empty-path'))
    const dbPath = join(dir, 'bita.db')
    const fake = nodeScriptBin(dir, 'fake-claude', FAKE_CLAUDE)
    const first = join(dir, 'first.jsonl')
    const second = join(dir, 'second.jsonl')
    copyFileSync(fixture, first)
    copyFileSync(fixture, second)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      PATH: join(dir, 'empty-path'),
      BITA_DB_PATH: dbPath,
      BITA_CONFIG_PATH: join(dir, 'config.json'),
      KIT_NO_EVENTS: '1',
      KIT_REGISTRY_DIR: join(dir, 'registry'),
      BITA_HARNESS_BIN_CLAUDE: fake,
      BITA_HARNESS_BIN_CODEX: join(dir, 'missing'),
      BITA_HARNESS_BIN_GEMINI: join(dir, 'missing'),
      BITA_HARNESS_BIN_OPENCODE: join(dir, 'missing'),
      BITA_WRAPPER_ID: 'wrapper-e2e',
      BITA_HARNESS: 'claude',
      BITA_SESSION_PROJECT: '1',
    }
    delete env['BITA_CHILD']

    const ctx = createLocalContext({ values: { 'db-path': dbPath }, positionals: [] })
    try {
      ctx.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (1, ?, ?)').run('E2E', new Date().toISOString())
      await startSessionEntry(ctx, { wrapperId: 'wrapper-e2e', wrapperPid: process.pid, harness: 'claude', projectId: 1, cwd: dir })
    } finally {
      ctx.db.close()
    }

    const fire = (event: string, payload: Record<string, unknown>): void => {
      const result = spawnSync(process.execPath, [bin, 'hook', event], { cwd: dir, encoding: 'utf8', input: JSON.stringify(payload), env })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')
    }

    fire('session-start', { session_id: 'sess-a', transcript_path: first, cwd: dir, source: 'startup' })
    await sleep(1100)
    fire('session-end', { session_id: 'sess-a', reason: 'clear' })
    fire('session-start', { session_id: 'sess-b', transcript_path: second, cwd: dir, source: 'clear' })
    await sleep(1100)
    fire('session-end', { session_id: 'sess-b', reason: 'prompt_input_exit' })

    const read = (): Row[] => {
      const db = openDatabase(dbPath)
      try {
        return queryAll<Row>(
          db.prepare(
            `SELECT e.id, e.description, e.started_at, e.stopped_at, s.ended_at, s.outcome, s.end_reason
             FROM entries e JOIN entry_sessions s ON s.entry_id = e.id ORDER BY e.id`,
          ),
        )
      } finally {
        db.close()
      }
    }

    let rows = read()
    for (let attempt = 0; attempt < 100 && !(rows.length === 2 && rows.every((row) => row.outcome !== null)); attempt++) {
      await sleep(200)
      rows = read()
    }

    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.end_reason), ['clear', 'prompt_input_exit'])
    for (const row of rows) {
      assert.equal(row.description, 'Synthetic title')
      assert.equal(row.outcome, 'summarized')
      assert.notEqual(row.stopped_at, null)
      assert.equal(row.stopped_at, row.ended_at)
    }
    assert.ok(rows[0]!.stopped_at! <= rows[1]!.started_at)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
