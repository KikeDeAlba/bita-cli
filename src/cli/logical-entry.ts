import type { DatabaseSync } from 'node:sqlite'
import type { EntryWithProjectRow } from '../db/rows.ts'
import { listSegments } from '../db/entries.ts'
import { enrichEntry } from '../domain/enrich.ts'
import { formatDuration, toDecimalHours } from '../domain/duration.ts'
import type { EnrichedTimeEntry } from '../domain/types.ts'

export interface EntrySegment {
  entryId: number
  localDay: string
  startLocal: string
  durationSeconds: number
  durationHuman: string
}

export type LogicalEntry = EnrichedTimeEntry & { segments: EntrySegment[] }

function toSegment(entry: EnrichedTimeEntry): EntrySegment {
  return {
    entryId: entry.id,
    localDay: entry.localDay,
    startLocal: entry.startLocal,
    durationSeconds: entry.durationSeconds,
    durationHuman: entry.durationHuman,
  }
}

export function withSegments(target: EnrichedTimeEntry, blocks: EnrichedTimeEntry[]): LogicalEntry {
  if (blocks.length === 0) return { ...target, segments: [] }
  const ordered = [target, ...blocks].sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)
  const durationSeconds = ordered.reduce((sum, entry) => sum + entry.durationSeconds, 0)
  return {
    ...target,
    durationSeconds,
    durationHuman: formatDuration(durationSeconds),
    durationHours: toDecimalHours(durationSeconds),
    segments: ordered.map(toSegment),
  }
}

export function enrichLogical(
  db: DatabaseSync,
  row: EntryWithProjectRow,
  timezone: string,
  now: Date,
): LogicalEntry {
  const blocks = listSegments(db, row.id).map((segment) => enrichEntry(segment, timezone, now))
  return withSegments(enrichEntry(row, timezone, now), blocks)
}

export function collapseSegments(entries: EnrichedTimeEntry[]): LogicalEntry[] {
  const present = new Set(entries.map((entry) => entry.id))
  const blocksOf = new Map<number, EnrichedTimeEntry[]>()
  for (const entry of entries) {
    if (entry.mergedInto === null || !present.has(entry.mergedInto)) continue
    const list = blocksOf.get(entry.mergedInto) ?? []
    list.push(entry)
    blocksOf.set(entry.mergedInto, list)
  }
  return entries
    .filter((entry) => entry.mergedInto === null || !present.has(entry.mergedInto))
    .map((entry) => withSegments(entry, blocksOf.get(entry.id) ?? []))
}
