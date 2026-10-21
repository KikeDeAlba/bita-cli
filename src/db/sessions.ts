import type { DatabaseSync } from 'node:sqlite'
import type { HarnessId } from '../harness/types.ts'
import { queryAll, queryOne } from './query.ts'
import { toUtcIso } from './rows.ts'

export type SessionOutcome = 'summarized' | 'fallback' | 'skipped'

export interface EntrySessionRow {
  id: number
  entryId: number
  wrapperId: string
  wrapperPid: number
  harness: HarnessId
  sessionId: string | null
  transcriptPath: string | null
  cwd: string
  startedAt: string
  endedAt: string | null
  endReason: string | null
  claimedAt: string | null
  finalizedAt: string | null
  outcome: SessionOutcome | null
  error: string | null
}

interface RawEntrySession {
  id: number
  entry_id: number
  wrapper_id: string
  wrapper_pid: number
  harness: string
  session_id: string | null
  transcript_path: string | null
  cwd: string
  started_at: string
  ended_at: string | null
  end_reason: string | null
  claimed_at: string | null
  finalized_at: string | null
  outcome: string | null
  error: string | null
}

function toRow(raw: RawEntrySession): EntrySessionRow {
  return {
    id: raw.id,
    entryId: raw.entry_id,
    wrapperId: raw.wrapper_id,
    wrapperPid: raw.wrapper_pid,
    harness: raw.harness as HarnessId,
    sessionId: raw.session_id,
    transcriptPath: raw.transcript_path,
    cwd: raw.cwd,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    endReason: raw.end_reason,
    claimedAt: raw.claimed_at,
    finalizedAt: raw.finalized_at,
    outcome: raw.outcome as SessionOutcome | null,
    error: raw.error,
  }
}

export interface NewEntrySession {
  entryId: number
  wrapperId: string
  wrapperPid: number
  harness: HarnessId
  sessionId?: string | null
  transcriptPath?: string | null
  cwd: string
  startedAt: string
}

export function insertEntrySession(db: DatabaseSync, session: NewEntrySession): EntrySessionRow {
  const result = db
    .prepare(
      `INSERT INTO entry_sessions
         (entry_id, wrapper_id, wrapper_pid, harness, session_id, transcript_path, cwd, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.entryId,
      session.wrapperId,
      session.wrapperPid,
      session.harness,
      session.sessionId ?? null,
      session.transcriptPath ?? null,
      session.cwd,
      toUtcIso(session.startedAt),
    )
  const created = findSessionById(db, Number(result.lastInsertRowid))
  if (!created) throw new Error('the session vanished right after being inserted')
  return created
}

export function findSessionById(db: DatabaseSync, id: number): EntrySessionRow | undefined {
  const raw = queryOne<RawEntrySession>(db.prepare('SELECT * FROM entry_sessions WHERE id = ?'), id)
  return raw ? toRow(raw) : undefined
}

export function findSessionByEntry(db: DatabaseSync, entryId: number): EntrySessionRow | undefined {
  const raw = queryOne<RawEntrySession>(db.prepare('SELECT * FROM entry_sessions WHERE entry_id = ?'), entryId)
  return raw ? toRow(raw) : undefined
}

export function findOpenByWrapper(db: DatabaseSync, wrapperId: string): EntrySessionRow[] {
  return queryAll<RawEntrySession>(
    db.prepare('SELECT * FROM entry_sessions WHERE wrapper_id = ? AND ended_at IS NULL ORDER BY id'),
    wrapperId,
  ).map(toRow)
}

export function findWrapperSession(db: DatabaseSync, wrapperId: string, sessionId: string): EntrySessionRow | undefined {
  const raw = queryOne<RawEntrySession>(
    db.prepare('SELECT * FROM entry_sessions WHERE wrapper_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1'),
    wrapperId,
    sessionId,
  )
  return raw ? toRow(raw) : undefined
}

export function findLatestByWrapper(db: DatabaseSync, wrapperId: string): EntrySessionRow | undefined {
  const raw = queryOne<RawEntrySession>(
    db.prepare('SELECT * FROM entry_sessions WHERE wrapper_id = ? ORDER BY id DESC LIMIT 1'),
    wrapperId,
  )
  return raw ? toRow(raw) : undefined
}

export function findUnfinalizedByWrapper(db: DatabaseSync, wrapperId: string): EntrySessionRow[] {
  return queryAll<RawEntrySession>(
    db.prepare('SELECT * FROM entry_sessions WHERE wrapper_id = ? AND finalized_at IS NULL ORDER BY id'),
    wrapperId,
  ).map(toRow)
}

export function listOpenSessions(db: DatabaseSync): EntrySessionRow[] {
  return queryAll<RawEntrySession>(db.prepare('SELECT * FROM entry_sessions WHERE ended_at IS NULL ORDER BY id')).map(toRow)
}

export function listUnfinalizedEnded(db: DatabaseSync, endedBeforeIso: string, staleClaimBeforeIso: string): EntrySessionRow[] {
  return queryAll<RawEntrySession>(
    db.prepare(
      `SELECT * FROM entry_sessions
       WHERE ended_at IS NOT NULL AND ended_at < ? AND finalized_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < ?)
       ORDER BY id`,
    ),
    toUtcIso(endedBeforeIso),
    toUtcIso(staleClaimBeforeIso),
  ).map(toRow)
}

export function linkSession(db: DatabaseSync, rowId: number, sessionId: string, transcriptPath: string | null): boolean {
  return (
    db
      .prepare('UPDATE entry_sessions SET session_id = ?, transcript_path = ? WHERE id = ? AND session_id IS NULL')
      .run(sessionId, transcriptPath, rowId).changes > 0
  )
}

export function fillTranscriptPath(db: DatabaseSync, rowId: number, transcriptPath: string): boolean {
  return (
    db
      .prepare('UPDATE entry_sessions SET transcript_path = ? WHERE id = ? AND transcript_path IS NULL')
      .run(transcriptPath, rowId).changes > 0
  )
}

export function markSessionEnded(db: DatabaseSync, rowId: number, endedAt: string, reason: string): boolean {
  return (
    db
      .prepare(
        `UPDATE entry_sessions SET ended_at = MAX(?, started_at), end_reason = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(toUtcIso(endedAt), reason, rowId).changes > 0
  )
}

export function claimFinalize(db: DatabaseSync, entryId: number, nowIso: string, staleBeforeIso: string): boolean {
  return (
    db
      .prepare(
        `UPDATE entry_sessions SET claimed_at = ?
         WHERE entry_id = ? AND finalized_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(toUtcIso(nowIso), entryId, toUtcIso(staleBeforeIso)).changes > 0
  )
}

export function completeFinalize(
  db: DatabaseSync,
  entryId: number,
  nowIso: string,
  outcome: SessionOutcome,
  error: string | null,
): boolean {
  return (
    db
      .prepare('UPDATE entry_sessions SET finalized_at = ?, outcome = ?, error = ? WHERE entry_id = ? AND finalized_at IS NULL')
      .run(toUtcIso(nowIso), outcome, error, entryId).changes > 0
  )
}
