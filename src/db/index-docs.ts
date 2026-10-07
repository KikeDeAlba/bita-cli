import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { EntryWithProjectRow } from './rows.ts'
import type { EntryDocRow } from './docs.ts'
import type { DocKind } from '../docs/layout.ts'
import type { NoteSource } from '../state/notes.ts'
import { toEntryWithProject, type RawEntryWithProject } from './entries.ts'
import { queryAll, queryOne } from './query.ts'

export interface DocIndexFilter {
  projectId?: number | null
  fromUtc?: string
  toUtc?: string
  onlyWithDoc?: boolean
}

export interface DocIndexPage extends DocIndexFilter {
  limit?: number
  offset?: number
}

export interface EntryDocIndexRow {
  entry: EntryWithProjectRow
  doc: EntryDocRow | null
  appendixCount: number
}

export interface ProjectDocCountRow {
  projectId: number | null
  projectName: string | null
  active: boolean
  entryCount: number
  docCount: number
  appendixCount: number
  minStartedAt: string | null
  maxStartedAt: string | null
  lastRecordedAt: string | null
}

export interface DocCorpusTotals {
  projectCount: number
  entryCount: number
  entriesWithDoc: number
  docCount: number
  appendixCount: number
  minStartedAt: string | null
  maxStartedAt: string | null
}

export interface DocCalendarRow {
  projectId: number | null
  startedAt: string
  hasDoc: boolean
}

export interface SearchCandidateRow {
  doc: EntryDocRow
  entryId: number
  projectId: number | null
  projectName: string | null
  description: string
  startedAt: string
}

const APPENDICES = `LEFT JOIN (SELECT entry_id, COUNT(*) AS cnt FROM entry_docs WHERE kind = 'appendix' GROUP BY entry_id) ap
                      ON ap.entry_id = e.id`

const NOTE_JOIN = `LEFT JOIN entry_docs d ON d.entry_id = e.id AND d.kind = 'note'`

const DOC_FIELDS = `d.entry_id AS doc_entry_id,
                    d.rel_path AS doc_rel_path,
                    d.kind AS doc_kind,
                    d.title AS doc_title,
                    d.title_slug AS doc_title_slug,
                    d.source AS doc_source,
                    d.section_count AS doc_section_count,
                    d.byte_size AS doc_byte_size,
                    d.checksum AS doc_checksum,
                    d.repo_slug AS doc_repo_slug,
                    d.branch AS doc_branch,
                    d.head_sha AS doc_head_sha,
                    d.created_at AS doc_created_at,
                    d.recorded_at AS doc_recorded_at`

interface RawDocFields {
  doc_entry_id: number | null
  doc_rel_path: string | null
  doc_kind: DocKind | null
  doc_title: string | null
  doc_title_slug: string | null
  doc_source: NoteSource | null
  doc_section_count: number | null
  doc_byte_size: number | null
  doc_checksum: string | null
  doc_repo_slug: string | null
  doc_branch: string | null
  doc_head_sha: string | null
  doc_created_at: string | null
  doc_recorded_at: string | null
}

interface RawIndexRow extends RawEntryWithProject, RawDocFields {
  appendix_count: number
}

function toDoc(raw: RawDocFields): EntryDocRow | null {
  if (raw.doc_entry_id === null || raw.doc_rel_path === null) return null
  return {
    entryId: raw.doc_entry_id,
    relPath: raw.doc_rel_path,
    kind: raw.doc_kind ?? 'note',
    title: raw.doc_title ?? '',
    titleSlug: raw.doc_title_slug ?? '',
    source: raw.doc_source ?? 'manual',
    sectionCount: raw.doc_section_count ?? 0,
    byteSize: raw.doc_byte_size ?? 0,
    checksum: raw.doc_checksum ?? '',
    repoSlug: raw.doc_repo_slug,
    branch: raw.doc_branch,
    headSha: raw.doc_head_sha,
    createdAt: raw.doc_created_at ?? '',
    recordedAt: raw.doc_recorded_at ?? '',
  }
}

