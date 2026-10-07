import { ConflictError } from '../errors.ts'
import type { AtlassianCredentials } from '../atlassian/sites.ts'
import type { Fetch } from '../atlassian/runtime.ts'
import { adfToMarkdown, type AdfDocument } from './adf.ts'

export interface JiraUser {
  accountId: string
  displayName: string
  emailAddress: string | null
}

export interface JiraIssueView {
  id: string
  key: string
  url: string
  summary: string
  status: string | null
  statusCategory: string | null
  issueType: string | null
  parentKey: string | null
  projectKey: string | null
  assignee: string | null
  description: string
  timeOriginalEstimateSeconds: number | null
  timeSpentSeconds: number | null
  created: string | null
  updated: string | null
  fields: Record<string, unknown>
}

export interface JiraTransition {
  id: string
  name: string
  to: { name: string | null; statusCategory: string | null }
}

export interface JiraIssueType {
  id: string
  name: string
  subtask: boolean
  hierarchyLevel: number | null
}

export interface JiraField {
  fieldId: string
  name: string
  required: boolean
  schema: unknown
  allowedValues: unknown[] | null
}

interface RawIssue {
  id: string
  key: string
  fields?: Record<string, unknown>
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const step of path) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[step]
  }
  return current ?? null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

export function jiraStarted(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) throw new ConflictError(`"${iso}" is not a date and time.`, 'JIRA_STARTED')
  return parsed.toISOString().replace('Z', '+0000')
}

export class JiraClient {
  readonly site: string
  private readonly authorization: string
  private readonly fetch: Fetch

