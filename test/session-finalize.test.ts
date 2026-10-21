import './helpers/isolate.ts'
import { SESSION_SANDBOX, addProject, openContext } from './helpers/session-env.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LocalContext } from '../src/cli/local-context.ts'
import { findEntryById, insertEntry, updateEntry } from '../src/db/entries.ts'
import { findSessionByEntry } from '../src/db/sessions.ts'
import { finalizeEntry, type FinalizeDeps } from '../src/domain/finalize.ts'
import { startSessionEntry } from '../src/domain/session.ts'
import type { HarnessAdapter, SessionSummary, SummaryInput, SummaryResult, Turn } from '../src/harness/types.ts'

const SUMMARY: SessionSummary = {
  title: 'Wire the session finalizer',
  kind: 'feature',
  note: { context: 'ctx', done: 'did it', decisions: null, findings: 'found', verification: null, pending: null },
}

interface Recorder {
  calls: string[]
  summaries: SummaryInput[]
  deps: Partial<FinalizeDeps>
}

function fakeAdapter(rec: Recorder, turns: Turn[] | Error, result: SummaryResult | Error): HarnessAdapter {
  return {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    defaultSummaryModel: 'haiku',
    resolveBin: () => '/bin/claude',
    available: () => true,
    launchArgs: (args) => ({ args: [...args], warnings: [] }),
    extractTranscript: async () => {
      rec.calls.push('transcript')
      if (turns instanceof Error) throw turns
      return turns
    },
    summarize: async (input) => {
      rec.calls.push('summarize')
      rec.summaries.push(input)
      if (result instanceof Error) throw result
      return result
    },
  }
}

function recorder(turns: Turn[] | Error = [{ role: 'user', text: 'hola' }], result: SummaryResult | Error = { ok: true, summary: SUMMARY }): Recorder {
  const rec: Recorder = { calls: [], summaries: [], deps: {} }
  rec.deps = {
    getAdapter: () => fakeAdapter(rec, turns, result),
    writeNote: async (_id, note) => {
      rec.calls.push(`note:${note.context}`)
      return { written: 3, error: null }
    },
    emit: async (_ctx, payloads) => {
      for (const payload of payloads) rec.calls.push(`emit:${payload.event}`)
      return payloads.length
    },
    log: async () => undefined,
  }
  return rec
}

async function context(): Promise<LocalContext> {
  const dir = mkdtempSync(join(SESSION_SANDBOX, 'finalize-'))
  const ctx = await openContext(join(dir, 'bita.db'))
  addProject(ctx.db, 7, 'Apps')
  return ctx
}

async function sessionEntry(ctx: LocalContext, minutesAgo: number, endedMinutesAgo: number | null): Promise<number> {
  const { entryId } = await startSessionEntry(ctx, {
    wrapperId: 'w',
    wrapperPid: process.pid,
    harness: 'claude',
    projectId: 7,
    cwd: join(SESSION_SANDBOX, 'no-repo'),
    sessionId: 's',
  })
  const start = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const end = endedMinutesAgo === null ? null : new Date(Date.now() - endedMinutesAgo * 60_000).toISOString()
  ctx.db.prepare('UPDATE entries SET started_at = ? WHERE id = ?').run(start, entryId)
  ctx.db.prepare('UPDATE entry_sessions SET started_at = ?, ended_at = ?, end_reason = ? WHERE entry_id = ?').run(start, end, end ? 'clear' : null, entryId)
  return entryId
}

test('a summarized session writes the notes, then amends, then stops at ended_at', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    const ended = findSessionByEntry(ctx.db, id)?.endedAt
    const rec = recorder()
    const report = await finalizeEntry(ctx, id, rec.deps)

    assert.equal(report.status, 'summarized')
    assert.equal(report.title, SUMMARY.title)
    assert.equal(report.kind, 'feature')
    assert.equal(report.notesWritten, 3)
    assert.deepEqual(rec.calls, ['transcript', 'summarize', 'note:ctx', 'emit:amend', 'emit:stop'])
    const entry = findEntryById(ctx.db, id)
    assert.equal(entry?.description, SUMMARY.title)
    assert.equal(entry?.kind, 'feature')
    assert.equal(entry?.stoppedAt, ended)
    const row = findSessionByEntry(ctx.db, id)
    assert.equal(row?.outcome, 'summarized')
    assert.notEqual(row?.finalizedAt, null)
    assert.equal(rec.summaries[0]?.meta.projectName, 'Apps')
    assert.equal(rec.summaries[0]?.model, null)
  } finally {
    ctx.db.close()
  }
})

test('a failing or throwing summary falls back to the generic title and still stops', async () => {
  for (const result of [{ ok: false as const, error: 'no structured_output' }, new Error('boom')]) {
    const ctx = await context()
    try {
      const id = await sessionEntry(ctx, 30, 5)
      const rec = recorder(undefined, result)
      const report = await finalizeEntry(ctx, id, rec.deps)
      assert.equal(report.status, 'fallback')
      assert.match(report.title ?? '', /^Sesión Claude · no-repo$/)
      assert.match(report.error ?? '', /no structured_output|boom/)
      assert.deepEqual(rec.calls, ['transcript', 'summarize', 'emit:amend', 'emit:stop'])
      assert.notEqual(findEntryById(ctx.db, id)?.stoppedAt, null)
      assert.equal(findSessionByEntry(ctx.db, id)?.outcome, 'fallback')
    } finally {
      ctx.db.close()
    }
  }
})

