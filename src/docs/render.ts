import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ConflictError } from '../errors.ts'
import { orphanedRenders, type DiagramBlock } from './diagrams.ts'

export const MERMAID_CLI = '@mermaid-js/mermaid-cli@11'
export const DRAWIO_APP = '/Applications/draw.io.app/Contents/MacOS/draw.io'
export const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RENDER_TIMEOUT_MS = 180_000

export type Runner = (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<void>

export const execRunner: Runner = async (command, args, env) => {
  await promisify(execFile)(command, [...args], {
    timeout: RENDER_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
}

export interface RenderEnvironment {
  run: Runner
  exists: (path: string) => boolean
  drawioApp: string
  chromeApp: string
}

export const defaultEnvironment: RenderEnvironment = {
  run: execRunner,
  exists: existsSync,
  drawioApp: DRAWIO_APP,
  chromeApp: CHROME_APP,
}

export type RenderState = 'rendered' | 'fresh' | 'missing-source' | 'failed'

export interface RenderResult {
  index: number
  kind: DiagramBlock['kind']
  name: string
  state: RenderState
  sourcePath: string
  imagePath: string
  error?: string
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

export async function isFresh(block: DiagramBlock, assetsDir: string): Promise<boolean> {
  const image = await mtime(join(assetsDir, block.imageFile))
  if (image === null) return false
  if (block.kind === 'mermaid') return true
  const source = await mtime(join(assetsDir, block.sourceFile))
  return source !== null && source <= image
}

async function renderMermaid(block: DiagramBlock, assetsDir: string, env: RenderEnvironment): Promise<void> {
  const sourcePath = join(assetsDir, block.sourceFile)
  await writeFile(sourcePath, `${block.source.trim()}\n`, { mode: 0o600 })
  await runMermaidCli(sourcePath, join(assetsDir, block.imageFile), env)
}

export async function renderMermaidSvg(
  source: string,
  workDir: string,
  name: string,
  env: RenderEnvironment = defaultEnvironment,
): Promise<string> {
  const sourcePath = join(workDir, `${name}.mmd`)
  const svgPath = join(workDir, `${name}.svg`)
  await writeFile(sourcePath, `${source.trim()}\n`, { mode: 0o600 })
  await runMermaidCli(sourcePath, svgPath, env, ['-I', name])
  return readFile(svgPath, 'utf8')
}

async function runMermaidCli(sourcePath: string, outputPath: string, env: RenderEnvironment, extraArgs: readonly string[] = []): Promise<void> {
  const args = ['-y', MERMAID_CLI, '-i', sourcePath, '-o', outputPath, '-s', '2', '-b', 'white', '-t', 'default', '-q', ...extraArgs]
  const extra: NodeJS.ProcessEnv = {}
  if (env.exists(env.chromeApp)) {
    const config = join(tmpdir(), 'bita-mermaid-puppeteer.json')
    await writeFile(config, JSON.stringify({ executablePath: env.chromeApp, headless: 'shell' }))
    args.push('-p', config)
    extra['PUPPETEER_SKIP_DOWNLOAD'] = '1'
  }
  await env.run('npx', args, extra)
}

async function renderDrawio(block: DiagramBlock, assetsDir: string, env: RenderEnvironment): Promise<void> {
  if (!env.exists(env.drawioApp)) {
    throw new ConflictError(
      'draw.io Desktop is not installed, and it is what exports .drawio files to PNG.',
      'DRAWIO_MISSING',
      'Run "bita setup", or "brew install --cask drawio".',
    )
  }
  await env.run(env.drawioApp, [
    '--export',
    '--format',
    'png',
    '--scale',
    '2',
    '--border',
    '16',
    '--output',
    join(assetsDir, block.imageFile),
    join(assetsDir, block.sourceFile),
  ])
}

export async function renderDiagrams(
  blocks: readonly DiagramBlock[],
  assetsDir: string,
  options: { force?: boolean; env?: RenderEnvironment } = {},
): Promise<RenderResult[]> {
  const env = options.env ?? defaultEnvironment
  await mkdir(assetsDir, { recursive: true, mode: 0o700 })
  const results: RenderResult[] = []

  for (const block of blocks) {
    const base = {
      index: block.index,
      kind: block.kind,
      name: block.name,
      sourcePath: join(assetsDir, block.sourceFile),
      imagePath: join(assetsDir, block.imageFile),
    }

    if (block.kind === 'drawio' && !env.exists(base.sourcePath)) {
      results.push({ ...base, state: 'missing-source' })
      continue
    }
    if (!options.force && (await isFresh(block, assetsDir))) {
      results.push({ ...base, state: 'fresh' })
      continue
    }

    try {
      if (block.kind === 'mermaid') await renderMermaid(block, assetsDir, env)
      else await renderDrawio(block, assetsDir, env)
      results.push({ ...base, state: env.exists(base.imagePath) ? 'rendered' : 'failed' })
    } catch (error) {
      if (error instanceof ConflictError) throw error
      const message = error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ') : String(error)
      results.push({ ...base, state: 'failed', error: message })
    }
  }

  let files: string[] = []
  try {
    files = await readdir(assetsDir)
  } catch {
    files = []
  }
  for (const orphan of orphanedRenders(blocks, files)) {
    await unlink(join(assetsDir, orphan)).catch(() => undefined)
  }

  return results
}
