import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertEntry } from '../src/db/entries.ts'
import { insertProject } from '../src/db/projects.ts'
import { insertPage, requirePage } from '../src/db/pages.ts'
import { linkEntryToPage, meetingsOfPage } from '../src/db/page-links.ts'
import { upsertDoc } from '../src/db/docs.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import { searchPages } from '../src/docs/page-search.ts'

const NOW = '2026-10-06T12:00:00.000Z'

function write(root: string, relPath: string, contents: string): void {
  const path = join(root, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

async function seed() {
  const db = openMemoryDatabase()
  const root = mkdtempSync(join(tmpdir(), 'bita-page-search-'))
  const ctx = { db, docsRoot: root, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const project = insertProject(db, { name: 'Apartados', createdAt: NOW })
  const other = insertProject(db, { name: 'Otro', createdAt: NOW })

  const page = (title: string, slug: string, parentId: number | null, projectId: number, depth: number) =>
    insertPage(db, { projectId, parentId, slug, title, relPath: `${slug}.md`, depth, source: 'cli', now: NOW })

  const infra = page('Infraestructura', 'infra', null, project.id, 0)
  const waf = page('Reglas del WAF', 'waf', infra, project.id, 1)
  const quiet = page('Sin coincidencias', 'quiet', null, project.id, 0)
  const elsewhere = page('WAF ajeno', 'ajeno', null, other.id, 0)

  await recordPageDoc(ctx, requirePage(db, waf), { body: '## Estado\n\nEl WAF bloquea las IPs de admin.\n\nOtra regla del waf.' })
  await recordPageDoc(ctx, requirePage(db, infra), { body: '## Resumen\n\nRed y balanceadores.' })
  await recordPageDoc(ctx, requirePage(db, quiet), { body: 'Nada que ver.' })
  await recordPageDoc(ctx, requirePage(db, elsewhere), { body: 'waf de otro proyecto' })

  const entry = (description: string, start: string, mergedInto?: number) => {
    const created = insertEntry(db, {
      description,
      projectId: project.id,
      startedAt: start,
      stoppedAt: new Date(Date.parse(start) + 3_600_000).toISOString(),
      source: 'timer',
      kind: 'remote-meeting',
      now: NOW,
    })
    if (mergedInto !== undefined) db.prepare('UPDATE entries SET merged_into = ? WHERE id = ?').run(mergedInto, created.id)
    return created
  }
  const note = (entryId: number, relPath: string, body: string) => {
    write(root, relPath, body)
    upsertDoc(db, {
      entryId,
      relPath,
      title: 'note',
      titleSlug: 'note',
      source: 'stop',
      sectionCount: 1,
      byteSize: Buffer.byteLength(body),
      checksum: 'sha256:x',
      now: NOW,
    })
  }

  const survivor = entry('ajustar waf', '2026-10-01T15:00:00.000Z')
  const segment = entry('segmento', '2026-10-02T15:00:00.000Z', survivor.id)
  note(survivor.id, 'notes/a.md', '## Qué se hizo\n\nSe abrió el WAF a la oficina.\n')
  note(segment.id, 'notes/b.md', '## Qué se hizo\n\nWAF otra vez, y otra vez el waf.\n')
  linkEntryToPage(db, waf, survivor.id, '', NOW)
  linkEntryToPage(db, quiet, survivor.id, '', NOW)

  return { db, root, project, infra, waf, quiet, survivor, segment }
}

test('page search aggregates the page and the notes of its entries, merged ones included', async () => {
  const { db, root, project, infra, waf, quiet, survivor, segment } = await seed()
  const result = await searchPages(db, root, 'waf', { projectId: project.id })

  assert.deepEqual(
    result.hits.map((hit) => [hit.pageId, hit.matchCount, hit.sources]),
    [
      [waf, 6, { page: 3, entries: 3 }],
      [quiet, 3, { page: 0, entries: 3 }],
    ],
  )
  const top = result.hits[0]!
  assert.equal(top.title, 'Reglas del WAF')
  assert.equal(top.projectName, 'Apartados')
  assert.equal(top.projectSlug, 'apartados')
  assert.deepEqual(top.ancestors, [{ pageId: infra, title: 'Infraestructura' }])
  assert.equal(top.matches[0]?.source, 'page')
  assert.equal(top.matches[0]?.section, null)
  assert.equal(top.matches[1]?.section, 'Estado')
  assert.equal(top.matches[1]?.match, 'WAF')
  assert.equal('entryId' in top.matches[1]!, false)
  const entryIds = new Set(top.matches.filter((match) => match.source === 'entry').map((match) => match.entryId))
  assert.deepEqual([...entryIds].sort(), [survivor.id, segment.id].sort())

  const everywhere = await searchPages(db, root, 'waf')
  assert.equal(everywhere.hits.length, 3)

  assert.deepEqual(
    meetingsOfPage(db, waf).map((meeting) => meeting.entryId),
    [survivor.id, segment.id],
  )
  db.close()
  rmSync(root, { recursive: true, force: true })
})
