import { createHash } from 'node:crypto'
import { UsageError } from '../errors.ts'

export type DiagramKind = 'mermaid' | 'drawio'

export interface DiagramBlock {
  kind: DiagramKind
  index: number
  line: number
  source: string
  name: string
  sourceFile: string
  imageFile: string
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/

export function assetsRelDir(pageRelPath: string): string {
  if (!pageRelPath.endsWith('.md')) throw new UsageError(`"${pageRelPath}" is not a page path.`)
  return `${pageRelPath.slice(0, -3)}.assets`
}

export function assertAssetName(name: string): string {
  const trimmed = name.trim()
  if (!ASSET_NAME.test(trimmed) || trimmed.includes('..')) {
    throw new UsageError(
      `"${name}" is not a valid asset name: letters, digits, dots, dashes and underscores, no folders.`,
    )
  }
  return trimmed
}

export function assetRelPath(pageRelPath: string, name: string): string {
  return `${assetsRelDir(pageRelPath)}/${assertAssetName(name)}`
}

export function contentHash(source: string): string {
  return createHash('sha256').update(source.trim()).digest('hex').slice(0, 8)
}

function stem(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot <= 0 ? file : file.slice(0, dot)
}

export function extractDiagrams(markdown: string): DiagramBlock[] {
  const lines = markdown.split('\n')
  const blocks: DiagramBlock[] = []
  let open: { marker: string; lang: string; start: number; body: string[] } | null = null
  let mermaidCount = 0

  for (const [at, line] of lines.entries()) {
    const fence = FENCE.exec(line)
    if (open === null) {
      if (fence?.[1]) open = { marker: fence[1], lang: (fence[2] ?? '').toLowerCase(), start: at + 1, body: [] }
      continue
    }
    const closes =
      fence?.[1] !== undefined &&
      (fence[2] ?? '') === '' &&
      fence[1][0] === open.marker[0] &&
      fence[1].length >= open.marker.length
    if (!closes) {
      open.body.push(line)
      continue
    }

    const source = open.body.join('\n')
    if (open.lang === 'mermaid' && source.trim().length > 0) {
      mermaidCount += 1
      const name = `mermaid-${mermaidCount}-${contentHash(source)}`
      blocks.push({
        kind: 'mermaid',
        index: blocks.length + 1,
        line: open.start,
        source,
        name,
        sourceFile: `${name}.mmd`,
        imageFile: `${name}.png`,
      })
    }
    if (open.lang === 'drawio') {
      const file = source.trim().split('\n')[0]?.trim() ?? ''
      if (file.length > 0) {
        const sourceFile = assertAssetName(file.endsWith('.drawio') ? file : `${file}.drawio`)
        blocks.push({
          kind: 'drawio',
          index: blocks.length + 1,
          line: open.start,
          source: sourceFile,
          name: stem(sourceFile),
          sourceFile,
          imageFile: `${stem(sourceFile)}.png`,
        })
      }
    }
    open = null
  }

  return blocks
}

export function orphanedRenders(blocks: readonly DiagramBlock[], files: readonly string[]): string[] {
  const kept = new Set(blocks.flatMap((block) => [block.sourceFile, block.imageFile]))
  return files.filter((file) => /^mermaid-\d+-[0-9a-f]{8}\.(mmd|png)$/.test(file) && !kept.has(file))
}
