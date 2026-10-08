import { existsSync } from 'node:fs'
import { NotFoundError, UsageError } from '../../errors.ts'
import { readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { resolveMappedProject } from '../resolve-project.ts'
import { entryWithMerged, suggestRepos } from '../repo-suggest.ts'
import { readConfig } from '../../state/config.ts'
import { canonicalPath, RepoRootResolver } from '../../state/repo-roots.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { findProjectById } from '../../db/projects.ts'
import type { ProjectRow } from '../../db/rows.ts'
import {
  deleteProjectRepos,
  entryIdsOfProject,
  listProjectRepos,
  PROJECT_REPO_SOURCES,
  upsertProjectRepo,
  type ProjectRepoRow,
  type ProjectRepoSource,
} from '../../db/project-repos.ts'

export const PROJECT_REPO_OPTIONS = {
  project: { type: 'string' as const },
  source: { type: 'string' as const },
  history: { type: 'boolean' as const, default: false },
}

const USAGE =
  'Usage: bita project repo ls [--project P] | add <path> [--project P] [--source stop|manual] | rm <path> [--project P] | suggest <entryId> | suggest --project P --history'

export interface RepoView {
  project: string
  path: string
  slug: string | null
  source: ProjectRepoSource
  addedAt: string
  lastSeenAt: string
  exists: boolean
}

export function repoView(row: ProjectRepoRow): RepoView {
  return {
    project: row.projectName,
    path: row.path,
    slug: row.slug,
    source: row.source,
    addedAt: row.addedAt,
    lastSeenAt: row.lastSeenAt,
    exists: existsSync(row.path),
  }
}

function readSource(args: ParsedArgs): ProjectRepoSource {
  const raw = readString(args, 'source') ?? 'manual'
  const source = PROJECT_REPO_SOURCES.find((candidate) => candidate === raw)
  if (!source) throw new UsageError(`--source takes stop or manual, not "${raw}".`)
  return source
}

export async function runProjectRepo(args: ParsedArgs, rest: string[]): Promise<number> {
  const [action, ...positionals] = rest
  const json = readBoolean(args, 'json')

  if (action === 'ls' || action === 'list') {
    if (positionals.length > 0) throw new UsageError(USAGE)
    return runLs(args, json)
  }
  if (action === 'add') {
    if (positionals.length > 1) throw new UsageError(USAGE)
    return runAdd(args, positionals[0] ?? '.', json)
  }
  if (action === 'rm' || action === 'remove') {
    const [target] = positionals
    if (target === undefined || positionals.length > 1) throw new UsageError(USAGE)
    return runRm(args, target, json)
  }
  if (action === 'suggest') {
    if (positionals.length > 1) throw new UsageError(USAGE)
    return runSuggest(args, positionals[0], json)
  }
  throw new UsageError(USAGE)
}

function runLs(args: ParsedArgs, json: boolean): number {
  const ctx = createLocalContext(args)
  try {
    const raw = readString(args, 'project')
    const project = raw === undefined ? undefined : resolveProjectArg(ctx.db, raw)
    const repos = listProjectRepos(ctx.db, project?.id).map(repoView)

    if (json) {
      writeJson(successEnvelope('project repo ls', { repos }))
      return 0
    }
    if (repos.length === 0) {
      writeOut(project ? `${project.name} has no repositories yet.` : 'No project has repositories yet.')
      writeOut('Add one with: bita project repo add <path> --project <p>')
      return 0
    }
    writeOut(
      renderTable(
        [{ header: 'Project' }, { header: 'Path' }, { header: 'Slug' }, { header: 'Source' }, { header: 'On disk' }],
        repos.map((repo) => [repo.project, repo.path, repo.slug ?? '-', repo.source, repo.exists ? 'yes' : 'missing']),
        80,
      ),
    )
    return 0
  } finally {
    ctx.db.close()
  }
}

async function runAdd(args: ParsedArgs, target: string, json: boolean): Promise<number> {
  const source = readSource(args)
  const absolute = canonicalPath(target)
  if (!existsSync(absolute)) throw new UsageError(`No such directory: ${absolute}`)

  const resolver = new RepoRootResolver()
  const root = await resolver.resolve(absolute)
  if (root === null) throw new UsageError(`${absolute} is not inside a git repository.`)

  const raw = readString(args, 'project')
  const config = raw === undefined ? await readConfig() : null
  const ctx = createLocalContext(args)
  try {
    let project: ProjectRow | undefined
    if (raw !== undefined) project = resolveProjectArg(ctx.db, raw)
    else {
      const mapped = config ? resolveMappedProject(root.slug, config) : null
      if (mapped) project = findProjectById(ctx.db, mapped.projectId)
      if (!project) {
        const owners = [...new Set(listProjectRepos(ctx.db).filter((repo) => repo.path === root.path).map((repo) => repo.projectId))]
        const [only] = owners
        if (owners.length === 1 && only !== undefined) project = findProjectById(ctx.db, only)
      }
    }
    if (!project) {
      throw new UsageError(`${root.slug} does not resolve to a project. Pass --project <id|name|key>.`)
    }

    const { row, created } = upsertProjectRepo(ctx.db, {
      projectId: project.id,
      path: root.path,
      slug: root.slug,
      source,
      now: ctx.now.toISOString(),
    })
    const repo = repoView(row)

    if (json) writeJson(successEnvelope('project repo add', { repo, created }))
    else writeOut(created ? `Added ${repo.path} to ${repo.project}.` : `${repo.path} was already in ${repo.project}; seen again.`)
    return 0
  } finally {
    ctx.db.close()
  }
}

async function runRm(args: ParsedArgs, target: string, json: boolean): Promise<number> {
  const absolute = canonicalPath(target)
  const candidates = [absolute]
  if (existsSync(absolute)) {
    const root = await new RepoRootResolver().rootOf(absolute)
    if (root !== null) candidates.push(root)
  }

  const ctx = createLocalContext(args)
  try {
    const raw = readString(args, 'project')
    const project = raw === undefined ? undefined : resolveProjectArg(ctx.db, raw)
    const removed = deleteProjectRepos(ctx.db, candidates, project?.id) > 0

    if (json) writeJson(successEnvelope('project repo rm', { removed }))
    else writeOut(removed ? `Removed ${absolute}${project ? ` from ${project.name}` : ''}.` : `${absolute} was not mapped.`)
    return 0
  } finally {
    ctx.db.close()
  }
}

async function runSuggest(args: ParsedArgs, rawEntry: string | undefined, json: boolean): Promise<number> {
  const rawProject = readString(args, 'project')
  const history = readBoolean(args, 'history')
  const ctx = createLocalContext(args)
  try {
    let projectId: number | null
    let projectName: string | null
    let entryIds: number[]
    let cwd: string | undefined

    if (rawEntry !== undefined) {
      if (history) throw new UsageError('--history goes with --project, not with an entry id.')
      const id = Number(rawEntry)
      if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${rawEntry}" is not an entry id.`)
      const entry = findEntryWithProject(ctx.db, id)
      if (!entry) throw new NotFoundError(`No entry #${id}.`, 'ENTRY_NOT_FOUND', 'Run "bita current" or "bita entries".')
      projectId = entry.projectId
      projectName = entry.projectName
      entryIds = entryWithMerged(ctx.db, id)
      cwd = process.cwd()
    } else {
      if (rawProject === undefined || !history) throw new UsageError(USAGE)
      const project = resolveProjectArg(ctx.db, rawProject)
      projectId = project.id
      projectName = project.name
      entryIds = entryIdsOfProject(ctx.db, project.id)
    }

    const suggestions = await suggestRepos(ctx.db, entryIds, projectId, {
      docsRoot: ctx.docsRoot,
      ...(cwd !== undefined ? { cwd } : {}),
    })

    if (json) {
      writeJson(successEnvelope('project repo suggest', { project: projectName, suggestions }))
      return 0
    }
    if (suggestions.length === 0) {
      writeOut('No repositories among the touched files.')
      return 0
    }
    writeOut(
      renderTable(
        [{ header: 'Path' }, { header: 'Slug' }, { header: 'Files', align: 'right' }, { header: 'Mapped' }],
        suggestions.map((item) => [item.path, item.slug, String(item.files), item.mapped ? 'yes' : 'no']),
        80,
      ),
    )
    if (projectName && suggestions.some((item) => !item.mapped)) {
      writeOut('')
      writeOut(`Map the ones that belong to ${projectName} with: bita project repo add <path> --project "${projectName}"`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}
