import type { EnrichedTimeEntry } from '../../src/domain/types.ts'
import { formatDuration, toDecimalHours } from '../../src/domain/duration.ts'
import { localDay, toJiraStarted, toLocalIso } from '../../src/domain/timezone.ts'

export const TEST_TZ = 'America/Mazatlan'

export interface EntryOverrides {
  id?: number
  description?: string
  projectId?: number | null
  projectName?: string | null
  start?: string
  durationSeconds?: number
  running?: boolean
  mergedInto?: number | null
  kind?: string | null
}

export function makeEntry(overrides: EntryOverrides = {}): EnrichedTimeEntry {
  const start = overrides.start ?? '2026-09-16T16:00:00Z'
  const durationSeconds = overrides.durationSeconds ?? 3600
  const stop = new Date(Date.parse(start) + durationSeconds * 1000).toISOString()

  return {
    id: overrides.id ?? 1,
    externalId: null,
    description: overrides.description ?? 'ajustar pipeline',
    projectId: overrides.projectId === undefined ? 789 : overrides.projectId,
    projectName: overrides.projectName === undefined ? 'Plataforma' : overrides.projectName,
    clientName: null,
    billable: false,
    start,
    stop: overrides.running ? null : stop,
    startLocal: toLocalIso(start, TEST_TZ),
    localDay: localDay(start, TEST_TZ),
    durationSeconds,
    durationHuman: formatDuration(durationSeconds),
    durationHours: toDecimalHours(durationSeconds),
    startedJira: toJiraStarted(start, TEST_TZ),
    running: overrides.running ?? false,
    mergedInto: overrides.mergedInto ?? null,
    kind: overrides.kind ?? null,
  }
}
