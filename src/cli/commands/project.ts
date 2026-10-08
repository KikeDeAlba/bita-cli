import { NotFoundError, UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, withLocalContext } from '../local-context.ts'
import { runProjectDelete } from './delete.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import {
  findProjectById,
  findProjectByKey,
  findProjectByName,
  insertProject,
  renameProject,
  setProjectActive,
  setProjectAtlassian,
  setProjectJira,
  setProjectKey,
  type ProjectAtlassianUpdate,
} from '../../db/projects.ts'
import type { ProjectRow } from '../../db/rows.ts'
import { parseConfluenceRef, projectAtlassianView } from '../../atlassian/project-view.ts'
import { findSite, loadAtlassianConfig, sitesOf } from '../../atlassian/sites.ts'
import type { AppConfig } from '../../state/config.ts'
import { PROJECT_KEY_PATTERN, UNASSIGNED_KEY } from '../../db/project-keys.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { PROJECT_REPO_OPTIONS, runProjectRepo } from './project-repo.ts'

const OPTIONS = {
  client: { type: 'string' as const },
  activate: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
  yes: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
  'no-jira': { type: 'boolean' as const, default: false },
  site: { type: 'string' as const },
  via: { type: 'string' as const },
  confluence: { type: 'string' as const },
  pull: { type: 'string' as const },
  push: { type: 'string' as const },
  ...PROJECT_REPO_OPTIONS,
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
        jira: !readBoolean(args, 'no-jira'),
        createdAt: new Date().toISOString(),
      })

      if (json) {
        writeJson(successEnvelope('project add', created))
      } else {
        writeOut(`Created project ${created.id}: ${created.name} (key ${created.key ?? '-'})${created.jira ? '' : ', never sent to Jira'}`)
        writeOut('')
        writeOut('To track time for a repository against it, from inside that repository:')
        writeOut(`  bita repo set . ${created.id}`)
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

  if (subcommand === 'key') {
    const usage = 'Usage: bita project key <id|name|key> <KEY>  (2 to 6 letters or digits, starting with a letter)'
    const target = rest[0]
    const key = rest[1]?.trim().toUpperCase()
    if (target === undefined || key === undefined || rest.length > 2) throw new UsageError(usage)
    if (!PROJECT_KEY_PATTERN.test(key) || key === UNASSIGNED_KEY) {
      throw new UsageError(`"${rest[1]}" is not a valid key. ${usage.replace('Usage: ', 'Use: ')}`)
    }

    return withLocalContext(args, (ctx) => {
      const project = resolveProjectArg(ctx.db, target)
      const clash = findProjectByKey(ctx.db, key)
      if (clash && clash.id !== project.id) {
        throw new UsageError(`The key ${key} already belongs to "${clash.name}" (id ${clash.id}).`)
      }

      setProjectKey(ctx.db, project.id, key)
      if (json) writeJson(successEnvelope('project key', { id: project.id, from: project.key, to: key }))
      else {
        writeOut(`Key of ${project.name}: ${project.key ?? '-'} -> ${key}`)
        writeOut(`Its backlog items are now ${key}-1, ${key}-2, ...`)
      }
      return 0
    })
  }

  if (subcommand === 'jira') {
    const usage = 'Usage: bita project jira <id|name|key> on|off'
    const target = rest[0]
    const value = rest[1]?.trim().toLowerCase()
    if (target === undefined || (value !== 'on' && value !== 'off') || rest.length > 2) throw new UsageError(usage)

    return withLocalContext(args, (ctx) => {
      const project = resolveProjectArg(ctx.db, target)
      const jira = value === 'on'
      setProjectJira(ctx.db, project.id, jira)
      if (json) writeJson(successEnvelope('project jira', { id: project.id, name: project.name, jira }))
      else {
        writeOut(jira ? `${project.name} goes to Jira again.` : `${project.name} no longer goes to Jira.`)
        if (!jira) writeOut('Its time is still tracked and documented, and is reported apart from the Jira hours.')
      }
      return 0
    })
  }

  if (subcommand === 'show') {
    const target = rest[0]
    if (target === undefined || rest.length > 1) throw new UsageError('Usage: bita project show <id|name|key>')
    return runProjectShow(args, target, json)
  }

  if (subcommand === 'atlassian') {
    const target = rest[0]
    if (target === undefined || rest.length > 1) {
      throw new UsageError(
        'Usage: bita project atlassian <id|name|key> [--site S|none] [--via mcp|cli] [--confluence URL|SPACEKEY|none] [--pull on|off] [--push on|off]',
      )
    }
    return runProjectAtlassian(args, target, json)
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
    'Usage: bita project add|show|rename|key|jira|atlassian|repo|archive|delete. To list them, run "bita projects".',
  )
}

