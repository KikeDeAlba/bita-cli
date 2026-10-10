import type { DatabaseSync } from 'node:sqlite'
import { toUtcIso } from './rows.ts'
import { queryAll } from './query.ts'

export interface MergeWrite {
  targetId: number
  sourceIds: number[]
  description: string
  projectId: number | null
  now: string
}

export interface MergeWriteOutcome {
  segmentIds: number[]
  touchesMoved: number
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

export function writeMerge(db: DatabaseSync, merge: MergeWrite): MergeWriteOutcome {
  const now = toUtcIso(merge.now)
  const sources = merge.sourceIds.filter((id) => id !== merge.targetId)

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
  }

  const segmentIds = queryAll<{ id: number }>(
    db.prepare('SELECT id FROM entries WHERE merged_into = ? ORDER BY started_at'),
    merge.targetId,
  ).map((row) => row.id)

  return { segmentIds, touchesMoved }
}
