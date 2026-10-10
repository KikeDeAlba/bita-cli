import { ConflictError, UsageError } from '../../errors.ts'
import {
  BASE_OPTIONS,
  parseCommandArgs,
  readBoolean,
  readString,
  readStringList,
  type ParsedArgs,
} from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { enrichEntry } from '../../domain/enrich.ts'
import { formatDuration } from '../../domain/duration.ts'
import { parseClockTime, parseDurationSeconds } from '../../domain/duration-input.ts'
import type { EnrichedTimeEntry } from '../../domain/types.ts'
import {
  countRunning,
  deleteEntry,
  findEntryById,
  insertEntry,
  listRunning,
  stopEntry,
} from '../../db/entries.ts'
import { findProjectByName, listProjects } from '../../db/projects.ts'
import type { EntryWithProjectRow } from '../../db/rows.ts'
import { recordTouch } from '../../db/touches.ts'
import { readConfig, setScopeMapping } from '../../state/config.ts'
import { currentRepoIdentity } from './repo.ts'
import { resolveMappedProject } from '../resolve-project.ts'
import { promptText } from '../prompt.ts'
import { parseKind } from '../../domain/kind.ts'
import { emitHooks } from '../../hooks/emit.ts'
import { entryWithMerged, suggestRepos, type RepoSuggestion } from '../repo-suggest.ts'
import { RepoRootResolver } from '../../state/repo-roots.ts'
import type { HookPayload } from '../../hooks/hooks.ts'

const TIMER_OPTIONS = {
  project: { type: 'string' as const },
  file: { type: 'string' as const, multiple: true },
  all: { type: 'boolean' as const, default: false },
  last: { type: 'boolean' as const, default: false },
  at: { type: 'string' as const },
  from: { type: 'string' as const },
  to: { type: 'string' as const },
  for: { type: 'string' as const },
  'require-running': { type: 'boolean' as const, default: false },
  kind: { type: 'string' as const },
}

function readKind(args: ParsedArgs): string | null {
  const raw = readString(args, 'kind')
  return raw === undefined ? null : parseKind(raw)
}

function readTitle(args: ParsedArgs): string {
  return args.positionals.join(' ').trim()
}

function requireTitle(args: ParsedArgs): string {
  const title = readTitle(args)
  if (!title) throw new UsageError('A title is required: bita log "what you did".')
  return title
}

function enrich(ctx: LocalContext, row: EntryWithProjectRow): EnrichedTimeEntry {
  return enrichEntry(row, ctx.timezone, ctx.now)
}

async function resolveProjectId(
  ctx: LocalContext,
  args: ParsedArgs,
  json: boolean,
): Promise<number | null> {
  const raw = readString(args, 'project')
  if (raw) {
    const asNumber = Number(raw)
    if (Number.isInteger(asNumber) && asNumber > 0) return asNumber
    const match = findProjectByName(ctx.db, raw)
    if (!match) {
      throw new UsageError(`No project named "${raw}". Run "bita projects" to see them.`)
    }
    return match.id
  }

  const identity = await currentRepoIdentity()
  if (identity) {
    const config = await readConfig()
    const mapped = resolveMappedProject(identity.slug, config)
    if (mapped) return mapped.projectId
  }

  const candidates = listProjects(ctx.db).slice(0, 10)

  if (!identity) return null

  if (json || !process.stdin.isTTY) {
    throw new ConflictError(
      `No project resolves for the repository "${identity.slug}".`,
      'REPO_NOT_MAPPED',
      `bita repo init`,
    )
  }

  writeErr(`The repository "${identity.slug}" has no project yet.`)
  for (const [index, candidate] of candidates.entries()) {
    writeErr(`  ${index + 1}. ${candidate.name} (${candidate.id})`)
  }
  const answer = await promptText('Pick a number, or type a project id: ')
  const picked = Number(answer)
  if (!Number.isInteger(picked) || picked <= 0) throw new UsageError('No project chosen.')
  const fromList = candidates[picked - 1]
  const projectId = picked <= candidates.length && fromList ? fromList.id : picked

  await setScopeMapping(identity.slug, {
    projectId: projectId,
    projectName: listProjects(ctx.db, true).find((p) => p.id === projectId)?.name ?? String(projectId),
    slugSource: identity.source,
    verifiedAt: new Date().toISOString(),
  })
  return projectId
}

function recordArtifacts(ctx: LocalContext, entryId: number, args: ParsedArgs): void {
  const now = ctx.now.toISOString()
  for (const file of readStringList(args, 'file')) recordTouch(ctx.db, entryId, file, now)
}

