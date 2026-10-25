import './helpers/isolate.ts'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { nodeScriptBin } from './helpers/fake-bin.ts'
import assert from 'node:assert/strict'
import { CAPABILITIES } from '../src/kit/manifest.ts'
import { VERSION } from '../src/cli/router.ts'

const repo = join(import.meta.dirname, '..')
const DEN_CODEX = 'bita hook den codex'
const DEN_GEMINI = 'bita hook den gemini'
const OLD_DEN_CODEX = '[ -z "$DEN_AGENT_HOOK" ] || "$DEN_AGENT_HOOK" --agent-hook codex'
const OLD_DEN_GEMINI = '[ -z "$DEN_AGENT_HOOK" ] || "$DEN_AGENT_HOOK" --agent-hook gemini'
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
  const nodeDir = join(root, 'node-bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(nodeDir, { recursive: true })
  symlinkSync(process.execPath, join(nodeDir, 'node'))
  const env: NodeJS.ProcessEnv = {
    PATH: [binDir, nodeDir, '/usr/bin', '/bin'].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, 'config'),
    LOCALAPPDATA: join(root, 'data'),
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
  const envelope = JSON.stringify({
    schemaVersion: 3,
    ok: true,
    command: 'capabilities',
    generatedAt: new Date(0).toISOString(),
    data: { name: 'bita', version, envelope: 1, capabilities: [...CAPABILITIES], emits: [] },
  })
  return nodeScriptBin(box.binDir, 'bita', `process.stdout.write(${JSON.stringify(envelope + '\n')})\n`)
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function fakeClaude(box: Sandbox): string {
  const log = join(box.root, 'claude-argv.log')
  nodeScriptBin(
    box.binDir,
    'claude',
    `const args = process.argv.slice(2).join(' ')\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, args + '\\n')\nif (args.includes('--json')) process.stdout.write('[]\\n')\n`,
  )
  return log
}

function claudeCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) : []
}

