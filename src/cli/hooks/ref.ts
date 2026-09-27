import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { listRunning } from '../../db/entries.ts'
import { pagesOfEntry } from '../../db/page-links.ts'
import { addRefToEntry, addRefToPage } from '../../db/page-refs.ts'
import { readRepoContext } from '../../state/git.ts'
import { readConfig } from '../../state/config.ts'
import { resolveRepoIdentity } from '../../domain/repo.ts'
import { chooseRefTarget, extractRefs, type ExtractedRef, type ToolUse } from '../../domain/refs.ts'
import { resolveMappedProject } from '../resolve-project.ts'

export interface RefHookResult {
  decision: 'no-refs' | 'no-target' | 'page' | 'entry'
  entryId?: number
  refs: ExtractedRef[]
}

async function projectForCwd(cwd: string | undefined): Promise<number | null> {
  if (!cwd) return null
  const context = await readRepoContext(cwd)
  const identity = resolveRepoIdentity({
    cwd,
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

export function recordRefs(
  db: DatabaseSync,
  entryId: number,
  refs: readonly ExtractedRef[],
  now: string,
): 'page' | 'entry' {
  const pages = pagesOfEntry(db, entryId)
  for (const ref of refs) {
    const row = { url: ref.url, title: ref.title, kind: ref.kind, source: 'hook' as const, now }
    if (pages.length === 0) addRefToEntry(db, entryId, row)
    for (const page of pages) addRefToPage(db, page.pageId, row)
  }
  return pages.length === 0 ? 'entry' : 'page'
}

export async function runRefHook(payload: string, dbPath = databasePath()): Promise<RefHookResult> {
  let use: ToolUse & { cwd?: unknown }
  try {
    use = JSON.parse(payload) as ToolUse & { cwd?: unknown }
  } catch {
    return { decision: 'no-refs', refs: [] }
  }

  const config = await readConfig()
  const refs = extractRefs(use, config.jira?.siteUrl)
  if (refs.length === 0) return { decision: 'no-refs', refs }

  const db = openDatabase(dbPath)
  try {
    const running = listRunning(db).map((entry) => ({ id: entry.id, projectId: entry.projectId }))
    if (running.length === 0) return { decision: 'no-target', refs }
    const projectId = running.length === 1 ? null : await projectForCwd(typeof use.cwd === 'string' ? use.cwd : undefined)
    const entryId = chooseRefTarget(running, projectId)
    if (entryId === null) return { decision: 'no-target', refs }
    const decision = recordRefs(db, entryId, refs, new Date().toISOString())
    return { decision, entryId, refs }
  } finally {
    db.close()
  }
}
