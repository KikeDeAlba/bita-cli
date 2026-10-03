import type { DatabaseSync } from 'node:sqlite'
import { resolveDateRange, type ResolvedRange } from '../domain/date-range.ts'
import { matchesRegistration, withinLocalRange, type RegistrationFilter } from '../domain/filter.ts'
import { enrichEntries } from '../domain/enrich.ts'
import { describeOverlap, findOverlaps, type DayOverlap } from '../domain/overlap.ts'
import { listEntriesStartedBetween } from '../db/entries.ts'
import type { EnrichedTimeEntry, ExcludedEntry } from '../domain/types.ts'
import { hasExplicitRange, readRangeInput, readRegistrationFilter, type ParsedArgs } from './args.ts'
import { DEFAULT_PENDING_LOOKBACK_DAYS } from '../config/constants.ts'

export interface CollectOptions {
  includeRunning: boolean
  requireDescription: boolean
  requireProject: boolean
}

export interface CollectResult {
  range: ResolvedRange
  filter: RegistrationFilter
  selected: EnrichedTimeEntry[]
  nonJira: EnrichedTimeEntry[]
  excluded: ExcludedEntry[]
  alreadyRegistered: { count: number; totalSeconds: number }
  overlaps: DayOverlap[]
  warnings: string[]
}

export interface CollectContext {
  db: DatabaseSync
  timezone: string
  beginningOfWeek: number
  now: Date
}

function toExcluded(entry: EnrichedTimeEntry, reason: string): ExcludedEntry {
  return {
    id: entry.id,
    description: entry.description,
    projectName: entry.projectName,
    localDay: entry.localDay,
    durationSeconds: entry.durationSeconds,
    durationHuman: entry.durationHuman,
    registered: entry.registered,
    reason,
  }
}

export function collectEntries(
  ctx: CollectContext,
  args: ParsedArgs,
  options: CollectOptions,
): CollectResult {
  const filter = readRegistrationFilter(args)
  const explicitRange = hasExplicitRange(args)
  const warnings: string[] = []

  const rangeInput = readRangeInput(args)
  if (!explicitRange && filter === 'pending') {
    rangeInput.lastDays = DEFAULT_PENDING_LOOKBACK_DAYS
    warnings.push(
      `No range given; scanning the last ${DEFAULT_PENDING_LOOKBACK_DAYS} days. Use --from or --last-days to widen.`,
    )
  }

  const range = resolveDateRange(rangeInput, {
    timezone: ctx.timezone,
    beginningOfWeek: ctx.beginningOfWeek,
    now: ctx.now,
  })

  const rows = listEntriesStartedBetween(
    ctx.db,
    `${range.queryStartDate}T00:00:00.000Z`,
    `${range.queryEndDate}T00:00:00.000Z`,
  )

  const enriched = enrichEntries(rows, ctx.timezone, ctx.now)
  const inRange = enriched.filter((entry) => withinLocalRange(entry, range.fromDay, range.toDay))
  const matched = inRange.filter((entry) => matchesRegistration(entry, filter))

  const selected: EnrichedTimeEntry[] = []
  const nonJira: EnrichedTimeEntry[] = []
  const excluded: ExcludedEntry[] = []

  const registeredEntries = inRange.filter((entry) => entry.registered && entry.jira)
  const alreadyRegistered = {
    count: registeredEntries.length,
    totalSeconds: registeredEntries.reduce((sum, entry) => sum + entry.durationSeconds, 0),
  }

  for (const entry of matched) {
    if (filter === 'pending' && !entry.jira) {
      if (!entry.running || options.includeRunning) nonJira.push(entry)
      continue
    }
    if (entry.running && !options.includeRunning) {
      excluded.push(toExcluded(entry, 'running'))
      continue
    }
    if (options.requireProject && entry.projectId === null) {
      excluded.push(toExcluded(entry, 'no-project'))
      continue
    }
    if (options.requireDescription && entry.description.length < 3) {
      excluded.push(toExcluded(entry, 'no-description'))
      continue
    }
    if (options.requireDescription && Math.round(entry.durationSeconds / 60) === 0) {
      excluded.push(toExcluded(entry, 'zero-duration'))
      continue
    }
    selected.push(entry)
  }

  const runningCount = excluded.filter((entry) => entry.reason === 'running').length
  if (runningCount > 0) {
    warnings.push(
      `${runningCount} running entries were excluded; pass --include-running to count them.`,
    )
  }

  const overlaps = findOverlaps(inRange, ctx.now)
  for (const overlap of overlaps) warnings.push(describeOverlap(overlap))

  return { range, filter, selected, nonJira, excluded, alreadyRegistered, overlaps, warnings }
}
