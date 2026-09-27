import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { insertProject } from '../src/db/projects.ts'
import { insertPage } from '../src/db/pages.ts'
import { linkEntryToPage } from '../src/db/page-links.ts'
import { addRefToEntry, addRefToPage, refsOfEntry, refsOfPage } from '../src/db/page-refs.ts'
import { applyMerge, planMerge } from '../src/cli/commands/merge.ts'
import { recordRefs } from '../src/cli/hooks/ref.ts'
import { chooseRefTarget, classifyUrl, extractRefs } from '../src/domain/refs.ts'

const NOW = '2026-09-27T20:00:00.000Z'
const SITE = 'https://gruposti.atlassian.net'

function seed(db: DatabaseSync, startedAt: string) {
  return insertEntry(db, {
    description: 'Estimación',
    projectId: 1,
    startedAt,
    stoppedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
    source: 'timer',
    now: NOW,
  })
}

function setup(): { db: DatabaseSync; pageId: number } {
  const db = openMemoryDatabase()
  insertProject(db, { id: 1, name: 'Apartados', createdAt: NOW })
  const pageId = insertPage(db, {
    projectId: 1,
    parentId: null,
    slug: 'estimacion',
    title: 'Estimación',
    relPath: 'apartados/estimacion.md',
    depth: 0,
    source: 'test',
    now: NOW,
  })
  return { db, pageId }
}

function mcp(text: unknown): unknown {
  return [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }]
}

test('a confluence page read through the connector yields its web url and title', () => {
  const refs = extractRefs(
    {
      tool_name: 'mcp__claude_ai_Atlassian_Rovo__getConfluencePage',
      tool_input: { cloudId: 'x', pageId: '988577796' },
      tool_response: mcp({ id: '988577796', title: 'Remediación Apartados', _links: { webui: '/spaces/VB/pages/988577796/Remediacion' } }),
    },
    SITE,
  )
  assert.deepEqual(refs, [
    { url: `${SITE}/wiki/spaces/VB/pages/988577796/Remediacion`, title: 'Remediación Apartados', kind: 'confluence' },
  ])
})

test('a confluence page without webui falls back to its id', () => {
  const refs = extractRefs(
    { tool_name: 'mcp__x__updateConfluencePage', tool_input: { pageId: '42', title: 'Hub' }, tool_response: 'ok' },
    SITE,
  )
  assert.deepEqual(refs, [{ url: `${SITE}/wiki/pages/viewpage.action?pageId=42`, title: 'Hub', kind: 'confluence' }])
})

test('a created jira issue is recorded by its key under the site', () => {
  const refs = extractRefs(
    {
      tool_name: 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue',
      tool_input: { projectKey: 'VBAA', summary: 'Seguridad' },
      tool_response: mcp({ key: 'VBAA-700', id: '1' }),
    },
    SITE,
  )
  assert.deepEqual(refs, [{ url: `${SITE}/browse/VBAA-700`, title: 'Seguridad', kind: 'jira' }])
})

test('a jira issue read takes the summary from its fields', () => {
  const refs = extractRefs(
    {
      tool_name: 'mcp__a__getJiraIssue',
      tool_input: { issueIdOrKey: 'IADP-250' },
      tool_response: mcp({ key: 'IADP-250', fields: { summary: 'Opciones serverless' } }),
    },
    SITE,
  )
  assert.deepEqual(refs, [{ url: `${SITE}/browse/IADP-250`, title: 'Opciones serverless', kind: 'jira' }])
})

