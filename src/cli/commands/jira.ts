import { readFile } from 'node:fs/promises'
import { NotFoundError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, readStringList, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { atlassianRuntime } from '../../atlassian/runtime.ts'
import { chooseSite, credentialsFor, loadAtlassianConfig, projectSiteHint } from '../../atlassian/sites.ts'
import { JiraClient } from '../../jira/client.ts'
import { markdownToAdf, type AdfDocument } from '../../jira/adf.ts'

const OPTIONS = {
  site: { type: 'string' as const },
  project: { type: 'string' as const },
  type: { type: 'string' as const },
  summary: { type: 'string' as const },
  description: { type: 'string' as const },
  'description-file': { type: 'string' as const },
  parent: { type: 'string' as const },
  field: { type: 'string' as const, multiple: true },
  fields: { type: 'string' as const },
  to: { type: 'string' as const },
  from: { type: 'string' as const },
  jql: { type: 'string' as const },
  limit: { type: 'string' as const },
  started: { type: 'string' as const },
  seconds: { type: 'string' as const },
  comment: { type: 'string' as const },
  body: { type: 'string' as const },
  'body-file': { type: 'string' as const },
  query: { type: 'string' as const },
}

const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'project', 'assignee', 'timetracking', 'created', 'updated']

const USAGE = `Usage:
  bita jira myself
  bita jira project ls [--query Q]
  bita jira issue get KEY [--fields a,b]
  bita jira issue create --project KEY --type T --summary S [--description S|--description-file F] [--parent KEY] [--field k=v ...]
  bita jira issue edit KEY [--summary S] [--description S|--description-file F] [--field k=v ...]
  bita jira issue transitions KEY
  bita jira issue transition KEY --to NAME|ID
  bita jira issue search --jql Q [--limit N]
  bita jira issue createmeta --project KEY [--type T]
  bita jira worklog add KEY --started ISO --seconds N [--comment S]
  bita jira comment add KEY --body S|--body-file F
  bita jira link --from KEY --to KEY --type NAME`

export async function runJira(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const [scope, action, target] = args.positionals

  if (scope === 'myself') return runMyself(args, json)
  if (scope === 'project' && (action === 'ls' || action === 'list')) return runProjects(args, json)
  if (scope === 'issue' && action !== undefined) return runIssue(args, json, action, target)
  if (scope === 'worklog' && action === 'add') return runWorklog(args, json, target)
  if (scope === 'comment' && action === 'add') return runComment(args, json, target)
  if (scope === 'link') return runLink(args, json)
  throw new UsageError(USAGE)
}

async function clientFor(args: ParsedArgs, issueKey?: string): Promise<JiraClient> {
  const config = await loadAtlassianConfig()
  const project = readString(args, 'project')
  let projectSite: string | null = null
  if (readString(args, 'site') === undefined && (project !== undefined || issueKey !== undefined)) {
    const ctx = createLocalContext(args)
    try {
      projectSite = projectSiteHint(ctx.db, config, { project, issueKey })
    } finally {
      ctx.db.close()
    }
  }
  const entry = chooseSite(config, { site: readString(args, 'site'), projectSite })
  return new JiraClient(await credentialsFor(entry), atlassianRuntime().fetch)
}

function requireKey(raw: string | undefined, usage: string): string {
  if (raw === undefined || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(raw)) throw new UsageError(usage)
  return raw.toUpperCase()
}

export function parseFieldAssignments(raw: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const assignment of raw) {
    const at = assignment.indexOf('=')
    if (at <= 0) throw new UsageError(`"${assignment}" is not a field assignment; use --field name=value.`)
    const name = assignment.slice(0, at).trim()
    const value = assignment.slice(at + 1)
    try {
      fields[name] = JSON.parse(value) as unknown
    } catch {
      fields[name] = value
    }
  }
  return fields
}

async function markdownFrom(args: ParsedArgs, inline: string, file: string): Promise<AdfDocument | undefined> {
  const path = readString(args, file)
  const text = path !== undefined ? await readFile(path, 'utf8') : readString(args, inline)
  return text === undefined ? undefined : markdownToAdf(text)
}

function emit(json: boolean, command: string, data: unknown, line: string, meta?: Record<string, unknown>): number {
  if (json) writeJson(successEnvelope(command, data, meta))
  else writeOut(line)
  return 0
}

