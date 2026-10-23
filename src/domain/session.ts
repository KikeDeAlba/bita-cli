import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalContext } from '../cli/local-context.ts'
import { isHarnessId } from '../harness/registry.ts'
import type { HarnessId } from '../harness/types.ts'
import { findEntryWithProject, insertEntry } from '../db/entries.ts'
import {
  fillTranscriptPath,
  findLatestByWrapper,
  findOpenByWrapper,
  findUnfinalizedByWrapper,
  findWrapperSession,
  insertEntrySession,
  linkSession,
  listOpenSessions,
  listUnfinalizedEnded,
  markSessionEnded,
} from '../db/sessions.ts'
import { lastTouchAt } from '../db/touches.ts'
import { emitHooks } from '../hooks/emit.ts'
import { hooksLogPath, type HookPayload } from '../hooks/hooks.ts'
import { binEntry } from '../kit/manifest.ts'
import { enrichEntry } from './enrich.ts'

import {
  ANTIGRAVITY_CONVERSATION_ENV,
  CHILD_ENV,
  HARNESS_ENV,
  HEADLESS_ENV,
  SESSION_PROJECT_ENV,
  WRAPPER_ID_ENV,
  withoutHarnessSession,
} from './env-names.ts'
import { isConversationId } from '../harness/antigravity-ids.ts'

export { ANTIGRAVITY_CONVERSATION_ENV, CHILD_ENV, HARNESS_ENV, HEADLESS_ENV, SESSION_PROJECT_ENV, WRAPPER_ID_ENV, withoutHarnessSession }

const SCRUBBED_ENV = [WRAPPER_ID_ENV, HARNESS_ENV, SESSION_PROJECT_ENV]

const ORPHAN_RETRY_MS = 15 * 60_000
const STALE_CLAIM_MS = 10 * 60_000
const PROCESS_START_SLACK_MS = 1_000
const PS_TIMEOUT_MS = 2_000
const UNVERIFIABLE_WRAPPER_MS = 24 * 60 * 60_000

export interface WrapperEnv {
  wrapperId: string
  harness: HarnessId
  projectId: number
}

export interface StartSessionInput {
  wrapperId: string
  wrapperPid: number
  harness: HarnessId
  projectId: number
  cwd: string
  sessionId?: string | null
  transcriptPath?: string | null
}

export type FinalizeSpawner = (entryId: number, options: { cwd: string; databasePath: string }) => void

export interface SessionDeps {
  spawnFinalize?: FinalizeSpawner
  isAlive?: (pid: number, sinceIso: string) => boolean
}

export interface SessionStartInput {
  harness: HarnessId
  sessionId: string
  transcriptPath: string | null
  cwd: string
  source: string | null
}

export interface SessionStartResult {
  action: 'linked' | 'rotated' | 'same' | 'ignored'
  entryId?: number
  endedEntryIds: number[]
}

export interface SessionEndInput {
  harness: HarnessId
  sessionId: string
  reason: string
}

