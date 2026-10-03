import type { DatabaseSync } from 'node:sqlite'
import { queryAll, queryOne } from './query.ts'
import { toUtcIso } from './rows.ts'
import { UNASSIGNED_KEY, ensureProjectKey } from './project-keys.ts'

export type BacklogKind = 'pending' | 'finding'
export type BacklogStatus = 'open' | 'resolved'
export type BacklogSource = 'manual' | 'extracted'

export const BACKLOG_KINDS: readonly BacklogKind[] = ['pending', 'finding']

export interface BacklogItemRow {
  id: number
  key: string
  seq: number | null
  projectId: number | null
  projectKey: string | null
  projectName: string | null
  pageId: number | null
  pageTitle: string | null
  entryId: number | null
  kind: BacklogKind
  title: string
  body: string
  status: BacklogStatus
  resolution: string
  source: BacklogSource
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface NewBacklogItem {
  projectId: number | null
  pageId?: number | null
  entryId?: number | null
  kind: BacklogKind
  title: string
  body?: string
  source?: BacklogSource
  now: string
}

export interface BacklogFilter {
  projectId?: number | undefined
  pageId?: number | undefined
  kind?: BacklogKind | undefined
  status?: BacklogStatus | 'all' | undefined
}

interface RawItem {
  id: number
  seq: number | null
  project_id: number | null
  project_key: string | null
  project_name: string | null
  page_id: number | null
  page_title: string | null
  entry_id: number | null
  kind: BacklogKind
  title: string
  body: string
  status: BacklogStatus
  resolution: string
  source: BacklogSource
  created_at: string
  updated_at: string
  resolved_at: string | null
}

const SELECT = `
  SELECT b.*, p.key AS project_key, p.name AS project_name, d.title AS page_title
  FROM backlog_items b
  LEFT JOIN projects p ON p.id = b.project_id
  LEFT JOIN doc_pages d ON d.id = b.page_id
`

export const BACKLOG_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,5})-([1-9][0-9]*)$/

export function backlogKey(projectKey: string | null, seq: number | null, id: number): string {
  if (seq === null) return `#${id}`
  return `${projectKey ?? UNASSIGNED_KEY}-${seq}`
}

function toItem(raw: RawItem): BacklogItemRow {
  return {
    id: raw.id,
    key: backlogKey(raw.project_key, raw.seq, raw.id),
    seq: raw.seq,
    projectId: raw.project_id,
    projectKey: raw.project_key,
    projectName: raw.project_name,
    pageId: raw.page_id,
    pageTitle: raw.page_title,
    entryId: raw.entry_id,
    kind: raw.kind,
    title: raw.title,
    body: raw.body,
    status: raw.status,
    resolution: raw.resolution,
    source: raw.source,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    resolvedAt: raw.resolved_at,
  }
}

