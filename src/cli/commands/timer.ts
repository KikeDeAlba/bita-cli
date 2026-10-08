import { readFile } from 'node:fs/promises'
import { LEGACY_ENTRY_DOC_SECTIONS } from '../../config/constants.ts'
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
import type { NoteSource } from '../../state/notes.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { recordEntryDoc } from '../../docs/record.ts'
import { recordTouch } from '../../db/touches.ts'
import { insertPage, requirePage, uniqueSiblingSlug } from '../../db/pages.ts'
import { linkEntryToPage, pagesOfEntry } from '../../db/page-links.ts'
import { pageRelPath } from '../../docs/layout.ts'
import { titleSlug } from '../../docs/slug.ts'
import { DID_MAX } from '../../config/constants.ts'
import { checkpointStatus, findDocForEntry, listDocsForEntry, type CheckpointStatus } from '../../db/docs.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { removeDocument } from '../../docs/store.ts'
import { commitDocs } from '../../docs/git.ts'
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
  'note-json': { type: 'string' as const },
  'note-file': { type: 'string' as const },
  'note-md': { type: 'string' as const },
  section: { type: 'string' as const },
  file: { type: 'string' as const, multiple: true },
  command: { type: 'string' as const, multiple: true },
  resource: { type: 'string' as const, multiple: true },
  all: { type: 'boolean' as const, default: false },
  last: { type: 'boolean' as const, default: false },
  at: { type: 'string' as const },
  from: { type: 'string' as const },
  to: { type: 'string' as const },
  for: { type: 'string' as const },
  'require-running': { type: 'boolean' as const, default: false },
  did: { type: 'string' as const },
  page: { type: 'string' as const },
  'page-new': { type: 'string' as const },
  kind: { type: 'string' as const },
}

function readKind(args: ParsedArgs): string | null {
  const raw = readString(args, 'kind')
  return raw === undefined ? null : parseKind(raw)
}

function assertDidHasPage(ctx: LocalContext, entryIds: readonly number[], args: ParsedArgs): void {
  if (readString(args, 'did') === undefined) return
  for (const entryId of entryIds) {
    if (pagesOfEntry(ctx.db, entryId).length === 0) {
      throw new ConflictError(
        `Entry #${entryId} does not belong to a page yet.`,
        'ENTRY_WITHOUT_PAGE',
        'bita docs page link <pageId> --entry ' + String(entryId),
      )
    }
  }
}

function recordDid(ctx: LocalContext, entryId: number, args: ParsedArgs): void {
  const did = readString(args, 'did')
  if (did === undefined) return

  assertDidHasPage(ctx, [entryId], args)
  const links = pagesOfEntry(ctx.db, entryId)
  const summary = did.trim().slice(0, DID_MAX)
  for (const link of links) linkEntryToPage(ctx.db, link.pageId, entryId, summary, ctx.now.toISOString())
}

async function attachToPage(ctx: LocalContext, entryId: number, args: ParsedArgs): Promise<number | null> {
  const fresh = readString(args, 'page-new')
  if (fresh !== undefined) {
    const entry = findEntryWithProject(ctx.db, entryId)
    const projectId = entry?.projectId ?? null
    const slug = uniqueSiblingSlug(ctx.db, projectId, null, titleSlug(fresh))
    const projectName = entry?.projectName ?? null
    const id = insertPage(ctx.db, {
      projectId,
      parentId: null,
      slug,
      title: fresh.trim(),
      relPath: pageRelPath({ projectName, ancestorSlugs: [], slug }),
      depth: 0,
      source: 'cli',
      now: ctx.now.toISOString(),
    })
    linkEntryToPage(ctx.db, id, entryId, '', ctx.now.toISOString())
    return id
  }

  const raw = readString(args, 'page')
  if (raw === undefined) return null

  const pageId = Number(raw)
  if (!Number.isInteger(pageId) || pageId <= 0) throw new UsageError(`"${raw}" is not a page id.`)
  requirePage(ctx.db, pageId)
  linkEntryToPage(ctx.db, pageId, entryId, '', ctx.now.toISOString())
  return pageId
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

interface DocSeed {
  heading: string
  body: string
}

async function loadDocSeed(args: ParsedArgs): Promise<DocSeed | null> {
  const markdownPath = readString(args, 'note-md')
  const jsonPath = readString(args, 'note-json')
  const filePath = readString(args, 'note-file')

  if (markdownPath) {
    return { heading: readString(args, 'section') ?? 'Qué se hizo', body: await readSeedFile(markdownPath) }
  }

  if (filePath) return { heading: 'Qué se hizo', body: await readSeedFile(filePath) }

  if (jsonPath) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(jsonPath, 'utf8')) as unknown
    } catch (error) {
      throw new UsageError(`Could not read the note at ${jsonPath}: ${String(error)}`)
    }
    const body = (raw as { body?: unknown })?.body
    if (typeof body !== 'string') throw new UsageError('The note needs a "body" string.')
    return { heading: 'Resumen', body }
  }

  return null
}