test('an adapter that throws everywhere still leaves the entry stopped', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    const rec = recorder()
    rec.deps.getAdapter = () => {
      throw new Error('not implemented: claude')
    }
    rec.deps.emit = async () => {
      throw new Error('emit broke')
    }
    const report = await finalizeEntry(ctx, id, rec.deps)
    assert.equal(report.status, 'fallback')
    const entry = findEntryById(ctx.db, id)
    assert.notEqual(entry?.stoppedAt, null)
    assert.match(entry?.description ?? '', /^Sesión Claude/)
    assert.equal(findSessionByEntry(ctx.db, id)?.outcome, 'fallback')
  } finally {
    ctx.db.close()
  }
})

test('a session shorter than a minute with no prompts is cancelled', async () => {
  const ctx = await context()
  try {
    const id = await startSessionEntry(ctx, { wrapperId: 'w', wrapperPid: process.pid, harness: 'claude', projectId: 7, cwd: '/tmp' })
    const rec = recorder([{ role: 'assistant', text: 'hi' }])
    const report = await finalizeEntry(ctx, id.entryId, rec.deps)
    assert.equal(report.status, 'cancelled')
    assert.deepEqual(rec.calls, ['transcript', 'emit:cancel'])
    assert.equal(findEntryById(ctx.db, id.entryId), undefined)
    assert.equal(findSessionByEntry(ctx.db, id.entryId), undefined)
  } finally {
    ctx.db.close()
  }
})

test('a short session with a prompt is summarized, not cancelled', async () => {
  const ctx = await context()
  try {
    const { entryId } = await startSessionEntry(ctx, { wrapperId: 'w', wrapperPid: process.pid, harness: 'claude', projectId: 7, cwd: '/tmp' })
    const report = await finalizeEntry(ctx, entryId, recorder().deps)
    assert.equal(report.status, 'summarized')
    assert.notEqual(findEntryById(ctx.db, entryId)?.stoppedAt, null)
  } finally {
    ctx.db.close()
  }
})

test('a minute or more with no turns skips the model and falls back', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 3, 1)
    const rec = recorder([])
    const report = await finalizeEntry(ctx, id, rec.deps)
    assert.equal(report.status, 'fallback')
    assert.equal(report.error, 'empty transcript')
    assert.ok(!rec.calls.includes('summarize'))
  } finally {
    ctx.db.close()
  }
})

test('a title and kind set by hand are kept', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    updateEntry(ctx.db, id, { description: 'Mine', kind: 'bug' }, new Date().toISOString())
    const rec = recorder()
    const report = await finalizeEntry(ctx, id, rec.deps)
    assert.equal(report.title, 'Mine')
    assert.equal(report.kind, 'bug')
    assert.deepEqual(rec.calls, ['transcript', 'summarize', 'note:ctx', 'emit:stop'])
    assert.equal(findEntryById(ctx.db, id)?.description, 'Mine')
  } finally {
    ctx.db.close()
  }
})

test('a second finalize does nothing and emits nothing', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    await finalizeEntry(ctx, id, recorder().deps)
    const rec = recorder()
    const again = await finalizeEntry(ctx, id, rec.deps)
    assert.equal(again.status, 'already-finalized')
    assert.deepEqual(rec.calls, [])
  } finally {
    ctx.db.close()
  }
})

test('a fresh lease is busy and a stale one is taken over', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    ctx.db.prepare('UPDATE entry_sessions SET claimed_at = ? WHERE entry_id = ?').run(new Date(Date.now() - 60_000).toISOString(), id)
    const busy = recorder()
    assert.equal((await finalizeEntry(ctx, id, busy.deps)).status, 'busy')
    assert.deepEqual(busy.calls, [])

    ctx.db.prepare('UPDATE entry_sessions SET claimed_at = ? WHERE entry_id = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), id)
    assert.equal((await finalizeEntry(ctx, id, recorder().deps)).status, 'summarized')
  } finally {
    ctx.db.close()
  }
})

test('a merged segment is skipped and an unknown entry is not found', async () => {
  const ctx = await context()
  try {
    const id = await sessionEntry(ctx, 30, 5)
    const now = new Date().toISOString()
    const target = insertEntry(ctx.db, { description: 'Target', projectId: 7, startedAt: now, stoppedAt: now, source: 'manual', now })
    ctx.db.prepare('UPDATE entries SET merged_into = ? WHERE id = ?').run(target.id, id)
    const rec = recorder()
    assert.equal((await finalizeEntry(ctx, id, rec.deps)).status, 'skipped')
    assert.deepEqual(rec.calls, [])
    assert.equal(findSessionByEntry(ctx.db, id)?.outcome, 'skipped')
    assert.equal((await finalizeEntry(ctx, 9999, rec.deps)).status, 'not-found')
  } finally {
    ctx.db.close()
  }
})

test('the summary model comes from config summary.<harness>.model and kinds from the entries', async () => {
  const ctx = await context()
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env['BITA_CONFIG_PATH'] ?? '', JSON.stringify({ version: 1, scopeMapping: {}, summary: { claude: { model: 'sonnet' } } }))
    const now = new Date().toISOString()
    insertEntry(ctx.db, { description: 'Old', projectId: 7, startedAt: now, stoppedAt: now, source: 'manual', kind: 'research', now })
    const id = await sessionEntry(ctx, 30, 5)
    const rec = recorder()
    await finalizeEntry(ctx, id, rec.deps)
    assert.equal(rec.summaries[0]?.model, 'sonnet')
    assert.deepEqual(rec.summaries[0]?.kinds, ['research'])
  } finally {
    const { rmSync } = await import('node:fs')
    rmSync(process.env['BITA_CONFIG_PATH'] ?? '', { force: true })
    ctx.db.close()
  }
})