export function atlassianOf(project: ProjectRow, config: AppConfig) {
  return projectAtlassianView(project, sitesOf(config)[0]?.site ?? null)
}

async function runProjectShow(args: ParsedArgs, target: string, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const ctx = createLocalContext(args)
  try {
    const project = resolveProjectArg(ctx.db, target)
    const data = {
      id: project.id,
      key: project.key,
      name: project.name,
      clientName: project.clientName,
      active: project.active,
      jira: project.jira,
      jiraProjectKey: config.projectMapping[String(project.id)]?.jiraProjectKey ?? null,
      atlassian: atlassianOf(project, config),
    }
    if (json) {
      writeJson(successEnvelope('project show', data))
      return 0
    }
    writeOut(`${project.id}  ${project.name} (key ${project.key ?? '-'})`)
    writeAtlassian(data.atlassian)
    return 0
  } finally {
    ctx.db.close()
  }
}

function writeAtlassian(view: ReturnType<typeof atlassianOf>): void {
  writeOut(`Atlassian site : ${view.site ?? '(default)'}`)
  writeOut(`Through        : ${view.via === 'cli' ? 'bita jira / bita confluence' : 'the Atlassian MCP'}`)
  const confluence = view.confluence
  writeOut(
    `Confluence     : ${
      confluence === null
        ? '(none)'
        : `${confluence.kind} ${confluence.kind === 'space' ? (confluence.spaceKey ?? '') : (confluence.title ?? confluence.pageId ?? '')}${confluence.url ? `  ${confluence.url}` : ''}`
    }`,
  )
  writeOut(`Sync           : pull ${view.sync.pull ? 'on' : 'off'}, push ${view.sync.push ? 'on' : 'off'}${view.sync.lastSyncAt ? `, last ${view.sync.lastSyncAt}` : ''}`)
}

function onOff(args: ParsedArgs, name: string): boolean | undefined {
  const raw = readString(args, name)
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'on' || value === 'true' || value === 'yes') return true
  if (value === 'off' || value === 'false' || value === 'no') return false
  throw new UsageError(`--${name} takes on or off, not "${raw}".`)
}

async function runProjectAtlassian(args: ParsedArgs, target: string, json: boolean): Promise<number> {
  const config = await loadAtlassianConfig()
  const ctx = createLocalContext(args)
  try {
    const project = resolveProjectArg(ctx.db, target)
    const update: ProjectAtlassianUpdate = {}
    const warnings: string[] = []

    const siteRaw = readString(args, 'site')
    if (siteRaw !== undefined) {
      if (siteRaw.trim().toLowerCase() === 'none') update.site = null
      else {
        const entry = findSite(config, siteRaw)
        if (!entry) {
          throw new NotFoundError(
            `There is no login for ${siteRaw}.`,
            'ATLASSIAN_SITE_NOT_FOUND',
            'Add it first with "bita atlassian site add --site <url> --email <you@company.com>".',
          )
        }
        update.site = entry.site
      }
    }

    const via = readString(args, 'via')
    if (via !== undefined) {
      if (via !== 'mcp' && via !== 'cli') throw new UsageError(`--via takes mcp or cli, not "${via}".`)
      update.via = via
    }

    const confluenceRaw = readString(args, 'confluence')
    if (confluenceRaw !== undefined) {
      const parsed = parseConfluenceRef(confluenceRaw)
      update.confluence = parsed === null ? null : { ref: parsed.ref, kind: parsed.kind }
      if (parsed?.site) {
        const current = update.site !== undefined ? update.site : project.atlassianSite
        if (current === null && update.site === undefined && findSite(config, parsed.site)) update.site = parsed.site
        else if (current !== null && current !== parsed.site) {
          warnings.push(`The Confluence URL is on ${parsed.site}, but the project works against ${current}.`)
        }
        if (!findSite(config, parsed.site)) warnings.push(`There is no login for ${parsed.site} yet.`)
      }
    }

    const pull = onOff(args, 'pull')
    const push = onOff(args, 'push')
    if (pull !== undefined) update.syncPull = pull
    if (push !== undefined) update.syncPush = push

    setProjectAtlassian(ctx.db, project.id, update)
    const updated = resolveProjectArg(ctx.db, String(project.id))
    if ((updated.syncPull || updated.syncPush) && updated.confluenceRef === null) {
      warnings.push('Sync is on, but there is no Confluence page or space to sync with: pass --confluence.')
    }

    const data = { id: updated.id, name: updated.name, atlassian: atlassianOf(updated, config), warnings }
    if (json) {
      writeJson(successEnvelope('project atlassian', data))
      return 0
    }
    writeOut(`${updated.name}:`)
    writeAtlassian(data.atlassian)
    for (const warning of warnings) writeOut(`Warning: ${warning}`)
    return 0
  } finally {
    ctx.db.close()
  }
}