  constructor(credentials: AtlassianCredentials, fetch: Fetch = globalThis.fetch) {
    this.site = credentials.siteUrl.replace(/\/+$/, '')
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`
    this.fetch = fetch
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: this.authorization, Accept: 'application/json' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await this.fetch(`${this.site}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      throw new ConflictError(
        `Jira refused the credentials (HTTP ${response.status}).`,
        'JIRA_AUTH',
        'Check the token with "bita atlassian site test <site>", or add it again with "bita atlassian site add".',
      )
    }
    if (!response.ok) {
      throw new ConflictError(`Jira answered HTTP ${response.status}: ${errorDetail(text)}`, 'JIRA_HTTP')
    }
    return text.length === 0 ? null : (JSON.parse(text) as unknown)
  }

  issueUrl(key: string): string {
    return `${this.site}/browse/${key}`
  }

  async myself(): Promise<JiraUser> {
    const body = await this.request('/rest/api/3/myself')
    return {
      accountId: asString(nested(body, 'accountId')) ?? '',
      displayName: asString(nested(body, 'displayName')) ?? '',
      emailAddress: asString(nested(body, 'emailAddress')),
    }
  }

  async projects(query?: string): Promise<{ id: string; key: string; name: string; type: string | null }[]> {
    const found: { id: string; key: string; name: string; type: string | null }[] = []
    let startAt = 0
    for (;;) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: '50' })
      if (query) params.set('query', query)
      const body = await this.request(`/rest/api/3/project/search?${params.toString()}`)
      const values = nested(body, 'values')
      const page = Array.isArray(values) ? values : []
      for (const raw of page) {
        found.push({
          id: asString(nested(raw, 'id')) ?? '',
          key: asString(nested(raw, 'key')) ?? '',
          name: asString(nested(raw, 'name')) ?? '',
          type: asString(nested(raw, 'projectTypeKey')),
        })
      }
      if (nested(body, 'isLast') !== false || page.length === 0) break
      startAt += page.length
    }
    return found
  }

  toView(raw: RawIssue): JiraIssueView {
    const fields = raw.fields ?? {}
    return {
      id: raw.id,
      key: raw.key,
      url: this.issueUrl(raw.key),
      summary: asString(fields['summary']) ?? '',
      status: asString(nested(fields, 'status', 'name')),
      statusCategory: asString(nested(fields, 'status', 'statusCategory', 'key')),
      issueType: asString(nested(fields, 'issuetype', 'name')),
      parentKey: asString(nested(fields, 'parent', 'key')),
      projectKey: asString(nested(fields, 'project', 'key')),
      assignee: asString(nested(fields, 'assignee', 'displayName')),
      description: adfToMarkdown(fields['description']),
      timeOriginalEstimateSeconds: asNumber(nested(fields, 'timetracking', 'originalEstimateSeconds')) ?? asNumber(fields['timeoriginalestimate']),
      timeSpentSeconds: asNumber(nested(fields, 'timetracking', 'timeSpentSeconds')) ?? asNumber(fields['timespent']),
      created: asString(fields['created']),
      updated: asString(fields['updated']),
      fields,
    }
  }

  async getIssue(key: string, fields?: readonly string[]): Promise<JiraIssueView> {
    const query = fields && fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(','))}` : ''
    const body = (await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}${query}`)) as RawIssue
    return this.toView(body)
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string; url: string }> {
    const body = await this.request('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) })
    const key = asString(nested(body, 'key')) ?? ''
    return { id: asString(nested(body, 'id')) ?? '', key, url: this.issueUrl(key) }
  }

  async editIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ fields }) })
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const body = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    const list = nested(body, 'transitions')
    return (Array.isArray(list) ? list : []).map((raw) => ({
      id: asString(nested(raw, 'id')) ?? '',
      name: asString(nested(raw, 'name')) ?? '',
      to: {
        name: asString(nested(raw, 'to', 'name')),
        statusCategory: asString(nested(raw, 'to', 'statusCategory', 'key')),
      },
    }))
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    })
  }

  async search(jql: string, limit: number, fields: readonly string[]): Promise<JiraIssueView[]> {
    const issues: JiraIssueView[] = []
    let nextPageToken: string | undefined
    while (issues.length < limit) {
      const body = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          maxResults: Math.min(100, limit - issues.length),
          fields,
          ...(nextPageToken !== undefined ? { nextPageToken } : {}),
        }),
      })
      const page = nested(body, 'issues')
      for (const raw of Array.isArray(page) ? page : []) issues.push(this.toView(raw as RawIssue))
      const token = asString(nested(body, 'nextPageToken'))
      if (token === null || !Array.isArray(page) || page.length === 0) break
      nextPageToken = token
    }
    return issues.slice(0, limit)
  }

  async issueTypes(projectKey: string): Promise<JiraIssueType[]> {
    const body = await this.request(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=200`)
    const list = nested(body, 'issueTypes') ?? nested(body, 'values')
    return (Array.isArray(list) ? list : []).map((raw) => ({
      id: asString(nested(raw, 'id')) ?? '',
      name: asString(nested(raw, 'name')) ?? '',
      subtask: nested(raw, 'subtask') === true,
      hierarchyLevel: asNumber(nested(raw, 'hierarchyLevel')),
    }))
  }

  async issueTypeFields(projectKey: string, issueTypeId: string): Promise<JiraField[]> {
    const body = await this.request(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`,
    )
    const list = nested(body, 'fields') ?? nested(body, 'values')
    return (Array.isArray(list) ? list : []).map((raw) => {
      const allowed = nested(raw, 'allowedValues')
      return {
        fieldId: asString(nested(raw, 'fieldId')) ?? asString(nested(raw, 'key')) ?? '',
        name: asString(nested(raw, 'name')) ?? '',
        required: nested(raw, 'required') === true,
        schema: nested(raw, 'schema'),
        allowedValues: Array.isArray(allowed) ? allowed : null,
      }
    })
  }

  async addWorklog(
    key: string,
    worklog: { started: string; timeSpentSeconds: number; comment?: AdfDocument | undefined },
  ): Promise<{ id: string; started: string; timeSpentSeconds: number }> {
    const body = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
      method: 'POST',
      body: JSON.stringify({
        started: jiraStarted(worklog.started),
        timeSpentSeconds: worklog.timeSpentSeconds,
        ...(worklog.comment ? { comment: worklog.comment } : {}),
      }),
    })
    return {
      id: asString(nested(body, 'id')) ?? '',
      started: asString(nested(body, 'started')) ?? jiraStarted(worklog.started),
      timeSpentSeconds: asNumber(nested(body, 'timeSpentSeconds')) ?? worklog.timeSpentSeconds,
    }
  }

  async addComment(key: string, comment: AdfDocument): Promise<{ id: string; created: string | null }> {
    const body = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: comment }),
    })
    return { id: asString(nested(body, 'id')) ?? '', created: asString(nested(body, 'created')) }
  }

  async linkIssues(type: string, from: string, to: string): Promise<void> {
    await this.request('/rest/api/3/issueLink', {
      method: 'POST',
      body: JSON.stringify({ type: { name: type }, inwardIssue: { key: from }, outwardIssue: { key: to } }),
    })
  }
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> }
    const messages = [...(parsed.errorMessages ?? []), ...Object.entries(parsed.errors ?? {}).map(([field, message]) => `${field}: ${message}`)]
    if (messages.length > 0) return messages.join('; ')
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 240)
  }
  return text.replace(/\s+/g, ' ').slice(0, 240)
}
