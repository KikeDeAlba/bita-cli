import type { EnrichedTimeEntry } from './types.ts'
import { formatDuration } from './duration.ts'

export interface DayOverlap {
  localDay: string
  trackedSeconds: number
  clockSeconds: number
  overlapSeconds: number
}

interface Interval {
  from: number
  to: number
}

export function unionSeconds(intervals: Interval[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((left, right) => left.from - right.from)

  let total = 0
  let current = sorted[0]
  if (!current) return 0
  let { from, to } = current

  for (let index = 1; index < sorted.length; index += 1) {
    current = sorted[index]
    if (!current) continue
    if (current.from <= to) {
      to = Math.max(to, current.to)
      continue
    }
    total += to - from
    from = current.from
    to = current.to
  }

  return Math.round((total + (to - from)) / 1000)
}

function intervalOf(entry: EnrichedTimeEntry, now: Date): Interval | null {
  const from = Date.parse(entry.start)
  const to = entry.stop === null ? now.getTime() : Date.parse(entry.stop)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return { from, to }
}

export function findOverlaps(entries: EnrichedTimeEntry[], now: Date): DayOverlap[] {
  const byDay = new Map<string, Interval[]>()
  const trackedByDay = new Map<string, number>()

  for (const entry of entries) {
    const interval = intervalOf(entry, now)
    if (!interval) continue

    const intervals = byDay.get(entry.localDay) ?? []
    intervals.push(interval)
    byDay.set(entry.localDay, intervals)
    trackedByDay.set(entry.localDay, (trackedByDay.get(entry.localDay) ?? 0) + entry.durationSeconds)
  }

  const overlaps: DayOverlap[] = []
  for (const [localDay, intervals] of byDay) {
    const clockSeconds = unionSeconds(intervals)
    const trackedSeconds = trackedByDay.get(localDay) ?? 0
    const overlapSeconds = trackedSeconds - clockSeconds
    if (overlapSeconds >= 60) {
      overlaps.push({ localDay, trackedSeconds, clockSeconds, overlapSeconds })
    }
  }

  return overlaps.sort((left, right) => left.localDay.localeCompare(right.localDay))
}

export function overlappingKeys<K>(
  entries: EnrichedTimeEntry[],
  overlaps: DayOverlap[],
  now: Date,
  keyOf: (entry: EnrichedTimeEntry) => K,
): Set<K> {
  const days = new Set(overlaps.map((overlap) => overlap.localDay))
  const byDay = new Map<string, Array<Interval & { key: K }>>()
  for (const entry of entries) {
    if (!days.has(entry.localDay)) continue
    const interval = intervalOf(entry, now)
    if (!interval) continue
    const intervals = byDay.get(entry.localDay) ?? []
    intervals.push({ ...interval, key: keyOf(entry) })
    byDay.set(entry.localDay, intervals)
  }

  const keys = new Set<K>()
  for (const intervals of byDay.values()) {
    intervals.sort((left, right) => left.from - right.from)
    for (let index = 0; index < intervals.length; index += 1) {
      const current = intervals[index]
      if (!current) continue
      for (let next = index + 1; next < intervals.length; next += 1) {
        const other = intervals[next]
        if (!other || other.from >= current.to) break
        if (other.key === current.key) continue
        keys.add(current.key)
        keys.add(other.key)
      }
    }
  }
  return keys
}

export function describeOverlap(overlap: DayOverlap): string {
  return `${overlap.localDay}: ${formatDuration(overlap.trackedSeconds)} tracked over ${formatDuration(overlap.clockSeconds)} of clock time (${formatDuration(overlap.overlapSeconds)} overlapping)`
}