export function insertBacklogItem(db: DatabaseSync, item: NewBacklogItem): BacklogItemRow {
  const now = toUtcIso(item.now)
  if (item.projectId !== null) ensureProjectKey(db, item.projectId)
  const result = db
    .prepare(
      `INSERT INTO backlog_items
         (project_id, seq, page_id, entry_id, kind, title, body, source, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM backlog_items WHERE project_id IS ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.projectId,
      item.projectId,
      item.pageId ?? null,
      item.entryId ?? null,
      item.kind,
      item.title.trim(),
      (item.body ?? '').trim(),
      item.source ?? 'manual',
      now,
      now,
    )
  const created = findBacklogItem(db, Number(result.lastInsertRowid))
  if (!created) throw new Error('the backlog item vanished right after being inserted')
  return created
}

export function findBacklogItem(db: DatabaseSync, id: number): BacklogItemRow | undefined {
  const raw = queryOne<RawItem>(db.prepare(`${SELECT} WHERE b.id = ?`), id)
  return raw ? toItem(raw) : undefined
}

export function findBacklogItemByRef(db: DatabaseSync, ref: string): BacklogItemRow | undefined {
  const trimmed = ref.trim().replace(/^#/, '')
  if (/^[1-9][0-9]*$/.test(trimmed)) return findBacklogItem(db, Number(trimmed))
  const match = BACKLOG_KEY_PATTERN.exec(trimmed)
  if (!match) return undefined
  const prefix = match[1]!.toUpperCase()
  const seq = Number(match[2])
  const raw =
    prefix === UNASSIGNED_KEY
      ? queryOne<RawItem>(db.prepare(`${SELECT} WHERE b.project_id IS NULL AND b.seq = ?`), seq)
      : queryOne<RawItem>(db.prepare(`${SELECT} WHERE p.key = ? COLLATE NOCASE AND b.seq = ?`), prefix, seq)
  return raw ? toItem(raw) : undefined
}

export function isBacklogRef(ref: string): boolean {
  const trimmed = ref.trim().replace(/^#/, '')
  return /^[1-9][0-9]*$/.test(trimmed) || BACKLOG_KEY_PATTERN.test(trimmed)
}

export function listBacklogItems(db: DatabaseSync, filter: BacklogFilter = {}): BacklogItemRow[] {
  const clauses: string[] = []
  const values: (string | number)[] = []
  if (filter.projectId !== undefined) {
    clauses.push('b.project_id = ?')
    values.push(filter.projectId)
  }
  if (filter.pageId !== undefined) {
    clauses.push('b.page_id = ?')
    values.push(filter.pageId)
  }
  if (filter.kind !== undefined) {
    clauses.push('b.kind = ?')
    values.push(filter.kind)
  }
  const status = filter.status ?? 'open'
  if (status !== 'all') {
    clauses.push('b.status = ?')
    values.push(status)
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  return queryAll<RawItem>(
    db.prepare(
      `${SELECT} ${where}
       ORDER BY p.name COLLATE NOCASE, IFNULL(d.title, '') COLLATE NOCASE, b.status, b.kind, b.created_at, b.id`,
    ),
    ...values,
  ).map(toItem)
}

export function setBacklogStatus(
  db: DatabaseSync,
  id: number,
  status: BacklogStatus,
  resolution: string | undefined,
  now: string,
): boolean {
  const at = toUtcIso(now)
  const result = db
    .prepare(
      `UPDATE backlog_items
       SET status = ?,
           resolved_at = ?,
           resolution = CASE WHEN ? IS NULL THEN resolution ELSE ? END,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      status === 'resolved' ? at : null,
      resolution ?? null,
      resolution ?? null,
      at,
      id,
    )
  return result.changes > 0
}

export function editBacklogItem(
  db: DatabaseSync,
  id: number,
  fields: {
    title?: string | undefined
    body?: string | undefined
    kind?: BacklogKind | undefined
    pageId?: number | null | undefined
    projectId?: number | null | undefined
  },
  now: string,
): boolean {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (fields.title !== undefined) {
    sets.push('title = ?')
    values.push(fields.title.trim())
  }
  if (fields.body !== undefined) {
    sets.push('body = ?')
    values.push(fields.body.trim())
  }
  if (fields.kind !== undefined) {
    sets.push('kind = ?')
    values.push(fields.kind)
  }
  if (fields.pageId !== undefined) {
    sets.push('page_id = ?')
    values.push(fields.pageId)
  }
  if (fields.projectId !== undefined) {
    const current = queryOne<{ project_id: number | null }>(db.prepare('SELECT project_id FROM backlog_items WHERE id = ?'), id)
    if (current !== undefined && current.project_id !== fields.projectId) {
      sets.push('project_id = ?', 'seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM backlog_items WHERE project_id IS ?)')
      values.push(fields.projectId, fields.projectId)
    }
  }
  if (sets.length === 0) return false
  sets.push('updated_at = ?')
  values.push(toUtcIso(now), id)
  return db.prepare(`UPDATE backlog_items SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes > 0
}

export function deleteBacklogItem(db: DatabaseSync, id: number): boolean {
  return db.prepare('DELETE FROM backlog_items WHERE id = ?').run(id).changes > 0
}

export interface BacklogTally {
  open: number
  resolved: number
}

export function backlogTallyOfPage(db: DatabaseSync, pageId: number): BacklogTally {
  const row = queryOne<{ open: number | null; resolved: number | null }>(
    db.prepare(
      `SELECT SUM(status = 'open') AS open, SUM(status = 'resolved') AS resolved
       FROM backlog_items WHERE page_id = ?`,
    ),
    pageId,
  )
  return { open: row?.open ?? 0, resolved: row?.resolved ?? 0 }
}
