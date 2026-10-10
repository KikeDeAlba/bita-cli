import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FoundTool } from '@kikedealba/kit/registry'
import { writeErr, writeJson } from './output.ts'

type KitRegistry = typeof import('@kikedealba/kit/registry')

export type Provider = 'atl' | 'inkwell'

export interface DelegationPlan {
  provider: Provider
  command: string
  capabilities: string[]
  calls: string[][]
  siteHint?: { project?: string; issueKey?: string }
  aggregate?: boolean
}

export const DELEGATED_COMMANDS = new Set(['jira', 'confluence', 'atlassian', 'docs', 'backlog', 'meeting'])

export const PROVIDER_CAPABILITIES: Record<Provider, string[]> = {
  atl: ['jira.issue.read', 'jira.issue.write', 'jira.worklog.write', 'confluence.page.read', 'confluence.page.write', 'confluence.attachment.write'],
  inkwell: ['docs.page.read', 'docs.page.write', 'docs.backlog', 'docs.history', 'docs.propose', 'docs.diagrams', 'docs.export.pdf', 'docs.confluence.sync'],
}

const PROBE_TIMEOUT_MS = 5_000

export const PROVIDER_HINTS: Record<Provider | 'recap', string> = {
  atl: 'npm install -g @kikedealba/atl && atl setup',
  inkwell: 'npm install -g @kikedealba/inkwell && inkwell setup && inkwell migrate --from-bita',
  recap: 'npm install -g @kikedealba/recap && recap setup',
}

const BITA_STORE_FLAGS = ['--db-path', '--docs-dir']

const BOOLEAN_FLAGS = new Set([
  'json',
  'markdown',
  'storage',
  'all',
  'dry-run',
  'token-stdin',
  'check',
  'force',
  'offline',
  'verbose',
  'no-cache',
  'help',
])

interface Parsed {
  positionals: string[]
  options: Map<string, string[]>
  flags: Set<string>
}

function parseLenient(tokens: readonly string[]): Parsed {
  const positionals: string[] = []
  const options = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1))
      break
    }
    if (token.startsWith('--') && token.length > 2) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        const name = body.slice(0, eq)
        options.set(name, [...(options.get(name) ?? []), body.slice(eq + 1)])
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags.add(body)
      } else {
        const next = tokens[index + 1]
        if (next === undefined) {
          flags.add(body)
        } else {
          options.set(body, [...(options.get(body) ?? []), next])
          index += 1
        }
      }
      continue
    }
    positionals.push(token)
  }
  return { positionals, options, flags }
}

function one(parsed: Parsed, name: string): string | undefined {
  const values = parsed.options.get(name)
  return values ? values[values.length - 1] : undefined
}

function onlyUses(parsed: Parsed, options: readonly string[], flags: readonly string[] = []): boolean {
  const allowedOptions = new Set(['site', ...options])
  const allowedFlags = new Set(['json', ...flags])
  for (const name of parsed.options.keys()) if (!allowedOptions.has(name)) return false
  for (const name of parsed.flags) if (!allowedFlags.has(name)) return false
  return true
}

function literal(value: string): string {
  return value.startsWith('@') ? `@${value}` : value
}

function option(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`--${name}=${literal(value)}`]
}

function fileOption(name: string, path: string): string[] {
  return [`--${name}=@${resolve(path)}`]
}

function siteOption(parsed: Parsed): string[] {
  return option('site', one(parsed, 'site'))
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i
const PAGE_ID = /^\d+$/

function issueKey(raw: string | undefined): string | null {
  return raw !== undefined && ISSUE_KEY.test(raw) ? raw.toUpperCase() : null
}

function pageId(raw: string | undefined): string | null {
  return raw !== undefined && PAGE_ID.test(raw) ? raw : null
}

export function fieldAssignments(raw: readonly string[]): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {}
  for (const assignment of raw) {
    const at = assignment.indexOf('=')
    if (at <= 0) return null
    const value = assignment.slice(at + 1)
    try {
      fields[assignment.slice(0, at).trim()] = JSON.parse(value) as unknown
    } catch {
      fields[assignment.slice(0, at).trim()] = value
    }
  }
  return fields
}

function descriptionOptions(parsed: Parsed): string[] {
  const file = one(parsed, 'description-file')
  if (file !== undefined) return fileOption('description', file)
  return option('description', one(parsed, 'description'))
}

