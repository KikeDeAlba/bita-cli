import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertProject } from '../src/db/projects.ts'
import { insertPage, requirePage } from '../src/db/pages.ts'
import {
  backlogTallyOfPage,
  insertBacklogItem,
  listBacklogItems,
  setBacklogStatus,
} from '../src/db/backlog.ts'
import { backlogKindOf, splitBacklog } from '../src/docs/backlog-extract.ts'
import { parseDocument } from '../src/docs/markdown.ts'
import { applyExtraction, planExtraction } from '../src/cli/commands/backlog.ts'
import { pageWarnings } from '../src/cli/commands/docs-page.ts'
import type { LocalContext } from '../src/cli/local-context.ts'

const NOW = '2026-09-27T20:00:00.000Z'

const PAGE = `---
bita: 1
pageId: 1
title: Auth
---
# Auth

El login local ya no existe.

## Cómo funciona

Entra por Entra ID.

## Pendiente

- Rotar el **secreto** de dev
  antes del viernes.
- [x] Cargar MS_CLIENT_ID

## Hallazgos

El SDK devuelve 200 con cuerpo vacío cuando el token expiró. Eso tapaba el fallo.

## Verificación

\`pnpm test\`
`

function context(): LocalContext & { root: string } {
  const db = openMemoryDatabase()
  const root = mkdtempSync(join(tmpdir(), 'bita-backlog-'))
  insertProject(db, { id: 1, name: 'Apartados', createdAt: NOW })
  return { db, timezone: 'America/Mazatlan', beginningOfWeek: 1, now: new Date(NOW), databasePath: ':memory:', docsRoot: root, root }
}

function page(ctx: LocalContext, body: string): number {
  const id = insertPage(ctx.db, {
    projectId: 1,
    parentId: null,
    slug: 'auth',
    title: 'Auth',
    relPath: 'apartados/auth.md',
    depth: 0,
    source: 'test',
    now: NOW,
  })
  const path = join(ctx.docsRoot, 'apartados/auth.md')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return id
}

test('headings are recognised whatever their accents or plural', () => {
  assert.equal(backlogKindOf('Pendiente'), 'pending')
  assert.equal(backlogKindOf('Pendientes'), 'pending')
  assert.equal(backlogKindOf('Próximos pasos'), 'pending')
  assert.equal(backlogKindOf('Limitaciones pendientes'), 'pending')
  assert.equal(backlogKindOf('Hallazgos'), 'finding')
  assert.equal(backlogKindOf('Hallazgos del despliegue'), 'finding')
  assert.equal(backlogKindOf('Cómo funciona'), null)
  assert.equal(backlogKindOf('Pendientemente'), null)
})

test('bullets become one item each, prose becomes one item', () => {
  const split = splitBacklog(parseDocument(PAGE))
  assert.deepEqual(split.headings, ['Pendiente', 'Hallazgos'])
  assert.deepEqual(
    split.items.map((item) => [item.kind, item.title, item.body, item.done]),
    [
      ['pending', 'Rotar el secreto de dev antes del viernes.', '', false],
      ['pending', 'Cargar MS_CLIENT_ID', '', true],
      [
        'finding',
        'El SDK devuelve 200 con cuerpo vacío cuando el token expiró.',
        'El SDK devuelve 200 con cuerpo vacío cuando el token expiró. Eso tapaba el fallo.',
        false,
      ],
    ],
  )
})

test('extracting moves the items into the backlog and strips the sections', async () => {
  const ctx = context()
  const id = page(ctx, PAGE)

  const plans = await planExtraction(ctx, [requirePage(ctx.db, id)])
  assert.equal(plans.length, 1)
  await applyExtraction(ctx, plans[0]!)

  const items = listBacklogItems(ctx.db, { status: 'all' })
  assert.equal(items.length, 3)
  assert.equal(items.every((item) => item.pageId === id && item.projectId === 1 && item.source === 'extracted'), true)
  assert.deepEqual(backlogTallyOfPage(ctx.db, id), { open: 2, resolved: 1 })

  const written = readFileSync(join(ctx.root, 'apartados/auth.md'), 'utf8')
  assert.equal(written.includes('## Pendiente'), false)
  assert.equal(written.includes('## Hallazgos'), false)
  assert.equal(written.includes('## Cómo funciona'), true)
  assert.equal(written.includes('## Verificación'), true)

  assert.deepEqual(await planExtraction(ctx, [requirePage(ctx.db, id)]), [])
  ctx.db.close()
})

test('resolving stamps the time and reopening clears it', () => {
  const ctx = context()
  const item = insertBacklogItem(ctx.db, { projectId: 1, kind: 'pending', title: 'Rotar secreto', now: NOW })

  setBacklogStatus(ctx.db, item.id, 'resolved', 'Rotado en dev y test.', NOW)
  let [row] = listBacklogItems(ctx.db, { status: 'resolved' })
  assert.equal(row?.resolvedAt, NOW)
  assert.equal(row?.resolution, 'Rotado en dev y test.')

  setBacklogStatus(ctx.db, item.id, 'open', undefined, NOW)
  ;[row] = listBacklogItems(ctx.db)
  assert.equal(row?.resolvedAt, null)
  assert.equal(row?.resolution, 'Rotado en dev y test.')
  ctx.db.close()
})

test('the listing filters by kind and status, open by default', () => {
  const ctx = context()
  insertBacklogItem(ctx.db, { projectId: 1, kind: 'pending', title: 'A', now: NOW })
  const b = insertBacklogItem(ctx.db, { projectId: 1, kind: 'finding', title: 'B', now: NOW })
  setBacklogStatus(ctx.db, b.id, 'resolved', undefined, NOW)

  assert.deepEqual(listBacklogItems(ctx.db).map((item) => item.title), ['A'])
  assert.deepEqual(listBacklogItems(ctx.db, { kind: 'finding', status: 'all' }).map((item) => item.title), ['B'])
  ctx.db.close()
})

test('writing a page warns about backlog sections and about size', () => {
  const warnings = pageWarnings(parseDocument(PAGE), 400).map((warning) => warning.code)
  assert.deepEqual(warnings, ['BACKLOG_SECTION_IN_PAGE'])

  const long = ['# X', ...Array.from({ length: 8 }, (_, index) => `## S${index}\n\nTexto.`)].join('\n\n')
  assert.deepEqual(pageWarnings(parseDocument(long), 400).map((warning) => warning.code), ['PAGE_SHOULD_SPLIT'])
})