function indexFilter(filter: DocIndexFilter): { clause: string; params: SQLInputValue[] } {
  const conditions: string[] = []
  const params: SQLInputValue[] = []

  if (filter.projectId === null) {
    conditions.push('e.project_id IS NULL')
  } else if (filter.projectId !== undefined) {
    conditions.push('e.project_id = ?')
    params.push(filter.projectId)
  }

  if (filter.fromUtc !== undefined) {
    conditions.push('e.started_at >= ?')
    params.push(filter.fromUtc)
  }

  if (filter.toUtc !== undefined) {
    conditions.push('e.started_at < ?')
    params.push(filter.toUtc)
  }

  if (filter.onlyWithDoc === true) conditions.push('d.entry_id IS NOT NULL')

  return { clause: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, params }
}

export function listEntryDocIndex(db: DatabaseSync, page: DocIndexPage = {}): EntryDocIndexRow[] {
  const { clause, params } = indexFilter(page)
  const limit = page.limit ?? 50
  const bounded = limit > 0 ? 'LIMIT ? OFFSET ?' : ''
  const bounds: SQLInputValue[] = limit > 0 ? [limit, page.offset ?? 0] : []

  const raws = queryAll<RawIndexRow>(
    db.prepare(
      `SELECT e.*,
              p.name AS project_name,
              p.client_name AS client_name,
              j.entry_id IS NOT NULL AS registered,
              j.issue_key AS issue_key,
              ${DOC_FIELDS},
              COALESCE(ap.cnt, 0) AS appendix_count
       FROM entries e
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN jira_links j ON j.entry_id = e.id
       ${NOTE_JOIN}
       ${APPENDICES}
       ${clause}
       ORDER BY e.started_at DESC, e.id DESC
       ${bounded}`,
    ),
    ...params,
    ...bounds,
  )

  return raws.map((raw) => ({
    entry: toEntryWithProject(raw),
    doc: toDoc(raw),
    appendixCount: raw.appendix_count,
  }))
}

export function countEntryDocIndex(db: DatabaseSync, filter: DocIndexFilter = {}): number {
  const { clause, params } = indexFilter(filter)
  const row = queryOne<{ total: number }>(
    db.prepare(
      `SELECT COUNT(*) AS total
       FROM entries e
       ${NOTE_JOIN}
       ${clause}`,
    ),
    ...params,
  )
  return row?.total ?? 0
}

export function docCountsByProject(db: DatabaseSync, filter: DocIndexFilter = {}): ProjectDocCountRow[] {
  const { clause, params } = indexFilter(filter)
  const raws = queryAll<{
    project_id: number | null
    project_name: string | null
    active: number | null
    entry_count: number
    doc_count: number
    appendix_count: number
    min_started_at: string | null
    max_started_at: string | null
    last_recorded_at: string | null
  }>(
    db.prepare(
      `SELECT e.project_id AS project_id,
              p.name AS project_name,
              p.active AS active,
              COUNT(*) AS entry_count,
              SUM(CASE WHEN d.entry_id IS NOT NULL THEN 1 ELSE 0 END) AS doc_count,
              SUM(COALESCE(ap.cnt, 0)) AS appendix_count,
              MIN(e.started_at) AS min_started_at,
              MAX(e.started_at) AS max_started_at,
              MAX(d.recorded_at) AS last_recorded_at
       FROM entries e
       LEFT JOIN projects p ON p.id = e.project_id
       ${NOTE_JOIN}
       ${APPENDICES}
       ${clause}
       GROUP BY e.project_id
       ORDER BY doc_count DESC, entry_count DESC, p.name COLLATE NOCASE`,
    ),
    ...params,
  )

  return raws.map((raw) => ({
    projectId: raw.project_id,
    projectName: raw.project_name,
    active: raw.active === null ? true : raw.active === 1,
    entryCount: raw.entry_count,
    docCount: raw.doc_count,
    appendixCount: raw.appendix_count,
    minStartedAt: raw.min_started_at,
    maxStartedAt: raw.max_started_at,
    lastRecordedAt: raw.last_recorded_at,
  }))
}