function fieldsOption(parsed: Parsed): string[] | null {
  const raw = parsed.options.get('field') ?? []
  if (raw.length === 0) return []
  const fields = fieldAssignments(raw)
  return fields === null ? null : [`--fields=${JSON.stringify(fields)}`]
}

function atl(command: string, capabilities: string[], calls: string[][], extra: Partial<DelegationPlan> = {}): DelegationPlan {
  return { provider: 'atl', command, capabilities, calls, ...extra }
}

function planJira(rest: readonly string[]): DelegationPlan | null {
  const parsed = parseLenient(rest)
  const [scope, action, target, extra] = parsed.positionals
  const site = siteOption(parsed)
  const read = ['jira.issue.read']
  const write = ['jira.issue.write']

  if (scope === 'myself' && action === undefined && onlyUses(parsed, [])) {
    return atl('jira myself', read, [['jira', 'myself', ...site]])
  }
  if (scope === 'project' && (action === 'ls' || action === 'list') && target === undefined && onlyUses(parsed, ['query'])) {
    return atl('jira project ls', read, [['jira', 'project', 'ls', ...option('query', one(parsed, 'query')), ...site]])
  }
  if (scope === 'issue') {
    const key = issueKey(target)
    if (action === 'get' && key && extra === undefined && onlyUses(parsed, ['fields'])) {
      return atl('jira issue get', read, [['jira', 'issue', 'get', key, ...option('fields', one(parsed, 'fields')), ...site]], { siteHint: { issueKey: key } })
    }
    if (action === 'create' && target === undefined && onlyUses(parsed, ['project', 'type', 'summary', 'description', 'description-file', 'parent', 'field'])) {
      const project = one(parsed, 'project')
      const type = one(parsed, 'type')
      const summary = one(parsed, 'summary')
      const fields = fieldsOption(parsed)
      if (project === undefined || type === undefined || summary === undefined || fields === null) return null
      const parent = one(parsed, 'parent')
      return atl(
        'jira issue create',
        write,
        [['jira', 'issue', 'create', ...option('project', project.toUpperCase()), ...option('type', type), ...option('summary', summary), ...descriptionOptions(parsed), ...option('parent', parent?.toUpperCase()), ...fields, ...site]],
        { siteHint: { project } },
      )
    }
    if (action === 'edit' && key && extra === undefined && onlyUses(parsed, ['summary', 'description', 'description-file', 'field'])) {
      const fields = fieldsOption(parsed)
      if (fields === null) return null
      return atl('jira issue edit', write, [['jira', 'issue', 'edit', key, ...option('summary', one(parsed, 'summary')), ...descriptionOptions(parsed), ...fields, ...site]], { siteHint: { issueKey: key } })
    }
    if (action === 'transitions' && key && extra === undefined && onlyUses(parsed, [])) {
      return atl('jira issue transitions', read, [['jira', 'issue', 'transitions', key, ...site]], { siteHint: { issueKey: key } })
    }
    if (action === 'transition' && key && extra === undefined && onlyUses(parsed, ['to'])) {
      const to = one(parsed, 'to')
      if (to === undefined) return null
      return atl('jira issue transition', write, [['jira', 'issue', 'transition', key, ...option('to', to), ...site]], { siteHint: { issueKey: key } })
    }
    if (action === 'search' && extra === undefined && onlyUses(parsed, ['jql', 'limit', 'fields'])) {
      const jql = one(parsed, 'jql') ?? target
      if (jql === undefined) return null
      return atl('jira issue search', read, [['jira', 'search', ...option('jql', jql), ...option('limit', one(parsed, 'limit')), ...option('fields', one(parsed, 'fields')), ...site]])
    }
    if (action === 'createmeta' && target === undefined && onlyUses(parsed, ['project', 'type'])) {
      const project = one(parsed, 'project')
      if (project === undefined) return null
      return atl('jira issue createmeta', read, [['jira', 'createmeta', ...option('project', project.toUpperCase()), ...option('type', one(parsed, 'type')), ...site]], { siteHint: { project } })
    }
    return null
  }
  if (scope === 'worklog' && action === 'add') {
    const key = issueKey(target)
    const started = one(parsed, 'started')
    const seconds = one(parsed, 'seconds')
    if (!key || extra !== undefined || started === undefined || seconds === undefined || !/^\d+$/.test(seconds) || Number(seconds) <= 0) return null
    if (!onlyUses(parsed, ['started', 'seconds', 'comment'])) return null
    return atl(
      'jira worklog add',
      ['jira.worklog.write'],
      [['jira', 'worklog', 'add', key, ...option('started', started), `--time-spent=${seconds}`, ...option('comment', one(parsed, 'comment')), ...site]],
      { siteHint: { issueKey: key } },
    )
  }
  if (scope === 'comment') {
    const key = issueKey(target)
    if (!key) return null
    if (action === 'add' && extra === undefined && onlyUses(parsed, ['body', 'body-file'])) {
      const file = one(parsed, 'body-file')
      const body = file !== undefined ? fileOption('body', file) : option('body', one(parsed, 'body'))
      if (body.length === 0) return null
      return atl('jira comment add', write, [['jira', 'comment', 'add', key, ...body, ...site]], { siteHint: { issueKey: key } })
    }
    if ((action === 'ls' || action === 'list') && extra === undefined && onlyUses(parsed, [])) {
      return atl('jira comment ls', read, [['jira', 'comment', 'ls', key, ...site]], { siteHint: { issueKey: key } })
    }
    if ((action === 'rm' || action === 'delete') && extra !== undefined && /^\d+$/.test(extra) && parsed.positionals.length === 4 && onlyUses(parsed, [])) {
      return atl('jira comment rm', write, [['jira', 'comment', 'rm', key, extra, ...site]], { siteHint: { issueKey: key } })
    }
    return null
  }
  if (scope === 'attach') {
    const key = issueKey(action)
    const files = parsed.positionals.slice(2)
    if (!key || files.length === 0 || !onlyUses(parsed, [])) return null
    return atl('jira attach', write, files.map((file) => ['jira', 'attach', key, resolve(file), ...site]), { siteHint: { issueKey: key }, aggregate: true })
  }
  if (scope === 'link' && action === undefined && onlyUses(parsed, ['from', 'to', 'type'])) {
    const from = issueKey(one(parsed, 'from'))
    const to = issueKey(one(parsed, 'to'))
    const type = one(parsed, 'type')
    if (!from || !to || type === undefined) return null
    return atl('jira link', write, [['jira', 'link', ...option('type', type), ...option('inward', from), ...option('outward', to), ...site]], { siteHint: { issueKey: from } })
  }
  return null
}

