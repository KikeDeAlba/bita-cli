import type { EnrichedTimeEntry } from './types.ts'

export function withinLocalRange(entry: EnrichedTimeEntry, fromDay: string, toDay: string): boolean {
  return entry.localDay >= fromDay && entry.localDay <= toDay
}
