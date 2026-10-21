import os from 'node:os'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { listRunning } from '../../db/entries.ts'
import { recordTouch } from '../../db/touches.ts'
import { readRepoContext } from '../../state/git.ts'
import { readConfig } from '../../state/config.ts'
import { resolveRepoIdentity } from '../../domain/repo.ts'
import { decideAttachment, type RunningSnapshot } from '../../domain/attach.ts'
import { resolveMappedProject } from '../resolve-project.ts'

export interface TouchedResult {
  decision: string
  entryId?: number
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

function snapshots(db: DatabaseSync): RunningSnapshot[] {
  return listRunning(db).map((entry) => ({ id: entry.id, projectId: entry.projectId }))
}

export interface TouchedOptions {
  dbPath?: string
  preferredEntryId?: number | null
}

export async function runTouched(file: string, options: TouchedOptions = {}): Promise<TouchedResult> {
  const dbPath = options.dbPath ?? databasePath()
  const absolute = resolve(file)
  const projectId = await projectForFile(absolute)
  const iso = new Date().toISOString()

  const db = openDatabase(dbPath)
  try {
    const decision = decideAttachment({
      running: snapshots(db),
      projectId,
      preferredEntryId: options.preferredEntryId ?? null,
    })

    if (decision.kind === 'ignore') return { decision: `ignore:${decision.reason}` }

    recordTouch(db, decision.entryId, absolute, iso)
    return { decision: 'record', entryId: decision.entryId }
  } finally {
    db.close()
  }
}