test('setup installs the Claude Code plugin and the skill, commands and hooks in the other agents', () => {
  const box = sandbox()
  try {
    const log = fakeClaude(box)
    const result = setup(box, '--target', 'all')
    const data = result['data'] as { agents: string[] }
    assert.deepEqual(data.agents, ['claude', 'opencode', 'codex', 'gemini', 'antigravity', 'claude-desktop'])
    const dataHome = join(box.root, 'data')
    const rules = readFileSync(join(dataHome, 'kikedealba', 'agents', 'antigravity', 'bita', 'rules', 'bita.md'), 'utf8').replace(/\r\n/g, '\n')
    assert.match(rules, /^---\ntrigger: always_on\n---\n/)
    assert.ok(rules.split('\n').filter((line) => line.trim().length > 0).length <= 6)
    assert.match(rules, /skill `bita`/)

    const calls = claudeCalls(log)
    assert.ok(calls.includes('plugin marketplace add KikeDeAlba/bita-cli'), calls.join(' | '))
    assert.ok(calls.includes('plugin install bita@bita --scope user'), calls.join(' | '))
    assert.ok(!calls.some((call) => call.includes('bita-timer')))
    assert.equal(existsSync(join(box.claude, 'skills', 'bita')), false)
    assert.equal(existsSync(join(box.claude, 'commands', 'bita-start.md')), false)
    const settings = readJson(join(box.claude, 'settings.json')) as {
      permissions: { allow: string[]; ask: string[] }
      hooks?: Record<string, unknown>
    }
    assert.ok(settings.permissions.allow.includes('Bash(bita start:*)'))
    assert.ok(settings.permissions.allow.includes('Bash(bita sessions:*)'))
    assert.ok(settings.permissions.ask.includes('Bash(bita cancel:*)'))
    assert.equal(settings.hooks, undefined)

    const openCodeSkill = readFileSync(join(box.opencode, 'skills', 'bita', 'SKILL.md'), 'utf8')
    assert.match(openCodeSkill, /^name: bita$/m)
    assert.ok(existsSync(join(box.opencode, 'commands', 'bita-stop.md')))
    assert.equal(existsSync(join(box.opencode, 'plugins', 'bita.ts')), true)
    const launcher = readJson(join(box.opencode, 'bita-launcher.json')) as { command: string; args: string[]; cwd: string; log: string }
    assert.equal(launcher.command, process.execPath)
    assert.equal(launcher.args.length, 1)
    assert.ok(existsSync(launcher.args[0] as string))
    assert.ok(existsSync(launcher.cwd))
    assert.match(launcher.log, /hooks\.log$/)
    assert.equal(existsSync(join(box.opencode, 'opencode.json')), false)

    assert.ok(existsSync(join(box.agentsSkills, 'bita', 'SKILL.md')))
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }
    assert.equal(codexHooks.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'bita hook codex')
    assert.equal(codexHooks.hooks['SessionEnd']?.[0]?.hooks[0]?.command, 'bita hook codex')
    assert.equal(codexHooks.hooks['UserPromptSubmit'], undefined)
    assert.notEqual(codexHooks.hooks['PostToolUse']?.[0]?.matcher, '.*')
    assert.match(codexHooks.hooks['PostToolUse']?.[0]?.matcher ?? '', /apply_patch/)
    assert.deepEqual(codexHooks.hooks['PreToolUse'], [{ hooks: [{ type: 'command', command: DEN_CODEX, timeout: 10 }] }])
    assert.deepEqual(codexHooks.hooks['PostToolUse']?.[1], { hooks: [{ type: 'command', command: DEN_CODEX, timeout: 10 }] })
    assert.ok(existsSync(join(box.codex, 'prompts', 'bita-start.md')))
    assert.equal(existsSync(join(box.codex, 'config.toml')), false)

    const extension = join(box.gemini, 'extensions', 'bita')
    assert.ok(existsSync(join(extension, 'skills', 'bita', 'SKILL.md')))
    assert.ok(existsSync(join(extension, 'commands', 'bita-start.toml')))
    const geminiHooks = readJson(join(extension, 'hooks', 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }
    assert.equal(geminiHooks.hooks['AfterTool']?.[0]?.hooks[0]?.command, 'bita hook gemini')
    assert.notEqual(geminiHooks.hooks['AfterTool']?.[0]?.matcher, '.*')
    assert.equal(geminiHooks.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'bita hook gemini')
    assert.equal(geminiHooks.hooks['SessionEnd']?.[0]?.hooks[0]?.command, 'bita hook gemini')
    assert.equal(geminiHooks.hooks['BeforeAgent'], undefined)
    assert.equal(geminiHooks.hooks['BeforeTool']?.[0]?.matcher, undefined)
    assert.equal(geminiHooks.hooks['BeforeTool']?.[0]?.hooks[0]?.command, DEN_GEMINI)
    assert.equal(geminiHooks.hooks['AfterTool']?.[1]?.matcher, undefined)
    assert.equal(geminiHooks.hooks['AfterTool']?.[1]?.hooks[0]?.command, DEN_GEMINI)
    const geminiManifest = readJson(join(extension, 'gemini-extension.json'))
    assert.equal(geminiManifest['mcpServers'], undefined)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup --mod also installs the bita-timer plugin', () => {
  const box = sandbox()
  try {
    const log = fakeClaude(box)
    setup(box, '--target', 'claude', '--mod')
    const calls = claudeCalls(log)
    assert.ok(calls.includes('plugin install bita@bita --scope user'))
    assert.ok(calls.includes('plugin install bita-timer@bita --scope user'))
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup removes the loose Claude files and hooks an older bita wrote, keeping the user ones', () => {
  const box = sandbox()
  try {
    fakeClaude(box)
    mkdirSync(join(box.claude, 'commands'), { recursive: true })
    mkdirSync(join(box.claude, 'skills'), { recursive: true })
    const oldCommand = join(box.claude, 'commands', 'bita-start.md')
    const oldSkill = join(box.claude, 'skills', 'bita')
    symlinkSync(join(repo, 'commands', 'bita-start.md'), oldCommand)
    symlinkSync(join(repo, 'skill'), oldSkill)
    writeFileSync(
      join(box.claude, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(bita start:*)', 'Bash(git status:*)'] },
        hooks: {
          SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'bita hook session-start', timeout: 5 }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'bita hook prompt-submit', timeout: 5 }] },
            { hooks: [{ type: 'command', command: 'bita hook checkpoint', timeout: 5 }] },
            { hooks: [{ type: 'command', command: 'echo mine' }] },
          ],
        },
      }),
    )

    setup(box, '--target', 'claude')

    assert.throws(() => lstatSync(oldCommand))
    assert.throws(() => lstatSync(oldSkill))
    const settings = readJson(join(box.claude, 'settings.json')) as {
      permissions: { allow: string[] }
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const commands = Object.values(settings.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.deepEqual(commands, ['echo mine'])
    assert.ok(settings.permissions.allow.includes('Bash(git status:*)'))
    assert.ok(settings.permissions.allow.includes('Bash(bita start:*)'))
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup --no-settings still drops the old Claude hooks but leaves the permissions alone', () => {
  const box = sandbox()
  try {
    fakeClaude(box)
    mkdirSync(box.claude, { recursive: true })
    writeFileSync(
      join(box.claude, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(bita summary:*)'] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bita hook prompt-submit', timeout: 5 }] }] },
      }),
    )
    setup(box, '--target', 'claude', '--no-settings')
    const settings = readJson(join(box.claude, 'settings.json')) as { permissions: { allow: string[] }; hooks?: Record<string, unknown> }
    assert.deepEqual(settings.hooks ?? {}, {})
    assert.deepEqual(settings.permissions.allow, ['Bash(bita summary:*)'])
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup leaves the old Claude files alone when the plugin could not be installed', () => {
  const box = sandbox()
  try {
    writeFileSync(
      join(box.root, 'settings-seed.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bita hook prompt-submit', timeout: 5 }] }] } }),
    )
    mkdirSync(box.claude, { recursive: true })
    writeFileSync(join(box.claude, 'settings.json'), readFileSync(join(box.root, 'settings-seed.json'), 'utf8'))
    const result = setup(box, '--target', 'claude')
    const steps = (result['data'] as { steps: Array<{ item: string; state: string }> }).steps
    assert.ok(steps.some((step) => step.item === 'plugin bita@bita' && step.state === 'unavailable'))
    const settings = readJson(join(box.claude, 'settings.json')) as { hooks: Record<string, unknown[]> }
    assert.equal(settings.hooks['UserPromptSubmit']?.length, 1)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup narrows an older catch-all Codex PostToolUse hook to the edit tools', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    writeFileSync(
      join(box.codex, 'hooks.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }] }] } }),
    )
    setup(box, '--target', 'codex')
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string }>> }
    assert.equal(codexHooks.hooks['PostToolUse']?.length, 2)
    assert.notEqual(codexHooks.hooks['PostToolUse']?.[0]?.matcher, '.*')
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup drops the old Codex UserPromptSubmit hook and keeps the user ones', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    writeFileSync(
      join(box.codex, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }] },
            { hooks: [{ type: 'command', command: 'echo mine' }] },
          ],
          PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }] }],
        },
      }),
    )
    setup(box, '--target', 'codex')
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const prompt = (codexHooks.hooks['UserPromptSubmit'] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.deepEqual(prompt, ['echo mine'])
    assert.equal(codexHooks.hooks['SessionStart']?.length, 1)
    assert.equal(codexHooks.hooks['SessionEnd']?.length, 1)
    assert.equal(codexHooks.hooks['PostToolUse']?.length, 2)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('running setup twice keeps the settings and hooks without duplicates', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    writeFileSync(join(box.codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }))
    fakeClaude(box)
    setup(box, '--target', 'claude,codex')
    const firstWrite = statSync(join(box.claude, 'settings.json')).mtimeMs
    setup(box, '--target', 'claude,codex')
    assert.equal(statSync(join(box.claude, 'settings.json')).mtimeMs, firstWrite)
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    assert.equal(codexHooks.hooks['Stop']?.[0]?.hooks[0]?.command, 'echo keep')
    assert.equal(codexHooks.hooks['SessionStart']?.length, 1)
    assert.equal(codexHooks.hooks['PostToolUse']?.length, 2)
    assert.equal(codexHooks.hooks['PreToolUse']?.length, 1)
    const settings = readJson(join(box.claude, 'settings.json')) as { permissions: { allow: string[] }; hooks?: Record<string, unknown[]> }
    assert.equal(settings.permissions.allow.filter((rule) => rule === 'Bash(bita start:*)').length, 1)
    assert.equal(settings.hooks, undefined)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup cleans what an older bita installed for documents and Atlassian', () => {
  const box = sandbox()
  try {
    fakeClaude(box)
    mkdirSync(join(box.claude, 'commands'), { recursive: true })
    const stale = join(box.claude, 'commands', 'bita-check.md')
    symlinkSync(join(repo, 'commands', 'bita-check.md'), stale)
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('the plugin manifests parse and point at the plugin contents', () => {
  const plugin = readJson(join(repo, '.claude-plugin', 'plugin.json'))
  assert.equal(plugin['name'], 'bita')
  assert.equal(plugin['version'], VERSION)
  const marketplace = readJson(join(repo, '.claude-plugin', 'marketplace.json')) as { name: string; plugins: Array<{ name: string; source: string }> }
  assert.equal(marketplace.name, 'bita')
  assert.deepEqual(
    marketplace.plugins.map((entry) => [entry.name, entry.source]),
    [
      ['bita', './'],
      ['bita-timer', './plugins/bita-timer'],
    ],
  )
  const hooks = readJson(join(repo, 'hooks', 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; async?: boolean }> }>> }
  assert.equal(hooks.hooks['SessionStart']?.length, 1)
  assert.equal(hooks.hooks['SessionStart']?.[0]?.matcher, undefined)
  assert.equal(hooks.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'bita hook session-start')
  assert.equal(hooks.hooks['SessionEnd']?.length, 1)
  assert.equal(hooks.hooks['SessionEnd']?.[0]?.hooks[0]?.command, 'bita hook session-end')
  assert.equal(hooks.hooks['UserPromptSubmit'], undefined)
  const touched = hooks.hooks['PostToolUse']?.[0]
  assert.equal(touched?.matcher, 'Edit|Write|MultiEdit')
  assert.equal(touched?.hooks[0]?.command, 'bita hook touched')
  assert.equal(touched?.hooks[0]?.async, true)
})

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, 'missing frontmatter')
  const attributes: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) attributes[pair[1] ?? ''] = pair[2] ?? ''
  }
  return attributes
}