async function runMyself(args: ParsedArgs, json: boolean): Promise<number> {
  const client = await clientFor(args)
  const user = await client.myself()
  return emit(json, 'jira myself', { ...user, site: client.site }, `${user.displayName} <${user.emailAddress ?? '?'}> on ${client.site}`)
}

async function runProjects(args: ParsedArgs, json: boolean): Promise<number> {
  const client = await clientFor(args)
  const projects = await client.projects(readString(args, 'query'))
  if (json) {
    writeJson(successEnvelope('jira project ls', projects, { site: client.site }))
    return 0
  }
  for (const project of projects) writeOut(`${project.key.padEnd(10)} ${project.name}`)
  return 0
}

async function runIssue(args: ParsedArgs, json: boolean, action: string, target: string | undefined): Promise<number> {
  if (action === 'get') {
    const key = requireKey(target, 'Usage: bita jira issue get KEY [--fields a,b]')
    const client = await clientFor(args, key)
    const fields = readString(args, 'fields')?.split(',').map((field) => field.trim()).filter(Boolean)
    const issue = await client.getIssue(key, fields)
    return emit(json, 'jira issue get', issue, `${issue.key} [${issue.status ?? '?'}] ${issue.summary}\n${issue.url}`)
  }

  if (action === 'create') {
    const projectKey = readString(args, 'project')
    const type = readString(args, 'type')
    const summary = readString(args, 'summary')
    if (projectKey === undefined || type === undefined || summary === undefined) {
      throw new UsageError('Usage: bita jira issue create --project KEY --type T --summary S [--description S|--description-file F] [--parent KEY] [--field k=v ...]')
    }
    const client = await clientFor(args)
    const description = await markdownFrom(args, 'description', 'description-file')
    const parent = readString(args, 'parent')
    const fields: Record<string, unknown> = {
      project: { key: projectKey.toUpperCase() },
      issuetype: /^\d+$/.test(type) ? { id: type } : { name: type },
      summary,
      ...(description ? { description } : {}),
      ...(parent ? { parent: { key: parent.toUpperCase() } } : {}),
      ...parseFieldAssignments(readStringList(args, 'field')),
    }
    const created = await client.createIssue(fields)
    return emit(json, 'jira issue create', { ...created, summary }, `Created ${created.key}: ${created.url}`)
  }

  if (action === 'edit') {
    const key = requireKey(target, 'Usage: bita jira issue edit KEY [--summary S] [--description S|--description-file F] [--field k=v ...]')
    const client = await clientFor(args, key)
    const description = await markdownFrom(args, 'description', 'description-file')
    const summary = readString(args, 'summary')
    const fields: Record<string, unknown> = {
      ...(summary !== undefined ? { summary } : {}),
      ...(description ? { description } : {}),
      ...parseFieldAssignments(readStringList(args, 'field')),
    }
    if (Object.keys(fields).length === 0) throw new UsageError('Nothing to change: pass --summary, --description or --field.')
    await client.editIssue(key, fields)
    return emit(json, 'jira issue edit', { key, url: client.issueUrl(key), fields: Object.keys(fields) }, `Updated ${key}.`)
  }

  if (action === 'transitions') {
    const key = requireKey(target, 'Usage: bita jira issue transitions KEY')
    const client = await clientFor(args, key)
    const transitions = await client.transitions(key)
    if (json) {
      writeJson(successEnvelope('jira issue transitions', transitions, { key }))
      return 0
    }
    for (const transition of transitions) writeOut(`${transition.id.padStart(4)}  ${transition.name} -> ${transition.to.name ?? '?'}`)
    return 0
  }

  if (action === 'transition') {
    const key = requireKey(target, 'Usage: bita jira issue transition KEY --to NAME|ID')
    const wanted = readString(args, 'to')
    if (wanted === undefined) throw new UsageError('Pass --to with the transition name or id.')
    const client = await clientFor(args, key)
    const transitions = await client.transitions(key)
    const lowered = wanted.trim().toLowerCase()
    const chosen =
      transitions.find((transition) => transition.id === wanted.trim()) ??
      transitions.find((transition) => transition.name.toLowerCase() === lowered) ??
      transitions.find((transition) => transition.to.name?.toLowerCase() === lowered)
    if (!chosen) {
      throw new NotFoundError(
        `${key} has no transition "${wanted}".`,
        'JIRA_TRANSITION_NOT_FOUND',
        `Available: ${transitions.map((transition) => `${transition.name} (${transition.id})`).join(', ') || 'none'}.`,
      )
    }
    await client.transition(key, chosen.id)
    return emit(json, 'jira issue transition', { key, transition: chosen }, `${key} -> ${chosen.to.name ?? chosen.name}`)
  }

  if (action === 'search') {
    const jql = readString(args, 'jql') ?? target
    if (jql === undefined) throw new UsageError('Usage: bita jira issue search --jql "<JQL>" [--limit N]')
    const client = await clientFor(args)
    const fields = readString(args, 'fields')?.split(',').map((field) => field.trim()).filter(Boolean) ?? SEARCH_FIELDS
    const issues = await client.search(jql, readInteger(args, 'limit') ?? 50, fields)
    if (json) {
      writeJson(successEnvelope('jira issue search', issues, { jql, site: client.site }))
      return 0
    }
    for (const issue of issues) writeOut(`${issue.key.padEnd(12)} [${issue.status ?? '?'}] ${issue.summary}`)
    return 0
  }

  if (action === 'createmeta') {
    const projectKey = readString(args, 'project')
    if (projectKey === undefined) throw new UsageError('Usage: bita jira issue createmeta --project KEY [--type T]')
    const client = await clientFor(args)
    const types = await client.issueTypes(projectKey.toUpperCase())
    const typeRaw = readString(args, 'type')
    if (typeRaw === undefined) {
      if (json) {
        writeJson(successEnvelope('jira issue createmeta', { projectKey: projectKey.toUpperCase(), issueTypes: types }))
        return 0
      }
      for (const type of types) writeOut(`${type.id.padStart(6)}  ${type.name}${type.subtask ? ' (subtask)' : ''}`)
      return 0
    }
    const type = types.find((candidate) => candidate.id === typeRaw || candidate.name.toLowerCase() === typeRaw.toLowerCase())
    if (!type) {
      throw new NotFoundError(`${projectKey} has no issue type "${typeRaw}".`, 'JIRA_ISSUE_TYPE_NOT_FOUND', `Available: ${types.map((candidate) => candidate.name).join(', ')}.`)
    }
    const fields = await client.issueTypeFields(projectKey.toUpperCase(), type.id)
    const data = { projectKey: projectKey.toUpperCase(), issueType: type, fields, timetracking: fields.some((field) => field.fieldId === 'timetracking') }
    if (json) {
      writeJson(successEnvelope('jira issue createmeta', data))
      return 0
    }
    for (const field of fields) writeOut(`${field.required ? '*' : ' '} ${field.fieldId.padEnd(24)} ${field.name}`)
    return 0
  }

  throw new UsageError(USAGE)
}

