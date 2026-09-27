import type { DatabaseSync } from 'node:sqlite'
import type { EntryRow, EntrySource, EntryWithProjectRow } from './rows.ts'
import { fromBoolean, toBoolean, toUtcIso } from './rows.ts'
import { queryAll, queryOne } from './query.ts'

interface RawEntry {
  id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  billable: number
  source: string
  external_id: number | null
  merged_into: number | null
  created_at: string
  updated_at: string
}

export interface RawEntryWithProject extends RawEntry {
  project_name: string | null
  client_name: string | null
  registered: number
  issue_key: string | null
}

const SELECT_WITH_PROJECT = `
  SELECT e.*,
         p.name AS project_name,
         p.client_name AS client_name,
         j.entry_id IS NOT NULL AS registered,
         j.issue_key AS issue_key
  FROM entries e
  LEFT JOIN projects p ON p.id = e.project_id
  LEFT JOIN jira_links j ON j.entry_id = e.id
`

function toEntry(raw: RawEntry): EntryRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    description: raw.description,
    startedAt: raw.started_at,
    stoppedAt: raw.stopped_at,
    billable: toBoolean(raw.billable),
    source: raw.source as EntrySource,
    externalId: raw.external_id,
    mergedInto: raw.merged_into ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export function toEntryWithProject(raw: RawEntryWithProject): EntryWithProjectRow {
  return {
    ...toEntry(raw),
    projectName: raw.project_name,
    clientName: raw.client_name,
    registered: toBoolean(raw.registered),
    issueKey: raw.issue_key,
  }
}

export interface NewEntry {
  description: string
  projectId: number | null
  startedAt: string
  stoppedAt?: string | null
  billable?: boolean
  source: EntrySource
  externalId?: number | null
  now: string
}

export function insertEntry(db: DatabaseSync, entry: NewEntry): EntryRow {
  const result = db
    .prepare(
      `INSERT INTO entries
         (project_id, description, started_at, stopped_at, billable, source, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.projectId,
      entry.description,
      toUtcIso(entry.startedAt),
      entry.stoppedAt == null ? null : toUtcIso(entry.stoppedAt),
      fromBoolean(entry.billable ?? false),
      entry.source,
      entry.externalId ?? null,
      toUtcIso(entry.now),
      toUtcIso(entry.now),
    )
  const created = findEntryById(db, Number(result.lastInsertRowid))
  if (!created) throw new Error('the entry vanished right after being inserted')
  return created
}

export function findEntryById(db: DatabaseSync, id: number): EntryRow | undefined {
  const raw = queryOne<RawEntry>(db.prepare('SELECT * FROM entries WHERE id = ?'), id)
  return raw ? toEntry(raw) : undefined
}

export function findEntryWithProject(db: DatabaseSync, id: number): EntryWithProjectRow | undefined {
  const raw = queryOne<RawEntryWithProject>(db.prepare(`${SELECT_WITH_PROJECT} WHERE e.id = ?`), id)
  return raw ? toEntryWithProject(raw) : undefined
}

export function findEntryByExternalId(db: DatabaseSync, externalId: number): EntryRow | undefined {
  const raw = queryOne<RawEntry>(
    db.prepare('SELECT * FROM entries WHERE external_id = ?'),
    externalId,
  )
  return raw ? toEntry(raw) : undefined
}

export function listRunning(db: DatabaseSync): EntryWithProjectRow[] {
  const raws = queryAll<RawEntryWithProject>(
    db.prepare(`${SELECT_WITH_PROJECT} WHERE e.stopped_at IS NULL ORDER BY e.started_at`),
  )
  return raws.map(toEntryWithProject)
}

export function listRunningDrafts(db: DatabaseSync): EntryWithProjectRow[] {
  return listRunning(db).filter((entry) => entry.description.trim().length === 0)
}

export function countRunning(db: DatabaseSync): number {
  const row = queryOne<{ total: number }>(
    db.prepare('SELECT COUNT(*) AS total FROM entries WHERE stopped_at IS NULL'),
  )
  return row?.total ?? 0
}

export function listEntriesStartedBetween(
  db: DatabaseSync,
  fromUtc: string,
  toUtc: string,
): EntryWithProjectRow[] {
  const raws = queryAll<RawEntryWithProject>(
    db.prepare(
      `${SELECT_WITH_PROJECT} WHERE e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at`,
    ),
    fromUtc,
    toUtc,
  )
  return raws.map(toEntryWithProject)
}

export function listPendingEntries(db: DatabaseSync, sinceUtc?: string): EntryWithProjectRow[] {
  const clause = sinceUtc === undefined ? '' : 'AND e.started_at >= ?'
  const statement = db.prepare(
    `${SELECT_WITH_PROJECT} WHERE j.entry_id IS NULL ${clause} ORDER BY e.started_at`,
  )
  const raws =
    sinceUtc === undefined
      ? queryAll<RawEntryWithProject>(statement)
      : queryAll<RawEntryWithProject>(statement, sinceUtc)
  return raws.map(toEntryWithProject)
}

export function stopEntry(db: DatabaseSync, id: number, stoppedAt: string, now: string): boolean {
  const result = db
    .prepare(
      'UPDATE entries SET stopped_at = ?, updated_at = ? WHERE id = ? AND stopped_at IS NULL',
    )
    .run(toUtcIso(stoppedAt), toUtcIso(now), id)
  return result.changes > 0
}

export function updateEntry(
  db: DatabaseSync,
  id: number,
  fields: { description?: string; projectId?: number | null; startedAt?: string; stoppedAt?: string | null },
  now: string,
): boolean {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (fields.description !== undefined) {
    sets.push('description = ?')
    values.push(fields.description)
  }
  if (fields.projectId !== undefined) {
    sets.push('project_id = ?')
    values.push(fields.projectId)
  }
  if (fields.startedAt !== undefined) {
    sets.push('started_at = ?')
    values.push(toUtcIso(fields.startedAt))
  }
  if (fields.stoppedAt !== undefined) {
    sets.push('stopped_at = ?')
    values.push(fields.stoppedAt === null ? null : toUtcIso(fields.stoppedAt))
  }
  if (sets.length === 0) return false
  sets.push('updated_at = ?')
  values.push(toUtcIso(now), id)
  const result = db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  if (result.changes > 0 && (fields.description !== undefined || fields.projectId !== undefined)) {
    propagateToSegments(db, id, now)
  }
  return result.changes > 0
}

function propagateToSegments(db: DatabaseSync, id: number, now: string): void {
  db.prepare(
    `UPDATE entries
     SET description = (SELECT description FROM entries WHERE id = ?),
         project_id = (SELECT project_id FROM entries WHERE id = ?),
         updated_at = ?
     WHERE merged_into = ?`,
  ).run(id, id, toUtcIso(now), id)
}

export function listSegments(db: DatabaseSync, targetId: number): EntryWithProjectRow[] {
  const raws = queryAll<RawEntryWithProject>(
    db.prepare(`${SELECT_WITH_PROJECT} WHERE e.merged_into = ? ORDER BY e.started_at`),
    targetId,
  )
  return raws.map(toEntryWithProject)
}

export function deleteEntry(db: DatabaseSync, id: number): boolean {
  return db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0
}

export function listEntriesForProject(db: DatabaseSync, projectId: number): EntryWithProjectRow[] {
  const raws = queryAll<RawEntryWithProject>(
    db.prepare(`${SELECT_WITH_PROJECT} WHERE e.project_id = ? ORDER BY e.started_at`),
    projectId,
  )
  return raws.map(toEntryWithProject)
}
