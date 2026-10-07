import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { findProjectById, insertProject, setProjectAtlassian } from '../src/db/projects.ts'
import { insertPage, listPages, requirePage } from '../src/db/pages.ts'
import { findMapByPage, mapsOfProject } from '../src/db/confluence-map.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import { resolveDocPath } from '../src/docs/paths.ts'
import { ConfluenceClient } from '../src/confluence/client.ts'
import { demoteTitledHeadings, resolveConflict, syncProject, syncStatus } from '../src/confluence/sync.ts'
import { FakeConfluence } from './helpers/fake-confluence.ts'

const SITE = 'https://acme.atlassian.net'
const NOW = '2026-10-06T12:00:00.000Z'

async function setup() {
  const db = openMemoryDatabase()
  const docsRoot = mkdtempSync(join(tmpdir(), 'bita-sync-'))
  const ctx = { db, docsRoot, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const created = insertProject(db, { name: 'Apartados', createdAt: NOW })
  setProjectAtlassian(db, created.id, {
    site: SITE,
    via: 'cli',
    confluence: { ref: `${SITE}/wiki/spaces/K/pages/100/Apartados`, kind: 'page' },
    syncPull: true,
    syncPush: true,
  })

  const fake = new FakeConfluence(SITE)
  fake.add({ id: '100', title: 'Apartados', parentId: null, storage: '<p>root</p>' })
  fake.add({ id: '101', title: 'Arquitectura', parentId: '100', storage: '<h2>Estado</h2><p>uno</p>' })
  fake.add({ id: '102', title: 'WAF', parentId: '101', storage: '<h1>Reglas</h1><p>bloquea admin</p>' })

  const runbookId = insertPage(db, {
    projectId: created.id,
    parentId: null,
    slug: 'runbook',
    title: 'Runbook',
    relPath: 'apartados/runbook.md',
    depth: 0,
    source: 'cli',
    now: NOW,
  })
  await recordPageDoc(ctx, requirePage(db, runbookId), { body: '## Pasos\n\n- reiniciar' })

  const client = new ConfluenceClient({ siteUrl: SITE, email: 'me@acme.com', token: 't' }, fake.fetch)
  const project = () => findProjectById(db, created.id)!
  return { db, docsRoot, ctx, fake, client, project, runbookId }
}

function byTitle(db: ReturnType<typeof openMemoryDatabase>, title: string) {
  const page = listPages(db).find((candidate) => candidate.title === title)
  assert.ok(page, `page ${title}`)
  return page
}

test('a dry run reports what the first sync would do and writes nothing', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  const report = await syncProject(ctx, client, project(), SITE, { dryRun: true })

  assert.deepEqual(report, {
    project: 'Apartados',
    pulled: [],
    pushed: [],
    created: [
      { confluenceId: '101', title: 'Arquitectura', reason: 'from Confluence' },
      { confluenceId: '102', title: 'WAF', reason: 'from Confluence' },
      { pageId: runbookId, title: 'Runbook', reason: 'from bita' },
    ],
    conflicts: [],
    skipped: [],
  })
  assert.equal(fake.writes().length, 0)
  assert.equal(listPages(db).length, 1)
  assert.equal(project().lastSyncAt, null)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('the first sync mirrors both trees and maps every page', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })

  const arquitectura = byTitle(db, 'Arquitectura')
  const waf = byTitle(db, 'WAF')
  assert.equal(arquitectura.depth, 0)
  assert.equal(waf.parentId, arquitectura.id)
  assert.equal(waf.depth, 1)
  assert.equal(waf.relPath, 'apartados/arquitectura/waf.md')

  const wafFile = readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8')
  assert.match(wafFile, /## Reglas\n\nbloquea admin/)

  assert.equal(report.created.length, 3)
  const runbookRemote = findMapByPage(db, runbookId)
  assert.ok(runbookRemote)
  assert.equal(fake.pages.get(runbookRemote.confluenceId)?.parentId, '100')
  assert.match(fake.pages.get(runbookRemote.confluenceId)?.storage ?? '', /<li>reiniciar<\/li>/)
  assert.equal(mapsOfProject(db, project().id).length, 3)
  assert.equal(project().lastSyncAt, NOW)

  const again = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual([again.pulled, again.pushed, again.created, again.conflicts, again.skipped], [[], [], [], [], []])
  rmSync(docsRoot, { recursive: true, force: true })
})

