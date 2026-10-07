import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { Fetch } from '../src/atlassian/runtime.ts'
import { adfToMarkdown, markdownToAdf } from '../src/jira/adf.ts'
import { JiraClient, jiraStarted } from '../src/jira/client.ts'
import { parseFieldAssignments } from '../src/cli/commands/jira.ts'

const SITE = 'https://acme.atlassian.net'

interface Call {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

function fakeFetch(calls: Call[], respond: (call: Call) => { status?: number; body?: unknown }): Fetch {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      headers: init.headers as Record<string, string>,
    }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(body === undefined ? '' : JSON.stringify(body), { status })
  }) as Fetch
}

function client(calls: Call[], respond: (call: Call) => { status?: number; body?: unknown }): JiraClient {
  return new JiraClient({ siteUrl: SITE, email: 'me@acme.com', token: 't0k' }, fakeFetch(calls, respond))
}

test('markdown becomes ADF with headings, lists, code and marks', () => {
  const adf = markdownToAdf('## Criterios\n\n1. **Uno** con `code`\n2. [link](https://x.com)\n\n- [ ] tarea\n\n```sql\nSELECT 1\n```')
  assert.deepEqual(adf.content[0], { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Criterios' }] })
  assert.deepEqual(adf.content[1], {
    type: 'orderedList',
    attrs: { order: 1 },
    content: [
      {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Uno', marks: [{ type: 'strong' }] },
              { type: 'text', text: ' con ' },
              { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            ],
          },
        ],
      },
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }] }] }],
      },
    ],
  })
  assert.equal(adf.content[2]?.type, 'bulletList')
  assert.deepEqual(adf.content[3], { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT 1' }] })
  assert.equal(adfToMarkdown(adf), '## Criterios\n\n1. **Uno** con `code`\n2. [link](https://x.com)\n\n- [ ] tarea\n\n```sql\nSELECT 1\n```')
})

test('issues are created with basic auth and come back with their url', async () => {
  const calls: Call[] = []
  const jira = client(calls, () => ({ body: { id: '10001', key: 'DPP-7' } }))
  const created = await jira.createIssue({ project: { key: 'DPP' }, summary: 'x' })
  assert.deepEqual(created, { id: '10001', key: 'DPP-7', url: `${SITE}/browse/DPP-7` })
  assert.equal(calls[0]?.url, `${SITE}/rest/api/3/issue`)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.headers['Authorization'], `Basic ${Buffer.from('me@acme.com:t0k').toString('base64')}`)
  assert.deepEqual(calls[0]?.body, { fields: { project: { key: 'DPP' }, summary: 'x' } })
})

test('an issue is read into the useful fields', async () => {
  const jira = client([], () => ({
    body: {
      id: '1',
      key: 'DPP-1',
      fields: {
        summary: 'Cupones',
        status: { name: 'En curso', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Subtarea' },
        parent: { key: 'DPP-0' },
        project: { key: 'DPP' },
        description: markdownToAdf('Hola **mundo**'),
        timetracking: { originalEstimateSeconds: 3600, timeSpentSeconds: 1800 },
      },
    },
  }))
  const issue = await jira.getIssue('DPP-1')
  assert.equal(issue.status, 'En curso')
  assert.equal(issue.statusCategory, 'indeterminate')
  assert.equal(issue.parentKey, 'DPP-0')
  assert.equal(issue.description, 'Hola **mundo**')
  assert.equal(issue.timeOriginalEstimateSeconds, 3600)
  assert.equal(issue.url, `${SITE}/browse/DPP-1`)
})

test('worklogs carry Jira timestamps and links read from left to right', async () => {
  const calls: Call[] = []
  const jira = client(calls, (call) => (call.url.endsWith('/worklog') ? { body: { id: '55', timeSpentSeconds: 5400 } } : { status: 201 }))
  const worklog = await jira.addWorklog('DPP-1', { started: '2026-10-06T09:30:00-06:00', timeSpentSeconds: 5400, comment: markdownToAdf('hecho') })
  assert.equal(worklog.id, '55')
  assert.equal((calls[0]?.body as { started: string }).started, '2026-10-06T15:30:00.000+0000')
  assert.equal(jiraStarted('2026-10-06T15:30:00Z'), '2026-10-06T15:30:00.000+0000')

  await jira.linkIssues('Blocks', 'DPP-1', 'DPP-2')
  assert.deepEqual(calls[1]?.body, { type: { name: 'Blocks' }, inwardIssue: { key: 'DPP-1' }, outwardIssue: { key: 'DPP-2' } })
})

test('search follows the page token until the limit', async () => {
  const calls: Call[] = []
  const jira = client(calls, (call) => {
    const token = (call.body as { nextPageToken?: string }).nextPageToken
    return token === undefined
      ? { body: { issues: [{ id: '1', key: 'A-1', fields: { summary: 'a' } }], nextPageToken: 'n1' } }
      : { body: { issues: [{ id: '2', key: 'A-2', fields: { summary: 'b' } }, { id: '3', key: 'A-3', fields: {} }] } }
  })
  const issues = await jira.search('project = A', 2, ['summary'])
  assert.deepEqual(issues.map((issue) => issue.key), ['A-1', 'A-2'])
  assert.equal(calls[0]?.url, `${SITE}/rest/api/3/search/jql`)
  assert.equal((calls[1]?.body as { maxResults: number }).maxResults, 1)
})

test('a refused token and other failures are told apart', async () => {
  await assert.rejects(client([], () => ({ status: 401 })).myself(), /refused the credentials/)
  await assert.rejects(
    client([], () => ({ status: 400, body: { errorMessages: [], errors: { summary: 'required' } } })).createIssue({}),
    /HTTP 400: summary: required/,
  )
})

test('field assignments take JSON when they can', () => {
  assert.deepEqual(parseFieldAssignments(['timetracking={"originalEstimate":"2h"}', 'labels=["a"]', 'customfield_1=texto']), {
    timetracking: { originalEstimate: '2h' },
    labels: ['a'],
    customfield_1: 'texto',
  })
  assert.throws(() => parseFieldAssignments(['nada']), /field assignment/)
})
