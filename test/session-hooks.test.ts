import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { openDatabase } from '../src/db/open.ts'
import { findEntryById, insertEntry } from '../src/db/entries.ts'
import { findSessionByEntry, insertEntrySession } from '../src/db/sessions.ts'
import { listTouches } from '../src/db/touches.ts'
import type { HarnessId } from '../src/harness/types.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

interface Box {
  dir: string
  db: string
  entryId: number
}

function box(harness: HarnessId, startedMinutesAgo = 0): Box {
  const dir = mkdtempSync(join(tmpdir(), 'bita-session-hooks-'))
  mkdirSync(join(dir, 'empty-path'))
  const path = join(dir, 'bita.db')
  const db = openDatabase(path)
  const at = new Date(Date.now() - startedMinutesAgo * 60_000).toISOString()
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (7, ?, ?)').run('Apps', at)
  const entry = insertEntry(db, { description: '', projectId: 7, startedAt: at, source: 'session', now: at })
  insertEntrySession(db, { entryId: entry.id, wrapperId: 'w-1', wrapperPid: process.pid, harness, cwd: dir, startedAt: at })
  db.close()
  return { dir, db: path, entryId: entry.id }
}

function baseEnv(b: Box): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: b.dir,
    USERPROFILE: b.dir,
    PATH: join(b.dir, 'empty-path'),
    BITA_DB_PATH: b.db,
    BITA_CONFIG_PATH: join(b.dir, 'config.json'),
    KIT_NO_EVENTS: '1',
    KIT_REGISTRY_DIR: join(b.dir, 'registry'),
    BITA_HARNESS_BIN_CLAUDE: join(b.dir, 'missing'),
    BITA_HARNESS_BIN_CODEX: join(b.dir, 'missing'),
    BITA_HARNESS_BIN_GEMINI: join(b.dir, 'missing'),
    BITA_HARNESS_BIN_OPENCODE: join(b.dir, 'missing'),
    BITA_HARNESS_BIN_ANTIGRAVITY: join(b.dir, 'missing'),
  }
  delete env['KIT_HEADLESS']
  delete env['ANTIGRAVITY_CONVERSATION_ID']
  for (const key of ['BITA_WRAPPER_ID', 'BITA_HARNESS', 'BITA_SESSION_PROJECT', 'BITA_CHILD', 'CLAUDECODE']) delete env[key]
  return env
}

function wrapped(b: Box, harness: HarnessId): NodeJS.ProcessEnv {
  return { ...baseEnv(b), BITA_WRAPPER_ID: 'w-1', BITA_HARNESS: harness, BITA_SESSION_PROJECT: '7' }
}