function bodyOptions(parsed: Parsed): string[] {
  const file = one(parsed, 'file')
  const body = file !== undefined ? fileOption('body', file) : option('body', one(parsed, 'body'))
  return body.length === 0 ? [] : [...body, ...(parsed.flags.has('storage') ? ['--format=storage'] : [])]
}

function planConfluencePage(parsed: Parsed): DelegationPlan | null {
  const [, action, target, extra] = parsed.positionals
  const site = siteOption(parsed)
  const hint = one(parsed, 'project') !== undefined ? { siteHint: { project: one(parsed, 'project') as string } } : {}
  const read = ['confluence.page.read']
  const write = ['confluence.page.write']
  if (extra !== undefined) return null

  if (action === 'get' && onlyUses(parsed, ['project'], ['markdown'])) {
    const id = pageId(target)
    if (!id) return null
    return atl('confluence page get', read, [['confluence', 'page', 'get', id, ...(parsed.flags.has('markdown') ? [] : ['--format=storage']), ...site]], hint)
  }
  if (action === 'create' && target === undefined && onlyUses(parsed, ['project', 'space', 'parent', 'title', 'file', 'body'], ['storage'])) {
    const space = one(parsed, 'space')
    const title = one(parsed, 'title')
    const body = bodyOptions(parsed)
    if (space === undefined || title === undefined || body.length === 0) return null
    return atl('confluence page create', write, [['confluence', 'page', 'create', ...option('space', space), ...option('title', title), ...body, ...option('parent-id', one(parsed, 'parent')), ...site]], hint)
  }
  if (action === 'update' && onlyUses(parsed, ['project', 'file', 'body', 'title', 'message'], ['storage'])) {
    const id = pageId(target)
    const body = bodyOptions(parsed)
    if (!id || body.length === 0) return null
    return atl('confluence page update', write, [['confluence', 'page', 'update', id, ...body, ...option('title', one(parsed, 'title')), ...option('message', one(parsed, 'message')), ...site]], hint)
  }
  if (action === 'search' && onlyUses(parsed, ['project', 'cql', 'limit'])) {
    const cql = one(parsed, 'cql') ?? target
    if (cql === undefined) return null
    return atl('confluence page search', read, [['confluence', 'search', ...option('cql', cql), ...option('limit', one(parsed, 'limit')), ...site]], hint)
  }
  if (action === 'children' && onlyUses(parsed, ['project'])) {
    const id = pageId(target)
    if (!id) return null
    return atl('confluence page children', read, [['confluence', 'page', 'children', id, ...site]], hint)
  }
  return null
}

