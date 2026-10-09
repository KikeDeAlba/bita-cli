import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCommandArgs } from '../src/cli/args.ts'
import { openMemoryDatabase } from '../src/db/open.ts'
import { parseDocument, renderDocument, upsertSection } from '../src/docs/markdown.ts'
import { normalizeDatabaseText, normalizeDocFiles } from '../src/docs/normalize.ts'

const composed = 'Ejecución en laboratorio'
const decomposed = composed.normalize('NFD')

test('a decomposed section argument replaces the composed heading instead of adding a second one', () => {
  const doc = parseDocument(`# Página\n\n## ${composed}\n\nViejo.\n\n## Otra\n\nTexto.\n`)
  const { doc: next, created } = upsertSection(doc, decomposed, 'Nuevo.')
  assert.equal(created, false)
  assert.deepEqual(next.sections.map((section) => section.heading), [composed, 'Otra'])
  assert.equal(next.sections[0]?.body, 'Nuevo.')
})

test('decomposed headings in a file are read back composed', () => {
  const doc = parseDocument(`# ${'Página'.normalize('NFD')}\n\n## ${decomposed}\n\nTexto.\n`)
  assert.equal(doc.title, 'Página')
  assert.equal(doc.sections[0]?.heading, composed)
  assert.ok(renderDocument(doc).includes(`## ${composed}`))
})

test('command arguments arrive composed', () => {
  const args = parseCommandArgs(['--section', decomposed, decomposed], { section: { type: 'string' } }, {})
  assert.equal(args.values.section, composed)
  assert.deepEqual(args.positionals, [composed])
})

test('normalize rewrites decomposed documents and database text, leaving paths alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bita-nfc-'))
  try {
    mkdirSync(join(root, 'p'))
    writeFileSync(join(root, 'p', 'a.md'), `# ${decomposed}\n`)
    writeFileSync(join(root, 'p', 'b.md'), `# ${composed}\n`)
    assert.deepEqual(await normalizeDocFiles(root, true), ['p/a.md'])
    assert.equal(readFileSync(join(root, 'p', 'a.md'), 'utf8'), `# ${decomposed}\n`)
    assert.deepEqual(await normalizeDocFiles(root, false), ['p/a.md'])
    assert.equal(readFileSync(join(root, 'p', 'a.md'), 'utf8'), `# ${composed}\n`)

    const db = openMemoryDatabase()
    db.exec(`CREATE TABLE sample (title TEXT, rel_path TEXT)`)
    db.prepare(`INSERT INTO sample (title, rel_path) VALUES (?, ?), (?, ?)`).run(decomposed, decomposed, composed, composed)
    assert.deepEqual(normalizeDatabaseText(db, true), [{ table: 'sample', column: 'title', rows: 1 }])
    assert.deepEqual(normalizeDatabaseText(db, false), [{ table: 'sample', column: 'title', rows: 1 }])
    const rows = db.prepare(`SELECT title, rel_path AS relPath FROM sample`).all() as { title: string; relPath: string }[]
    assert.deepEqual(rows.map((row) => row.title), [composed, composed])
    assert.equal(rows[0]?.relPath, decomposed)
    assert.deepEqual(normalizeDatabaseText(db, false), [])
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
