import type { EnrichedTimeEntry, TaskGroup, WorklogSlice } from './types.ts'
import { formatDuration, roundUpToStep, toDecimalHours } from './duration.ts'
import { localDay, toJiraStarted, toLocalIso } from './timezone.ts'
import { ESTIMATE_STEP_SECONDS, MAX_TASK_SECONDS } from '../config/constants.ts'

export interface GroupOptions {
  timezone: string
  maxTaskSeconds?: number
  estimateStepSeconds?: number
  caseInsensitive?: boolean
}

export function groupingKey(description: string, caseInsensitive: boolean): string {
  const collapsed = description.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '')
  if (!caseInsensitive) return collapsed
  return collapsed.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function sliceEntry(
  entry: EnrichedTimeEntry,
  maxSeconds: number,
  timezone: string,
): WorklogSlice[] {
  if (entry.durationSeconds <= maxSeconds) {
    return [
      {
        entryId: entry.id,
        startedJira: entry.startedJira,
        startLocal: entry.startLocal,
        localDay: entry.localDay,
        durationSeconds: entry.durationSeconds,
        timeSpent: entry.durationHuman,
        partial: false,
      },
    ]
  }

  const slices: WorklogSlice[] = []
  const startMs = Date.parse(entry.start)
  let consumed = 0

  while (consumed < entry.durationSeconds) {
    const chunk = Math.min(maxSeconds, entry.durationSeconds - consumed)
    const sliceStart = new Date(startMs + consumed * 1000)
    slices.push({
      entryId: entry.id,
      startedJira: toJiraStarted(sliceStart, timezone),
      startLocal: toLocalIso(sliceStart, timezone),
      localDay: localDay(sliceStart, timezone),
      durationSeconds: chunk,
      timeSpent: formatDuration(chunk),
      partial: true,
    })
    consumed += chunk
  }

  return slices
}

function packIntoParts(slices: WorklogSlice[], maxSeconds: number): WorklogSlice[][] {
  const parts: WorklogSlice[][] = []
  let current: WorklogSlice[] = []
  let currentTotal = 0

  for (const slice of slices) {
    if (current.length > 0 && currentTotal + slice.durationSeconds > maxSeconds) {
      parts.push(current)
      current = []
      currentTotal = 0
    }
    current.push(slice)
    currentTotal += slice.durationSeconds
  }

  if (current.length > 0) parts.push(current)
  return parts
}

function buildGroup(
  base: {
    key: string
    summary: string
    sample: EnrichedTimeEntry
    entries: EnrichedTimeEntry[]
  },
  worklogs: WorklogSlice[],
  partIndex: number,
  partCount: number,
  estimateStepSeconds: number,
): TaskGroup {
  const totalSeconds = worklogs.reduce((sum, slice) => sum + slice.durationSeconds, 0)
  const jira = base.sample.jira
  const estimateSeconds = jira ? roundUpToStep(totalSeconds, estimateStepSeconds) : 0
  const entryIds = [...new Set(worklogs.map((slice) => slice.entryId))]
  const entriesInPart = base.entries.filter((entry) => entryIds.includes(entry.id))
  const days = [...new Set(worklogs.map((slice) => slice.localDay))].sort()
  const stops = entriesInPart
    .map((entry) => entry.stop)
    .filter((stop): stop is string => stop !== null)
    .sort()

  return {
    key: partCount > 1 ? `${base.key}#${partIndex}` : base.key,
    summary: partCount > 1 ? `${base.summary} (${partIndex}/${partCount})` : base.summary,
    projectId: base.sample.projectId,
    projectName: base.sample.projectName,
    clientName: base.sample.clientName,
    billable: entriesInPart.some((entry) => entry.billable),
    totalSeconds,
    totalHuman: formatDuration(totalSeconds),
    totalHours: toDecimalHours(totalSeconds),
    estimateSeconds,
    estimateHuman: formatDuration(estimateSeconds),
    entryIds,
    days,
    firstStart: worklogs[0]?.startLocal ?? base.sample.startLocal,
    lastStop: stops.at(-1) ?? null,
    worklogs,
    partIndex,
    partCount,
    splitReason: partCount > 1 ? 'max-task-hours' : 'none',
    jira,
  }
}

export function groupEntries(
  entries: EnrichedTimeEntry[],
  options: GroupOptions,
): TaskGroup[] {
  const maxSeconds = options.maxTaskSeconds ?? MAX_TASK_SECONDS
  const caseInsensitive = options.caseInsensitive ?? false
  const estimateStep = options.estimateStepSeconds ?? ESTIMATE_STEP_SECONDS

  const buckets = new Map<string, EnrichedTimeEntry[]>()

  for (const entry of entries) {
    const key = `${entry.projectId ?? 'none'}\u0000${groupingKey(entry.description, caseInsensitive)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }

  const groups: TaskGroup[] = []

  for (const [key, bucket] of buckets) {
    const ordered = [...bucket].sort((a, b) => a.start.localeCompare(b.start))
    const sample = ordered[0]
    if (!sample) continue

    const slices = ordered.flatMap((entry) => sliceEntry(entry, maxSeconds, options.timezone))
    const parts = packIntoParts(slices, maxSeconds)

    parts.forEach((worklogs, index) => {
      groups.push(
        buildGroup(
          { key, summary: sample.description, sample, entries: ordered },
          worklogs,
          index + 1,
          parts.length,
          estimateStep,
        ),
      )
    })
  }

  return groups.sort((a, b) => {
    if (b.totalSeconds !== a.totalSeconds) return b.totalSeconds - a.totalSeconds
    if (a.summary !== b.summary) return a.summary.localeCompare(b.summary)
    return a.partIndex - b.partIndex
  })
}
