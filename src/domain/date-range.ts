import { UsageError } from '../errors.ts'
import { addDays, isValidIsoDay, localDay, weekdayIndex } from './timezone.ts'

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'last-week'
  | 'month'
  | 'last-month'

export const RANGE_PRESETS: readonly RangePreset[] = [
  'today',
  'yesterday',
  'week',
  'last-week',
  'month',
  'last-month',
]

export interface DateRangeInput {
  preset?: RangePreset | undefined
  from?: string | undefined
  to?: string | undefined
  lastDays?: number | undefined
}

export interface RangeContext {
  timezone: string
  beginningOfWeek: number
  now: Date
}

export interface ResolvedRange {
  fromDay: string
  toDay: string
  queryStartDate: string
  queryEndDate: string
  timezone: string
  preset: RangePreset | 'custom'
  spanDays: number
}

function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`)
  const to = Date.parse(`${toDay}T00:00:00Z`)
  return Math.round((to - from) / 86400000) + 1
}

export function startOfWeek(isoDay: string, beginningOfWeek: number): string {
  const current = weekdayIndex(isoDay)
  const delta = (current - beginningOfWeek + 7) % 7
  return addDays(isoDay, -delta)
}

function startOfMonth(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`
}

function requireValidDay(value: string, flag: string): string {
  if (!isValidIsoDay(value)) {
    throw new UsageError(`Invalid date for ${flag}: "${value}". Expected format YYYY-MM-DD.`)
  }
  return value
}

export function resolveDateRange(input: DateRangeInput, ctx: RangeContext): ResolvedRange {
  const today = localDay(ctx.now, ctx.timezone)

  let fromDay: string
  let toDay: string
  let preset: RangePreset | 'custom' = input.preset ?? 'custom'

  if (input.from || input.to) {
    if (input.preset) {
      throw new UsageError('Use either a range preset or --from/--to, not both.')
    }
    toDay = input.to ? requireValidDay(input.to, '--to') : today
    fromDay = input.from ? requireValidDay(input.from, '--from') : toDay
    preset = 'custom'
  } else if (input.lastDays !== undefined) {
    if (!Number.isInteger(input.lastDays) || input.lastDays < 1) {
      throw new UsageError(`Invalid value for --last-days: "${input.lastDays}". Expected a positive integer.`)
    }
    toDay = today
    fromDay = addDays(today, -(input.lastDays - 1))
    preset = 'custom'
  } else {
    switch (input.preset ?? 'today') {
      case 'today':
        fromDay = today
        toDay = today
        preset = 'today'
        break
      case 'yesterday':
        fromDay = addDays(today, -1)
        toDay = fromDay
        preset = 'yesterday'
        break
      case 'week':
        fromDay = startOfWeek(today, ctx.beginningOfWeek)
        toDay = today
        preset = 'week'
        break
      case 'last-week': {
        const thisWeek = startOfWeek(today, ctx.beginningOfWeek)
        fromDay = addDays(thisWeek, -7)
        toDay = addDays(thisWeek, -1)
        preset = 'last-week'
        break
      }
      case 'month':
        fromDay = startOfMonth(today)
        toDay = today
        preset = 'month'
        break
      case 'last-month': {
        const firstOfThisMonth = startOfMonth(today)
        toDay = addDays(firstOfThisMonth, -1)
        fromDay = startOfMonth(toDay)
        preset = 'last-month'
        break
      }
    }
  }

  if (fromDay > toDay) {
    throw new UsageError(`Empty range: --from ${fromDay} is after --to ${toDay}.`)
  }

  return {
    fromDay,
    toDay,
    queryStartDate: addDays(fromDay, -1),
    queryEndDate: addDays(toDay, 2),
    timezone: ctx.timezone,
    preset,
    spanDays: daysBetween(fromDay, toDay),
  }
}