function planSite(command: string, parsed: Parsed, words: readonly string[]): DelegationPlan | null {
  const [action, target, extra] = words
  if (extra !== undefined) return null
  if (action === 'add' && target === undefined && onlyUses(parsed, ['email'], ['token-stdin'])) {
    const url = one(parsed, 'site')
    const email = one(parsed, 'email')
    if (url === undefined || email === undefined) return null
    return atl(command, [], [['site', 'add', literal(url), ...option('email', email), ...(parsed.flags.has('token-stdin') ? ['--token-stdin'] : [])]])
  }
  if ((action === 'ls' || action === 'list') && target === undefined && onlyUses(parsed, [])) {
    return atl(command, [], [['site', 'ls']])
  }
  if (action === 'test' && onlyUses(parsed, [])) {
    const site = target ?? one(parsed, 'site')
    return atl(command, [], [['site', 'test', ...(site !== undefined ? [literal(site)] : [])]])
  }
  if ((action === 'rm' || action === 'remove') && parsed.flags.has('force') && onlyUses(parsed, [], ['force'])) {
    const site = target ?? one(parsed, 'site')
    if (site === undefined) return null
    return atl(command, [], [['site', 'rm', literal(site)]])
  }
  return null
}

const BITA_ONLY_OPTIONS = new Set(['--workspace'])
const BITA_ONLY_FLAGS = new Set(['--no-cache', '--verbose'])

function withoutBitaOnly(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--') {
      kept.push(...args.slice(index))
      break
    }
    if (BITA_ONLY_FLAGS.has(arg)) continue
    if (BITA_ONLY_OPTIONS.has(arg)) {
      index += 1
      continue
    }
    if ([...BITA_ONLY_OPTIONS].some((name) => arg.startsWith(`${name}=`))) continue
    kept.push(arg)
  }
  return kept
}

function inkwell(command: string, capabilities: string[], args: string[]): DelegationPlan {
  return { provider: 'inkwell', command, capabilities, calls: [withoutBitaOnly(args)] }
}

function leadingWords(tokens: readonly string[], count: number): string[] {
  const words: string[] = []
  for (const token of tokens) {
    if (token.startsWith('-') || words.length === count) break
    words.push(token)
  }
  return words
}

function planConfluence(rest: readonly string[]): DelegationPlan | null {
  const [action, second] = rest
  if (action === 'sync') {
    if (second === 'status') return inkwell('confluence sync status', ['docs.confluence.sync'], ['confluence', 'status', ...rest.slice(2)])
    return inkwell('confluence sync', ['docs.confluence.sync'], ['confluence', 'sync', ...rest.slice(1)])
  }
  if (action === 'conflict') {
    const sub = second === 'list' ? 'ls' : second
    return inkwell(`confluence conflict ${sub ?? ''}`.trim(), ['docs.confluence.sync'], ['confluence', 'conflict', ...rest.slice(1)])
  }
  const parsed = parseLenient(rest)
  if (action === 'page') return planConfluencePage(parsed)
  if (action === 'attach') {
    const [, target, ...files] = parsed.positionals
    const id = pageId(target)
    if (!id || files.length === 0 || !onlyUses(parsed, ['comment', 'project'])) return null
    const comment = option('comment', one(parsed, 'comment'))
    const hint = one(parsed, 'project') !== undefined ? { siteHint: { project: one(parsed, 'project') as string } } : {}
    return atl('confluence attach', ['confluence.attachment.write'], files.map((file) => ['confluence', 'attach', id, resolve(file), ...comment, ...siteOption(parsed)]), { ...hint, aggregate: true })
  }
  if (action === 'login') return planSite('confluence login', parsed, ['add', ...parsed.positionals.slice(1)])
  if (action === 'status' && parsed.positionals.length === 1 && onlyUses(parsed, [])) {
    return atl('confluence status', [], [['site', 'test', ...(one(parsed, 'site') !== undefined ? [literal(one(parsed, 'site') as string)] : [])]])
  }
  return null
}

