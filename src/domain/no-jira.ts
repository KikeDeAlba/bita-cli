import type { EnrichedTimeEntry } from './types.ts'
import { formatDuration } from './duration.ts'

export interface NonJiraSummary {
  entryCount: number
  totalSeconds: number
  totalHuman: string
  projects: { id: number | null; name: string | null; totalSeconds: number; totalHuman: string }[]
}

export function partitionByJira(entries: readonly EnrichedTimeEntry[]): {
  jira: EnrichedTimeEntry[]
  nonJira: EnrichedTimeEntry[]
} {
  return {
    jira: entries.filter((entry) => entry.jira),
    nonJira: entries.filter((entry) => !entry.jira),
  }
}

export function summarizeNonJira(entries: readonly EnrichedTimeEntry[]): NonJiraSummary {
  const byProject = new Map<number | null, { name: string | null; totalSeconds: number }>()
  for (const entry of entries) {
    const current = byProject.get(entry.projectId) ?? { name: entry.projectName, totalSeconds: 0 }
    current.totalSeconds += entry.durationSeconds
    byProject.set(entry.projectId, current)
  }
  const totalSeconds = entries.reduce((sum, entry) => sum + entry.durationSeconds, 0)
  return {
    entryCount: entries.length,
    totalSeconds,
    totalHuman: formatDuration(totalSeconds),
    projects: [...byProject.entries()]
      .map(([id, project]) => ({
        id,
        name: project.name,
        totalSeconds: project.totalSeconds,
        totalHuman: formatDuration(project.totalSeconds),
      }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds),
  }
}
