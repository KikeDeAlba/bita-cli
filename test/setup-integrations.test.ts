import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITIES } from '../src/kit/manifest.ts'
import { VERSION } from '../src/cli/router.ts'

const repo = join(import.meta.dirname, '..')
const bin = join(repo, 'src', 'bin', 'bita.ts')

interface Sandbox {
  root: string
  env: NodeJS.ProcessEnv
  claude: string
  codex: string
  opencode: string
  agentsSkills: string
  gemini: string
  registry: string
  binDir: string
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'bita-setup-'))
  const home = join(root, 'home')
  const binDir = join(root, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    PATH: [binDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    KIT_REGISTRY_DIR: join(root, 'registry'),
    KIT_CREDENTIALS: 'file',
    KIT_AGENTS_HOME: join(root, 'agents'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    GEMINI_CLI_HOME: join(root, 'gemini-home'),
    BITA_DB_PATH: join(root, 'bita.db'),
    BITA_CONFIG_PATH: join(root, 'bita-config.json'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  }
  return {
    root,
    env,
    claude: join(root, 'claude'),
    codex: join(root, 'codex'),
    opencode: join(root, 'config', 'opencode'),
    agentsSkills: join(root, 'agents', 'skills'),
    gemini: join(root, 'gemini-home', '.gemini'),
    registry: join(root, 'registry'),
    binDir,
  }
}

function setup(box: Sandbox, ...args: string[]): Record<string, unknown> {
  const run = spawnSync(process.execPath, [bin, 'setup', '--json', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' })
  assert.equal(run.status, 0, `setup failed: ${run.stderr}${run.stdout}`)
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
}

function bitaShim(box: Sandbox, version: string): string {
  const path = join(box.binDir, 'bita')
  const envelope = JSON.stringify({
    schemaVersion: 3,
    ok: true,
    command: 'capabilities',
    generatedAt: new Date(0).toISOString(),
    data: { name: 'bita', version, envelope: 1, capabilities: [...CAPABILITIES], emits: [] },
  })
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${envelope}'\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('setup registers bita in the kit registry with its capabilities and events', () => {
  const box = sandbox()
  try {
    setup(box, '--target', 'claude', '--no-settings')
    const manifest = readJson(join(box.registry, 'bita.json'))
    assert.equal(manifest['name'], 'bita')
    assert.deepEqual(manifest['capabilities'], [...CAPABILITIES])
    assert.deepEqual(manifest['emits'], ['start', 'stop', 'cancel', 'amend', 'delete', 'merge'])
    const bitaBin = manifest['bin'] as string[]
    assert.equal(bitaBin[0], process.execPath)
    assert.equal(bitaBin[1], bin)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('setup registers the bita on PATH when it reports the same version', () => {
  const box = sandbox()
  try {
    const shim = bitaShim(box, VERSION)
    setup(box, '--target', 'claude', '--no-settings')
    const manifest = readJson(join(box.registry, 'bita.json'))
    assert.deepEqual(manifest['bin'], [shim])
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('setup keeps its own path when the bita on PATH reports another version', () => {
  const box = sandbox()
  try {
    bitaShim(box, '0.0.1')
    setup(box, '--target', 'claude', '--no-settings')
    const manifest = readJson(join(box.registry, 'bita.json'))
    assert.deepEqual(manifest['bin'], [process.execPath, bin])
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('setup installs the skill, commands, settings and hooks in all four agents', () => {
  const box = sandbox()
  try {
    const result = setup(box, '--target', 'all')
    const data = result['data'] as { agents: string[] }
    assert.deepEqual(data.agents, ['claude', 'opencode', 'codex', 'gemini'])

    const claudeSkill = readFileSync(join(box.claude, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.doesNotMatch(claudeSkill, /Los avisos de bita en (OpenCode|Codex|Gemini CLI)/)
    assert.doesNotMatch(claudeSkill, /::: agent/)
    assert.equal(existsSync(join(box.claude, 'commands', 'bita-start.md')), true)
    const settings = readJson(join(box.claude, 'settings.json')) as {
      permissions: { allow: string[]; ask: string[] }
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    assert.ok(settings.permissions.allow.includes('Bash(bita start:*)'))
    assert.ok(settings.permissions.ask.includes('Bash(bita cancel:*)'))
    assert.equal(settings.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'bita hook session-start')
    assert.equal(settings.hooks['UserPromptSubmit']?.length, 2)

    const openCodeSkill = readFileSync(join(box.opencode, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.match(openCodeSkill, /Los avisos de bita en OpenCode/)
    assert.doesNotMatch(openCodeSkill, /Los avisos de bita en Codex/)
    assert.equal(existsSync(join(box.opencode, 'commands', 'bita-stop.md')), true)
    assert.equal(existsSync(join(box.opencode, 'plugins', 'bita.ts')), true)
    assert.equal(existsSync(join(box.opencode, 'opencode.json')), false)

    const codexSkill = readFileSync(join(box.agentsSkills, 'bita', 'SKILL.md'), 'utf8')
    assert.match(codexSkill, /Los avisos de bita en Codex/)
    assert.doesNotMatch(codexSkill, /Los avisos de bita en OpenCode/)
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    assert.equal(codexHooks.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'bita hook codex')
    assert.ok(existsSync(join(box.codex, 'prompts', 'bita-start.md')))
    assert.equal(existsSync(join(box.codex, 'config.toml')), false)
    assert.equal(existsSync(join(box.claude, 'commands', 'bita-check.md')), false)
    assert.ok(!settings.permissions.allow.includes('Bash(bita docs:*)'))

    const extension = join(box.gemini, 'extensions', 'bita')
    const geminiSkill = readFileSync(join(extension, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.match(geminiSkill, /Los avisos de bita en Gemini CLI/)
    assert.doesNotMatch(geminiSkill, /Los avisos de bita en Codex/)
    assert.ok(existsSync(join(extension, 'commands', 'bita-start.toml')))
    const geminiHooks = readJson(join(extension, 'hooks', 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    assert.equal(geminiHooks.hooks['AfterTool']?.[0]?.hooks[0]?.command, 'bita hook gemini')
    assert.equal(geminiHooks.hooks['BeforeAgent']?.[0]?.hooks[0]?.command, 'bita hook gemini')
    const geminiManifest = readJson(join(extension, 'gemini-extension.json'))
    assert.equal(geminiManifest['mcpServers'], undefined)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('running setup twice keeps the settings and hooks without duplicates', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    writeFileSync(join(box.codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }))
    setup(box, '--target', 'claude,codex')
    const firstWrite = statSync(join(box.claude, 'settings.json')).mtimeMs
    setup(box, '--target', 'claude,codex')
    assert.equal(statSync(join(box.claude, 'settings.json')).mtimeMs, firstWrite)
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    assert.equal(codexHooks.hooks['Stop']?.[0]?.hooks[0]?.command, 'echo keep')
    assert.equal(codexHooks.hooks['SessionStart']?.length, 1)
    assert.equal(codexHooks.hooks['PostToolUse']?.length, 1)
    const settings = readJson(join(box.claude, 'settings.json')) as { permissions: { allow: string[] }; hooks: Record<string, unknown[]> }
    assert.equal(settings.permissions.allow.filter((rule) => rule === 'Bash(bita start:*)').length, 1)
    assert.equal(settings.hooks['PostToolUse']?.length, 1)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('an Atlassian MCP the user already configured in Codex is left alone', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    const own = '[mcp_servers.atlassian]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "MINE"\n'
    writeFileSync(join(box.codex, 'config.toml'), own)
    setup(box, '--target', 'codex')
    assert.equal(readFileSync(join(box.codex, 'config.toml'), 'utf8'), own)
    assert.ok(existsSync(join(box.agentsSkills, 'bita', 'SKILL.md')))
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('the old setup flags are accepted and ignored with a warning', () => {
  const box = sandbox()
  try {
    const run = spawnSync(process.execPath, [bin, 'setup', '--target', 'gemini', '--no-drawio', '--no-recap', '--no-docs-git', '--no-atlassian'], {
      cwd: box.root,
      env: box.env,
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /--no-drawio is ignored/)
    assert.match(run.stderr, /--no-recap is ignored: .*npm i -g @kikedealba\/recap && recap setup/)
    assert.match(run.stderr, /--no-atlassian is ignored: .*atl/)
    assert.match(run.stderr, /--no-docs-git is ignored: .*inkwell/)
    const geminiManifest = readJson(join(box.gemini, 'extensions', 'bita', 'gemini-extension.json'))
    assert.equal(geminiManifest['mcpServers'], undefined)
    assert.equal(existsSync(join(box.claude, 'skills')), false)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('setup cleans what an older bita installed for documents and Atlassian', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.claude, 'commands'), { recursive: true })
    const stale = join(box.claude, 'commands', 'bita-check.md')
    symlinkSync(join(box.root, 'gone', 'bita-check.md'), stale)
    writeFileSync(
      join(box.claude, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(bita docs:*)', 'Bash(bita summary:*)', 'Bash(git status:*)'] },
        hooks: {
          PostToolUse: [
            { matcher: 'mcp__.*Atlassian.*|mcp__.*Google_Drive.*', hooks: [{ type: 'command', command: 'bita hook ref', timeout: 10 }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
          ],
        },
      }),
    )

    setup(box, '--target', 'claude')

    assert.throws(() => lstatSync(stale))
    const settings = readJson(join(box.claude, 'settings.json')) as {
      permissions: { allow: string[] }
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    assert.ok(settings.permissions.allow.includes('Bash(git status:*)'))
    assert.ok(!settings.permissions.allow.includes('Bash(bita docs:*)'))
    assert.ok(!settings.permissions.allow.includes('Bash(bita summary:*)'))
    const commands = (settings.hooks['PostToolUse'] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.ok(!commands.includes('bita hook ref'))
    assert.ok(commands.includes('echo mine'))
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('the commands that moved to other tools fail with a hint to the right one', () => {
  const box = sandbox()
  try {
    const cases: Array<[string[], RegExp]> = [
      [['app', '--json'], /Den/],
      [['note', 'save', '1', '--json'], /inkwell note/],
      [['summary', '--json'], /tally summary/],
      [['jira', 'myself', '--json'], /atl jira/],
      [['meeting', 'export', '1', '--json'], /recap/],
      [['toString', '--json'], /bita --help/],
      [['project', 'constructor', '--json'], /^$/],
    ]
    for (const [args, hint] of cases) {
      const run = spawnSync(process.execPath, [bin, ...args], { cwd: box.root, env: box.env, encoding: 'utf8' })
      assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`)
      const envelope = JSON.parse(run.stdout) as { ok: boolean; error: { code: string; hint: string } }
      assert.equal(envelope.ok, false)
      if (args[0] === 'project') {
        assert.equal(envelope.error.code, 'USAGE_ERROR')
        continue
      }
      assert.equal(envelope.error.code, 'UNKNOWN_COMMAND')
      assert.match(envelope.error.hint, hint)
    }
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('the shared skill keeps the agent-specific sections in agent blocks', () => {
  const skill = readFileSync(join(repo, 'skill', 'SKILL.md'), 'utf8')
  assert.match(skill, /^::: agent codex$/m)
  assert.match(skill, /^::: agent opencode$/m)
  assert.match(skill, /^::: agent gemini$/m)
  assert.equal(existsSync(join(repo, 'skill-codex')), false)
  assert.equal(existsSync(join(repo, 'skill-opencode')), false)
})
