import type { DatabaseSync } from 'node:sqlite'
import { toUtcIso } from './rows.ts'
import { queryAll } from './query.ts'
import { adoptEntryRefs, moveEntryRefs } from './page-refs.ts'

export interface MergeWrite {
  targetId: number
  sourceIds: number[]
  description: string
  projectId: number | null
  now: string
}

export interface MergeWriteOutcome {
  segmentIds: number[]
  pageIds: number[]
  touchesMoved: number
  docsMoved: number
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

export function joinSummaries(summaries: readonly string[]): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of summaries) {
    const summary = raw.trim()
    if (summary.length === 0 || seen.has(summary)) continue
    seen.add(summary)
    kept.push(summary)
  }
  return kept.join(' ')
}

export function writeMerge(db: DatabaseSync, merge: MergeWrite): MergeWriteOutcome {
  const now = toUtcIso(merge.now)
  const sources = merge.sourceIds.filter((id) => id !== merge.targetId)
  const everyone = [merge.targetId, ...sources]

  if (sources.length > 0) {
    db.prepare(
      `UPDATE entries SET merged_into = ?, updated_at = ?
       WHERE id IN (${placeholders(sources)}) OR merged_into IN (${placeholders(sources)})`,
    ).run(merge.targetId, now, ...sources, ...sources)
  }

  db.prepare(
    `UPDATE entries SET description = ?, project_id = ?, updated_at = ?
     WHERE id = ? OR merged_into = ?`,
  ).run(merge.description, merge.projectId, now, merge.targetId, merge.targetId)

  let touchesMoved = 0
  let docsMoved = 0
  const pageIds = new Set<number>()

  if (sources.length > 0) {
    touchesMoved = Number(
      db
        .prepare(
          `INSERT INTO entry_touches (entry_id, path, first_seen_at)
           SELECT ?, path, MIN(first_seen_at) FROM entry_touches
           WHERE entry_id IN (${placeholders(sources)})
           GROUP BY path
           ON CONFLICT (entry_id, path) DO UPDATE SET
             first_seen_at = MIN(entry_touches.first_seen_at, excluded.first_seen_at)`,
        )
        .run(merge.targetId, ...sources).changes,
    )
    db.prepare(`DELETE FROM entry_touches WHERE entry_id IN (${placeholders(sources)})`).run(...sources)

    docsMoved = Number(
      db
        .prepare(
          `UPDATE entry_docs SET entry_id = ?, kind = 'appendix', recorded_at = ?
           WHERE entry_id IN (${placeholders(sources)})`,
        )
        .run(merge.targetId, now, ...sources).changes,
    )
  }

  const links = queryAll<{ page_id: number; summary: string }>(
    db.prepare(
      `SELECT pe.page_id, pe.summary
       FROM page_entries pe JOIN entries e ON e.id = pe.entry_id
       WHERE pe.entry_id IN (${placeholders(everyone)})
       ORDER BY e.started_at, pe.page_id`,
    ),
    ...everyone,
  )

  const summariesByPage = new Map<number, string[]>()
  for (const link of links) {
    const list = summariesByPage.get(link.page_id) ?? []
    list.push(link.summary)
    summariesByPage.set(link.page_id, list)
  }

  if (sources.length > 0) {
    db.prepare(`DELETE FROM page_entries WHERE entry_id IN (${placeholders(sources)})`).run(...sources)
  }

  for (const [pageId, summaries] of summariesByPage) {
    pageIds.add(pageId)
    db.prepare(
      `INSERT INTO page_entries (page_id, entry_id, summary, linked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (page_id, entry_id) DO UPDATE SET summary = excluded.summary`,
    ).run(pageId, merge.targetId, joinSummaries(summaries), now)
  }

  moveEntryRefs(db, sources, merge.targetId)
  for (const pageId of pageIds) adoptEntryRefs(db, merge.targetId, pageId)

  const segmentIds = queryAll<{ id: number }>(
    db.prepare('SELECT id FROM entries WHERE merged_into = ? ORDER BY started_at'),
    merge.targetId,
  ).map((row) => row.id)

  return { segmentIds, pageIds: [...pageIds], touchesMoved, docsMoved }
}
