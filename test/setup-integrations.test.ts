import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packageRoot, runSetup } from '../src/cli/commands/setup.ts'
import {
  ATLASSIAN_MCP_URL,
  ensureCodexAtlassianMcp,
  ensureOpenCodeAtlassianMcp,
  type AtlassianMcpEnvironment,
} from '../src/setup/atlassian.ts'

const run = promisify(execFile)

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bita-setup-'))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('installs OpenCode skill, commands, and plugin into a custom directory', async () => {
  const directory = await temporaryDirectory()
  try {
    await runSetup(['--target', 'opencode', '--opencode-dir', directory, '--no-drawio', '--no-atlassian', '--no-docs-git'])

    assert.equal(await readlink(join(directory, 'skills', 'bita')), join(packageRoot(), 'skill-opencode'))
    const skill = await readFile(join(directory, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.match(skill, /El conector de Atlassian en OpenCode/)
    assert.doesNotMatch(skill, /El conector de Atlassian en Codex/)
    assert.equal(await exists(join(directory, 'commands', 'bita-start.md')), true)
    assert.equal(
      (await exists(join(directory, 'plugins', 'bita.ts'))) || (await exists(join(directory, 'plugins', 'bita.js'))),
      true,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installs Codex skill and merges hooks without duplicates', async () => {
  const directory = await temporaryDirectory()
  const agents = join(directory, 'agents')
  const codex = join(directory, 'codex')
  try {
    await runSetup(['--target', 'codex', '--codex-home', codex, '--agents-home', agents, '--no-docs-git'])
    await runSetup(['--target', 'codex', '--codex-home', codex, '--agents-home', agents, '--no-docs-git'])

    const hooks = JSON.parse(await readFile(join(codex, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    assert.equal(await readlink(join(agents, 'skills', 'bita')), join(packageRoot(), 'skill-codex'))
    const skill = await readFile(join(agents, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.match(skill, /El conector de Atlassian en Codex/)
    assert.doesNotMatch(skill, /El conector de Atlassian en OpenCode/)
    const config = await readFile(join(codex, 'config.toml'), 'utf8')
    assert.match(config, /\[mcp_servers\.atlassian\]/)
    assert.ok(config.includes(`url = "${ATLASSIAN_MCP_URL}"`))
    const sessionStart = hooks.hooks.SessionStart ?? []
    const promptSubmit = hooks.hooks.UserPromptSubmit ?? []
    const postToolUse = hooks.hooks.PostToolUse ?? []
    assert.equal(sessionStart.length, 1)
    assert.equal(promptSubmit.length, 1)
    assert.equal(postToolUse.length, 1)
    assert.equal(sessionStart[0]?.hooks?.[0]?.command, 'bita hook codex')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps Claude on the shared skill without client-specific Atlassian guidance', async () => {
  const skill = await readFile(join(packageRoot(), 'skill', 'SKILL.md'), 'utf8')

  assert.doesNotMatch(skill, /El conector de Atlassian en OpenCode/)
  assert.doesNotMatch(skill, /El conector de Atlassian en Codex/)
})

test('configures OpenCode Atlassian MCP without authenticating', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const environment: AtlassianMcpEnvironment = {
    which: async () => '/bin/opencode',
    run: async (command, args) => {
      calls.push({ command, args })
    },
  }

  const result = await ensureOpenCodeAtlassianMcp({}, environment)

  assert.equal(result.state, 'installed')
  assert.deepEqual(calls, [
    {
      command: '/bin/opencode',
      args: ['mcp', 'add', '--global', 'atlassian', '--url', ATLASSIAN_MCP_URL],
    },
  ])
})

test('preserves an existing Codex config while adding Atlassian MCP', async () => {
  const directory = await temporaryDirectory()
  const configPath = join(directory, 'config.toml')
  try {
    await writeFile(configPath, '[mcp_servers.context7]\nurl = "https://example.com/mcp"\n')

    const first = await ensureCodexAtlassianMcp(configPath)
    const second = await ensureCodexAtlassianMcp(configPath)
    const config = await readFile(configPath, 'utf8')

    assert.equal(first.state, 'installed')
    assert.equal(second.state, 'present')
    assert.match(config, /\[mcp_servers\.context7\]/)
    assert.match(config, /\[mcp_servers\.atlassian\]/)
    assert.ok(config.includes(`url = "${ATLASSIAN_MCP_URL}"`))
    assert.equal(await exists(`${configPath}.backup`), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('preserves an existing Codex hook configuration', async () => {
  const directory = await temporaryDirectory()
  const hooksPath = join(directory, 'hooks.json')
  try {
    await writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }))
    await run('node', ['scripts/merge-codex-hooks.mjs', hooksPath])

    const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    assert.equal(hooks.hooks.Stop?.[0]?.hooks?.[0]?.command, 'echo keep')
    assert.equal(await exists(`${hooksPath}.backup`), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
