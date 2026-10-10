export interface EnrichedTimeEntry {
  id: number
  externalId: number | null
  description: string
  projectId: number | null
  projectName: string | null
  clientName: string | null
  billable: boolean
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
