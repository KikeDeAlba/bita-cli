import type { RefKind } from '../db/page-refs.ts'

export interface ExtractedRef {
  url: string
  title: string
  kind: RefKind
}

export interface ToolUse {
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
}

const JIRA_TOOLS = new Set([
  'getJiraIssue',
  'createJiraIssue',
  'editJiraIssue',
  'addCommentToJiraIssue',
  'addWorklogToJiraIssue',
  'transitionJiraIssue',
])

const CONFLUENCE_TOOLS = new Set([
  'getConfluencePage',
  'createConfluencePage',
  'updateConfluencePage',
  'createConfluenceFooterComment',
  'createConfluenceInlineComment',
])

const DRIVE_TOOLS = new Set([
  'read_file_content',
  'download_file_content',
  'get_file_metadata',
  'create_file',
  'update_file',
  'copy_file',
])

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/
const URL_PATTERN = /https?:\/\/[^\s"'<>\\)\]]+/g

export function shortToolName(name: string): string {
  const parts = name.split('__')
  return parts[parts.length - 1] ?? name
}

function texts(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value)
    return into
  }
  if (Array.isArray(value)) {
    for (const item of value) texts(item, into)
    return into
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string' && Object.keys(record).length <= 3) {
      into.push(record.text)
      return into
    }
    into.push(JSON.stringify(value))
  }
  return into
}

function parsed(value: unknown): unknown[] {
  const out: unknown[] = []
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (!(typeof record.text === 'string' && Object.keys(record).length <= 3)) out.push(value)
  }
  for (const text of texts(value)) {
    try {
      out.push(JSON.parse(text))
    } catch {
      continue
    }
  }
  return out
}

function field(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function firstString(values: unknown[], paths: readonly (readonly string[])[]): string | undefined {
  for (const value of values) {
    for (const path of paths) {
      const found = field(value, path)
      if (typeof found === 'string' && found.trim().length > 0) return found.trim()
    }
  }
  return undefined
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:]+$/, '')
}

export function classifyUrl(url: string): RefKind | null {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return null
  }
  const host = parsedUrl.hostname
  if (host.endsWith('.atlassian.net')) {
    if (parsedUrl.pathname.startsWith('/wiki/')) return 'confluence'
    if (parsedUrl.pathname.startsWith('/browse/')) return 'jira'
    return null
  }
  if (host === 'docs.google.com' || host === 'drive.google.com') return 'drive'
  return null
}

function siteBase(siteUrl: string | undefined): string | undefined {
  if (!siteUrl) return undefined
  return siteUrl.replace(/\/+$/, '')
}

function jiraRefs(input: unknown, responses: unknown[], siteUrl: string | undefined): ExtractedRef[] {
  const base = siteBase(siteUrl)
  if (!base) return []
  const key =
    firstString([input], [['issueIdOrKey'], ['issueKey']]) ?? firstString(responses, [['key'], ['issue', 'key']])
  if (!key || !ISSUE_KEY.test(key)) return []
  const title =
    firstString(responses, [['fields', 'summary'], ['summary']]) ??
    firstString([input], [['summary']]) ??
    ''
  return [{ url: `${base}/browse/${key}`, title, kind: 'jira' }]
}

function confluenceRefs(input: unknown, responses: unknown[], siteUrl: string | undefined): ExtractedRef[] {
  const base = siteBase(siteUrl)
  const title = firstString(responses, [['title']]) ?? firstString([input], [['title']]) ?? ''
  const webui = firstString(responses, [['_links', 'webui'], ['webui'], ['links', 'webui']])
  if (webui) {
    if (/^https?:\/\//.test(webui)) return [{ url: trimUrl(webui), title, kind: 'confluence' }]
    const linkBase = firstString(responses, [['_links', 'base']])
    const root = linkBase ?? (base ? `${base}/wiki` : undefined)
    if (root) return [{ url: `${root.replace(/\/+$/, '')}${webui}`, title, kind: 'confluence' }]
  }
  const pageId = firstString([input], [['pageId']]) ?? firstString(responses, [['id']])
  if (pageId && /^\d+$/.test(pageId) && base) {
    return [{ url: `${base}/wiki/pages/viewpage.action?pageId=${pageId}`, title, kind: 'confluence' }]
  }
  return []
}

function driveRefs(input: unknown, responses: unknown[]): ExtractedRef[] {
  const title = firstString(responses, [['title'], ['name']]) ?? ''
  const link = firstString(responses, [['webViewLink'], ['alternateLink'], ['url']])
  if (link && classifyUrl(link) === 'drive') return [{ url: trimUrl(link), title, kind: 'drive' }]
  const fileId = firstString([input], [['fileId'], ['file_id'], ['id']]) ?? firstString(responses, [['id']])
  if (fileId && /^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return [{ url: `https://drive.google.com/file/d/${fileId}/view`, title, kind: 'drive' }]
  }
  return []
}

function urlsIn(value: unknown): string[] {
  const found: string[] = []
  for (const text of texts(value)) {
    for (const match of text.matchAll(URL_PATTERN)) found.push(trimUrl(match[0]))
  }
  return found
}

export function extractRefs(use: ToolUse, siteUrl?: string): ExtractedRef[] {
  const name = typeof use.tool_name === 'string' ? shortToolName(use.tool_name) : ''
  const responses = parsed(use.tool_response)

  let refs: ExtractedRef[] = []
  if (JIRA_TOOLS.has(name)) refs = jiraRefs(use.tool_input, responses, siteUrl)
  else if (CONFLUENCE_TOOLS.has(name)) refs = confluenceRefs(use.tool_input, responses, siteUrl)
  else if (DRIVE_TOOLS.has(name)) refs = driveRefs(use.tool_input, responses)
  else return []

  if (refs.length === 0) {
    refs = urlsIn(use.tool_input).flatMap((url) => {
      const kind = classifyUrl(url)
      return kind ? [{ url, title: '', kind }] : []
    })
  }

  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (seen.has(ref.url)) return false
    seen.add(ref.url)
    return true
  })
}

export interface RefTargetCandidate {
  id: number
  projectId: number | null
}

export function chooseRefTarget(
  running: readonly RefTargetCandidate[],
  projectId: number | null,
): number | null {
  if (running.length === 1) return running[0]?.id ?? null
  if (projectId === null) return null
  const matching = running.filter((entry) => entry.projectId === projectId)
  return matching.length === 1 ? (matching[0]?.id ?? null) : null
}
