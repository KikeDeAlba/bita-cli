import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../src/db/open.ts'
import { insertEntry, listRunning } from '../src/db/entries.ts'
import { listTouches } from '../src/db/touches.ts'
import { recordTouch } from '../src/db/touches.ts'
import { statusLine } from '../src/cli/commands/statusline.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

function env(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_CONFIG_PATH: join(dir, 'config.json'),
    KIT_NO_EVENTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  }
}

function run(dir: string, args: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', input, env: env(dir) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function contextOf(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput.additionalContext
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

test('hook prompt answers the draft reminder and the checkpoint in one context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-prompt-'))
  try {
    const db = openDatabase(join(dir, 'bita.db'))
    const draft = insertEntry(db, { description: '', projectId: null, startedAt: ago(3), source: 'timer', now: ago(3) })
    const busy = insertEntry(db, { description: 'Wire kit', projectId: null, startedAt: ago(60), source: 'timer', now: ago(60) })
    for (const file of ['a.ts', 'b.ts', 'c.ts']) recordTouch(db, busy.id, join(dir, file), ago(5))
    db.close()

    const first = run(dir, ['hook', 'prompt'], '{"prompt":"hola"}')
    assert.equal(first.status, 0, first.stderr)
    assert.equal(first.stdout.trim().split('\n').length, 1)
    const parsed = JSON.parse(first.stdout) as { hookSpecificOutput: { hookEventName: string } }
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    const context = contextOf(first.stdout)
    assert.match(context, new RegExp(`#${draft.id} lleva`))
    assert.match(context, /bita amend --draft/)
    assert.match(context, new RegExp(`#${busy.id} "Wire kit"`))
    assert.match(context, new RegExp(`inkwell note save ${busy.id}`))
    assert.ok(context.length < 900, `context is ${context.length} chars`)

    const second = contextOf(run(dir, ['hook', 'prompt']).stdout)
    assert.match(second, /SIN TITULO/)
    assert.doesNotMatch(second, /Wire kit/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hook prompt is silent with nothing running, and the old events keep answering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-prompt-'))
  try {
    assert.equal(run(dir, ['hook', 'prompt']).stdout, '')
    const db = openDatabase(join(dir, 'bita.db'))
    insertEntry(db, { description: '', projectId: null, startedAt: ago(1), source: 'timer', now: ago(1) })
    db.close()
    assert.match(contextOf(run(dir, ['hook', 'prompt-submit']).stdout), /SIN TITULO/)
    assert.equal(run(dir, ['hook', 'checkpoint']).stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the session-start context stays short', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-session-'))
  try {
    const repo = join(dir, 'work', 'app')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo, env: env(dir) })
    assert.equal(run(repo, ['project', 'add', 'Apps', '--json']).status, 0)
    assert.equal(run(repo, ['scope', 'set', '.', '1', '--json']).status, 0)
    const out = run(repo, ['hook', 'session-start'])
    assert.equal(out.status, 0, out.stderr)
    const context = contextOf(out.stdout)
    assert.match(context, /Apps/)
    assert.match(context, /Nada corriendo/)
    assert.ok(context.length <= 400, `context is ${context.length} chars`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hook touched reads the file path from the PostToolUse JSON on stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-touched-'))
  try {
    const db = openDatabase(join(dir, 'bita.db'))
    const entry = insertEntry(db, { description: 'Edit', projectId: null, startedAt: ago(1), source: 'timer', now: ago(1) })
    db.close()
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'x')
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } })
    const out = run(dir, ['hook', 'touched'], input)
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout, '')
    assert.equal(run(dir, ['hook', 'touched'], 'not json').status, 0)
    assert.equal(run(dir, ['hook', 'touched', '--file', join(dir, 'other.txt')]).status, 0)
    const after = openDatabase(join(dir, 'bita.db'))
    assert.deepEqual(listTouches(after, entry.id).sort(), [file, join(dir, 'other.txt')].sort())
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('statusline prints the running timers in one line, or nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-statusline-'))
  try {
    assert.equal(run(dir, ['statusline']).stdout, '')
    assert.equal(run(dir, ['project', 'add', 'Kit', '--json']).status, 0)
    assert.equal(run(dir, ['start', 'Wire the kit', '--project', 'Kit', '--json']).status, 0)
    const db = openDatabase(join(dir, 'bita.db'))
    insertEntry(db, { description: '', projectId: null, startedAt: ago(65), source: 'timer', now: ago(65) })
    const ids = listRunning(db).map((entry) => entry.id)
    db.close()

    const started = process.hrtime.bigint()
    const out = run(dir, ['statusline'], '{"session_id":"x"}')
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(out.status, 0, out.stderr)
    const lines = out.stdout.trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /Wire the kit · Kit · 0m/)
    assert.match(lines[0] ?? '', /\(sin título\) · 1h 5m/)
    assert.ok(ids.every((id) => (lines[0] ?? '').includes(`#${id}`)))
    assert.ok(elapsedMs < 2_000, `statusline took ${elapsedMs} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('statusLine shortens long titles', () => {
  const line = statusLine([{ id: 7, description: 'x'.repeat(80), started_at: new Date(0).toISOString(), project_name: null }], new Date(120_000))
  assert.match(line, /^#7 x{39}… · 2m$/)
})

test('entries --brief keeps only id, title, project, start, stop and seconds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-brief-'))
  try {
    assert.equal(run(dir, ['project', 'add', 'Kit', '--json']).status, 0)
    assert.equal(run(dir, ['start', 'Brief work', '--project', 'Kit', '--json']).status, 0)
    const out = run(dir, ['entries', 'today', '--brief', '--json'])
    assert.equal(out.status, 0, out.stderr)
    const envelope = JSON.parse(out.stdout) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> }
    assert.equal(envelope.data.length, 1)
    assert.deepEqual(Object.keys(envelope.data[0] ?? {}).sort(), ['id', 'project', 'seconds', 'start', 'stop', 'title'])
    assert.equal(envelope.data[0]?.['title'], 'Brief work')
    assert.equal(envelope.data[0]?.['project'], 'Kit')
    assert.equal(envelope.data[0]?.['stop'], null)
    assert.deepEqual(Object.keys(envelope.meta).sort(), ['entryCount', 'totalSeconds', 'warnings'])

    const text = run(dir, ['entries', 'today', '--brief'])
    assert.match(text.stdout, /^\d+\tBrief work\tKit\t/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
