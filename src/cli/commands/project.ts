import { UnknownCommandError, UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString } from '../args.ts'
import { withLocalContext } from '../local-context.ts'
import { runProjectDelete } from './delete.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { findProjectById, findProjectByName, insertProject, renameProject, setProjectActive } from '../../db/projects.ts'
import type { ProjectRow } from '../../db/rows.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { PROJECT_REPO_OPTIONS, runProjectRepo } from './project-repo.ts'

const OPTIONS = {
  client: { type: 'string' as const },
  activate: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
  yes: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
  ...PROJECT_REPO_OPTIONS,
}

const MOVED: Record<string, string> = {
  jira: 'Whether a project goes to Jira is kept by tally now: use "tally map …".',
  atlassian: 'Atlassian sites and Confluence spaces are kept by atl and inkwell now: use "atl site …" or "inkwell …".',
  key: 'Backlog keys are kept by inkwell now: use "inkwell backlog …".',
}

export function projectView(project: ProjectRow) {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    clientName: project.clientName,
    active: project.active,
  }
}

function requireProjectId(raw: string | undefined): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new UsageError(`"${raw ?? ''}" is not a project id. Run "bita projects" to see them.`)
  }
  return id
}

export async function runProject(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS)
  const [subcommand, ...rest] = args.positionals
  const json = readBoolean(args, 'json')

  if (subcommand === 'delete' || subcommand === 'rm') {
    return runProjectDelete(args, rest)
  }

  if (subcommand === 'repo') {
    return runProjectRepo(args, rest)
  }

  if (subcommand === 'add') {
    const name = rest.join(' ').trim()
    if (!name) throw new UsageError('Usage: bita project add "<name>" [--client "<name>"]')

    return withLocalContext(args, (ctx) => {
      const existing = findProjectByName(ctx.db, name)
      if (existing) {
        throw new UsageError(`A project named "${existing.name}" already exists (id ${existing.id}).`)
      }

      const created = insertProject(ctx.db, {
        name,
        clientName: readString(args, 'client') ?? null,
        createdAt: new Date().toISOString(),
      })

      if (json) {
        writeJson(successEnvelope('project add', projectView(created)))
      } else {
        writeOut(`Created project ${created.id}: ${created.name}`)
        writeOut('')
        writeOut('To track time for a repository against it, from inside that repository:')
        writeOut(`  bita scope set . ${created.id}`)
      }
      return 0
    })
  }

  if (subcommand === 'rename') {
    const id = requireProjectId(rest[0])
    const name = rest.slice(1).join(' ').trim()
    if (!name) throw new UsageError('Usage: bita project rename <id> "<new name>"')

    return withLocalContext(args, (ctx) => {
      const project = findProjectById(ctx.db, id)
      if (!project) throw new UsageError(`No project with id ${id}.`)

      const clash = findProjectByName(ctx.db, name)
      if (clash && clash.id !== id) {
        throw new UsageError(`A project named "${clash.name}" already exists (id ${clash.id}).`)
      }

      renameProject(ctx.db, id, name)
      if (json) writeJson(successEnvelope('project rename', { id, from: project.name, to: name }))
      else writeOut(`Renamed ${id}: ${project.name} -> ${name}`)
      return 0
    })
  }

  if (subcommand === 'show') {
    const target = rest[0]
    if (target === undefined || rest.length > 1) throw new UsageError('Usage: bita project show <id|name|key>')
    return withLocalContext(args, (ctx) => {
      const data = projectView(resolveProjectArg(ctx.db, target))
      if (json) writeJson(successEnvelope('project show', data))
      else writeOut(`${data.id}  ${data.name}${data.clientName ? ` (${data.clientName})` : ''}${data.active ? '' : ', archived'}`)
      return 0
    })
  }

  if (subcommand !== undefined && Object.hasOwn(MOVED, subcommand)) {
    throw new UnknownCommandError(`"bita project ${subcommand}" is no longer part of bita.`, MOVED[subcommand])
  }

  if (subcommand === 'archive') {
    const id = requireProjectId(rest[0])
    const activate = readBoolean(args, 'activate')

    return withLocalContext(args, (ctx) => {
      const project = findProjectById(ctx.db, id)
      if (!project) throw new UsageError(`No project with id ${id}.`)

      setProjectActive(ctx.db, id, activate)
      if (json) writeJson(successEnvelope('project archive', { id, active: activate }))
      else writeOut(`${activate ? 'Reactivated' : 'Archived'} ${id}: ${project.name}`)
      return 0
    })
  }

  throw new UsageError(
    'Usage: bita project add|show|rename|repo|archive|delete. To list them, run "bita projects".',
  )
}
