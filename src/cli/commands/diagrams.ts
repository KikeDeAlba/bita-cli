import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { requirePage, type DocPageRow } from '../../db/pages.ts'
import { assetsRelDir, extractDiagrams, type DiagramBlock } from '../../docs/diagrams.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { isFresh, renderDiagrams, type RenderEnvironment, type RenderResult } from '../../docs/render.ts'
import { readRaw } from '../../docs/store.ts'

const ACTIONS = new Set(['ls', 'render'])

const OPTIONS = {
  force: { type: 'boolean' as const, default: false },
}

export interface PageDiagrams {
  page: DocPageRow
  assetsDir: string
  assetsRelDir: string
  blocks: DiagramBlock[]
}

export async function loadPageDiagrams(ctx: LocalContext, pageId: number): Promise<PageDiagrams> {
  const page = requirePage(ctx.db, pageId)
  const raw = await readRaw(resolveDocPath(ctx.docsRoot, page.relPath))
  if (raw === null) throw new UsageError(`Page #${page.id} has no document on disk yet.`)
  const relDir = assetsRelDir(page.relPath)
  return {
    page,
    assetsDir: resolveDocPath(ctx.docsRoot, relDir),
    assetsRelDir: relDir,
    blocks: extractDiagrams(raw),
  }
}

export async function renderPageDiagrams(
  ctx: LocalContext,
  pageId: number,
  options: { force?: boolean; env?: RenderEnvironment } = {},
): Promise<{ diagrams: PageDiagrams; results: RenderResult[] }> {
  const diagrams = await loadPageDiagrams(ctx, pageId)
  const results = await renderDiagrams(diagrams.blocks, diagrams.assetsDir, options)
  return { diagrams, results }
}

function readPageId(raw: string | undefined): number {
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0) {
    throw new UsageError('Usage: bita docs diagrams <ls|render> <pageId> [--force]')
  }
  return id
}

function describe(block: DiagramBlock): string {
  return block.kind === 'mermaid' ? `mermaid #${block.index} (line ${block.line})` : `drawio ${block.sourceFile}`
}

export async function runDiagrams(argv: string[]): Promise<number> {
  const action = argv[0] ?? 'ls'
  if (!ACTIONS.has(action)) throw new UsageError('Usage: bita docs diagrams <ls|render> <pageId> [--force]')

  const args = parseCommandArgs(argv.slice(1), OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const pageId = readPageId(args.positionals[0])
  const ctx = createLocalContext(args)

  try {
    if (action === 'ls') {
      const diagrams = await loadPageDiagrams(ctx, pageId)
      const rows = await Promise.all(
        diagrams.blocks.map(async (block) => ({
          index: block.index,
          kind: block.kind,
          name: block.name,
          line: block.line,
          sourcePath: join(diagrams.assetsDir, block.sourceFile),
          imagePath: join(diagrams.assetsDir, block.imageFile),
          imageRelPath: `${diagrams.assetsRelDir}/${block.imageFile}`,
          sourceExists: block.kind === 'mermaid' || existsSync(join(diagrams.assetsDir, block.sourceFile)),
          fresh: await isFresh(block, diagrams.assetsDir),
        })),
      )
      if (json) {
        writeJson(
          successEnvelope('docs diagrams ls', rows, { pageId, assetsDir: diagrams.assetsDir, assetsRelDir: diagrams.assetsRelDir }),
        )
        return 0
      }
      if (rows.length === 0) {
        writeOut(`#${pageId} ${diagrams.page.title} has no diagrams.`)
        return 0
      }
      for (const [at, row] of rows.entries()) {
        const block = diagrams.blocks[at]!
        const state = !row.sourceExists ? 'no source' : row.fresh ? 'rendered' : 'not rendered'
        writeOut(`${describe(block).padEnd(40)} ${state}`)
      }
      return 0
    }

    const { diagrams, results } = await renderPageDiagrams(ctx, pageId, { force: readBoolean(args, 'force') })
    if (json) {
      writeJson(
        successEnvelope('docs diagrams render', results, {
          pageId,
          assetsDir: diagrams.assetsDir,
          assetsRelDir: diagrams.assetsRelDir,
          failed: results.filter((result) => result.state === 'failed' || result.state === 'missing-source').length,
        }),
      )
      return results.some((result) => result.state === 'failed') ? 1 : 0
    }
    if (results.length === 0) writeOut(`#${pageId} ${diagrams.page.title} has no diagrams.`)
    for (const result of results) {
      const line = `${result.kind} ${result.name}: ${result.state}`
      writeOut(result.error ? `${line} (${result.error})` : line)
      if (result.state === 'rendered' || result.state === 'fresh') writeOut(`  ${result.imagePath}`)
    }
    return results.some((result) => result.state === 'failed') ? 1 : 0
  } finally {
    ctx.db.close()
  }
}
