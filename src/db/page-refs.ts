import type { DatabaseSync } from 'node:sqlite'
import { queryAll } from './query.ts'
import { toUtcIso } from './rows.ts'

export type RefKind = 'confluence' | 'jira' | 'drive' | 'link'
export type RefSource = 'manual' | 'hook'

export const REF_KINDS: readonly RefKind[] = ['confluence', 'jira', 'drive', 'link']

export interface PageRefRow {
  id: number
  pageId: number | null
  entryId: number | null
  url: string
  title: string
  kind: RefKind
  source: RefSource
  firstSeenAt: string
  lastSeenAt: string
}

export interface NewRef {
  url: string
  title?: string
  kind: RefKind
  source: RefSource
  now: string
}

interface RawRef {
  id: number
  page_id: number | null
  entry_id: number | null
  url: string
  title: string
  kind: RefKind
  source: RefSource
  first_seen_at: string
  last_seen_at: string
}

const COLUMNS = 'id, page_id, entry_id, url, title, kind, source, first_seen_at, last_seen_at'

function toRef(raw: RawRef): PageRefRow {
  return {
    id: raw.id,
    pageId: raw.page_id,
    entryId: raw.entry_id,
    url: raw.url,
    title: raw.title,
    kind: raw.kind,
    source: raw.source,
    firstSeenAt: raw.first_seen_at,
    lastSeenAt: raw.last_seen_at,
  }
}

const ON_CONFLICT = `DO UPDATE SET
  title = CASE WHEN excluded.title = '' THEN page_refs.title ELSE excluded.title END,
  kind = CASE WHEN page_refs.source = 'manual' AND excluded.source = 'hook' THEN page_refs.kind ELSE excluded.kind END,
  source = CASE WHEN page_refs.source = 'manual' THEN 'manual' ELSE excluded.source END,
  first_seen_at = MIN(page_refs.first_seen_at, excluded.first_seen_at),
  last_seen_at = MAX(page_refs.last_seen_at, excluded.last_seen_at)`

export function addRefToPage(db: DatabaseSync, pageId: number, ref: NewRef): void {
  const now = toUtcIso(ref.now)
  db.prepare(
    `INSERT INTO page_refs (page_id, url, title, kind, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, url) WHERE page_id IS NOT NULL ${ON_CONFLICT}`,
  ).run(pageId, ref.url, ref.title ?? '', ref.kind, ref.source, now, now)
}

export function addRefToEntry(db: DatabaseSync, entryId: number, ref: NewRef): void {
  const now = toUtcIso(ref.now)
  db.prepare(
    `INSERT INTO page_refs (entry_id, url, title, kind, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, url) WHERE entry_id IS NOT NULL ${ON_CONFLICT}`,
  ).run(entryId, ref.url, ref.title ?? '', ref.kind, ref.source, now, now)
}

export function adoptEntryRefs(db: DatabaseSync, entryId: number, pageId: number): void {
  db.prepare(
    `INSERT INTO page_refs (page_id, url, title, kind, source, first_seen_at, last_seen_at)
     SELECT ?, url, title, kind, source, first_seen_at, last_seen_at
     FROM page_refs WHERE entry_id = ?
     ON CONFLICT (page_id, url) WHERE page_id IS NOT NULL ${ON_CONFLICT}`,
  ).run(pageId, entryId)
  db.prepare('DELETE FROM page_refs WHERE entry_id = ?').run(entryId)
}

export function moveEntryRefs(db: DatabaseSync, fromEntryIds: readonly number[], toEntryId: number): void {
  for (const from of fromEntryIds) {
    if (from === toEntryId) continue
    db.prepare(
      `INSERT INTO page_refs (entry_id, url, title, kind, source, first_seen_at, last_seen_at)
       SELECT ?, url, title, kind, source, first_seen_at, last_seen_at
       FROM page_refs WHERE entry_id = ?
       ON CONFLICT (entry_id, url) WHERE entry_id IS NOT NULL ${ON_CONFLICT}`,
    ).run(toEntryId, from)
    db.prepare('DELETE FROM page_refs WHERE entry_id = ?').run(from)
  }
}

export function removeRefFromPage(db: DatabaseSync, pageId: number, url: string): boolean {
  return db.prepare('DELETE FROM page_refs WHERE page_id = ? AND url = ?').run(pageId, url).changes > 0
}

export function refsOfPage(db: DatabaseSync, pageId: number): PageRefRow[] {
  return queryAll<RawRef>(
    db.prepare(`SELECT ${COLUMNS} FROM page_refs WHERE page_id = ? ORDER BY kind, last_seen_at DESC, url`),
    pageId,
  ).map(toRef)
}

export function refsOfEntry(db: DatabaseSync, entryId: number): PageRefRow[] {
  return queryAll<RawRef>(
    db.prepare(`SELECT ${COLUMNS} FROM page_refs WHERE entry_id = ? ORDER BY last_seen_at DESC, url`),
    entryId,
  ).map(toRef)
}
