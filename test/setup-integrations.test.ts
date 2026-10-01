import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packageRoot, runSetup } from '../src/cli/commands/setup.ts'

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
    await runSetup(['--target', 'opencode', '--opencode-dir', directory, '--no-drawio'])

    assert.equal(await readlink(join(directory, 'skills', 'bita')), join(packageRoot(), 'skill'))
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
    await runSetup(['--target', 'codex', '--codex-home', codex, '--agents-home', agents])
    await runSetup(['--target', 'codex', '--codex-home', codex, '--agents-home', agents])

    const hooks = JSON.parse(await readFile(join(codex, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    assert.equal(await exists(join(agents, 'skills', 'bita', 'SKILL.md')), true)
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