export function docCorpusTotals(db: DatabaseSync): DocCorpusTotals {
  const entries = queryOne<{
    entry_count: number
    entries_with_doc: number
    project_count: number
    min_started_at: string | null
    max_started_at: string | null
  }>(
    db.prepare(
      `SELECT COUNT(*) AS entry_count,
              SUM(CASE WHEN d.entry_id IS NOT NULL THEN 1 ELSE 0 END) AS entries_with_doc,
              COUNT(DISTINCT e.project_id) AS project_count,
              MIN(e.started_at) AS min_started_at,
              MAX(e.started_at) AS max_started_at
       FROM entries e
       ${NOTE_JOIN}`,
    ),
  )

  const docs = queryOne<{ note_count: number; appendix_count: number }>(
    db.prepare(
      `SELECT SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) AS note_count,
              SUM(CASE WHEN kind = 'appendix' THEN 1 ELSE 0 END) AS appendix_count
       FROM entry_docs`,
    ),
  )

  return {
    projectCount: entries?.project_count ?? 0,
    entryCount: entries?.entry_count ?? 0,
    entriesWithDoc: entries?.entries_with_doc ?? 0,
    docCount: docs?.note_count ?? 0,
    appendixCount: docs?.appendix_count ?? 0,
    minStartedAt: entries?.min_started_at ?? null,
    maxStartedAt: entries?.max_started_at ?? null,
  }
}

export function listDocCalendarRows(db: DatabaseSync, filter: DocIndexFilter = {}): DocCalendarRow[] {
  const { clause, params } = indexFilter(filter)
  const raws = queryAll<{ project_id: number | null; started_at: string; has_doc: number }>(
    db.prepare(
      `SELECT e.project_id AS project_id,
              e.started_at AS started_at,
              d.entry_id IS NOT NULL AS has_doc
       FROM entries e
       ${NOTE_JOIN}
       ${clause}
       ORDER BY e.started_at DESC, e.id DESC`,
    ),
    ...params,
  )

  return raws.map((raw) => ({
    projectId: raw.project_id,
    startedAt: raw.started_at,
    hasDoc: raw.has_doc === 1,
  }))
}

export function listSearchCandidates(db: DatabaseSync, filter: DocIndexFilter = {}): SearchCandidateRow[] {
  const { clause, params } = indexFilter({ ...filter, onlyWithDoc: true })
  const raws = queryAll<
    RawDocFields & {
      entry_id: number
      project_id: number | null
      project_name: string | null
      description: string
      started_at: string
    }
  >(
    db.prepare(
      `SELECT e.id AS entry_id,
              e.project_id AS project_id,
              e.description AS description,
              e.started_at AS started_at,
              p.name AS project_name,
              ${DOC_FIELDS}
       FROM entries e
       LEFT JOIN projects p ON p.id = e.project_id
       ${NOTE_JOIN}
       ${clause}
       ORDER BY e.started_at DESC, e.id DESC`,
    ),
    ...params,
  )

  const candidates: SearchCandidateRow[] = []
  for (const raw of raws) {
    const doc = toDoc(raw)
    if (!doc) continue
    candidates.push({
      doc,
      entryId: raw.entry_id,
      projectId: raw.project_id,
      projectName: raw.project_name,
      description: raw.description,
      startedAt: raw.started_at,
    })
  }
  return candidates
}

export interface PageNoteRow {
  pageId: number
  entryId: number
  startedAt: string
  relPath: string
  checksum: string
  byteSize: number
}

export function listPageNotes(db: DatabaseSync, projectId?: number | null): PageNoteRow[] {
  const scoped = projectId === undefined ? '' : 'WHERE IFNULL(p.project_id, 0) = IFNULL(?, 0)'
  const params: SQLInputValue[] = projectId === undefined ? [] : [projectId]
  return queryAll<{
    page_id: number
    entry_id: number
    started_at: string
    rel_path: string
    checksum: string
    byte_size: number
  }>(
    db.prepare(
      `SELECT DISTINCT pe.page_id, e.id AS entry_id, e.started_at, d.rel_path, d.checksum, d.byte_size
       FROM page_entries pe
       JOIN doc_pages p ON p.id = pe.page_id
       JOIN entries e ON e.id = pe.entry_id OR e.merged_into = pe.entry_id
       JOIN entry_docs d ON d.entry_id = e.id AND d.kind = 'note'
       ${scoped}
       ORDER BY pe.page_id, e.started_at DESC, e.id DESC`,
    ),
    ...params,
  ).map((row) => ({
    pageId: row.page_id,
    entryId: row.entry_id,
    startedAt: row.started_at,
    relPath: row.rel_path,
    checksum: row.checksum,
    byteSize: row.byte_size,
  }))
}
