export type EntrySource = 'timer' | 'manual' | 'import'

export type AtlassianVia = 'mcp' | 'cli'

export type ConfluenceKind = 'space' | 'page'

export interface ProjectRow {
  id: number
  name: string
  key: string | null
  clientName: string | null
  active: boolean
  jira: boolean
  externalId: number | null
  createdAt: string
  atlassianSite: string | null
  atlassianVia: AtlassianVia
  confluenceRef: string | null
  confluenceKind: ConfluenceKind | null
  syncPull: boolean
  syncPush: boolean
  lastSyncAt: string | null
}

export interface EntryRow {
  id: number
  projectId: number | null
  description: string
  startedAt: string
  stoppedAt: string | null
  billable: boolean
  source: EntrySource
  externalId: number | null
  mergedInto: number | null
  kind: string | null
  createdAt: string
  updatedAt: string
}

export interface EntryWithProjectRow extends EntryRow {
  projectName: string | null
  projectJira: boolean
  clientName: string | null
  registered: boolean
  issueKey: string | null
}

export interface JiraLinkRow {
  entryId: number
  issueKey: string | null
  worklogId: string | null
  linkedAt: string
}

export function toUtcIso(instant: string): string {
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`not a valid instant: ${instant}`)
  }
  return parsed.toISOString()
}

export function toBoolean(value: unknown): boolean {
  return value === 1 || value === true
}

export function fromBoolean(value: boolean): number {
  return value ? 1 : 0
}