function planDocs(rest: readonly string[]): DelegationPlan | null {
  const first = rest[0] === undefined || rest[0].startsWith('-') ? 'tree' : rest[0]
  const tail = rest[0] === undefined || rest[0].startsWith('-') ? [...rest] : rest.slice(1)
  if (first === 'migrate') return null
  if (first === 'ls' || first === 'show') return null
  if (first === 'tree' || first === 'search') {
    if (!tail.includes('--pages')) return null
    return inkwell(`docs ${first}`, ['docs.page.read'], [first, ...tail])
  }
  if (first === 'page') {
    const words = leadingWords(tail, 2)
    const label = words[0] === 'ref' || words[0] === 'asset' ? words.join(' ') : (words[0] ?? '')
    return inkwell(`docs page ${label}`.trim(), ['docs.page.read', 'docs.page.write'], ['page', ...tail])
  }
  if (first === 'diagrams') {
    return inkwell(`docs diagrams ${leadingWords(tail, 1).join(' ')}`.trim(), ['docs.diagrams'], ['diagrams', ...tail])
  }
  if (first === 'git') return inkwell('docs git init', ['docs.history'], ['git', ...tail])
  if (first === 'status' || first === 'commit' || first === 'normalize') {
    return inkwell(`docs ${first}`, ['docs.history'], ['git', first, ...tail])
  }
  if (first === 'propose') return inkwell('docs propose', ['docs.propose'], ['git', 'propose', ...tail])
  if (first === 'branch') {
    const action = leadingWords(tail, 1)[0] ?? 'ls'
    return inkwell(`docs branch ${action}`, ['docs.propose'], ['branch', ...tail])
  }
  return null
}

function planMeeting(rest: readonly string[]): DelegationPlan | null {
  const parsed = parseLenient(rest)
  const [action, target] = parsed.positionals
  if (action !== 'export' || target === undefined || !/^\d+$/.test(target) || parsed.positionals.length !== 2) return null
  if (!onlyUses(parsed, ['out'])) return null
  return inkwell('meeting export', ['docs.export.pdf'], ['export', 'meeting', '--bita-entry', target, ...option('out', one(parsed, 'out'))])
}

export function planDelegation(argv: readonly string[]): DelegationPlan | null {
  const [command, ...rest] = argv
  if (command === undefined || !DELEGATED_COMMANDS.has(command)) return null
  if (rest.some((token) => BITA_STORE_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`)))) return null
  if (rest.includes('--help') || rest.includes('-h')) return null
  if (command === 'jira') return planJira(rest)
  if (command === 'confluence') return planConfluence(rest)
  if (command === 'atlassian') {
    const parsed = parseLenient(rest)
    if (parsed.positionals[0] !== 'site') return null
    const words = parsed.positionals.slice(1)
    return planSite(`atlassian site ${words[0] === 'list' ? 'ls' : words[0] === 'remove' ? 'rm' : (words[0] ?? '')}`.trim(), parsed, words)
  }
  if (command === 'docs') return planDocs(rest)
  if (command === 'backlog') {
    const action = leadingWords(rest, 1)[0] ?? 'ls'
    return inkwell(`backlog ${action}`, ['docs.backlog'], ['backlog', ...rest])
  }
  return planMeeting(rest)
}

let kitPromise: Promise<KitRegistry | null> | null = null

export function loadKit(): Promise<KitRegistry | null> {
  kitPromise ??= import('@kikedealba/kit/registry').then(
    (module) => module,
    () => null,
  )
  return kitPromise
}

export function delegationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['BITA_NO_DELEGATE']
  return value !== undefined && value !== '' && value !== '0'
}

export interface MigrationStatus {
  migrated: boolean
  bitaDatabase: string | null
  migratedAt: string | null
}

export async function inkwellMigration(kit: KitRegistry, tool: FoundTool): Promise<MigrationStatus | null> {
  try {
    const { envelope } = await kit.invokeTool<Partial<MigrationStatus>>(tool, ['migrate', 'status', '--json'], { timeoutMs: PROBE_TIMEOUT_MS })
    if (!envelope.ok || typeof envelope.data !== 'object' || envelope.data === null) return null
    return {
      migrated: envelope.data.migrated === true,
      bitaDatabase: typeof envelope.data.bitaDatabase === 'string' ? envelope.data.bitaDatabase : null,
      migratedAt: typeof envelope.data.migratedAt === 'string' ? envelope.data.migratedAt : null,
    }
  } catch {
    return null
  }
}

function samePath(left: string, right: string): boolean {
  const canonical = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return canonical(left) === canonical(right)
}

async function currentDatabase(): Promise<string | null> {
  try {
    return (await import('../db/paths.ts')).databasePath()
  } catch {
    return null
  }
}

export async function migratedHere(status: MigrationStatus | null): Promise<boolean> {
  if (!status?.migrated) return false
  if (status.bitaDatabase === null) return true
  const current = await currentDatabase()
  return current === null || samePath(status.bitaDatabase, current)
}

export async function findProvider(kit: KitRegistry, plan: DelegationPlan): Promise<FoundTool | null> {
  const tool = await kit.findTool(plan.provider, plan.capabilities.length > 0 ? { capability: plan.capabilities } : {})
  if (!tool) return null
  if (plan.provider === 'inkwell') {
    const status = await inkwellMigration(kit, tool)
    if (status === null) {
      writeErr(`bita: inkwell ${tool.manifest.version} did not answer "inkwell migrate status"; running "bita ${plan.command}" on bita's own documents.`)
      return null
    }
    if (!(await migratedHere(status))) return null
  }
  return tool
}

function siteKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/wiki$/, '')
}

async function bitaSiteHint(hint: { project?: string; issueKey?: string }): Promise<string | null> {
  try {
    const [{ loadAtlassianConfig, projectSiteHint }, { createLocalContext }] = await Promise.all([import('../atlassian/sites.ts'), import('./local-context.ts')])
    const config = await loadAtlassianConfig()
    const ctx = createLocalContext({ values: {}, positionals: [] })
    try {
      return projectSiteHint(ctx.db, config, hint)
    } finally {
      ctx.db.close()
    }
  } catch {
    return null
  }
}

type SiteChoice = { kind: 'default' } | { kind: 'site'; name: string } | { kind: 'unknown'; site: string }

async function atlSiteFor(kit: KitRegistry, tool: FoundTool, hint: { project?: string; issueKey?: string }): Promise<SiteChoice> {
  const site = await bitaSiteHint(hint)
  if (site === null) return { kind: 'default' }
  try {
    const { envelope } = await kit.invokeTool<Array<{ name?: unknown; url?: unknown }>>(tool, ['site', 'ls', '--json'], { timeoutMs: PROBE_TIMEOUT_MS })
    if (!envelope.ok || !Array.isArray(envelope.data)) return { kind: 'unknown', site }
    const match = envelope.data.find((entry) => typeof entry.url === 'string' && siteKey(entry.url) === siteKey(site))
    return match && typeof match.name === 'string' ? { kind: 'site', name: match.name } : { kind: 'unknown', site }
  } catch {
    return { kind: 'unknown', site }
  }
}

interface ProviderEnvelope {
  schemaVersion?: unknown
  ok: boolean
  command: string
  meta?: Record<string, unknown>
  data?: unknown
  error?: unknown
  [key: string]: unknown
}

function parseProviderEnvelope(stdout: string): ProviderEnvelope | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  try {
    const parsed = JSON.parse(last) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const envelope = parsed as Record<string, unknown>
    if (typeof envelope['ok'] !== 'boolean' || typeof envelope['command'] !== 'string') return null
    return envelope as ProviderEnvelope
  } catch {
    return null
  }
}

interface RunResult {
  code: number
  stdout: string
}

function runProvider(bin: readonly string[], args: readonly string[], capture: boolean): Promise<RunResult> {
  const [command, ...prefix] = bin
  return new Promise((done, fail) => {
    if (command === undefined) {
      fail(new Error('The provider has no binary.'))
      return
    }
    const child = spawn(command, [...prefix, ...args], { stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], env: process.env })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', fail)
    child.on('close', (code, signal) => done({ code: code ?? (signal ? 1 : 0), stdout: Buffer.concat(chunks).toString('utf8') }))
  })
}