async function readSeedFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new UsageError(`Could not read ${path}: ${String(error)}`)
  }
}

async function repoIdentity() {
  const found = await currentRepoIdentity()
  if (!found) return null
  return {
    slug: found.slug,
    ...(found.branch !== undefined ? { branch: found.branch } : {}),
    ...(found.headSha !== undefined ? { headSha: found.headSha } : {}),
  }
}

async function recordDoc(
  ctx: LocalContext,
  entryId: number,
  seed: DocSeed | null,
  source: NoteSource,
  create: boolean,
): Promise<string | null> {
  const entry = findEntryWithProject(ctx.db, entryId)
  if (!entry) return null

  const recorded = await recordEntryDoc(ctx, entry, {
    source,
    identity: await repoIdentity(),
    create,
    ...(seed ? { section: seed } : {}),
  })
  return recorded?.path ?? null
}

function checkpointNote(state: CheckpointStatus | undefined): string {
  if (!state) return 'none'
  if (!state.lastNoteAt) return 'not written yet'
  return state.touchedSinceNote === 0 ? 'up to date' : `${state.touchedSinceNote} files since`
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

    const pageId = await attachToPage(ctx, created.id, args)
    const row = listRunning(ctx.db).find((entry) => entry.id === created.id)
    const enriched = row ? enrich(ctx, row) : null
    const docPath = isDraft ? null : await recordDoc(ctx, created.id, null, 'start', true)
    const hooksFired = enriched ? await emitHooks(ctx, [{ event: 'start', entry: enriched, docPath }]) : 0

    if (json) {
      writeJson(
        successEnvelope('start', enriched, {
          alsoRunning: alreadyRunning.map((entry) => ({
            id: entry.id,
            description: entry.description,
          })),
          runningCount: countRunning(ctx.db),
          draft: isDraft,
          docPath,
          pageId,
          hooksFired,
        }),
      )
    } else {
      writeOut(isDraft ? `Started #${created.id}, still a draft` : `Started #${created.id}: ${title}`)
      if (enriched?.projectName) writeOut(`Project : ${enriched.projectName}`)
      if (kind) writeOut(`Kind    : ${kind}`)
      writeOut(`Since   : ${enriched?.startLocal.slice(11, 16) ?? ''}`)
      if (docPath) writeOut(`Document: ${docPath}`)
      if (isDraft) {
        writeOut('')
        writeOut('It has no title yet, so it stays out of any Jira summary.')
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
    const seed = await loadDocSeed(args)
    assertDidHasPage(
      ctx,
      targets.map((target) => target.id),
      args,
    )

    const stopped: EnrichedTimeEntry[] = []
    const payloads: HookPayload[] = []
    let docPath: string | null = null
    let hooksFired = 0
    try {
      for (const target of targets) {
        const snapshot = enrich(ctx, { ...target, stoppedAt })
        stopEntry(ctx.db, target.id, stoppedAt, ctx.now.toISOString())
        const payload: HookPayload = { event: 'stop', entry: snapshot, docPath: null }
        payloads.push(payload)
        if (targets.length === 1) {
          recordArtifacts(ctx, target.id, args)
          docPath = await recordDoc(ctx, target.id, seed, 'stop', seed !== null)
        }
        recordDid(ctx, target.id, args)
        stopped.push(snapshot)
        const stored = findDocForEntry(ctx.db, target.id)
        payload.docPath = stored ? resolveDocPath(ctx.docsRoot, stored.relPath) : null
      }
    } finally {
      hooksFired = await emitHooks(ctx, payloads)
    }

    if (json) {
      writeJson(
        successEnvelope('stop', stopped, {
          stopped: stopped.length,
          stillRunning: countRunning(ctx.db),
          docPath,
          hooksFired,
          repoSuggestions: await unmappedRepoSuggestions(ctx, stopped),
        }),
      )
    } else {
      for (const entry of stopped) {
        writeOut(`Stopped #${entry.id}: ${entry.description} (${entry.durationHuman})`)
      }
      if (docPath) writeOut(`Document: ${docPath}`)
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
    const rows = listRunning(ctx.db)
    const running = rows.map((row) => enrich(ctx, row))
    const totalSeconds = running.reduce((sum, entry) => sum + entry.durationSeconds, 0)
    const status = checkpointStatus(
      ctx.db,
      rows.map((row) => row.id),
    )

    if (json) {
      writeJson(
        successEnvelope(
          'current',
          running.map((entry) => {
            const state = status.get(entry.id)
            const stored = findDocForEntry(ctx.db, entry.id)
            return {
              ...entry,
              docPath: stored ? resolveDocPath(ctx.docsRoot, stored.relPath) : null,
              docRelPath: stored?.relPath ?? null,
              sectionsWritten: stored?.sectionCount ?? 0,
              sectionsTotal: LEGACY_ENTRY_DOC_SECTIONS.length,
              lastNoteAt: state?.lastNoteAt ?? null,
              touchedSinceNote: state?.touchedSinceNote ?? 0,
            }
          }),
          {
            runningCount: running.length,
            totalSeconds,
            totalHuman: formatDuration(totalSeconds),
            docsRoot: ctx.docsRoot,
          },
        ),
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
          { header: 'DOCUMENT' },
        ],
        running.map((entry) => [
          String(entry.id),
          entry.startLocal.slice(11, 16),
          entry.projectName ?? '(no project)',
          entry.description,
          entry.durationHuman,
          checkpointNote(status.get(entry.id)),
        ]),
      ),
    )
    for (const entry of running) {
      const stored = findDocForEntry(ctx.db, entry.id)
      if (stored) writeOut(`  #${entry.id} ${resolveDocPath(ctx.docsRoot, stored.relPath)}`)
    }
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
    const docPaths: string[] = []
    const discarded = targets.map((target) => {
      const snapshot = enrich(ctx, target)
      for (const doc of listDocsForEntry(ctx.db, target.id)) {
        docPaths.push(resolveDocPath(ctx.docsRoot, doc.relPath))
      }
      deleteEntry(ctx.db, target.id)
      return snapshot
    })

    const docsRemoved: string[] = []
    for (const path of docPaths) {
      if (await removeDocument(path)) docsRemoved.push(path)
    }
    if (docsRemoved.length > 0) {
      await commitDocs(ctx.docsRoot, docsRemoved, {
        source: 'note',
        subject: `docs: remove the documents of ${discarded.length === 1 ? 'a cancelled timer' : `${discarded.length} cancelled timers`}`,
        entryId: discarded.length === 1 ? (discarded[0]?.id ?? null) : null,
        reason: 'timer cancelled',
      })
    }
    const hooksFired = await emitHooks(
      ctx,
      discarded.map((entry) => ({ event: 'cancel' as const, entry, docPath: null })),
    )

    if (json) {
      writeJson(successEnvelope('cancel', discarded, { discarded: discarded.length, docsRemoved, hooksFired }))
    } else {
      for (const entry of discarded) {
        writeOut(`Discarded #${entry.id}: ${entry.description} (${entry.durationHuman} lost)`)
      }
      for (const path of docsRemoved) writeOut(`  Document removed: ${path}`)
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

    const seed = await loadDocSeed(args)
    recordArtifacts(ctx, created.id, args)
    const docPath = await recordDoc(ctx, created.id, seed, 'log', seed !== null)
    const pageId = await attachToPage(ctx, created.id, args)
    recordDid(ctx, created.id, args)

    const row = findEntryById(ctx.db, created.id)
    const seconds = row ? Math.round((Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000) : 0

    if (json) {
      writeJson(successEnvelope('log', { ...created, durationSeconds: seconds }, { docPath, pageId }))
    } else {
      writeOut(`Logged #${created.id}: ${title} (${formatDuration(seconds)})`)
      if (docPath) writeOut(`Document: ${docPath}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

