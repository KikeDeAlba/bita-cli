import './helpers/isolate.ts'
import { SESSION_SANDBOX, addProject, openContext } from './helpers/session-env.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LocalContext } from '../src/cli/local-context.ts'
import { findEntryById, listRunning } from '../src/db/entries.ts'
import { findSessionByEntry } from '../src/db/sessions.ts'
import {
  childEnv,
  closeWrapper,
  currentSessionEntryId,
  handleSessionEnd,
  handleSessionStart,
  startSessionEntry,
  sweepOrphans,
  wrapperEnv,
  type SessionDeps,
  type WrapperEnv,
} from '../src/domain/session.ts'

interface Harnessed {
  ctx: LocalContext
  env: WrapperEnv
  spawned: number[]
  deps: SessionDeps
}

async function setup(harness: WrapperEnv['harness'] = 'claude'): Promise<Harnessed> {
  const dir = mkdtempSync(join(SESSION_SANDBOX, 'domain-'))
  const ctx = await openContext(join(dir, 'bita.db'))
  addProject(ctx.db, 7, 'Apps')
  const spawned: number[] = []
  return {
    ctx,
    env: { wrapperId: 'w-1', harness, projectId: 7 },
    spawned,
    deps: { spawnFinalize: (entryId) => spawned.push(entryId) },
  }
}

