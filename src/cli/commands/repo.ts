import os from 'node:os'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString, BASE_OPTIONS } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { findProjectById, findProjectByName, insertProject } from '../../db/projects.ts'
import { readRepoContext } from '../../state/git.ts'
import { resolveRepoIdentity, type RepoIdentity } from '../../domain/repo.ts'
import { readConfig, setScopeMapping } from '../../state/config.ts'
import { resolveMappedProject, suggestProject } from '../resolve-project.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

export async function currentRepoIdentity(cwd = process.cwd()): Promise<RepoIdentity | null> {
  const context = await readRepoContext(cwd)
  return resolveRepoIdentity({
    cwd,
    toplevel: context.toplevel,
    home: os.homedir(),
    remoteUrl: context.remoteUrl,
    branch: context.branch,
    headSha: context.headSha,
  })
}

export async function runRepo(argv: string[]): Promise<number> {
  const subcommand = argv[0] ?? 'show'
  const args = parseCommandArgs(
    argv.slice(1),
    { name: { type: 'string' }, client: { type: 'string' }, scope: { type: 'string' } },
    BASE_OPTIONS,
  )
  const json = readBoolean(args, 'json')

  if (subcommand === 'show') {
    const identity = await currentRepoIdentity()
    const config = await readConfig()
    const ctx = createLocalContext(args)
    let resolved = null
    try {
      resolved = identity ? suggestProject(ctx.db, identity.slug, config) : null
    } finally {
      ctx.db.close()
    }

    if (json) {
      writeJson(successEnvelope('repo show', { repo: identity, project: resolved }))
      return 0
    }

    if (!identity) {
      writeOut('Not inside a git repository.')
      return 0
    }

    writeOut(`Slug    : ${identity.slug} (from ${identity.source})`)
    if (identity.branch) writeOut(`Branch  : ${identity.branch}`)

    if (!resolved) {
      writeOut('Project : not mapped. Run "bita repo init" to resolve it.')
      return 0
    }

    writeOut(`Project : ${resolved.projectName} (${resolved.projectId})`)
    writeOut(
      resolved.via === 'scope'
        ? `Scope   : ${resolved.prefix}`
        : `Scope   : none yet. "${resolved.prefix}" would be saved by "bita repo init".`,
    )
    return 0
  }

  if (subcommand === 'init') {
    const [rawPath] = args.positionals
    const target = rawPath === undefined || rawPath === '.' ? process.cwd() : resolve(rawPath)

    if (!existsSync(target)) {
      throw new UsageError(`No such directory: ${target}`)
    }

    const identity = await currentRepoIdentity(target)
    if (!identity) {
      throw new UsageError(`${target} is not inside a git repository.`)
    }

    const config = await readConfig()
    const mapped = resolveMappedProject(identity.slug, config)
    if (mapped) {
      if (json) {
        writeJson(successEnvelope('repo init', { slug: identity.slug, ...mapped, created: false }))
      } else {
        writeOut(`${identity.slug} already resolves to ${mapped.projectName} (${mapped.projectId}).`)
        writeOut(`Scope   : ${mapped.prefix}`)
        writeOut(`Run "bita scope unset ${mapped.prefix}" first if you want to change it.`)
      }
      return 0
    }

    const explicitName = readString(args, 'name')
    const ctx = createLocalContext(args)
    let project
    let created = false
    let prefix = identity.slug

    try {
      const suggestion = explicitName === undefined ? suggestProject(ctx.db, identity.slug, config) : null

      if (suggestion) {
        project = { id: suggestion.projectId, name: suggestion.projectName }
        prefix = suggestion.prefix
      } else {
        const projectName = explicitName ?? identity.name
        const found = findProjectByName(ctx.db, projectName)
        if (found) {
          project = found
        } else {
          project = insertProject(ctx.db, {
            name: projectName,
            clientName: readString(args, 'client') ?? null,
            createdAt: new Date().toISOString(),
          })
          created = true
        }
      }
    } finally {
      ctx.db.close()
    }

    const scopePrefix = readString(args, 'scope') ?? prefix

    await setScopeMapping(scopePrefix, {
      projectId: project.id,
      projectName: project.name,
      slugSource: identity.source,
      verifiedAt: new Date().toISOString(),
    })

    if (json) {
      writeJson(
        successEnvelope('repo init', {
          slug: identity.slug,
          prefix: scopePrefix,
          projectId: project.id,
          projectName: project.name,
          created,
        }),
      )
    } else {
      writeOut(
        created
          ? `Created project ${project.id}: ${project.name}`
          : `Using the existing project ${project.id}: ${project.name}`,
      )
      writeOut(`Scope   : ${scopePrefix}`)
      if (scopePrefix !== identity.slug) {
        writeOut('          Every repository under that prefix resolves to this project.')
      }
      writeOut('')
      writeOut('Claude will now offer the timer in these repositories.')
      writeOut(`To send its time to Jira, map it in tally: tally map set ${project.id} <JIRAKEY>`)
    }
    return 0
  }

  throw new UsageError(`Unknown repo subcommand "${subcommand}". Use show or init; scopes live in "bita scope".`)
}
