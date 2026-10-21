import os from 'node:os'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { insertEntry, listRunning, stopEntry, updateEntry } from '../../db/entries.ts'
import { recordTouch } from '../../db/touches.ts'
import { readRepoContext } from '../../state/git.ts'
import { readConfig } from '../../state/config.ts'
import { resolveRepoIdentity } from '../../domain/repo.ts'
import { decideAttachment, type RunningSnapshot } from '../../domain/attach.ts'
import { resolveMappedProject } from '../resolve-project.ts'
import { MIN_SPLIT_SECONDS } from '../../config/constants.ts'

export interface TouchedResult {
  decision: string
  entryId?: number
  projectId?: number
}

async function projectForFile(file: string): Promise<number | null> {
  const context = await readRepoContext(dirname(file))
  const identity = resolveRepoIdentity({
    cwd: dirname(file),
    toplevel: context.toplevel,
    home: os.homedir(),
    remoteUrl: context.remoteUrl,
    branch: context.branch,
    headSha: context.headSha,
  })
  if (!identity) return null

  const config = await readConfig()
  return resolveMappedProject(identity.slug, config)?.projectId ?? null
}

function snapshots(db: DatabaseSync, now: Date): RunningSnapshot[] {
  return listRunning(db).map((entry) => ({
    id: entry.id,
    projectId: entry.projectId,
    isDraft: entry.description.trim().length === 0,
    elapsedSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(entry.startedAt)) / 1000)),
  }))
}

export interface TouchedOptions {
  dbPath?: string
  preferredEntryId?: number | null
}

export async function runTouched(file: string, options: TouchedOptions = {}): Promise<TouchedResult> {
  const dbPath = options.dbPath ?? databasePath()
  const absolute = resolve(file)
  const projectId = await projectForFile(absolute)
  const now = new Date()
  const iso = now.toISOString()

  const db = openDatabase(dbPath)
  try {
    const decision = decideAttachment({
      running: snapshots(db, now),
      projectId,
      wrote: true,
      minSplitSeconds: MIN_SPLIT_SECONDS,
    })

    if (decision.kind === 'ignore') return { decision: `ignore:${decision.reason}` }

    if (decision.kind === 'record') {
      recordTouch(db, decision.entryId, absolute, iso)
      return { decision: 'record', entryId: decision.entryId }
    }

    if (decision.kind === 'assign') {
      updateEntry(db, decision.entryId, { projectId: decision.projectId }, iso)
      recordTouch(db, decision.entryId, absolute, iso)
      return { decision: 'assign', entryId: decision.entryId, projectId: decision.projectId }
    }

    stopEntry(db, decision.stopEntryId, iso, iso)
    const created = insertEntry(db, {
      description: '',
      projectId: decision.projectId,
      startedAt: iso,
      source: 'timer',
      now: iso,
    })
    recordTouch(db, created.id, absolute, iso)
    return { decision: 'split', entryId: created.id, projectId: decision.projectId }
  } finally {
    db.close()
  }
}