test('the user skills replace the commands and only run when the user types them', () => {
  assert.equal(existsSync(join(repo, 'commands')), false)
  assert.equal(existsSync(join(repo, 'skill')), false)
  for (const name of ['bita-start', 'bita-stop', 'bita-log', 'bita-amend', 'bita-timers', 'bita-init']) {
    const attributes = frontmatter(readFileSync(join(repo, 'skills', name, 'SKILL.md'), 'utf8'))
    assert.equal(attributes['name'], name)
    assert.equal(attributes['disable-model-invocation'], 'true', name)
    assert.ok((attributes['description'] ?? '').length > 0)
  }
})

test('the main skill is a short user reference the model never invokes and never mentions Rovo', () => {
  const skill = readFileSync(join(repo, 'skills', 'bita', 'SKILL.md'), 'utf8')
  assert.ok(skill.split('\n').length < 150)
  assert.equal(frontmatter(skill)['disable-model-invocation'], 'true')
  assert.match(skill, /--brief/)
  assert.match(skill, /bita session/)
  assert.doesNotMatch(skill, /bita amend --draft --title "<titulo corto>"/)
  assert.match(readFileSync(join(repo, 'skills', 'bita', 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/)
  for (const dir of ['bita', 'bita-start', 'bita-stop', 'bita-timers', 'bita-init']) {
    assert.doesNotMatch(readFileSync(join(repo, 'skills', dir, 'SKILL.md'), 'utf8'), /hook de bita lo recuerda|Cuándo proponerlo|ofrecerás el cronómetro/)
  }
  for (const dir of ['bita', 'bita-start', 'bita-stop', 'bita-log', 'bita-amend', 'bita-timers', 'bita-init']) {
    assert.doesNotMatch(readFileSync(join(repo, 'skills', dir, 'SKILL.md'), 'utf8'), /rovo/i)
  }
})

test('setup adds the Den tool hooks to Codex next to the user ones, once, and the stale cleanup puts them back once', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo pre' }] }
    writeFileSync(
      join(box.codex, 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [mine], PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }] }] } }),
    )
    setup(box, '--target', 'codex')
    setup(box, '--target', 'codex')
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }
    assert.deepEqual(codexHooks.hooks['PreToolUse']?.[0], mine)
    const commands = (event: string): string[] => (codexHooks.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.deepEqual(commands('PreToolUse'), ['echo pre', DEN_CODEX])
    assert.deepEqual(commands('PostToolUse'), ['bita hook codex', DEN_CODEX])
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup replaces older Den hook commands in Codex instead of adding a second one', () => {
  const box = sandbox()
  try {
    mkdirSync(box.codex, { recursive: true })
    const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo pre' }] }
    writeFileSync(
      join(box.codex, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [mine, { hooks: [{ type: 'command', command: OLD_DEN_CODEX, timeout: 10 }] }],
          PostToolUse: [
            { matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }] },
            { hooks: [{ type: 'command', command: OLD_DEN_CODEX, timeout: 10 }] },
            { hooks: [{ type: 'command', command: '/opt/old/bita hook den codex --legacy', timeout: 10 }] },
          ],
        },
      }),
    )
    setup(box, '--target', 'codex')
    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }
    const commands = (event: string): string[] => (codexHooks.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.deepEqual(codexHooks.hooks['PreToolUse']?.[0], mine)
    assert.deepEqual(commands('PreToolUse'), ['echo pre', DEN_CODEX])
    assert.deepEqual(commands('PostToolUse'), ['bita hook codex', DEN_CODEX])
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('setup rewrites the Gemini extension hooks so an older Den hook command does not survive', () => {
  const box = sandbox()
  try {
    const hooksFile = join(box.gemini, 'extensions', 'bita', 'hooks', 'hooks.json')
    mkdirSync(join(box.gemini, 'extensions', 'bita', 'hooks'), { recursive: true })
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          BeforeTool: [{ hooks: [{ type: 'command', name: 'den-before-tool', command: OLD_DEN_GEMINI, timeout: 10000 }] }],
          AfterTool: [{ hooks: [{ type: 'command', name: 'den-after-tool', command: OLD_DEN_GEMINI, timeout: 10000 }] }],
        },
      }),
    )
    setup(box, '--target', 'gemini')
    const geminiHooks = readJson(hooksFile) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const all = Object.values(geminiHooks.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)))
    assert.equal(all.filter((command) => command.includes('DEN_AGENT_HOOK')).length, 0)
    assert.equal(all.filter((command) => command === DEN_GEMINI).length, 2)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bita hook den is a no-op without DEN_AGENT_HOOK', () => {
  const box = sandbox()
  try {
    const run = spawnSync(process.execPath, [bin, 'hook', 'den', 'codex'], { cwd: box.root, env: box.env, input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8' })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, '')
    assert.equal(existsSync(join(box.root, 'bita.db')), false)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bita hook den forwards stdin to DEN_AGENT_HOOK --agent-hook and returns its stdout and exit code', () => {
  const box = sandbox()
  try {
    const fake = nodeScriptBin(
      box.binDir,
      'den-hook',
      `const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }))
  process.exitCode = 2
})
`,
    )
    const input = '{"hook_event_name":"BeforeTool","tool_name":"run_shell_command"}'
    const run = spawnSync(process.execPath, [bin, 'hook', 'den', 'gemini'], { cwd: box.root, env: { ...box.env, DEN_AGENT_HOOK: fake }, input, encoding: 'utf8' })
    assert.equal(run.status, 2, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { argv: ['--agent-hook', 'gemini'], stdin: input })
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bita hook den exits 0 when DEN_AGENT_HOOK cannot be started', () => {
  const box = sandbox()
  try {
    const run = spawnSync(process.execPath, [bin, 'hook', 'den', 'codex'], {
      cwd: box.root,
      env: { ...box.env, DEN_AGENT_HOOK: join(box.root, 'missing-den') },
      input: '{}',
      encoding: 'utf8',
    })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, '')
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function snapshotTree(root: string, skip: ReadonlySet<string>): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (skip.has(path)) continue
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else files[path.slice(root.length)] = stat.isSymbolicLink() ? 'symlink' : readFileSync(path, 'utf8').replace(/"installedAt": "[^"]*"/, '"installedAt": "-"')
    }
  }
  walk(root)
  return files
}

test('running setup for every target twice leaves the whole tree byte-identical and registers each Den hook and permission once', () => {
  const box = sandbox()
  try {
    fakeClaude(box)
    mkdirSync(box.codex, { recursive: true })
    mkdirSync(join(box.gemini, 'extensions', 'bita', 'hooks'), { recursive: true })
    const skip = new Set([join(box.root, 'claude-argv.log'), join(box.root, 'bita.db'), join(box.root, 'bita.db-wal'), join(box.root, 'bita.db-shm')])
    setup(box, '--target', 'all')
    const first = snapshotTree(box.root, skip)
    setup(box, '--target', 'all')
    const second = snapshotTree(box.root, skip)
    assert.deepEqual(Object.keys(second), Object.keys(first))
    for (const [path, content] of Object.entries(first)) assert.equal(second[path], content, path)

    const codexHooks = readJson(join(box.codex, 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const commands = (event: string): string[] => (codexHooks.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.equal(commands('PreToolUse').filter((command) => command === DEN_CODEX).length, 1)
    assert.equal(commands('PostToolUse').filter((command) => command === DEN_CODEX).length, 1)
    const geminiText = readFileSync(join(box.gemini, 'extensions', 'bita', 'hooks', 'hooks.json'), 'utf8')
    assert.equal(geminiText.split(DEN_GEMINI).length - 1, 2)
    const settings = readJson(join(box.claude, 'settings.json')) as { permissions: { allow: string[] } }
    const allow = settings.permissions.allow
    assert.equal(new Set(allow).size, allow.length)
    assert.equal(allow.filter((rule) => rule === 'Bash(bita sessions:*)').length, 1)
  } finally {
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('only bita den hook commands count as Den hooks, never a user hook that looks alike', async () => {
  const { isDenAgentHookCommand } = await import('../src/kit/integration.ts')
  for (const command of [DEN_CODEX, DEN_GEMINI, OLD_DEN_CODEX, OLD_DEN_GEMINI, '/opt/old/bita hook den codex --legacy', 'C:\\tools\\bita.cmd hook den gemini', '  bita hook den codex  ']) {
    assert.equal(isDenAgentHookCommand(command), true, command)
  }
  for (const command of [
    'my-den hook den codex',
    'notbita hook den codex',
    'echo "$DEN_AGENT_HOOK" > /tmp/den.log',
    '"$DEN_AGENT_HOOK" --agent-hook codex --my-extra',
    'run-checks && bita hook den codex',
    'bita hook dense',
    'bita hook codex',
  ]) {
    assert.equal(isDenAgentHookCommand(command), false, command)
  }
})
