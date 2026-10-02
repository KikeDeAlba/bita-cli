export interface EnrichedTimeEntry {
  id: number
  externalId: number | null
  description: string
  projectId: number | null
  projectName: string | null
  clientName: string | null
  billable: boolean
  registered: boolean
  issueKey: string | null
  start: string
  stop: string | null
  startLocal: string
  localDay: string
  durationSeconds: number
  durationHuman: string
  durationHours: number
  startedJira: string
  running: boolean
  mergedInto: number | null
  kind: string | null
}

export interface WorklogSlice {
  entryId: number
  startedJira: string
  startLocal: string
  localDay: string
  durationSeconds: number
  timeSpent: string
  partial: boolean
}

export interface TaskGroup {
  key: string
  summary: string
  projectId: number | null
  projectName: string | null
  clientName: string | null
  billable: boolean
  totalSeconds: number
  totalHuman: string
  totalHours: number
  estimateSeconds: number
  estimateHuman: string
  entryIds: number[]
  days: string[]
  firstStart: string
  lastStop: string | null
  worklogs: WorklogSlice[]
  partIndex: number
  partCount: number
  splitReason: 'none' | 'max-task-hours'
}

export interface ExcludedEntry {
  id: number
  description: string
  projectName: string | null
  localDay: string
  durationSeconds: number
  durationHuman: string
  registered: boolean
  reason: string
}
