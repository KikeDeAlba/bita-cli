import type { DatabaseSync } from 'node:sqlite'
import { queryAll, queryOne } from './query.ts'

export type PageMapState = 'synced' | 'conflict'

export interface PageMapRow {
  pageId: number
  site: string
  confluenceId: string
  confluenceVersion: number
  localChecksum: string
  state: PageMapState
  syncedAt: string
}

interface RawMap {
  page_id: number
  site: string
  confluence_id: string
  confluence_version: number
  local_checksum: string
  state: PageMapState
  synced_at: string
}

const COLUMNS = 'm.page_id, m.site, m.confluence_id, m.confluence_version, m.local_checksum, m.state, m.synced_at'

function toRow(raw: RawMap): PageMapRow {
  return {
    pageId: raw.page_id,
    site: raw.site,
    confluenceId: raw.confluence_id,
    confluenceVersion: raw.confluence_version,
    localChecksum: raw.local_checksum,
    state: raw.state,
    syncedAt: raw.synced_at,
  }
}

export function findMapByPage(db: DatabaseSync, pageId: number): PageMapRow | undefined {
  const raw = queryOne<RawMap>(db.prepare(`SELECT ${COLUMNS} FROM confluence_page_map m WHERE m.page_id = ?`), pageId)
  return raw ? toRow(raw) : undefined
}

export function findMapByRemote(db: DatabaseSync, site: string, confluenceId: string): PageMapRow | undefined {
  const raw = queryOne<RawMap>(
    db.prepare(`SELECT ${COLUMNS} FROM confluence_page_map m WHERE m.site = ? AND m.confluence_id = ?`),
    site,
    confluenceId,
  )
  return raw ? toRow(raw) : undefined
}

export function mapsOfProject(db: DatabaseSync, projectId: number, state?: PageMapState): PageMapRow[] {
  const filter = state === undefined ? '' : 'AND m.state = ?'
  const params = state === undefined ? [projectId] : [projectId, state]
  return queryAll<RawMap>(
    db.prepare(
      `SELECT ${COLUMNS} FROM confluence_page_map m JOIN doc_pages p ON p.id = m.page_id
       WHERE p.project_id = ? ${filter}
       ORDER BY p.depth, p.position, p.id`,
    ),
    ...params,
  ).map(toRow)
}

export function saveMap(db: DatabaseSync, row: PageMapRow): void {
  db.prepare(
    `INSERT INTO confluence_page_map (page_id, site, confluence_id, confluence_version, local_checksum, state, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       site = excluded.site,
       confluence_id = excluded.confluence_id,
       confluence_version = excluded.confluence_version,
       local_checksum = excluded.local_checksum,
       state = excluded.state,
       synced_at = excluded.synced_at`,
  ).run(row.pageId, row.site, row.confluenceId, row.confluenceVersion, row.localChecksum, row.state, row.syncedAt)
}

export function setMapState(db: DatabaseSync, pageId: number, state: PageMapState): void {
  db.prepare('UPDATE confluence_page_map SET state = ? WHERE page_id = ?').run(state, pageId)
}
