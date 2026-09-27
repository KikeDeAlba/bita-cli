import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { promptConfirm } from '../prompt.ts'
import { inTransaction } from '../../db/open.ts'
import { deleteEntry, findEntryWithProject, listEntriesForProject, listSegments } from '../../db/entries.ts'
import { deleteProject, findProjectById, findProjectByName } from '../../db/projects.ts'
import {
  CONFIG_PATH,
  readConfig,
  unsetProjectMapping,
  unsetScopeMapping,
  type AppConfig,
} from '../../state/config.ts'
import { listDocsForEntry } from '../../db/docs.ts'
import { listTouches } from '../../db/touches.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { removeDocument } from '../../docs/store.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { formatDuration } from '../../domain/duration.ts'

const OPTIONS = {
  ids: { type: 'string' as const },
  force: { type: 'boolean' as const, default: false },
  yes: { type: 'boolean' as const, default: false },
  'keep-doc': { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
}

export interface DeletionTarget {
  id: number
  description: string
  projectName: string | null
  issueKey: string | null
  registered: boolean
  localDay: string
  durationSeconds: number
  durationHuman: string
  docPaths: string[]
  touchedCount: number
}

export interface PlanContext {
  db: DatabaseSync
  timezone: string
  now: Date
  docsRoot: string
}

export interface DeletionPlan {
  targets: DeletionTarget[]
  missing: number[]
  running: number[]
  registered: DeletionTarget[]
  merged: { id: number; mergedInto: number }[]
}

export interface DeletionOutcome {
  deleted: DeletionTarget[]
  docsRemoved: string[]
  docsKept: string[]
  docsOrphaned: string[]
}

export function readIds(args: ParsedArgs): number[] {
  const fromFlag = (readString(args, 'ids') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  const raw = [...args.positionals, ...fromFlag]
  if (raw.length === 0) throw new UsageError('Usage: bita delete <entryIds...>')

  const ids: number[] = []
  for (const value of raw) {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${value}" is not an entry id.`)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function planDeletions(ctx: PlanContext, ids: number[], force: boolean): DeletionPlan {
  const targets: DeletionTarget[] = []
  const missing: number[] = []
  const running: number[] = []
  const registered: DeletionTarget[] = []
  const merged: { id: number; mergedInto: number }[] = []

  for (const id of ids) {
    const row = findEntryWithProject(ctx.db, id)
    if (!row) {
      missing.push(id)
      continue
    }
    if (row.mergedInto !== null) {
      merged.push({ id, mergedInto: row.mergedInto })
      continue
    }
    if (row.stoppedAt === null) {
      running.push(id)
      continue
    }

    const enriched = enrichEntry(row, ctx.timezone, ctx.now)
    const segmentSeconds = listSegments(ctx.db, row.id).reduce(
      (sum, segment) => sum + enrichEntry(segment, ctx.timezone, ctx.now).durationSeconds,
      0,
    )
    const durationSeconds = enriched.durationSeconds + segmentSeconds
    const target: DeletionTarget = {
      id: row.id,
      description: enriched.description,
      projectName: row.projectName,
      issueKey: row.issueKey,
      registered: row.registered,
      localDay: enriched.localDay,
      durationSeconds,
      durationHuman: formatDuration(durationSeconds),
      docPaths: listDocsForEntry(ctx.db, row.id).map((doc) =>
        resolveDocPath(ctx.docsRoot, doc.relPath),
      ),
      touchedCount: listTouches(ctx.db, row.id).length,
    }

    if (row.registered && !force) {
      registered.push(target)
      continue
    }
    targets.push(target)
  }

  return { targets, missing, running, registered, merged }
}

export function assertPlanIsSafe(plan: DeletionPlan): void {
  if (plan.missing.length > 0) {
    throw new UsageError(`No entry with id ${plan.missing.join(', ')}.`)
  }
  const [firstMerged] = plan.merged
  if (firstMerged) {
    const ids = plan.merged.map((entry) => `#${entry.id}`).join(', ')
    throw new ConflictError(
      `${ids} ${plan.merged.length === 1 ? 'is a block' : 'are blocks'} of a merged entry.`,
      'ENTRY_MERGED',
      `Delete #${firstMerged.mergedInto} to remove the whole entry.`,
    )
  }
  if (plan.running.length > 0) {
    const ids = plan.running.map((id) => `#${id}`).join(', ')
    throw new ConflictError(
      `${ids} ${plan.running.length === 1 ? 'is' : 'are'} still running.`,
      'ENTRY_RUNNING',
      `bita cancel ${plan.running[0]} discards a running timer; bita stop records it first.`,
    )
  }
  if (plan.registered.length > 0) {
    const ids = plan.registered.map((target) => `#${target.id} (${target.issueKey ?? 'linked'})`)
    throw new ConflictError(
      `${ids.join(', ')} already reached Jira.`,
      'ENTRY_REGISTERED',
      'The worklog stays in Jira and has to be removed by hand there. Pass --force to delete the local entry anyway.',
    )
  }
}

export async function applyDeletions(
  db: DatabaseSync,
  targets: DeletionTarget[],
  keepDoc: boolean,
): Promise<DeletionOutcome> {
  const deleted: DeletionTarget[] = []

  inTransaction(db, () => {
    for (const target of targets) {
      if (deleteEntry(db, target.id)) deleted.push(target)
    }
  })

  const docsRemoved: string[] = []
  const docsKept: string[] = []
  const docsOrphaned: string[] = []

  for (const target of deleted) {
    for (const path of target.docPaths) {
      if (keepDoc) {
        docsKept.push(path)
        continue
      }
      try {
        if (await removeDocument(path)) docsRemoved.push(path)
        else docsOrphaned.push(path)
      } catch {
        docsOrphaned.push(path)
      }
    }
  }

  return { deleted, docsRemoved, docsKept, docsOrphaned }
}

function describe(target: DeletionTarget): string {
  return target.description.length > 0 ? target.description : '(no title)'
}

function renderPlan(targets: DeletionTarget[]): string {
  return renderTable(
    [
      { header: 'ID', align: 'right' },
      { header: 'DAY' },
      { header: 'PROJECT' },
      { header: 'DESCRIPTION' },
      { header: 'ELAPSED', align: 'right' },
      { header: 'JIRA' },
      { header: 'DOCS', align: 'right' },
    ],
    targets.map((target) => [
      String(target.id),
      target.localDay,
      target.projectName ?? '(no project)',
      describe(target),
      target.durationHuman,
      target.issueKey ?? '',
      String(target.docPaths.length),
    ]),
  )
}

export async function runDelete(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const force = readBoolean(args, 'force')
  const keepDoc = readBoolean(args, 'keep-doc')
  const dryRun = readBoolean(args, 'dry-run')
  const ids = readIds(args)
  const ctx = createLocalContext(args)

  try {
    const plan = planDeletions(ctx, ids, force)

    if (dryRun) {
      if (json) {
        writeJson(
          successEnvelope('delete', plan.targets, {
            dryRun: true,
            wouldDelete: plan.targets.length,
            wouldRemoveDocs: keepDoc
              ? 0
              : plan.targets.reduce((sum, target) => sum + target.docPaths.length, 0),
            missing: plan.missing,
            running: plan.running,
            heldBack: plan.registered.map((target) => target.id),
          }),
        )
        return 0
      }

      if (plan.targets.length > 0) writeOut(renderPlan(plan.targets))
      if (plan.missing.length > 0) writeOut(`No entry with id ${plan.missing.join(', ')}.`)
      for (const id of plan.running) writeOut(`#${id} is running; bita cancel or bita stop it first.`)
      for (const target of plan.registered) {
        writeOut(`#${target.id} reached ${target.issueKey ?? 'Jira'}; only --force would delete it.`)
      }
      writeOut('')
      writeOut('Nothing was deleted: --dry-run.')
      return 0
    }

    assertPlanIsSafe(plan)

    if (!readBoolean(args, 'yes')) {
      if (json || !process.stdin.isTTY) {
        throw new ConflictError(
          'Deleting an entry cannot be undone, so it needs a confirmation.',
          'CONFIRMATION_REQUIRED',
          'Pass --yes to delete without being asked, or --dry-run to see what would go.',
        )
      }
      writeErr(renderPlan(plan.targets))
      const total = plan.targets.reduce((sum, target) => sum + target.durationSeconds, 0)
      writeErr('')
      writeErr(`This removes ${plan.targets.length} entries and ${total} seconds of tracked time.`)
      if (!keepDoc) {
        const docs = plan.targets.reduce((sum, target) => sum + target.docPaths.length, 0)
        if (docs > 0) writeErr(`${docs} documents go with them. Keep them with --keep-doc.`)
      }
      if (!(await promptConfirm('Delete them?'))) {
        writeOut('Nothing was deleted.')
        return 0
      }
    }

    const outcome = await applyDeletions(ctx.db, plan.targets, keepDoc)

    if (json) {
      writeJson(
        successEnvelope('delete', outcome.deleted, {
          deleted: outcome.deleted.length,
          docsRemoved: outcome.docsRemoved,
          docsKept: outcome.docsKept,
          docsOrphaned: outcome.docsOrphaned,
          forced: force,
        }),
      )
      return 0
    }

    for (const target of outcome.deleted) {
      writeOut(`Deleted #${target.id}: ${describe(target)} (${target.durationHuman} lost)`)
    }
    for (const path of outcome.docsRemoved) writeOut(`  Document removed: ${path}`)
    for (const path of outcome.docsKept) writeOut(`  Document kept: ${path}`)
    for (const path of outcome.docsOrphaned) {
      writeErr(`  Document left behind, remove it by hand: ${path}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export interface ProjectDeletionPlan {
  id: number
  name: string
  entryIds: number[]
  runningIds: number[]
  registeredIds: number[]
  scopeSlugs: string[]
  mapped: boolean
}

export function planProjectDeletion(
  ctx: PlanContext,
  id: number,
  config: AppConfig,
): ProjectDeletionPlan {
  const project = findProjectById(ctx.db, id)
  if (!project) throw new UsageError(`No project with id ${id}. Run "bita projects" to see them.`)

  const entries = listEntriesForProject(ctx.db, id)

  return {
    id: project.id,
    name: project.name,
    entryIds: entries.map((entry) => entry.id),
    runningIds: entries.filter((entry) => entry.stoppedAt === null).map((entry) => entry.id),
    registeredIds: entries.filter((entry) => entry.registered).map((entry) => entry.id),
    scopeSlugs: Object.entries(config.scopeMapping)
      .filter(([, mapping]) => mapping.projectId === id)
      .map(([slug]) => slug),
    mapped: String(id) in config.projectMapping,
  }
}

export function assertProjectPlanIsSafe(plan: ProjectDeletionPlan, force: boolean): void {
  if (plan.runningIds.length > 0) {
    const ids = plan.runningIds.map((id) => `#${id}`).join(', ')
    throw new ConflictError(
      `${ids} ${plan.runningIds.length === 1 ? 'is' : 'are'} still running against "${plan.name}".`,
      'ENTRY_RUNNING',
      `bita stop ${plan.runningIds[0]} records it, bita cancel ${plan.runningIds[0]} throws it away.`,
    )
  }
  if (plan.entryIds.length > 0 && !force) {
    throw new ConflictError(
      `"${plan.name}" still holds ${plan.entryIds.length} entries.`,
      'PROJECT_HAS_ENTRIES',
      'bita project archive keeps them and hides the project. --force deletes the project and leaves the entries without one.',
    )
  }
}

export async function applyProjectDeletion(
  db: DatabaseSync,
  plan: ProjectDeletionPlan,
  configPath = CONFIG_PATH,
): Promise<{ removed: boolean; scopeSlugs: string[]; mappingRemoved: boolean }> {
  const removed = deleteProject(db, plan.id)
  if (!removed) return { removed, scopeSlugs: [], mappingRemoved: false }

  const scopeSlugs: string[] = []
  for (const slug of plan.scopeSlugs) {
    if (await unsetScopeMapping(slug, configPath)) scopeSlugs.push(slug)
  }
  const mappingRemoved = await unsetProjectMapping(plan.id, configPath)

  return { removed, scopeSlugs, mappingRemoved }
}

function blockerFor(plan: ProjectDeletionPlan, force: boolean): string | null {
  try {
    assertProjectPlanIsSafe(plan, force)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function runProjectDelete(args: ParsedArgs, rest: string[]): Promise<number> {
  const json = readBoolean(args, 'json')
  const force = readBoolean(args, 'force')
  const raw = rest.join(' ').trim()
  if (!raw) throw new UsageError('Usage: bita project delete <id|name>')

  const ctx = createLocalContext(args)

  try {
    const asNumber = Number(raw)
    const byName = Number.isInteger(asNumber) && asNumber > 0 ? undefined : findProjectByName(ctx.db, raw)
    if (byName === undefined && !(Number.isInteger(asNumber) && asNumber > 0)) {
      throw new UsageError(`No project named "${raw}". Run "bita projects" to see them.`)
    }

    const config = await readConfig()
    const plan = planProjectDeletion(ctx, byName?.id ?? asNumber, config)

    if (readBoolean(args, 'dry-run')) {
      const blocked = blockerFor(plan, force)
      if (json) {
        writeJson(successEnvelope('project delete', plan, { dryRun: true, blocked }))
        return 0
      }
      writeOut(`Would delete project ${plan.id}: ${plan.name}`)
      writeOut(`  entries left without a project: ${plan.entryIds.length}`)
      writeOut(`  scope mappings dropped: ${plan.scopeSlugs.join(', ') || 'none'}`)
      writeOut(`  jira mapping dropped: ${plan.mapped ? 'yes' : 'no'}`)
      if (blocked) writeOut(`  it would refuse: ${blocked}`)
      return 0
    }

    assertProjectPlanIsSafe(plan, force)

    if (!readBoolean(args, 'yes')) {
      if (json || !process.stdin.isTTY) {
        throw new ConflictError(
          'Deleting a project cannot be undone, so it needs a confirmation.',
          'CONFIRMATION_REQUIRED',
          'Pass --yes to delete without being asked, or --dry-run to see what would go.',
        )
      }
      writeErr(`Project ${plan.id}: ${plan.name}`)
      writeErr(`  ${plan.entryIds.length} entries would be left without a project`)
      if (plan.scopeSlugs.length > 0) writeErr(`  scope mappings dropped: ${plan.scopeSlugs.join(', ')}`)
      if (plan.mapped) writeErr('  its Jira mapping and cached stories go too')
      if (!(await promptConfirm('Delete it?'))) {
        writeOut('Nothing was deleted.')
        return 0
      }
    }

    const outcome = await applyProjectDeletion(ctx.db, plan)

    if (json) {
      writeJson(successEnvelope('project delete', plan, outcome))
      return 0
    }

    writeOut(`Deleted project ${plan.id}: ${plan.name}`)
    if (plan.entryIds.length > 0) {
      writeOut(`  ${plan.entryIds.length} entries kept, now without a project`)
    }
    for (const slug of outcome.scopeSlugs) writeOut(`  Scope mapping dropped: ${slug}`)
    if (outcome.mappingRemoved) writeOut('  Jira mapping and cached stories dropped')
    return 0
  } finally {
    ctx.db.close()
  }
}
