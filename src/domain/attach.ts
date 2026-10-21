export interface RunningSnapshot {
  id: number
  projectId: number | null
}

export type AttachDecision =
  | { kind: 'record'; entryId: number }
  | { kind: 'ignore'; reason: 'no-timer' | 'unknown-project' }

export interface AttachInput {
  running: readonly RunningSnapshot[]
  projectId: number | null
  preferredEntryId: number | null
}

export function decideAttachment(input: AttachInput): AttachDecision {
  const { running, projectId, preferredEntryId } = input

  if (preferredEntryId !== null) {
    const preferred = running.find((entry) => entry.id === preferredEntryId)
    if (preferred) return { kind: 'record', entryId: preferred.id }
  }

  const oldest = running[0]
  if (!oldest) return { kind: 'ignore', reason: 'no-timer' }

  if (projectId === null) return { kind: 'record', entryId: oldest.id }

  const sameProject = running.find((entry) => entry.projectId === projectId)
  if (sameProject) return { kind: 'record', entryId: sameProject.id }

  const unassigned = running.find((entry) => entry.projectId === null)
  if (unassigned) return { kind: 'record', entryId: unassigned.id }

  return { kind: 'ignore', reason: 'unknown-project' }
}