export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[HEADLESS_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

export function isChild(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CHILD_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

export function wrapperEnv(env: NodeJS.ProcessEnv = process.env): WrapperEnv | null {
  if (isChild(env)) return null
  const wrapperId = env[WRAPPER_ID_ENV]
  if (!wrapperId) return null
  const harness = env[HARNESS_ENV]
  if (!isHarnessId(harness)) return null
  const projectId = Number(env[SESSION_PROJECT_ENV])
  if (!Number.isInteger(projectId) || projectId <= 0) return null
  return { wrapperId, harness, projectId }
}

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = withoutHarnessSession(env)
  for (const key of SCRUBBED_ENV) delete next[key]
  next[CHILD_ENV] = '1'
  return next
}

function immediate<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function insertSessionEntry(db: DatabaseSync, input: StartSessionInput, nowIso: string): { entryId: number; rowId: number } {
  const entry = insertEntry(db, {
    description: '',
    projectId: input.projectId,
    startedAt: nowIso,
    source: 'session',
    now: nowIso,
  })
  const row = insertEntrySession(db, {
    entryId: entry.id,
    wrapperId: input.wrapperId,
    wrapperPid: input.wrapperPid,
    harness: input.harness,
    sessionId: input.sessionId ?? null,
    transcriptPath: input.transcriptPath ?? null,
    cwd: input.cwd,
    startedAt: nowIso,
  })
  return { entryId: entry.id, rowId: row.id }
}

async function emitStart(ctx: LocalContext, entryId: number): Promise<void> {
  const row = findEntryWithProject(ctx.db, entryId)
  if (!row) return
  const payload: HookPayload = { event: 'start', entry: enrichEntry(row, ctx.timezone, new Date()), docPath: null }
  await emitHooks(ctx, [payload])
}

export async function startSessionEntry(ctx: LocalContext, input: StartSessionInput): Promise<{ entryId: number; rowId: number }> {
  const created = immediate(ctx.db, () => insertSessionEntry(ctx.db, input, new Date().toISOString()))
  await emitStart(ctx, created.entryId)
  return created
}

function launch(ctx: LocalContext, deps: SessionDeps, entryId: number, cwd: string): void {
  const spawner = deps.spawnFinalize ?? spawnFinalize
  spawner(entryId, { cwd, databasePath: ctx.databasePath })
}

export async function handleSessionStart(
  ctx: LocalContext,
  env: WrapperEnv,
  input: SessionStartInput,
  deps: SessionDeps = {},
): Promise<SessionStartResult> {
  if (input.harness !== env.harness || input.source === 'compact') return { action: 'ignored', endedEntryIds: [] }

  const nowIso = new Date().toISOString()
  const outcome = immediate(ctx.db, (): SessionStartResult & { ended: { entryId: number; cwd: string }[] } => {
    const open = findOpenByWrapper(ctx.db, env.wrapperId)

    const same = open.find((row) => row.sessionId === input.sessionId)
    if (same) {
      if (input.transcriptPath) fillTranscriptPath(ctx.db, same.id, input.transcriptPath)
      return { action: 'same', entryId: same.entryId, endedEntryIds: [], ended: [] }
    }

    const unlinked = open.find((row) => row.sessionId === null)
    if (unlinked) {
      linkSession(ctx.db, unlinked.id, input.sessionId, input.transcriptPath)
      return { action: 'linked', entryId: unlinked.entryId, endedEntryIds: [], ended: [] }
    }

    if (input.source === 'startup') return { action: 'ignored', endedEntryIds: [], ended: [] }

    const ended = open.filter((row) => markSessionEnded(ctx.db, row.id, nowIso, 'rotated'))
    const wrapperPid = findLatestByWrapper(ctx.db, env.wrapperId)?.wrapperPid ?? process.ppid
    const created = insertSessionEntry(
      ctx.db,
      {
        wrapperId: env.wrapperId,
        wrapperPid,
        harness: env.harness,
        projectId: env.projectId,
        cwd: input.cwd,
        sessionId: input.sessionId,
        transcriptPath: input.transcriptPath,
      },
      nowIso,
    )
    const endedRows = ended.map((row) => ({ entryId: row.entryId, cwd: row.cwd }))
    return {
      action: 'rotated',
      entryId: created.entryId,
      endedEntryIds: endedRows.map((row) => row.entryId),
      ended: endedRows,
    }
  })

  for (const row of outcome.ended) launch(ctx, deps, row.entryId, row.cwd)
  if (outcome.action === 'rotated' && outcome.entryId !== undefined) await emitStart(ctx, outcome.entryId)

  return {
    action: outcome.action,
    ...(outcome.entryId !== undefined ? { entryId: outcome.entryId } : {}),
    endedEntryIds: outcome.endedEntryIds,
  }
}

export async function handleSessionEnd(
  ctx: LocalContext,
  env: WrapperEnv,
  input: SessionEndInput,
  deps: SessionDeps = {},
): Promise<number | null> {
  if (input.harness !== env.harness) return null
  const row = findWrapperSession(ctx.db, env.wrapperId, input.sessionId)
  if (!row) return null
  markSessionEnded(ctx.db, row.id, new Date().toISOString(), input.reason)
  launch(ctx, deps, row.entryId, row.cwd)
  return row.entryId
}

export function currentSessionEntryId(db: DatabaseSync, env: WrapperEnv | null): number | null {
  if (!env) return null
  return findOpenByWrapper(db, env.wrapperId).at(-1)?.entryId ?? null
}

export async function closeWrapper(ctx: LocalContext, wrapperId: string, deps: SessionDeps = {}): Promise<number[]> {
  const nowIso = new Date().toISOString()
  const pending = immediate(ctx.db, () => {
    for (const row of findOpenByWrapper(ctx.db, wrapperId)) markSessionEnded(ctx.db, row.id, nowIso, 'exit')
    return findUnfinalizedByWrapper(ctx.db, wrapperId)
  })
  for (const row of pending) launch(ctx, deps, row.entryId, row.cwd)
  return pending.map((row) => row.entryId)
}

export function attachExitSession(ctx: LocalContext, wrapperId: string, session: { sessionId: string; transcriptPath: string | null }): boolean {
  return immediate(ctx.db, () => {
    const unlinked = findOpenByWrapper(ctx.db, wrapperId).filter((row) => row.sessionId === null).at(-1)
    return unlinked ? linkSession(ctx.db, unlinked.id, session.sessionId, session.transcriptPath) : false
  })
}

export function bindHarnessConversation(
  env: NodeJS.ProcessEnv,
  open: () => LocalContext,
  transcriptPath: (conversationId: string) => string | null,
): boolean {
  const conversationId = env[ANTIGRAVITY_CONVERSATION_ENV]
  if (!isConversationId(conversationId)) return false
  const wrapper = wrapperEnv(env)
  if (!wrapper || wrapper.harness !== 'antigravity') return false
  const file = transcriptPath(conversationId)
  if (file === null) return false
  const ctx = open()
  try {
    return attachExitSession(ctx, wrapper.wrapperId, { sessionId: conversationId, transcriptPath: file })
  } finally {
    ctx.db.close()
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function processStartedAt(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  if (platform === 'win32') return null
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: PS_TIMEOUT_MS,
    })
    if (result.status !== 0) return null
    const started = Date.parse(result.stdout.trim())
    return Number.isNaN(started) ? null : started
  } catch {
    return null
  }
}

