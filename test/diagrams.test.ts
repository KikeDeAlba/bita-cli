import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assetRelPath,
  assetsRelDir,
  assertAssetName,
  contentHash,
  extractDiagrams,
  orphanedRenders,
} from '../src/docs/diagrams.ts'
import { renderDiagrams, type RenderEnvironment } from '../src/docs/render.ts'

const PAGE = `# Infra

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`\`markdown
\`\`\`mermaid
graph TD
  X --> Y
\`\`\`
\`\`\`\`

\`\`\`drawio
arquitectura.drawio
\`\`\`

\`\`\`sql
SELECT 1
\`\`\`

\`\`\`mermaid
sequenceDiagram
  A->>B: hola
\`\`\`
`

function fakeEnv(calls: string[][], options: { drawio?: boolean } = {}): RenderEnvironment {
  return {
    drawioApp: '/fake/draw.io',
    chromeApp: '/fake/chrome',
    exists: (path) => {
      if (path === '/fake/draw.io') return options.drawio ?? true
      if (path === '/fake/chrome') return false
      return existsSync(path)
    },
    run: async (command, args) => {
      calls.push([command, ...args])
      const output = args[args.indexOf(command === 'npx' ? '-o' : '--output') + 1]
      if (output) writeFileSync(output, 'png')
    },
  }
}

test('extracts mermaid and drawio blocks in order, skipping ones nested in other fences', () => {
  const blocks = extractDiagrams(PAGE)
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.index, block.sourceFile, block.imageFile]),
    [
      ['mermaid', 1, `mermaid-1-${contentHash('flowchart LR\n  A --> B')}.mmd`, `mermaid-1-${contentHash('flowchart LR\n  A --> B')}.png`],
      ['drawio', 2, 'arquitectura.drawio', 'arquitectura.png'],
      ['mermaid', 3, `mermaid-2-${contentHash('sequenceDiagram\n  A->>B: hola')}.mmd`, `mermaid-2-${contentHash('sequenceDiagram\n  A->>B: hola')}.png`],
    ],
  )
  assert.equal(blocks[0]?.line, 3)
})

test('a drawio block without extension still points at a .drawio file', () => {
  assert.equal(extractDiagrams('```drawio\nred\n```\n')[0]?.sourceFile, 'red.drawio')
})

test('the hash ignores surrounding whitespace, so reformatting does not re-render', () => {
  assert.equal(contentHash('graph TD\n A-->B\n\n'), contentHash('  graph TD\n A-->B'))
})

test('assets live next to the page, and names cannot climb out', () => {
  assert.equal(assetsRelDir('dportenis/infra/aws.md'), 'dportenis/infra/aws.assets')
  assert.equal(assetRelPath('dportenis/aws.md', 'red.drawio'), 'dportenis/aws.assets/red.drawio')
  assert.throws(() => assertAssetName('../x.drawio'), /not a valid asset name/)
  assert.throws(() => assertAssetName('a/b.drawio'), /not a valid asset name/)
  assert.throws(() => assetsRelDir('x.txt'), /not a page path/)
})

test('only stale mermaid renders are orphans', () => {
  const blocks = extractDiagrams('```mermaid\ngraph TD\n  A-->B\n```\n')
  const keep = blocks[0]!
  assert.deepEqual(
    orphanedRenders(blocks, [keep.imageFile, keep.sourceFile, 'mermaid-1-deadbeef.png', 'arquitectura.png', 'notes.txt']),
    ['mermaid-1-deadbeef.png'],
  )
})

test('renders what changed, skips what is fresh, and cleans up old mermaid renders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-diagrams-'))
  writeFileSync(join(dir, 'arquitectura.drawio'), '<mxfile/>')
  writeFileSync(join(dir, 'mermaid-1-deadbeef.png'), 'old')
  const blocks = extractDiagrams(PAGE)
  const calls: string[][] = []

  const first = await renderDiagrams(blocks, dir, { env: fakeEnv(calls) })
  assert.deepEqual(first.map((result) => result.state), ['rendered', 'rendered', 'rendered'])
  assert.equal(calls.length, 3)
  assert.equal(calls[0]?.[0], 'npx')
  assert.ok(calls[0]?.includes('-s') && calls[0]?.includes('white'))
  assert.equal(calls[1]?.[0], '/fake/draw.io')
  assert.ok(calls[1]?.includes('--scale'))
  assert.equal(readFileSync(join(dir, blocks[0]!.sourceFile), 'utf8'), 'flowchart LR\n  A --> B\n')
  assert.equal(existsSync(join(dir, 'mermaid-1-deadbeef.png')), false)

  const second = await renderDiagrams(blocks, dir, { env: fakeEnv(calls) })
  assert.deepEqual(second.map((result) => result.state), ['fresh', 'fresh', 'fresh'])
  assert.equal(calls.length, 3)

  const later = new Date(Date.now() + 60_000)
  utimesSync(join(dir, 'arquitectura.drawio'), later, later)
  const third = await renderDiagrams(blocks, dir, { env: fakeEnv(calls) })
  assert.deepEqual(third.map((result) => result.state), ['fresh', 'rendered', 'fresh'])
})

test('a drawio block without its file is reported, and without draw.io Desktop it stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-diagrams-'))
  const blocks = extractDiagrams('```drawio\nred.drawio\n```\n')
  const missing = await renderDiagrams(blocks, dir, { env: fakeEnv([]) })
  assert.equal(missing[0]?.state, 'missing-source')

  writeFileSync(join(dir, 'red.drawio'), '<mxfile/>')
  await assert.rejects(renderDiagrams(blocks, dir, { env: fakeEnv([], { drawio: false }) }), /draw.io Desktop/)
})

test('a renderer failure is reported per diagram instead of aborting the page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-diagrams-'))
  const env = fakeEnv([])
  env.run = async () => {
    throw new Error('Parse error on line 2\nmore')
  }
  const results = await renderDiagrams(extractDiagrams('```mermaid\ngraph TD\n  A-->\n```\n'), dir, { env })
  assert.equal(results[0]?.state, 'failed')
  assert.match(results[0]?.error ?? '', /Parse error/)
})
