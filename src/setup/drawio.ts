import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DRAWIO_APP } from '../docs/render.ts'

export const DRAWIO_MCP_ARGS = ['mcp', 'add', '--scope', 'user', 'drawio', '--', 'npx', '-y', '@drawio/mcp']
export const DRAWIO_CASK_ARGS = ['install', '--cask', 'drawio']
const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
const INSTALL_TIMEOUT_MS = 600_000

export type SetupState = 'present' | 'installed' | 'unavailable' | 'failed'

export interface SetupStep {
  name: 'drawio-mcp' | 'drawio-app'
  state: SetupState
  detail: string
}

export interface SetupEnvironment {
  run: (command: string, args: readonly string[]) => Promise<void>
  exists: (path: string) => boolean
  which: (command: string) => Promise<string | null>
  claudeJson: string
  drawioApp: string
}

export const defaultSetupEnvironment: SetupEnvironment = {
  run: async (command, args) => {
    await promisify(execFile)(command, [...args], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  },
  exists: existsSync,
  which: async (command) => {
    try {
      const { stdout } = await promisify(execFile)('/usr/bin/which', [command])
      const found = stdout.trim()
      return found.length > 0 ? found : null
    } catch {
      return null
    }
  },
  claudeJson: join(homedir(), '.claude.json'),
  drawioApp: DRAWIO_APP,
}

export function hasDrawioMcp(claudeJsonText: string | null): boolean {
  if (claudeJsonText === null) return false
  try {
    const parsed = JSON.parse(claudeJsonText) as { mcpServers?: Record<string, unknown> }
    return parsed.mcpServers !== undefined && Object.hasOwn(parsed.mcpServers, 'drawio')
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error)
}

export async function ensureDrawioMcp(env: SetupEnvironment): Promise<SetupStep> {
  if (hasDrawioMcp(env.exists(env.claudeJson) ? readText(env.claudeJson) : null)) {
    return { name: 'drawio-mcp', state: 'present', detail: 'The draw.io MCP server is already configured.' }
  }
  const claude = await env.which('claude')
  if (claude === null) {
    return {
      name: 'drawio-mcp',
      state: 'unavailable',
      detail: `Claude Code is not on PATH. Install the MCP by hand: claude ${DRAWIO_MCP_ARGS.join(' ')}`,
    }
  }
  try {
    await env.run(claude, DRAWIO_MCP_ARGS)
    return { name: 'drawio-mcp', state: 'installed', detail: 'Added the draw.io MCP server for every project.' }
  } catch (error) {
    return { name: 'drawio-mcp', state: 'failed', detail: `claude mcp add failed: ${reason(error)}` }
  }
}

export async function ensureDrawioApp(env: SetupEnvironment): Promise<SetupStep> {
  if (env.exists(env.drawioApp)) {
    return { name: 'drawio-app', state: 'present', detail: 'draw.io Desktop is installed.' }
  }
  const brew = BREW_CANDIDATES.find((candidate) => env.exists(candidate)) ?? (await env.which('brew'))
  if (!brew) {
    return {
      name: 'drawio-app',
      state: 'unavailable',
      detail: 'Homebrew is not installed. Get draw.io Desktop from https://www.drawio.com/ to render .drawio files.',
    }
  }
  try {
    await env.run(brew, DRAWIO_CASK_ARGS)
    return env.exists(env.drawioApp)
      ? { name: 'drawio-app', state: 'installed', detail: 'Installed draw.io Desktop with Homebrew.' }
      : { name: 'drawio-app', state: 'failed', detail: 'brew finished but draw.io.app is not in /Applications.' }
  } catch (error) {
    return { name: 'drawio-app', state: 'failed', detail: `brew install --cask drawio failed: ${reason(error)}` }
  }
}

export async function ensureDrawio(env: SetupEnvironment = defaultSetupEnvironment): Promise<SetupStep[]> {
  return [await ensureDrawioMcp(env), await ensureDrawioApp(env)]
}
