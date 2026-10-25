import './helpers/isolate.ts'
import { SESSION_SANDBOX, addProject, openContext } from './helpers/session-env.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LocalContext } from '../src/cli/local-context.ts'
import { findEntryById, listRunning } from '../src/db/entries.ts'
import { findSessionByEntry, findSessionById, listSessions } from '../src/db/sessions.ts'
import { recordTouch } from '../src/db/touches.ts'
import {
  childEnv,
  closeWrapper,
  currentSessionEntryId,
  handleSessionEnd,
  handleSessionStart,
  startSessionEntry,
  sweepOrphans,
  wrapperAlive,
  wrapperEnv,
  type SessionDeps,
  type WrapperEnv,
} from '../src/domain/session.ts'

interface Harnessed {
  ctx: LocalContext
  env: WrapperEnv & { projectId: number }
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

test('wrapperEnv needs a wrapper id, a known harness and a project or 0 for no timer, and never inside a child', () => {
  const base = { BITA_WRAPPER_ID: 'w', BITA_HARNESS: 'codex', BITA_SESSION_PROJECT: '3' }
  assert.deepEqual(wrapperEnv(base), { wrapperId: 'w', harness: 'codex', projectId: 3 })
  assert.equal(wrapperEnv({ ...base, BITA_CHILD: '1' }), null)
  assert.notEqual(wrapperEnv({ ...base, BITA_CHILD: '0' }), null)
  assert.equal(wrapperEnv({ ...base, BITA_HARNESS: 'cursor' }), null)
  assert.deepEqual(wrapperEnv({ ...base, BITA_SESSION_PROJECT: '0' }), { wrapperId: 'w', harness: 'codex', projectId: null })
  assert.equal(wrapperEnv({ ...base, BITA_SESSION_PROJECT: '' }), null)
  assert.equal(wrapperEnv({ ...base, BITA_SESSION_PROJECT: '-1' }), null)
  assert.equal(wrapperEnv({ BITA_WRAPPER_ID: 'w', BITA_HARNESS: 'codex' }), null)
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

test('sweepOrphans without a transcript ends at the last touch, or at the sweep when there is none', async () => {
  const h = await setup()
  try {
    const dead = deadPid()
    const orphan = async (wrapperId: string): Promise<number> => {
      const { entryId } = await startSessionEntry(h.ctx, { wrapperId, wrapperPid: dead, harness: 'claude', projectId: 7, cwd: '/tmp/app' })
      const start = new Date(Date.now() - 3 * 3_600_000).toISOString()
      h.ctx.db.prepare('UPDATE entry_sessions SET started_at = ? WHERE entry_id = ?').run(start, entryId)
      h.ctx.db.prepare('UPDATE entries SET started_at = ? WHERE id = ?').run(start, entryId)
      return entryId
    }
    const touched = await orphan('w-touched')
    const touchAt = new Date(Date.now() - 3_600_000).toISOString()
    recordTouch(h.ctx.db, touched, '/tmp/app/a.ts', new Date(Date.now() - 2 * 3_600_000).toISOString())
    recordTouch(h.ctx.db, touched, '/tmp/app/b.ts', touchAt)
    const bare = await orphan('w-bare')
    const before = Date.now()

    assert.deepEqual(await sweepOrphans(h.ctx, h.deps), [touched, bare])
    assert.equal(findSessionByEntry(h.ctx.db, touched)?.endedAt, touchAt)
    const bareEnd = Date.parse(findSessionByEntry(h.ctx.db, bare)?.endedAt ?? '')
    assert.ok(bareEnd >= before - 1_000 && bareEnd <= Date.now(), String(bareEnd))
  } finally {
    h.ctx.db.close()
  }
})

test('a live pid that started after the row is a reused pid, so the row is an orphan', async () => {
  assert.equal(wrapperAlive(process.pid, new Date().toISOString()), true)
  assert.equal(wrapperAlive(process.pid, '2000-01-01T00:00:00.000Z'), false)
  assert.equal(wrapperAlive(deadPid(), '2000-01-01T00:00:00.000Z'), false)

  const h = await setup()
  try {
    const entryId = await started(h)
    h.ctx.db.prepare('UPDATE entry_sessions SET started_at = ? WHERE entry_id = ?').run('2000-01-01T00:00:00.000Z', entryId)
    const fresh = await started(h)
    assert.deepEqual(await sweepOrphans(h.ctx, h.deps), [entryId])
    assert.equal(findSessionByEntry(h.ctx.db, entryId)?.endReason, 'orphan')
    assert.equal(findSessionByEntry(h.ctx.db, fresh)?.endedAt, null)
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

async function timerless(h: Harnessed, wrapperId = 'w-free', wrapperPid = process.pid): Promise<{ env: WrapperEnv; rowId: number }> {
  const env: WrapperEnv = { wrapperId, harness: 'claude', projectId: null }
  const { entryId, rowId } = await startSessionEntry(h.ctx, { wrapperId, wrapperPid, harness: 'claude', projectId: null, cwd: '/tmp/free' })
  assert.equal(entryId, null)
  return { env, rowId }
}

test('a session without a timer records its row and no entry', async () => {
  const h = await setup()
  try {
    const { env, rowId } = await timerless(h)
    const row = findSessionById(h.ctx.db, rowId)
    assert.equal(row?.entryId, null)
    assert.equal(row?.wrapperId, 'w-free')
    assert.equal(row?.wrapperPid, process.pid)
    assert.equal(row?.cwd, '/tmp/free')
    assert.equal(row?.endedAt, null)
    assert.equal(listRunning(h.ctx.db).length, 0)
    assert.equal(currentSessionEntryId(h.ctx.db, env), null)
    const [listed] = listSessions(h.ctx.db, { cwd: null, open: true, harness: null, limit: 10 })
    assert.equal(listed?.id, rowId)
    assert.equal(listed?.entryId, null)
    assert.equal(listed?.entry, null)
  } finally {
    h.ctx.db.close()
  }
})

test('session hooks link, rotate and end a session without a timer and never finalize it', async () => {
  const h = await setup()
  try {
    const { env, rowId } = await timerless(h)
    const input = { harness: 'claude' as const, sessionId: 's1', transcriptPath: '/tmp/s1.jsonl', cwd: '/tmp/free', source: 'startup' }
    assert.deepEqual(await handleSessionStart(h.ctx, env, input, h.deps), { action: 'linked', entryId: null, endedEntryIds: [] })
    assert.equal(findSessionById(h.ctx.db, rowId)?.sessionId, 's1')
    assert.equal(findSessionById(h.ctx.db, rowId)?.transcriptPath, '/tmp/s1.jsonl')

    const rotated = await handleSessionStart(h.ctx, env, { ...input, sessionId: 's2', transcriptPath: null, source: 'clear' }, h.deps)
    assert.deepEqual(rotated, { action: 'rotated', entryId: null, endedEntryIds: [] })
    assert.equal(findSessionById(h.ctx.db, rowId)?.endReason, 'rotated')
    assert.equal(listRunning(h.ctx.db).length, 0)

    assert.equal(await handleSessionEnd(h.ctx, env, { harness: 'claude', sessionId: 's2', reason: 'other' }, h.deps), null)
    const rows = listSessions(h.ctx.db, { cwd: '/tmp/free', open: false, harness: null, limit: 10 })
    assert.deepEqual(rows.map((row) => [row.sessionId, row.open, row.entry]), [['s2', false, null], ['s1', false, null]])
    assert.deepEqual(h.spawned, [])
  } finally {
    h.ctx.db.close()
  }
})

test('closeWrapper ends a session without a timer and launches no finalize', async () => {
  const h = await setup()
  try {
    const { rowId } = await timerless(h)
    assert.deepEqual(await closeWrapper(h.ctx, 'w-free', h.deps), [])
    assert.equal(findSessionById(h.ctx.db, rowId)?.endReason, 'exit')
    assert.equal(findSessionById(h.ctx.db, rowId)?.finalizedAt, null)
    assert.deepEqual(h.spawned, [])
  } finally {
    h.ctx.db.close()
  }
})

test('sweepOrphans ends a dead session without a timer or transcript at its start, not at the sweep', async () => {
  const h = await setup()
  try {
    const { rowId } = await timerless(h, 'w-bare-free', deadPid())
    const start = new Date(Date.now() - 3 * 3_600_000).toISOString()
    h.ctx.db.prepare('UPDATE entry_sessions SET started_at = ? WHERE id = ?').run(start, rowId)

    assert.deepEqual(await sweepOrphans(h.ctx, h.deps), [])
    const row = findSessionById(h.ctx.db, rowId)
    assert.equal(row?.endReason, 'orphan')
    assert.equal(row?.endedAt, start)
  } finally {
    h.ctx.db.close()
  }
})

test('sweepOrphans closes a dead session without a timer and never relaunches it', async () => {
  const h = await setup()
  try {
    const dead = await timerless(h, 'w-dead', deadPid())
    const old = await timerless(h, 'w-old')
    const long = new Date(Date.now() - 60 * 60_000).toISOString()
    h.ctx.db.prepare('UPDATE entry_sessions SET started_at = ?, ended_at = ?, end_reason = ? WHERE id = ?').run(long, long, 'exit', old.rowId)
    const live = await timerless(h, 'w-live')

    assert.deepEqual(await sweepOrphans(h.ctx, { ...h.deps, isAlive: (pid) => pid === process.pid }), [])
    assert.equal(findSessionById(h.ctx.db, dead.rowId)?.endReason, 'orphan')
    assert.equal(findSessionById(h.ctx.db, live.rowId)?.endedAt, null)
    assert.equal(findSessionById(h.ctx.db, old.rowId)?.endReason, 'exit')
    assert.deepEqual(h.spawned, [])
  } finally {
    h.ctx.db.close()
  }
})