export async function runStart(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, TIMER_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const title = readTitle(args)
  const kind = readKind(args)
  const ctx = createLocalContext(args)

  try {
    const projectId = await resolveProjectId(ctx, args, json)
    const isDraft = title.length === 0
    const at = readString(args, 'at')
    const startedAt = at === undefined ? ctx.now.toISOString() : parseClockTime(at, ctx.now, '--at').toISOString()

    const alreadyRunning = listRunning(ctx.db)
    const created = insertEntry(ctx.db, {
      description: title,
      projectId,
      startedAt,
      source: 'timer',
      kind,
      now: ctx.now.toISOString(),
    })

    const row = listRunning(ctx.db).find((entry) => entry.id === created.id)
    const enriched = row ? enrich(ctx, row) : null
    const hooksFired = enriched ? await emitHooks(ctx, [{ event: 'start', entry: enriched, docPath: null }]) : 0

    if (json) {
      writeJson(
        successEnvelope('start', enriched, {
          alsoRunning: alreadyRunning.map((entry) => ({
            id: entry.id,
            description: entry.description,
          })),
          runningCount: countRunning(ctx.db),
          draft: isDraft,
          hooksFired,
        }),
      )
    } else {
      writeOut(isDraft ? `Started #${created.id}, still a draft` : `Started #${created.id}: ${title}`)
      if (enriched?.projectName) writeOut(`Project : ${enriched.projectName}`)
      if (kind) writeOut(`Kind    : ${kind}`)
      writeOut(`Since   : ${enriched?.startLocal.slice(11, 16) ?? ''}`)
      if (isDraft) {
        writeOut('')
        writeOut('It has no title yet.')
        writeOut(`Name it with: bita amend ${created.id} --title "..."`)
      }
      if (alreadyRunning.length > 0) {
        writeOut('')
        writeOut(`Also running (${alreadyRunning.length}):`)
        for (const entry of alreadyRunning) writeOut(`  #${entry.id} ${entry.description}`)
      }
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export async function runStop(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, TIMER_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    const running = listRunning(ctx.db)

    if (running.length === 0) {
      if (readBoolean(args, 'require-running')) {
        throw new ConflictError('Nothing is running.', 'NO_RUNNING_TIMER', 'bita start "title"')
      }
      if (json) writeJson(successEnvelope('stop', null, { stopped: 0 }))
      else writeOut('Nothing is running.')
      return 0
    }

    const targets = await chooseTargets(ctx, args, running, json)
    const at = readString(args, 'at')
    const stoppedAt = at === undefined ? ctx.now.toISOString() : parseClockTime(at, ctx.now, '--at').toISOString()
    const stopped: EnrichedTimeEntry[] = []
    const payloads: HookPayload[] = []
    let hooksFired = 0
    try {
      for (const target of targets) {
        const snapshot = enrich(ctx, { ...target, stoppedAt })
        stopEntry(ctx.db, target.id, stoppedAt, ctx.now.toISOString())
        const payload: HookPayload = { event: 'stop', entry: snapshot, docPath: null }
        payloads.push(payload)
        if (targets.length === 1) recordArtifacts(ctx, target.id, args)
        stopped.push(snapshot)
      }
    } finally {
      hooksFired = await emitHooks(ctx, payloads)
    }

    if (json) {
      writeJson(
        successEnvelope('stop', stopped, {
          stopped: stopped.length,
          stillRunning: countRunning(ctx.db),
          hooksFired,
          repoSuggestions: await unmappedRepoSuggestions(ctx, stopped),
        }),
      )
    } else {
      for (const entry of stopped) {
        writeOut(`Stopped #${entry.id}: ${entry.description} (${entry.durationHuman})`)
      }
      const left = countRunning(ctx.db)
      if (left > 0) writeOut(`${left} still running.`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

async function unmappedRepoSuggestions(
  ctx: LocalContext,
  stopped: readonly EnrichedTimeEntry[],
): Promise<RepoSuggestion[] | Record<string, RepoSuggestion[]>> {
  const resolver = new RepoRootResolver()
  const byEntry: Record<string, RepoSuggestion[]> = {}
  for (const entry of stopped) {
    const suggestions = await suggestRepos(ctx.db, entryWithMerged(ctx.db, entry.id), entry.projectId, {
      docsRoot: ctx.docsRoot,
      cwd: process.cwd(),
      resolver,
    })
    byEntry[String(entry.id)] = suggestions.filter((suggestion) => !suggestion.mapped)
  }
  const [only] = stopped
  if (stopped.length === 1 && only) return byEntry[String(only.id)] ?? []
  return Object.fromEntries(Object.entries(byEntry).filter(([, suggestions]) => suggestions.length > 0))
}

async function chooseTargets(
  ctx: LocalContext,
  args: ParsedArgs,
  running: EntryWithProjectRow[],
  json: boolean,
): Promise<EntryWithProjectRow[]> {
  if (readBoolean(args, 'all')) return running

  const [positional] = args.positionals
  if (positional !== undefined) {
    const id = Number(positional)
    if (!Number.isInteger(id)) throw new UsageError(`"${positional}" is not an entry id.`)
    const match = running.find((entry) => entry.id === id)
    if (!match) throw new UsageError(`Entry #${id} is not running.`)
    return [match]
  }

  if (readBoolean(args, 'last')) {
    const last = running.at(-1)
    return last ? [last] : []
  }

  const only = running[0]
  if (running.length === 1 && only) return [only]

  if (json || !process.stdin.isTTY) {
    throw new ConflictError(
      `${running.length} timers are running; say which one.`,
      'AMBIGUOUS_TIMER',
      'bita stop <id>, bita stop --last or bita stop --all',
    )
  }

  writeErr(`${running.length} timers are running:`)
  for (const entry of running) {
    writeErr(`  #${entry.id} ${entry.description} (${enrich(ctx, entry).durationHuman})`)
  }
  const answer = await promptText('Which id? (or "all"): ')
  if (answer.trim().toLowerCase() === 'all') return running
  const id = Number(answer)
  const match = running.find((entry) => entry.id === id)
  if (!match) throw new UsageError(`Entry #${answer} is not running.`)
  return [match]
}

export function runCurrent(argv: string[]): number {
  const args = parseCommandArgs(argv, TIMER_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    const running = listRunning(ctx.db).map((row) => enrich(ctx, row))
    const totalSeconds = running.reduce((sum, entry) => sum + entry.durationSeconds, 0)

    if (json) {
      writeJson(
        successEnvelope('current', running, {
          runningCount: running.length,
          totalSeconds,
          totalHuman: formatDuration(totalSeconds),
        }),
      )
      return 0
    }

    if (running.length === 0) {
      writeOut('Nothing is running.')
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'ID', align: 'right' },
          { header: 'SINCE' },
          { header: 'PROJECT' },
          { header: 'DESCRIPTION' },
          { header: 'ELAPSED', align: 'right' },
        ],
        running.map((entry) => [
          String(entry.id),
          entry.startLocal.slice(11, 16),
          entry.projectName ?? '(no project)',
          entry.description || '(no title)',
          entry.durationHuman,
        ]),
      ),
    )
    if (running.length > 1) {
      writeOut('')
      writeOut(`${running.length} timers, ${formatDuration(totalSeconds)} of overlapping time.`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export async function runCancel(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, TIMER_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    const running = listRunning(ctx.db)
    if (running.length === 0) {
      if (json) writeJson(successEnvelope('cancel', null, { discarded: 0 }))
      else writeOut('Nothing is running.')
      return 0
    }

    const targets = await chooseTargets(ctx, args, running, json)
    const discarded = targets.map((target) => {
      const snapshot = enrich(ctx, target)
      deleteEntry(ctx.db, target.id)
      return snapshot
    })

    const hooksFired = await emitHooks(
      ctx,
      discarded.map((entry) => ({ event: 'cancel' as const, entry, docPath: null })),
    )

    if (json) {
      writeJson(successEnvelope('cancel', discarded, { discarded: discarded.length, hooksFired }))
    } else {
      for (const entry of discarded) {
        writeOut(`Discarded #${entry.id}: ${entry.description} (${entry.durationHuman} lost)`)
      }
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export async function runLog(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, TIMER_OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const title = readTitle(args)
  const ctx = createLocalContext(args)

  try {
    const projectId = await resolveProjectId(ctx, args, json)
    const isDraft = title.length === 0
    const rawFrom = readString(args, 'from')
    const rawTo = readString(args, 'to')
    const rawFor = readString(args, 'for')

    if (rawFrom === undefined) {
      throw new UsageError('bita log needs --from, plus either --to or --for.')
    }
    if (rawTo === undefined && rawFor === undefined) {
      throw new UsageError('bita log needs either --to or --for to know how long it lasted.')
    }

    const startedAt = parseClockTime(rawFrom, ctx.now, '--from').toISOString()
    const stoppedAt =
      rawTo !== undefined
        ? parseClockTime(rawTo, ctx.now, '--to').toISOString()
        : new Date(Date.parse(startedAt) + parseDurationSeconds(rawFor ?? '', '--for') * 1000).toISOString()

    if (Date.parse(stoppedAt) <= Date.parse(startedAt)) {
      throw new UsageError('The block ends before it starts.')
    }

    const created = insertEntry(ctx.db, {
      description: title,
      projectId,
      startedAt,
      stoppedAt,
      source: 'manual',
      kind: readKind(args),
      now: ctx.now.toISOString(),
    })

    recordArtifacts(ctx, created.id, args)

    const row = findEntryById(ctx.db, created.id)
    const seconds = row ? Math.round((Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000) : 0

    if (json) {
      writeJson(successEnvelope('log', { ...created, durationSeconds: seconds }))
    } else {
      writeOut(`Logged #${created.id}: ${title} (${formatDuration(seconds)})`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

