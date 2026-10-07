import type { DatabaseSync } from 'node:sqlite'
import { queryAll } from './query.ts'
import { adoptEntryRefs } from './page-refs.ts'

export type PageIssueRole = 'epic' | 'story' | 'task' | 'subtask'
export type StatusCategory = '' | 'new' | 'indeterminate' | 'done'

export interface PageEntryRow {
  pageId: number
  entryId: number
  summary: string
  linkedAt: string
}

export interface PageIssueRow {
  pageId: number
  issueKey: string
  role: PageIssueRole
  summary: string
  status: string
  statusCategory: StatusCategory
  url: string | null
  createdAt: string
  refreshedAt: string | null
}

interface EntryLink {
  page_id: number
  entry_id: number
  summary: string
  linked_at: string
}

interface IssueLink {
  page_id: number
  issue_key: string
  role: PageIssueRole
  summary: string
  status: string
  status_category: StatusCategory
  url: string | null
  created_at: string
  refreshed_at: string | null
}

function toEntry(row: EntryLink): PageEntryRow {
  return { pageId: row.page_id, entryId: row.entry_id, summary: row.summary, linkedAt: row.linked_at }
}

function toIssue(row: IssueLink): PageIssueRow {
  return {
    pageId: row.page_id,
    issueKey: row.issue_key,
    role: row.role,
    summary: row.summary,
    status: row.status,
    statusCategory: row.status_category,
    url: row.url,
    createdAt: row.created_at,
    refreshedAt: row.refreshed_at,
  }
}

