import os from 'node:os'
import path from 'node:path'
import type { LocalContext } from '../cli/local-context.ts'
import { deleteEntry, findEntryWithProject, stopEntry, updateEntry } from '../db/entries.ts'
import { queryAll } from '../db/query.ts'
import type { EntryWithProjectRow } from '../db/rows.ts'
import {
  claimFinalize,
  completeFinalize,
  findSessionByEntry,
  markSessionEnded,
  type EntrySessionRow,
  type SessionOutcome,
} from '../db/sessions.ts'
import { listTouches } from '../db/touches.ts'
import { emitHooks } from '../hooks/emit.ts'
import type { HookPayload } from '../hooks/hooks.ts'
import { getAdapter } from '../harness/registry.ts'
import type { HarnessAdapter, HarnessId, SessionSummary, Turn } from '../harness/types.ts'
import { writeEntryNote, type NoteWriter } from '../integrations/inkwell.ts'
import { readConfig, type AppConfig } from '../state/config.ts'
import { readRepoContext } from '../state/git.ts'
import { appendHookLog, childEnv } from './session.ts'
import { enrichEntry } from './enrich.ts'
import { resolveRepoIdentity } from './repo.ts'

export type FinalizeStatus = 'summarized' | 'fallback' | 'cancelled' | 'skipped' | 'busy' | 'already-finalized' | 'not-found'

export interface FinalizeReport {
  entryId: number
  status: FinalizeStatus
  title: string | null
  kind: string | null
  notesWritten: number
  error: string | null
}

export interface FinalizeDeps {
  getAdapter: (id: HarnessId) => HarnessAdapter
  writeNote: NoteWriter
  emit: (ctx: LocalContext, payloads: readonly HookPayload[]) => Promise<number>
  log: (line: string) => Promise<void>
  summaryTimeoutMs: number
  summaryGraceMs: number
}

const LEASE_MS = 10 * 60_000
const CANCEL_UNDER_SECONDS = 60
const SUMMARY_TIMEOUT_MS = 180_000
const SUMMARY_GRACE_MS = 15_000

const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  gemini: 'Gemini',
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

function report(entryId: number, status: FinalizeStatus, extra: Partial<FinalizeReport> = {}): FinalizeReport {
  return { entryId, status, title: null, kind: null, notesWritten: 0, error: null, ...extra }
}

function defaultDeps(ctx: LocalContext): FinalizeDeps {
  return {
    getAdapter,
    writeNote: writeEntryNote,
    emit: emitHooks,
    log: async (line) => appendHookLog(ctx.databasePath, line),
    summaryTimeoutMs: SUMMARY_TIMEOUT_MS,
    summaryGraceMs: SUMMARY_GRACE_MS,
  }
}

function knownKinds(ctx: LocalContext, config: AppConfig): string[] {
  const stored = queryAll<{ kind: string }>(ctx.db.prepare('SELECT DISTINCT kind FROM entries WHERE kind IS NOT NULL')).map(
    (row) => row.kind,
  )
  const fromHooks = (config.hooks ?? []).flatMap((hook) => hook.when?.kind ?? [])
  return [...new Set([...stored, ...fromHooks])].sort()
}

function summaryModel(config: AppConfig, harness: HarnessId): string | null {
  const summary = config['summary']
  if (typeof summary !== 'object' || summary === null) return null
  const entry = (summary as Record<string, unknown>)[harness]
  if (typeof entry !== 'object' || entry === null) return null
  const model = (entry as Record<string, unknown>)['model']
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
}

interface RepoFacts {
  repo: string | null
  branch: string | null
}

async function repoFacts(cwd: string): Promise<RepoFacts> {
  try {
    const context = await readRepoContext(cwd)
    const identity = resolveRepoIdentity({
      cwd,
      toplevel: context.toplevel,
      home: os.homedir(),
      remoteUrl: context.remoteUrl,
      branch: context.branch,
      headSha: context.headSha,
    })
    const branch = context.branch && context.branch !== 'HEAD' ? context.branch : null
    return { repo: identity ? (identity.slug.split('/').at(-1) ?? identity.name) : null, branch }
  } catch {
    return { repo: null, branch: null }
  }
}