function relabel(envelope: ProviderEnvelope, command: string, provider: FoundTool): ProviderEnvelope {
  return {
    ...envelope,
    command,
    meta: { ...(envelope.meta ?? {}), delegatedTo: { tool: provider.manifest.name, version: provider.manifest.version, command: envelope.command } },
  }
}

function failure(command: string, provider: FoundTool, message: string): ProviderEnvelope {
  return {
    schemaVersion: 3,
    ok: false,
    command,
    generatedAt: new Date().toISOString(),
    meta: { delegatedTo: { tool: provider.manifest.name, version: provider.manifest.version } },
    error: { code: 'DELEGATION_FAILED', message },
  }
}

function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function notice(plan: DelegationPlan, provider: FoundTool): string {
  const direct = [plan.provider, ...(plan.calls[0] ?? []).filter((arg) => arg !== '--json')].map(shellWord).join(' ')
  return `bita: "bita ${plan.command}" is deprecated and now runs through ${provider.manifest.name} ${provider.manifest.version}; use "${direct}" instead.`
}

function loginHint(envelope: ProviderEnvelope): string | null {
  const error = envelope.error as { code?: unknown } | undefined
  if (error?.code === 'LOGIN_REQUIRED' || error?.code === 'SITE_NOT_FOUND') {
    return 'bita: atl does not know your bita sites yet; copy them with "atl site import --from-bita".'
  }
  return null
}

export async function execute(plan: DelegationPlan, provider: FoundTool, json: boolean, site: string | null = null): Promise<number> {
  writeErr(notice(plan, provider))
  const calls = plan.calls
    .map((call) => call.filter((arg) => arg !== '--json'))
    .map((call) => (site !== null && plan.provider === 'atl' && !call.some((arg) => arg.startsWith('--site=')) ? [...call, `--site=${site}`] : call))

  if (!json) {
    let code = 0
    for (const call of calls) {
      code = (await runProvider(provider.bin, call, false)).code
      if (code !== 0) break
    }
    return code
  }

  const envelopes: ProviderEnvelope[] = []
  let code = 0
  for (const call of calls) {
    const result = await runProvider(provider.bin, [...call, '--json'], true)
    const envelope = parseProviderEnvelope(result.stdout)
    if (envelope === null) {
      writeJson(failure(plan.command, provider, `${provider.manifest.name} did not answer with a JSON envelope (exit ${result.code}).`))
      return result.code === 0 ? 1 : result.code
    }
    code = result.code
    envelopes.push(envelope)
    if (!envelope.ok || code !== 0) {
      const hint = plan.provider === 'atl' ? loginHint(envelope) : null
      if (hint) writeErr(hint)
      const done = envelopes.slice(0, -1)
      const partial = plan.aggregate && done.length > 0 ? { data: { completed: done.flatMap((item) => (Array.isArray(item.data) ? item.data : [item.data])), skipped: calls.length - envelopes.length } } : {}
      writeJson(relabel({ ...envelope, ...partial }, plan.command, provider))
      return code === 0 ? 1 : code
    }
  }

  const [first] = envelopes
  if (first === undefined) return 0
  if (plan.aggregate) {
    const data = envelopes.flatMap((envelope) => (Array.isArray(envelope.data) ? envelope.data : [envelope.data]))
    writeJson(relabel({ ...first, data }, plan.command, provider))
  } else {
    writeJson(relabel(first, plan.command, provider))
  }
  return code
}

export async function tryDelegate(argv: readonly string[]): Promise<number | null> {
  if (delegationDisabled()) return null
  const plan = planDelegation(argv)
  if (plan === null) return null
  const kit = await loadKit()
  if (kit === null) return null
  let provider: FoundTool | null
  try {
    provider = await findProvider(kit, plan)
  } catch {
    return null
  }
  if (provider === null) return null
  const hasSite = plan.calls.some((call) => call.some((arg) => arg.startsWith('--site=')))
  const choice: SiteChoice = plan.provider === 'atl' && plan.siteHint && !hasSite ? await atlSiteFor(kit, provider, plan.siteHint) : { kind: 'default' }
  if (choice.kind === 'unknown') {
    writeErr(`bita: atl has no site for ${choice.site}; running "bita ${plan.command}" itself. Add it with "atl site import --from-bita".`)
    return null
  }
  return execute(plan, provider, argv.includes('--json'), choice.kind === 'site' ? choice.name : null)
}