async function runWorklog(args: ParsedArgs, json: boolean, target: string | undefined): Promise<number> {
  const usage = 'Usage: bita jira worklog add KEY --started ISO --seconds N [--comment S]'
  const key = requireKey(target, usage)
  const started = readString(args, 'started')
  const seconds = readInteger(args, 'seconds')
  if (started === undefined || seconds === undefined || seconds <= 0) throw new UsageError(usage)
  const comment = readString(args, 'comment')
  const client = await clientFor(args, key)
  const worklog = await client.addWorklog(key, {
    started,
    timeSpentSeconds: seconds,
    comment: comment !== undefined ? markdownToAdf(comment) : undefined,
  })
  return emit(json, 'jira worklog add', { key, worklogId: worklog.id, started: worklog.started, timeSpentSeconds: worklog.timeSpentSeconds }, `Logged ${seconds}s on ${key} (worklog ${worklog.id}).`)
}

async function runComment(args: ParsedArgs, json: boolean, target: string | undefined): Promise<number> {
  const usage = 'Usage: bita jira comment add KEY --body S|--body-file F'
  const key = requireKey(target, usage)
  const body = await markdownFrom(args, 'body', 'body-file')
  if (body === undefined) throw new UsageError(usage)
  const client = await clientFor(args, key)
  const comment = await client.addComment(key, body)
  return emit(json, 'jira comment add', { key, commentId: comment.id, created: comment.created, url: client.issueUrl(key) }, `Commented on ${key} (${comment.id}).`)
}

async function runLink(args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: bita jira link --from KEY --to KEY --type NAME'
  const from = requireKey(readString(args, 'from'), usage)
  const to = requireKey(readString(args, 'to'), usage)
  const type = readString(args, 'type')
  if (type === undefined) throw new UsageError(usage)
  const client = await clientFor(args, from)
  await client.linkIssues(type, from, to)
  return emit(json, 'jira link', { from, to, type }, `${from} ${type} ${to}.`)
}