export function fallbackTitle(label: string, cwd: string, facts: RepoFacts): string {
  const repo = facts.repo ?? (path.basename(cwd) || cwd)
  return [`Sesión ${label}`, repo, ...(facts.branch ? [facts.branch] : [])].join(' · ')
}

function laterOf(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b
}

export async function finalizeEntry(ctx: LocalContext, entryId: number, overrides: Partial<FinalizeDeps> = {}): Promise<FinalizeReport> {
  const deps: FinalizeDeps = { ...defaultDeps(ctx), ...overrides }
  const db = ctx.db
  const now = new Date()
  const nowIso = now.toISOString()
  const log = async (line: string): Promise<void> => {
    try {
      await deps.log(`session finalize #${entryId}: ${line}`)
    } catch {
      return
    }
  }

  const initial = findSessionByEntry(db, entryId)
  if (!initial) {
    await log('no session row')
    return report(entryId, 'not-found')
  }
  if (initial.finalizedAt !== null) return report(entryId, 'already-finalized')

  if (!claimFinalize(db, entryId, nowIso, new Date(now.getTime() - LEASE_MS).toISOString())) {
    const again = findSessionByEntry(db, entryId)
    if (!again) return report(entryId, 'not-found')
    if (again.finalizedAt !== null) return report(entryId, 'already-finalized')
    await log('busy, another finalize holds the lease')
    return report(entryId, 'busy')
  }

  const entry = findEntryWithProject(db, entryId)
  if (!entry) return report(entryId, 'not-found')
  if (entry.mergedInto !== null) {
    completeFinalize(db, entryId, nowIso, 'skipped', null)
    await log(`skipped, merged into #${entry.mergedInto}`)
    return report(entryId, 'skipped', { title: entry.description || null, kind: entry.kind })
  }

  if (initial.endedAt === null) markSessionEnded(db, initial.id, nowIso, 'exit')
  const row: EntrySessionRow = findSessionByEntry(db, entryId) ?? initial
  const ended = laterOf(row.endedAt ?? nowIso, entry.startedAt)

  let adapter: HarnessAdapter | null = null
  let label = HARNESS_LABELS[row.harness]
  let facts: RepoFacts = { repo: null, branch: null }
  let summary: SessionSummary | null = null
  let failure: string | null = null
  let noteError: string | null = null
  let notesWritten = 0
  let cancelled = false
  let finalTitle: string | null = null
  let finalKind: string | null = entry.kind

  try {
    try {
      adapter = deps.getAdapter(row.harness)
      label = adapter.label
    } catch (error) {
      failure = `no adapter for ${row.harness}: ${errorText(error)}`
    }

    let turns: Turn[] = []
    if (adapter) {
      try {
        turns = await adapter.extractTranscript({
          harness: row.harness,
          sessionId: row.sessionId,
          transcriptPath: row.transcriptPath,
          cwd: row.cwd,
          startedAt: row.startedAt,
          endedAt: ended,
        })
      } catch (error) {
        failure = `transcript: ${errorText(error)}`
      }
    }

    const durationSeconds = Math.max(0, Math.round((Date.parse(ended) - Date.parse(entry.startedAt)) / 1000))
    const userTurns = turns.filter((turn) => turn.role === 'user').length
    const transcriptRead = adapter !== null && failure === null
    const mayCancel = transcriptRead && row.endReason !== 'orphan'
    if (mayCancel && durationSeconds < CANCEL_UNDER_SECONDS && userTurns === 0 && entry.description.trim().length === 0 && entry.stoppedAt === null) {
      const snapshot = enrichEntry(entry, ctx.timezone, now)
      deleteEntry(db, entryId)
      cancelled = true
      await log(`cancelled, ${durationSeconds}s with no prompts`)
      await deps.emit(ctx, [{ event: 'cancel', entry: snapshot, docPath: null }])
      return report(entryId, 'cancelled')
    }

    facts = await repoFacts(row.cwd)
    const touchedFiles = listTouches(db, entryId)
    const config = await readConfig()

    if (adapter && turns.length > 0) {
      try {
        const hardLimitMs = deps.summaryTimeoutMs + deps.summaryGraceMs
        const result = await withDeadline(adapter.summarize({
          turns,
          meta: {
            harness: row.harness,
            projectName: entry.projectName,
            repo: facts.repo,
            branch: facts.branch,
            cwd: row.cwd,
            durationSeconds,
            touchedFiles,
          },
          kinds: knownKinds(ctx, config),
          model: summaryModel(config, row.harness),
          timeoutMs: deps.summaryTimeoutMs,
        }), hardLimitMs, 'summary')
        if (result.ok) summary = result.summary
        else failure = result.error
      } catch (error) {
        failure = `summarize: ${errorText(error)}`
      }
    } else if (adapter) {
      failure = 'empty transcript'
    }
    await log(summary ? `summarized: ${summary.title}` : `fallback: ${failure ?? 'unknown error'}`)

    finalTitle = entry.description.trim() || summary?.title || fallbackTitle(label, row.cwd, facts)
    finalKind = entry.kind ?? summary?.kind ?? null
    const changed = finalTitle !== entry.description || finalKind !== entry.kind
    if (changed) updateEntry(db, entryId, { description: finalTitle, kind: finalKind }, nowIso)

    if (summary) {
      const written = await deps.writeNote(entryId, summary.note, {
        cwd: row.cwd,
        touchedFiles,
        env: { ...childEnv(), BITA_DB_PATH: ctx.databasePath },
      })
      notesWritten = written.written
      noteError = written.error
      await log(`note sections written: ${written.written}${written.error ? ` (${written.error})` : ''}`)
    }

    if (changed) {
      const current = findEntryWithProject(db, entryId)
      if (current) {
        await deps.emit(ctx, [
          {
            event: 'amend',
            entry: enrichEntry(current, ctx.timezone, now),
            previousKind: entry.kind,
            previousTitle: entry.description,
            previousProjectId: entry.projectId,
            docPath: null,
          },
        ])
      }
    }

    await stopAndEmit(ctx, deps, entryId, ended, nowIso)
    await log(`stopped at ${ended}`)
  } catch (error) {
    failure = failure ?? errorText(error)
    await log(`error: ${errorText(error)}`)
  } finally {
    if (!cancelled) {
      try {
        const current = findEntryWithProject(db, entryId)
        if (current && current.stoppedAt === null) {
          if (current.description.trim().length === 0) {
            finalTitle = fallbackTitle(label, row.cwd, facts)
            updateEntry(db, entryId, { description: finalTitle }, nowIso)
          }
          await stopAndEmit(ctx, deps, entryId, ended, nowIso)
          await log(`stopped at ${ended} after an error`)
        }
      } catch (error) {
        await log(`could not stop: ${errorText(error)}`)
      }
      const outcome: SessionOutcome = summary ? 'summarized' : 'fallback'
      const recorded = [failure, noteError].filter((part): part is string => part !== null).join('; ') || null
      completeFinalize(db, entryId, new Date().toISOString(), outcome, recorded)
    }
  }

  return report(entryId, summary ? 'summarized' : 'fallback', {
    title: finalTitle,
    kind: finalKind,
    notesWritten,
    error: [failure, noteError].filter((part): part is string => part !== null).join('; ') || null,
  })
}

async function stopAndEmit(ctx: LocalContext, deps: FinalizeDeps, entryId: number, ended: string, nowIso: string): Promise<void> {
  if (!stopEntry(ctx.db, entryId, ended, nowIso)) return
  const stopped: EntryWithProjectRow | undefined = findEntryWithProject(ctx.db, entryId)
  if (!stopped) return
  await deps.emit(ctx, [{ event: 'stop', entry: enrichEntry(stopped, ctx.timezone, new Date(nowIso)), docPath: null }])
}