function hook(b: Box, args: string[], input: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, 'hook', ...args], { cwd: b.dir, encoding: 'utf8', input, env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function session(b: Box) {
  const db = openDatabase(b.db)
  try {
    return findSessionByEntry(db, b.entryId)
  } finally {
    db.close()
  }
}

function silent(result: { status: number | null; stdout: string; stderr: string }): void {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
}

test('every hook exits 0 and prints nothing, with garbage, empty stdin or no wrapper', () => {
  const b = box('claude')
  try {
    const events = [['session-start'], ['session-end'], ['codex'], ['gemini'], ['prompt'], ['prompt-submit'], ['checkpoint'], ['touched'], ['nope']]
    for (const args of events) {
      for (const input of ['', 'not json', '[1,2]', '{"hook_event_name":"SessionStart"}', '{"session_id":7}']) {
        silent(hook(b, args, input, baseEnv(b)))
        silent(hook(b, args, input, wrapped(b, 'claude')))
      }
    }
    silent(hook(b, ['session-start', '--harness', 'cursor'], '{"session_id":"s","source":"startup"}', wrapped(b, 'claude')))
    assert.equal(session(b)?.sessionId, null)
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('inside a child nothing links, even with the wrapper variables', () => {
  const b = box('claude')
  try {
    silent(hook(b, ['session-start'], JSON.stringify({ session_id: 's1', source: 'startup', cwd: b.dir }), { ...wrapped(b, 'claude'), BITA_CHILD: '1' }))
    assert.equal(session(b)?.sessionId, null)
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('Claude session-start links and session-end marks the row and launches finalize', () => {
  const b = box('claude')
  try {
    const start = { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: join(b.dir, 's1.jsonl'), cwd: b.dir, source: 'startup' }
    silent(hook(b, ['session-start'], JSON.stringify(start), wrapped(b, 'claude')))
    assert.equal(session(b)?.sessionId, 's1')
    assert.equal(session(b)?.transcriptPath, join(b.dir, 's1.jsonl'))

    silent(hook(b, ['session-end'], JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'prompt_input_exit' }), wrapped(b, 'claude')))
    assert.equal(session(b)?.endReason, 'prompt_input_exit')
    assert.notEqual(session(b)?.endedAt, null)
    assert.match(readFileSync(join(b.dir, 'hooks.log'), 'utf8'), new RegExp(`session finalize #${b.entryId} launched`))
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('codex routes SessionStart, SessionEnd and PostToolUse', () => {
  const b = box('codex')
  try {
    silent(hook(b, ['codex'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'c1', cwd: b.dir, source: 'startup' }), wrapped(b, 'codex')))
    assert.equal(session(b)?.sessionId, 'c1')

    const file = join(b.dir, 'a.ts')
    silent(hook(b, ['codex'], JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Update File: ${file}\n` } }), wrapped(b, 'codex')))
    const db = openDatabase(b.db)
    assert.deepEqual(listTouches(db, b.entryId), [file])
    db.close()

    silent(hook(b, ['codex'], JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'c1', reason: 'other' }), wrapped(b, 'codex')))
    assert.equal(session(b)?.endReason, 'other')
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('gemini routes SessionStart and SessionEnd, and ignores BeforeAgent', () => {
  const b = box('gemini')
  try {
    silent(hook(b, ['gemini'], JSON.stringify({ hook_event_name: 'BeforeAgent', session_id: 'g1' }), wrapped(b, 'gemini')))
    assert.equal(session(b)?.sessionId, null)
    silent(hook(b, ['gemini'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'g1', transcript_path: '/tmp/g1.json', cwd: b.dir, source: 'startup' }), wrapped(b, 'gemini')))
    assert.equal(session(b)?.sessionId, 'g1')
    silent(hook(b, ['gemini'], JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'g1', reason: 'exit' }), wrapped(b, 'gemini')))
    assert.equal(session(b)?.endReason, 'exit')
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('opencode goes through session-start --harness opencode, and a Claude hook in an opencode wrapper is ignored', () => {
  const b = box('opencode')
  try {
    silent(hook(b, ['session-start'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'nested', source: 'startup' }), wrapped(b, 'opencode')))
    assert.equal(session(b)?.sessionId, null)
    silent(hook(b, ['session-start', '--harness', 'opencode'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'ses_1', cwd: b.dir, source: 'startup' }), wrapped(b, 'opencode')))
    assert.equal(session(b)?.sessionId, 'ses_1')
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function finalizeRoutes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'bita-route-probe-'))
  try {
    const result = spawnSync(process.execPath, [bin, 'session', 'finalize', '999999', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, BITA_DB_PATH: join(dir, 'bita.db'), KIT_NO_EVENTS: '1', BITA_CHILD: '1' },
    })
    return result.status === 0
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

test(
  'session-end leads to a detached finalize that stops the entry with the fallback title',
  { skip: finalizeRoutes() ? false : 'bita session finalize is not routed yet (router.ts belongs to part 3a)' },
  async () => {
    const b = box('claude', 5)
    try {
      silent(hook(b, ['session-start'], JSON.stringify({ session_id: 's1', cwd: b.dir, source: 'startup' }), wrapped(b, 'claude')))
      silent(hook(b, ['session-end'], JSON.stringify({ session_id: 's1', reason: 'prompt_input_exit' }), wrapped(b, 'claude')))
      const deadline = Date.now() + 10_000
      let stopped: string | null = null
      let title = ''
      while (Date.now() < deadline) {
        const db = openDatabase(b.db)
        const entry = findEntryById(db, b.entryId)
        db.close()
        stopped = entry?.stoppedAt ?? null
        title = entry?.description ?? ''
        if (stopped !== null && session(b)?.finalizedAt) break
        await sleep(200)
      }
      assert.notEqual(stopped, null, existsSync(join(b.dir, 'hooks.log')) ? readFileSync(join(b.dir, 'hooks.log'), 'utf8') : 'no hooks.log')
      assert.match(title, /^Sesión Claude · /)
      assert.equal(session(b)?.outcome, 'fallback')
    } finally {
      rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  },
)

test('hooks of a headless run (KIT_HEADLESS=1) record nothing', () => {
  const b = box('gemini')
  try {
    const env = { ...wrapped(b, 'gemini'), KIT_HEADLESS: '1' }
    silent(hook(b, ['gemini'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'g1', cwd: b.dir, source: 'startup' }), env))
    silent(hook(b, ['session-start', '--harness', 'gemini'], JSON.stringify({ session_id: 'g1', cwd: b.dir, source: 'startup' }), env))
    assert.equal(session(b)?.sessionId, null)
    silent(hook(b, ['gemini'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'g1', cwd: b.dir, source: 'startup' }), { ...env, KIT_HEADLESS: '0' }))
    assert.equal(session(b)?.sessionId, 'g1')
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('any bita run inside agy links the antigravity conversation of the wrapper', () => {
  const b = box('antigravity')
  try {
    const env = { ...wrapped(b, 'antigravity'), ANTIGRAVITY_CONVERSATION_ID: 'conv-1' }
    const listed = spawnSync(process.execPath, [bin, 'ls', '--json'], { cwd: b.dir, encoding: 'utf8', env })
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(session(b)?.sessionId, 'conv-1')
    assert.equal(session(b)?.transcriptPath, join(b.dir, '.gemini', 'antigravity-cli', 'conversations', 'conv-1.db'))
    spawnSync(process.execPath, [bin, 'ls', '--json'], { cwd: b.dir, encoding: 'utf8', env: { ...env, ANTIGRAVITY_CONVERSATION_ID: 'conv-2' } })
    assert.equal(session(b)?.sessionId, 'conv-1')
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('an invalid conversation id in the environment is never linked', () => {
  const b = box('antigravity')
  try {
    for (const id of ['../../x', '-x']) {
      spawnSync(process.execPath, [bin, 'ls', '--json'], { cwd: b.dir, encoding: 'utf8', env: { ...wrapped(b, 'antigravity'), ANTIGRAVITY_CONVERSATION_ID: id } })
      assert.equal(session(b)?.sessionId, null)
    }
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('the conversation id is ignored outside an antigravity wrapper', () => {
  const b = box('gemini')
  try {
    const env = { ...wrapped(b, 'gemini'), ANTIGRAVITY_CONVERSATION_ID: 'conv-1' }
    spawnSync(process.execPath, [bin, 'ls', '--json'], { cwd: b.dir, encoding: 'utf8', env })
    assert.equal(session(b)?.sessionId, null)
  } finally {
    rmSync(b.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