export function linkEntryToPage(
  db: DatabaseSync,
  pageId: number,
  entryId: number,
  summary: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO page_entries (page_id, entry_id, summary, linked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (page_id, entry_id) DO UPDATE SET
       summary = CASE WHEN excluded.summary = '' THEN page_entries.summary ELSE excluded.summary END`,
  ).run(pageId, entryId, summary, now)
  adoptEntryRefs(db, entryId, pageId)
}

export function unlinkEntryFromPage(db: DatabaseSync, pageId: number, entryId: number): void {
  db.prepare(`DELETE FROM page_entries WHERE page_id = ? AND entry_id = ?`).run(pageId, entryId)
}

export function pagesOfEntry(db: DatabaseSync, entryId: number): PageEntryRow[] {
  return queryAll<EntryLink>(
    db.prepare(
      `SELECT page_id, entry_id, summary, linked_at FROM page_entries
       WHERE entry_id = ? ORDER BY linked_at, page_id`,
    ),
    entryId,
  ).map(toEntry)
}

export function pageOfEntry(db: DatabaseSync, entryId: number): PageEntryRow | undefined {
  return pagesOfEntry(db, entryId)[0]
}

export function entriesOfPage(db: DatabaseSync, pageId: number): PageEntryRow[] {
  return queryAll<EntryLink>(
    db.prepare(
      `SELECT pe.page_id, pe.entry_id, pe.summary, pe.linked_at
       FROM page_entries pe JOIN entries e ON e.id = pe.entry_id
       WHERE pe.page_id = ?
       ORDER BY e.started_at DESC`,
    ),
    pageId,
  ).map(toEntry)
}

export interface NewPageIssue {
  pageId: number
  issueKey: string
  role?: PageIssueRole
  summary?: string
  status?: string
  statusCategory?: StatusCategory
  url?: string | null
  now: string
}

export function linkIssueToPage(db: DatabaseSync, issue: NewPageIssue): void {
  db.prepare(
    `INSERT INTO page_issues
       (page_id, issue_key, role, summary, status, status_category, url, created_at, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, issue_key) DO UPDATE SET
       role = excluded.role,
       summary = CASE WHEN excluded.summary = '' THEN page_issues.summary ELSE excluded.summary END,
       status = CASE WHEN excluded.status = '' THEN page_issues.status ELSE excluded.status END,
       status_category = CASE
         WHEN excluded.status_category = '' THEN page_issues.status_category
         ELSE excluded.status_category
       END,
       url = COALESCE(excluded.url, page_issues.url),
       refreshed_at = excluded.refreshed_at`,
  ).run(
    issue.pageId,
    issue.issueKey,
    issue.role ?? 'task',
    issue.summary ?? '',
    issue.status ?? '',
    issue.statusCategory ?? '',
    issue.url ?? null,
    issue.now,
    issue.now,
  )
}

export function unlinkIssueFromPage(db: DatabaseSync, pageId: number, issueKey: string): void {
  db.prepare(`DELETE FROM page_issues WHERE page_id = ? AND issue_key = ?`).run(pageId, issueKey)
}

export function issuesOfPage(db: DatabaseSync, pageId: number): PageIssueRow[] {
  return queryAll<IssueLink>(
    db.prepare(
      `SELECT page_id, issue_key, role, summary, status, status_category, url, created_at, refreshed_at
       FROM page_issues WHERE page_id = ? ORDER BY issue_key`,
    ),
    pageId,
  ).map(toIssue)
}

export function worklogIssuesOfPage(db: DatabaseSync, pageId: number): string[] {
  return queryAll<{ issue_key: string }>(
    db.prepare(
      `SELECT DISTINCT jl.issue_key
       FROM page_entries pe
       JOIN entries e ON e.id = pe.entry_id OR e.merged_into = pe.entry_id
       JOIN jira_links jl ON jl.entry_id = e.id
       WHERE pe.page_id = ?
       ORDER BY jl.issue_key`,
    ),
    pageId,
  ).map((row) => row.issue_key)
}

export interface PageTally {
  pageId: number
  entryCount: number
  durationSeconds: number
  issueCount: number
}

export function talliesByPage(db: DatabaseSync): Map<number, PageTally> {
  const rows = queryAll<{
    page_id: number
    entry_count: number
    duration_seconds: number | null
  }>(
    db.prepare(
      `SELECT pe.page_id,
              COUNT(DISTINCT pe.entry_id) AS entry_count,
              SUM(
                CASE WHEN e.stopped_at IS NULL THEN 0
                ELSE CAST((julianday(e.stopped_at) - julianday(e.started_at)) * 86400 AS INTEGER)
                END
              ) AS duration_seconds
       FROM page_entries pe JOIN entries e ON e.id = pe.entry_id OR e.merged_into = pe.entry_id
       GROUP BY pe.page_id`,
    ),
  )

  const issues = queryAll<{ page_id: number; issue_count: number }>(
    db.prepare(`SELECT page_id, COUNT(*) AS issue_count FROM page_issues GROUP BY page_id`),
  )
  const issueCounts = new Map(issues.map((row) => [row.page_id, row.issue_count]))

  const tallies = new Map<number, PageTally>()
  for (const row of rows) {
    tallies.set(row.page_id, {
      pageId: row.page_id,
      entryCount: row.entry_count,
      durationSeconds: row.duration_seconds ?? 0,
      issueCount: issueCounts.get(row.page_id) ?? 0,
    })
  }
  for (const [pageId, issueCount] of issueCounts) {
    if (tallies.has(pageId)) continue
    tallies.set(pageId, { pageId, entryCount: 0, durationSeconds: 0, issueCount })
  }
  return tallies
}

export const MEETING_KINDS: readonly string[] = ['remote-meeting', 'in-person-meeting']

export interface PageMeeting {
  entryId: number
  kind: string
  startedAt: string
  stoppedAt: string | null
  durationSeconds: number
}

export function meetingsOfPage(db: DatabaseSync, pageId: number): PageMeeting[] {
  return queryAll<{ id: number; kind: string; started_at: string; stopped_at: string | null }>(
    db.prepare(
      `SELECT DISTINCT e.id, e.kind, e.started_at, e.stopped_at
       FROM page_entries pe JOIN entries e ON e.id = pe.entry_id OR e.merged_into = pe.entry_id
       WHERE pe.page_id = ? AND e.kind IN (${MEETING_KINDS.map(() => '?').join(', ')})
       ORDER BY e.started_at`,
    ),
    pageId,
    ...MEETING_KINDS,
  ).map((row) => ({
    entryId: row.id,
    kind: row.kind,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    durationSeconds:
      row.stopped_at === null ? 0 : Math.max(0, Math.round((Date.parse(row.stopped_at) - Date.parse(row.started_at)) / 1000)),
  }))
}
