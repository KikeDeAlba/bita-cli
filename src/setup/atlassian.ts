import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SetupState } from './drawio.ts'

export const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v2/mcp'
export const OPENCODE_MCP_ARGS = ['mcp', 'add', '--global', 'atlassian', '--url', ATLASSIAN_MCP_URL] as const

export type AtlassianMcpTarget = 'opencode' | 'codex'

export interface AtlassianMcpStep {
  name: `atlassian-mcp-${AtlassianMcpTarget}`
  state: SetupState
  detail: string
}

export interface AtlassianMcpEnvironment {
  which: (command: string, environment?: NodeJS.ProcessEnv) => Promise<string | null>
  run: (command: string, args: readonly string[], environment?: NodeJS.ProcessEnv) => Promise<void>
}

const MCP_TIMEOUT_MS = 60_000

export const defaultAtlassianMcpEnvironment: AtlassianMcpEnvironment = {
  which: async (command, environment = process.env) => {
    try {
      const { stdout } = await promisify(execFile)('which', [command], { env: environment })
      const path = stdout.trim()
      return path.length > 0 ? path : null
    } catch {
      return null
    }
  },
  run: async (command, args, environment = process.env) => {
    await promisify(execFile)(command, [...args], {
      env: environment,
      timeout: MCP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
  },
}

export async function ensureOpenCodeAtlassianMcp(
  environment: NodeJS.ProcessEnv = process.env,
  runner: AtlassianMcpEnvironment = defaultAtlassianMcpEnvironment,
): Promise<AtlassianMcpStep> {
  const name = 'atlassian-mcp-opencode' as const
  const command = await runner.which('opencode', environment)
  if (command === null) {
    return {
      name,
      state: 'unavailable',
      detail: `OpenCode is not on PATH. Add the Atlassian MCP manually: opencode ${OPENCODE_MCP_ARGS.join(' ')}`,
    }
  }

  try {
    await runner.run(command, OPENCODE_MCP_ARGS, environment)
    return {
      name,
      state: 'installed',
      detail: 'Added the Atlassian MCP to OpenCode. Authenticate it from /mcps before publishing to Jira.',
    }
  } catch (error) {
    return { name, state: 'failed', detail: `opencode mcp add failed: ${reason(error)}` }
  }
}

export async function ensureCodexAtlassianMcp(configPath: string): Promise<AtlassianMcpStep> {
  const name = 'atlassian-mcp-codex' as const
  const existing = await readText(configPath)
  if (existing !== null && hasCodexAtlassianMcp(existing)) {
    return {
      name,
      state: 'present',
      detail: 'The Atlassian MCP is already configured in Codex.',
    }
  }

  if (existing !== null && hasInlineCodexMcpTable(existing)) {
    return {
      name,
      state: 'failed',
      detail: `Codex uses an inline mcp_servers table in ${configPath}; add the Atlassian MCP manually with codex mcp add atlassian --url ${ATLASSIAN_MCP_URL}`,
    }
  }

  const block = `${existing !== null && existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}[mcp_servers.atlassian]\nurl = "${ATLASSIAN_MCP_URL}"\n`
  try {
    await mkdir(dirname(configPath), { recursive: true })
    if (existing !== null) await copyFile(configPath, `${configPath}.backup`)
    await writeFile(configPath, `${existing ?? ''}${block}`)
    return {
      name,
      state: 'installed',
      detail: `Added the Atlassian MCP to ${configPath}. Authenticate it with codex mcp login atlassian before publishing to Jira.`,
    }
  } catch (error) {
    return { name, state: 'failed', detail: `Codex MCP configuration failed: ${reason(error)}` }
  }
}

function hasCodexAtlassianMcp(text: string): boolean {
  return /^\s*\[mcp_servers\.atlassian(?:\.[^\]]+)?\]\s*$/m.test(text)
}

function hasInlineCodexMcpTable(text: string): boolean {
  return /^\s*mcp_servers\s*=/m.test(text)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error)
}
