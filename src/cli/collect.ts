import type { DatabaseSync } from 'node:sqlite'
import { resolveDateRange, type ResolvedRange } from '../domain/date-range.ts'
import { withinLocalRange } from '../domain/filter.ts'
import { enrichEntries } from '../domain/enrich.ts'
import { describeOverlap, findOverlaps, type DayOverlap } from '../domain/overlap.ts'
import { listEntriesStartedBetween } from '../db/entries.ts'
import type { EnrichedTimeEntry } from '../domain/types.ts'
import { readRangeInput, type ParsedArgs } from './args.ts'

export interface CollectResult {
  range: ResolvedRange
  selected: EnrichedTimeEntry[]
  overlaps: DayOverlap[]
  warnings: string[]
}

export interface CollectContext {
  db: DatabaseSync
  timezone: string
  beginningOfWeek: number
  now: Date
}

export function collectEntries(ctx: CollectContext, args: ParsedArgs): CollectResult {
  const range = resolveDateRange(readRangeInput(args), {
    timezone: ctx.timezone,
    beginningOfWeek: ctx.beginningOfWeek,
    now: ctx.now,
  })

  const rows = listEntriesStartedBetween(
    ctx.db,
    `${range.queryStartDate}T00:00:00.000Z`,
    `${range.queryEndDate}T00:00:00.000Z`,
  )

  const selected = enrichEntries(rows, ctx.timezone, ctx.now).filter((entry) =>
    withinLocalRange(entry, range.fromDay, range.toDay),
  )
  const overlaps = findOverlaps(selected, ctx.now)
  return { range, selected, overlaps, warnings: overlaps.map(describeOverlap) }
}
