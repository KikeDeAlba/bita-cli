import type { EntryWithProjectRow } from '../db/rows.ts'
import type { EnrichedTimeEntry } from './types.ts'
import { formatDuration, toDecimalHours } from './duration.ts'
import { localDay, toJiraStarted, toLocalIso } from './timezone.ts'

export function normalizeDescription(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

export function elapsedSecondsOf(row: EntryWithProjectRow, now: Date): number {
  const started = Date.parse(row.startedAt)
  const ended = row.stoppedAt === null ? now.getTime() : Date.parse(row.stoppedAt)
  return Math.max(0, Math.round((ended - started) / 1000))
}

export function enrichEntry(
  row: EntryWithProjectRow,
  timezone: string,
  now: Date,
): EnrichedTimeEntry {
  const durationSeconds = elapsedSecondsOf(row, now)

  return {
    id: row.id,
    externalId: row.externalId,
    description: normalizeDescription(row.description),
    projectId: row.projectId,
    projectName: row.projectName,
    clientName: row.clientName,
    billable: row.billable,
    start: row.startedAt,
    stop: row.stoppedAt,
    startLocal: toLocalIso(row.startedAt, timezone),
    localDay: localDay(row.startedAt, timezone),
    durationSeconds,
    durationHuman: formatDuration(durationSeconds),
    durationHours: toDecimalHours(durationSeconds),
    startedJira: toJiraStarted(row.startedAt, timezone),
    running: row.stoppedAt === null,
    mergedInto: row.mergedInto,
    kind: row.kind,
  }
}

export function enrichEntries(
  rows: EntryWithProjectRow[],
  timezone: string,
  now: Date,
): EnrichedTimeEntry[] {
  return rows.map((row) => enrichEntry(row, timezone, now))
}