async function started(h: Harnessed): Promise<number> {
  const { entryId } = await startSessionEntry(h.ctx, {
    wrapperId: h.env.wrapperId,
    wrapperPid: process.pid,
    harness: h.env.harness,
    projectId: h.env.projectId,
    cwd: '/tmp/app',
  })
  return entryId
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

test('wrapperEnv needs a wrapper id, a known harness and a project, and never inside a child', () => {
  const base = { BITA_WRAPPER_ID: 'w', BITA_HARNESS: 'codex', BITA_SESSION_PROJECT: '3' }
  assert.deepEqual(wrapperEnv(base), { wrapperId: 'w', harness: 'codex', projectId: 3 })
  assert.equal(wrapperEnv({ ...base, BITA_CHILD: '1' }), null)
  assert.notEqual(wrapperEnv({ ...base, BITA_CHILD: '0' }), null)
  assert.equal(wrapperEnv({ ...base, BITA_HARNESS: 'cursor' }), null)
  assert.equal(wrapperEnv({ ...base, BITA_SESSION_PROJECT: '0' }), null)
  assert.equal(wrapperEnv({ BITA_HARNESS: 'claude', BITA_SESSION_PROJECT: '3' }), null)
  const child = childEnv({ ...base, CLAUDECODE: '1', KEEP: 'x' })
  assert.equal(child['BITA_CHILD'], '1')
  assert.equal(child['BITA_WRAPPER_ID'], undefined)
  assert.equal(child['CLAUDECODE'], undefined)
  assert.equal(child['KEEP'], 'x')
})

test('startSessionEntry opens a draft session entry with its row', async () => {
  const h = await setup()
  try {
    const entryId = await started(h)
    const entry = findEntryById(h.ctx.db, entryId)
    assert.equal(entry?.source, 'session')
    assert.equal(entry?.description, '')
    assert.equal(entry?.projectId, 7)
    const row = findSessionByEntry(h.ctx.db, entryId)
    assert.equal(row?.wrapperId, 'w-1')
    assert.equal(row?.sessionId, null)
    assert.equal(currentSessionEntryId(h.ctx.db, h.env), entryId)
    assert.equal(currentSessionEntryId(h.ctx.db, null), null)
  } finally {
    h.ctx.db.close()
  }
})

test('session-start links the first session, keeps the same one and ignores compact, other harnesses and nested startups', async () => {
  const h = await setup()
  try {
    const entryId = await started(h)
    const input = { harness: 'claude' as const, sessionId: 's1', transcriptPath: null, cwd: '/tmp/app', source: 'startup' }

    assert.deepEqual(await handleSessionStart(h.ctx, h.env, { ...input, harness: 'codex' }, h.deps), { action: 'ignored', endedEntryIds: [] })
    assert.deepEqual(await handleSessionStart(h.ctx, h.env, { ...input, source: 'compact' }, h.deps), { action: 'ignored', endedEntryIds: [] })

    const linked = await handleSessionStart(h.ctx, h.env, input, h.deps)
    assert.deepEqual(linked, { action: 'linked', entryId, endedEntryIds: [] })

    const same = await handleSessionStart(h.ctx, h.env, { ...input, transcriptPath: '/tmp/s1.jsonl', source: 'resume' }, h.deps)
    assert.deepEqual(same, { action: 'same', entryId, endedEntryIds: [] })
    assert.equal(findSessionByEntry(h.ctx.db, entryId)?.transcriptPath, '/tmp/s1.jsonl')

    const nested = await handleSessionStart(h.ctx, h.env, { ...input, sessionId: 'nested' }, h.deps)
    assert.deepEqual(nested, { action: 'ignored', endedEntryIds: [] })
    assert.equal(listRunning(h.ctx.db).length, 1)
    assert.deepEqual(h.spawned, [])
  } finally {
    h.ctx.db.close()
  }
})

test('a resume at launch links the unlinked row instead of rotating', async () => {
  const h = await setup()
  try {
    const entryId = await started(h)
    const result = await handleSessionStart(
      h.ctx,
      h.env,
      { harness: 'claude', sessionId: 'old', transcriptPath: null, cwd: '/tmp/app', source: 'resume' },
      h.deps,
    )
    assert.deepEqual(result, { action: 'linked', entryId, endedEntryIds: [] })
  } finally {
    h.ctx.db.close()
  }
})

test('/clear in Claude order: SessionEnd(clear) then SessionStart(clear) rotates to a new entry', async () => {
  const h = await setup()
  try {
    const first = await started(h)
    await handleSessionStart(h.ctx, h.env, { harness: 'claude', sessionId: 's1', transcriptPath: null, cwd: '/tmp/app', source: 'startup' }, h.deps)

    assert.equal(await handleSessionEnd(h.ctx, h.env, { harness: 'claude', sessionId: 's1', reason: 'clear' }, h.deps), first)
    assert.equal(findSessionByEntry(h.ctx.db, first)?.endReason, 'clear')
    assert.deepEqual(h.spawned, [first])

    const rotated = await handleSessionStart(h.ctx, h.env, { harness: 'claude', sessionId: 's2', transcriptPath: '/tmp/s2.jsonl', cwd: '/tmp/app', source: 'clear' }, h.deps)
    assert.equal(rotated.action, 'rotated')
    assert.deepEqual(rotated.endedEntryIds, [])
    assert.notEqual(rotated.entryId, first)
    const row = findSessionByEntry(h.ctx.db, rotated.entryId ?? 0)
    assert.equal(row?.sessionId, 's2')
    assert.equal(row?.wrapperPid, process.pid)
    assert.equal(findEntryById(h.ctx.db, rotated.entryId ?? 0)?.projectId, 7)
    assert.equal(currentSessionEntryId(h.ctx.db, h.env), rotated.entryId)
  } finally {
    h.ctx.db.close()
  }
})

test('/clear in Codex order: SessionStart(clear) ends the old row, then SessionEnd(other) only relaunches finalize', async () => {
  const h = await setup('codex')
  try {
    const first = await started(h)
    await handleSessionStart(h.ctx, h.env, { harness: 'codex', sessionId: 'a', transcriptPath: null, cwd: '/tmp/app', source: 'startup' }, h.deps)

    const rotated = await handleSessionStart(h.ctx, h.env, { harness: 'codex', sessionId: 'b', transcriptPath: null, cwd: '/tmp/app', source: 'clear' }, h.deps)
    assert.equal(rotated.action, 'rotated')
    assert.deepEqual(rotated.endedEntryIds, [first])
    assert.equal(findSessionByEntry(h.ctx.db, first)?.endReason, 'rotated')
    assert.deepEqual(h.spawned, [first])

    assert.equal(await handleSessionEnd(h.ctx, h.env, { harness: 'codex', sessionId: 'a', reason: 'other' }, h.deps), first)
    assert.equal(findSessionByEntry(h.ctx.db, first)?.endReason, 'rotated')
    assert.deepEqual(h.spawned, [first, first])
  } finally {
    h.ctx.db.close()
  }
})

test('session-end ignores unknown sessions and other harnesses', async () => {
  const h = await setup()
  try {
    await started(h)
    await handleSessionStart(h.ctx, h.env, { harness: 'claude', sessionId: 's1', transcriptPath: null, cwd: '/tmp/app', source: 'startup' }, h.deps)
    assert.equal(await handleSessionEnd(h.ctx, h.env, { harness: 'claude', sessionId: 'nested', reason: 'other' }, h.deps), null)
    assert.equal(await handleSessionEnd(h.ctx, h.env, { harness: 'gemini', sessionId: 's1', reason: 'other' }, h.deps), null)
    assert.deepEqual(h.spawned, [])
  } finally {
    h.ctx.db.close()
  }
})

test('closeWrapper ends the open rows with exit and finalizes every unfinalized one', async () => {
  const h = await setup()
  try {
    const first = await started(h)
    await handleSessionStart(h.ctx, h.env, { harness: 'claude', sessionId: 's1', transcriptPath: null, cwd: '/tmp/app', source: 'startup' }, h.deps)
    await handleSessionEnd(h.ctx, h.env, { harness: 'claude', sessionId: 's1', reason: 'clear' }, h.deps)
    const second = (await handleSessionStart(h.ctx, h.env, { harness: 'claude', sessionId: 's2', transcriptPath: null, cwd: '/tmp/app', source: 'clear' }, h.deps)).entryId
    h.spawned.length = 0

    assert.deepEqual(await closeWrapper(h.ctx, 'w-1', h.deps), [first, second])
    assert.deepEqual(h.spawned, [first, second])
    assert.equal(findSessionByEntry(h.ctx.db, second ?? 0)?.endReason, 'exit')
    assert.equal(findSessionByEntry(h.ctx.db, first)?.endReason, 'clear')
    assert.equal(currentSessionEntryId(h.ctx.db, h.env), null)
  } finally {
    h.ctx.db.close()
  }
})

test('sweepOrphans closes rows whose wrapper died, at the transcript mtime, and leaves live ones alone', async () => {
  const h = await setup()
  try {
    const live = await started(h)
    const dead = deadPid()
    const transcript = join(SESSION_SANDBOX, `orphan-${dead}.jsonl`)
    writeFileSync(transcript, '{}\n')
    const { entryId: orphan } = await startSessionEntry(h.ctx, {
      wrapperId: 'w-dead',
      wrapperPid: dead,
      harness: 'claude',
      projectId: 7,
      cwd: '/tmp/app',
      sessionId: 'x',
      transcriptPath: transcript,
    })
    const mtime = new Date(Date.now() + 5_000)
    utimesSync(transcript, mtime, mtime)

    assert.deepEqual(await sweepOrphans(h.ctx, h.deps), [orphan])
    const row = findSessionByEntry(h.ctx.db, orphan)
    assert.equal(row?.endReason, 'orphan')
    assert.equal(row?.endedAt, mtime.toISOString())
    assert.equal(findSessionByEntry(h.ctx.db, live)?.endedAt, null)
    assert.deepEqual(h.spawned, [orphan])
  } finally {
    h.ctx.db.close()
  }
})

test('sweepOrphans relaunches rows ended long ago that nobody finalized', async () => {
  const h = await setup()
  try {
    const entryId = await started(h)
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    h.ctx.db.prepare('UPDATE entry_sessions SET started_at = ?, ended_at = ?, end_reason = ? WHERE entry_id = ?').run(old, old, 'exit', entryId)
    const recent = await started(h)
    h.ctx.db.prepare('UPDATE entry_sessions SET ended_at = started_at, end_reason = ? WHERE entry_id = ?').run('exit', recent)

    assert.deepEqual(await sweepOrphans(h.ctx, { ...h.deps, isAlive: () => true }), [entryId])
  } finally {
    h.ctx.db.close()
  }
})