test('one-sided changes travel, two-sided ones become conflicts that are never overwritten', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  const arquitectura = byTitle(db, 'Arquitectura')
  const waf = byTitle(db, 'WAF')

  fake.edit('101', '<h2>Estado</h2><p>dos</p>')
  const pulled = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(pulled.pulled, [{ pageId: arquitectura.id, confluenceId: '101', title: 'Arquitectura' }])
  assert.match(readFileSync(resolveDocPath(docsRoot, arquitectura.relPath), 'utf8'), /## Estado\n\ndos/)

  await recordPageDoc(ctx, requirePage(db, waf.id), { body: '## Reglas\n\nbloquea admin y QA' })
  const pushed = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(pushed.pushed, [{ pageId: waf.id, confluenceId: '102', title: 'WAF' }])
  assert.equal(fake.pages.get('102')?.version, 2)
  assert.match(fake.pages.get('102')?.storage ?? '', /bloquea admin y QA/)

  fake.edit('102', '<h2>Reglas</h2><p>remoto</p>')
  await recordPageDoc(ctx, requirePage(db, waf.id), { body: '## Reglas\n\nlocal' })
  const writesBefore = fake.writes().length
  const clash = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(clash.conflicts, [{ pageId: waf.id, confluenceId: '102', title: 'WAF', reason: 'changed on both sides' }])
  assert.equal(findMapByPage(db, waf.id)?.state, 'conflict')
  assert.equal(fake.writes().length, writesBefore)
  assert.match(readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8'), /## Reglas\n\nlocal/)

  const still = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.equal(still.conflicts[0]?.reason, 'unresolved conflict')

  const statuses = await syncStatus(ctx, client, project())
  assert.equal(statuses.find((status) => status.pageId === waf.id)?.direction, 'conflict')

  const resolved = await resolveConflict(ctx, client, waf.id, 'remote')
  assert.equal(resolved.reason, 'kept Confluence')
  assert.match(readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8'), /## Reglas\n\nremoto/)
  assert.equal(findMapByPage(db, waf.id)?.state, 'synced')

  const settled = await syncStatus(ctx, client, project())
  assert.deepEqual(
    settled.map((status) => [status.title, status.confluenceTitle, status.state, status.direction]),
    [
      ['Runbook', 'Runbook', 'synced', 'none'],
      ['Arquitectura', 'Arquitectura', 'synced', 'none'],
      ['WAF', 'WAF', 'synced', 'none'],
    ],
  )
  rmSync(docsRoot, { recursive: true, force: true })
})

test('keeping the local side pushes it over the remote version', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  const waf = byTitle(db, 'WAF')
  fake.edit('102', '<p>remoto</p>')
  await recordPageDoc(ctx, requirePage(db, waf.id), { body: 'mio' })
  await syncProject(ctx, client, project(), SITE, { dryRun: false })

  await resolveConflict(ctx, client, waf.id, 'local')
  assert.equal(fake.pages.get('102')?.storage, '<p>mio</p>')
  assert.equal(findMapByPage(db, waf.id)?.state, 'synced')
  assert.equal(findMapByPage(db, waf.id)?.confluenceVersion, fake.pages.get('102')?.version)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a direction that is off leaves the change where it is', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  setProjectAtlassian(db, project().id, { syncPull: false })
  fake.edit('101', '<p>nuevo</p>')
  fake.add({ id: '103', title: 'Nueva', parentId: '100', storage: '<p>x</p>' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(report.skipped.map((skip) => [skip.title, skip.reason]), [['Arquitectura', 'changed in Confluence, but pull is off']])
  assert.equal(listPages(db).some((page) => page.title === 'Nueva'), false)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a space syncs under its home page, and a twin page is matched instead of duplicated', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  setProjectAtlassian(db, project().id, { confluence: { ref: 'K', kind: 'space' } })
  fake.spaces.set('K', { id: 'S1', key: 'K', homepageId: '100' })
  fake.add({ id: '110', title: 'runbook', parentId: '100', storage: '<p>otra cosa</p>' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(report.conflicts, [{ pageId: runbookId, confluenceId: '110', title: 'Runbook', reason: 'exists on both sides' }])
  assert.equal(report.created.some((created) => created.title === 'Runbook'), false)
  assert.equal(findMapByPage(db, runbookId)?.confluenceId, '110')
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a remote document with a title heading is pushed down a level', () => {
  assert.equal(demoteTitledHeadings('# A\n\n## B\n\n```\n# not\n```'), '## A\n\n### B\n\n```\n# not\n```')
  assert.equal(demoteTitledHeadings('## A\n\ntext'), '## A\n\ntext')
})
