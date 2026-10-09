import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Fetch } from '../src/atlassian/runtime.ts'
import { JiraClient } from '../src/jira/client.ts'

const SITE = 'https://acme.atlassian.net'

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(calls: Call[], respond: (call: Call) => { status?: number; body?: unknown }): Fetch {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(url), init }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }) as Fetch
}

function client(calls: Call[], respond: (call: Call) => { status?: number; body?: unknown }): JiraClient {
  return new JiraClient({ siteUrl: SITE, email: 'me@acme.com', token: 't0k' }, fakeFetch(calls, respond))
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>
}

test('a file is attached with a multipart POST, the no-check header and no JSON content type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-jira-attach-'))
  try {
    const file = join(dir, 'minuta-2026-10-08-sap.pdf')
    writeFileSync(file, '%PDF-1.4\n%fake\n')
    const calls: Call[] = []
    const jira = client(calls, () => ({
      body: [{ id: '10500', filename: 'minuta-2026-10-08-sap.pdf', mimeType: 'application/pdf', size: 15, content: `${SITE}/rest/api/3/attachment/content/10500` }],
    }))
    const attached = await jira.attach('PP-20615', file)

    assert.equal(calls[0]?.url, `${SITE}/rest/api/3/issue/PP-20615/attachments`)
    assert.equal(calls[0]?.init.method, 'POST')
    const headers = headersOf(calls[0])
    assert.equal(headers['X-Atlassian-Token'], 'no-check')
    assert.equal(headers['Content-Type'], undefined)
    assert.equal(headers['Authorization'], `Basic ${Buffer.from('me@acme.com:t0k').toString('base64')}`)
    const form = calls[0]?.init.body as FormData
    assert.ok(form instanceof FormData)
    const part = form.get('file') as File
    assert.equal(part.name, 'minuta-2026-10-08-sap.pdf')
    assert.equal(part.type, 'application/pdf')
    assert.equal(await part.text(), '%PDF-1.4\n%fake\n')
    assert.deepEqual(attached, [
      { id: '10500', filename: 'minuta-2026-10-08-sap.pdf', mimeType: 'application/pdf', size: 15, url: `${SITE}/rest/api/3/attachment/content/10500` },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JSON bodies still carry the JSON content type', async () => {
  const calls: Call[] = []
  await client(calls, () => ({ body: { id: '1', key: 'PP-1' } })).createIssue({ summary: 'x' })
  assert.equal(headersOf(calls[0])['Content-Type'], 'application/json')
})

test('comments are listed with author, date and the body as markdown, across pages', async () => {
  const calls: Call[] = []
  const comment = (id: string, text: string) => ({
    id,
    author: { displayName: 'Enrique', accountId: 'acc-1' },
    created: '2026-10-08T12:00:00.000-0600',
    updated: '2026-10-08T12:00:00.000-0600',
    body: { version: 1, type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] }] },
  })
  const jira = client(calls, (call) =>
    call.url.includes('startAt=0')
      ? { body: { startAt: 0, total: 2, comments: [comment('100', 'Resultado')] } }
      : { body: { startAt: 1, total: 2, comments: [comment('101', 'Verificación')] } },
  )
  const comments = await jira.comments('PP-20615')

  assert.equal(calls.length, 2)
  assert.ok(calls[0]?.url.startsWith(`${SITE}/rest/api/3/issue/PP-20615/comment?`))
  assert.ok(calls[1]?.url.includes('startAt=1'))
  assert.deepEqual(comments[0], {
    id: '100',
    author: 'Enrique',
    authorAccountId: 'acc-1',
    created: '2026-10-08T12:00:00.000-0600',
    updated: '2026-10-08T12:00:00.000-0600',
    body: '## Resultado',
  })
  assert.equal(comments[1]?.body, '## Verificación')
})

test('a comment is deleted with DELETE on its own url', async () => {
  const calls: Call[] = []
  await client(calls, () => ({ status: 204 })).deleteComment('PP-20615', '100')
  assert.equal(calls[0]?.url, `${SITE}/rest/api/3/issue/PP-20615/comment/100`)
  assert.equal(calls[0]?.init.method, 'DELETE')
  assert.equal(headersOf(calls[0])['Content-Type'], undefined)
})

test('a refused attachment surfaces the Jira error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-jira-attach-'))
  try {
    const file = join(dir, 'a.pdf')
    writeFileSync(file, 'x')
    const jira = client([], () => ({ status: 413, body: { errorMessages: ['Attachment too large'] } }))
    await assert.rejects(jira.attach('PP-1', file), /HTTP 413: Attachment too large/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
