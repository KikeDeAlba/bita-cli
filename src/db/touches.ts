import type { DatabaseSync } from 'node:sqlite'
import { queryAll, queryOne } from './query.ts'

export function recordTouch(db: DatabaseSync, entryId: number, path: string, now: string): void {
  db.prepare(
    `INSERT INTO entry_touches (entry_id, path, first_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT (entry_id, path) DO NOTHING`,
  ).run(entryId, path, now)
}

export function listTouches(db: DatabaseSync, entryId: number): string[] {
  return queryAll<{ path: string }>(
    db.prepare('SELECT path FROM entry_touches WHERE entry_id = ? ORDER BY first_seen_at, path'),
    entryId,
  ).map((row) => row.path)
}

export function lastTouchAt(db: DatabaseSync, entryId: number): string | null {
  const row = queryOne<{ last: string | null }>(
    db.prepare('SELECT MAX(first_seen_at) AS last FROM entry_touches WHERE entry_id = ?'),
    entryId,
  )
  return row?.last ?? null
}

export function touchesByEntry(db: DatabaseSync, entryIds: number[]): Map<number, string[]> {
  const byEntry = new Map<number, string[]>()
  if (entryIds.length === 0) return byEntry

  const placeholders = entryIds.map(() => '?').join(', ')
  const rows = queryAll<{ entry_id: number; path: string }>(
    db.prepare(
      `SELECT entry_id, path FROM entry_touches
       WHERE entry_id IN (${placeholders})
       ORDER BY first_seen_at, path`,
    ),
    ...entryIds,
  )

  for (const row of rows) {
    const paths = byEntry.get(row.entry_id) ?? []
    paths.push(row.path)
    byEntry.set(row.entry_id, paths)
  }

  return byEntry
}