test('a drive file yields its web view link', () => {
  const refs = extractRefs({
    tool_name: 'mcp__claude_ai_Google_Drive__get_file_metadata',
    tool_input: { fileId: '1AbCdEfGhIjKlMnOp' },
    tool_response: mcp({ name: 'Estimación Q4', webViewLink: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit' }),
  })
  assert.deepEqual(refs, [
    { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit', title: 'Estimación Q4', kind: 'drive' },
  ])
})

test('searches and unknown tools record nothing', () => {
  assert.deepEqual(
    extractRefs({ tool_name: 'mcp__a__searchJiraIssuesUsingJql', tool_response: mcp(`${SITE}/browse/X-1`) }, SITE),
    [],
  )
  assert.deepEqual(extractRefs({ tool_name: 'Bash', tool_input: { command: 'curl https://x.io' } }, SITE), [])
  assert.deepEqual(extractRefs({ tool_name: 'mcp__a__getJiraIssue', tool_input: {} }), [])
})

test('urls are classified by host and path', () => {
  assert.equal(classifyUrl(`${SITE}/wiki/spaces/X`), 'confluence')
  assert.equal(classifyUrl(`${SITE}/browse/X-1`), 'jira')
  assert.equal(classifyUrl('https://drive.google.com/file/d/abc'), 'drive')
  assert.equal(classifyUrl('https://example.com'), null)
})

test('the ref goes to the only timer, or to the only one of the project, or nowhere', () => {
  assert.equal(chooseRefTarget([{ id: 5, projectId: null }], null), 5)
  assert.equal(chooseRefTarget([{ id: 5, projectId: 1 }, { id: 6, projectId: 2 }], 2), 6)
  assert.equal(chooseRefTarget([{ id: 5, projectId: 1 }, { id: 6, projectId: 2 }], null), null)
  assert.equal(chooseRefTarget([{ id: 5, projectId: 1 }, { id: 6, projectId: 1 }], 1), null)
  assert.equal(chooseRefTarget([], 1), null)
})

test('a ref seen before the entry has a page waits on the entry and moves with it', () => {
  const { db, pageId } = setup()
  const entry = seed(db, '2026-09-27T15:00:00.000Z')

  assert.equal(recordRefs(db, entry.id, [{ url: `${SITE}/browse/VBAA-1`, title: 'A', kind: 'jira' }], NOW), 'entry')
  assert.equal(refsOfEntry(db, entry.id).length, 1)

  linkEntryToPage(db, pageId, entry.id, '', NOW)
  assert.deepEqual(refsOfPage(db, pageId).map((ref) => ref.url), [`${SITE}/browse/VBAA-1`])
  assert.equal(refsOfEntry(db, entry.id).length, 0)

  assert.equal(recordRefs(db, entry.id, [{ url: `${SITE}/wiki/x`, title: '', kind: 'confluence' }], NOW), 'page')
  assert.equal(refsOfPage(db, pageId).length, 2)
  db.close()
})

test('the same url is kept once, and a manual kind or title survives the hook', () => {
  const { db, pageId } = setup()
  addRefToPage(db, pageId, { url: 'https://x.io/a', title: 'Hoja de estimación', kind: 'link', source: 'manual', now: NOW })
  addRefToPage(db, pageId, { url: 'https://x.io/a', title: '', kind: 'drive', source: 'hook', now: '2026-09-28T00:00:00.000Z' })

  const [only, ...rest] = refsOfPage(db, pageId)
  assert.equal(rest.length, 0)
  assert.equal(only?.title, 'Hoja de estimación')
  assert.equal(only?.kind, 'link')
  assert.equal(only?.source, 'manual')
  assert.equal(only?.lastSeenAt, '2026-09-28T00:00:00.000Z')
  db.close()
})

test('merging carries the blocks refs to the survivor', () => {
  const { db, pageId } = setup()
  const a = seed(db, '2026-09-27T15:00:00.000Z')
  const b = seed(db, '2026-09-27T16:00:00.000Z')
  addRefToEntry(db, b.id, { url: `${SITE}/browse/VBAA-2`, kind: 'jira', source: 'hook', now: NOW })
  linkEntryToPage(db, pageId, a.id, '', NOW)

  const ctx = { db, timezone: 'America/Mazatlan', now: new Date(NOW) }
  applyMerge(ctx, planMerge(ctx, { ids: [a.id, b.id] }))

  assert.deepEqual(refsOfPage(db, pageId).map((ref) => ref.url), [`${SITE}/browse/VBAA-2`])
  assert.equal(refsOfEntry(db, b.id).length, 0)
  db.close()
})