export function wrapperAlive(
  pid: number,
  sinceIso: string,
  probe: { alive?: (pid: number) => boolean; startedAt?: (pid: number) => number | null; now?: number; platform?: NodeJS.Platform } = {},
): boolean {
  if (!(probe.alive ?? processAlive)(pid)) return false
  const started = (probe.startedAt ?? processStartedAt)(pid)
  const since = Date.parse(sinceIso)
  if (started === null) return (probe.platform ?? process.platform) !== 'win32' || (probe.now ?? Date.now()) - since <= UNVERIFIABLE_WRAPPER_MS
  return started <= since + PROCESS_START_SLACK_MS
}

function orphanEnd(db: DatabaseSync, row: { entryId: number; transcriptPath: string | null }, nowIso: string): string {
  if (row.transcriptPath) {
    try {
      return statSync(row.transcriptPath).mtime.toISOString()
    } catch {}
  }
  return lastTouchAt(db, row.entryId) ?? nowIso
}

export async function sweepOrphans(ctx: LocalContext, deps: SessionDeps = {}): Promise<number[]> {
  const alive = deps.isAlive ?? ((pid: number, sinceIso: string) => wrapperAlive(pid, sinceIso))
  const now = Date.now()
  const pending = immediate(ctx.db, () => {
    const orphans = listOpenSessions(ctx.db).filter((row) => !alive(row.wrapperPid, row.startedAt))
    const nowIso = new Date(now).toISOString()
    for (const row of orphans) markSessionEnded(ctx.db, row.id, orphanEnd(ctx.db, row, nowIso), 'orphan')
    const stale = listUnfinalizedEnded(
      ctx.db,
      new Date(now - ORPHAN_RETRY_MS).toISOString(),
      new Date(now - STALE_CLAIM_MS).toISOString(),
    )
    const byEntry = new Map<number, string>()
    for (const row of [...orphans, ...stale]) byEntry.set(row.entryId, row.cwd)
    return [...byEntry.entries()]
  })
  for (const [entryId, cwd] of pending) launch(ctx, deps, entryId, cwd)
  return pending.map(([entryId]) => entryId)
}

export function appendHookLog(databasePath: string, line: string): void {
  try {
    const logPath = hooksLogPath(databasePath)
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    return
  }
}

export function spawnFinalize(entryId: number, options: { cwd: string; databasePath: string }): void {
  const logPath = hooksLogPath(options.databasePath)
  let fd: number | null = null
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    fd = openSync(logPath, 'a')
    const child = spawn(process.execPath, [binEntry(), 'session', 'finalize', String(entryId)], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      cwd: existsSync(options.cwd) ? options.cwd : os.tmpdir(),
      env: { ...childEnv(), BITA_DB_PATH: options.databasePath },
    })
    child.on('error', (error) => appendHookLog(options.databasePath, `session finalize #${entryId} failed to start: ${error.message}`))
    child.unref()
    appendHookLog(options.databasePath, `session finalize #${entryId} launched (pid ${child.pid ?? '?'})`)
  } catch (error) {
    appendHookLog(options.databasePath, `session finalize #${entryId} failed to start: ${(error as Error).message}`)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
