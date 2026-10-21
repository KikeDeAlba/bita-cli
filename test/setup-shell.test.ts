import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  SHELL_BLOCK_END,
  SHELL_BLOCK_START,
  defaultRcFile,
  detectShell,
  installShellFunction,
  removeShellFunction,
  shellBlock,
} from '../src/cli/shell-setup.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const root = mkdtempSync(join(tmpdir(), 'bita-setup-shell-'))

test.after(() => rmSync(root, { recursive: true, force: true }))

function rc(content?: string): string {
  const dir = mkdtempSync(join(root, 'rc-'))
  const path = join(dir, '.zshrc')
  if (content !== undefined) writeFileSync(path, content, 'utf8')
  return path
}

const FUNCTION = [
  'function claude {',
  '  if command -v bita >/dev/null 2>&1; then',
  '    command bita session -- "$@"',
  '  else',
  '    command claude "$@"',
  '  fi',
  '}',
].join('\n')
const EXPECTED = `${SHELL_BLOCK_START}\n${FUNCTION}\n${SHELL_BLOCK_END}\n`

test('the block is exactly the marked claude function', () => {
  assert.equal(shellBlock('zsh'), EXPECTED)
  assert.equal(shellBlock('bash'), EXPECTED)
})

test('defaultRcFile follows ZDOTDIR for zsh and HOME for bash', () => {
  assert.equal(defaultRcFile('zsh', { HOME: '/h' }), '/h/.zshrc')
  assert.equal(defaultRcFile('zsh', { HOME: '/h', ZDOTDIR: '/z' }), '/z/.zshrc')
  assert.equal(defaultRcFile('bash', { HOME: '/h', ZDOTDIR: '/z' }), '/h/.bashrc')
  assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh')
  assert.equal(detectShell({ SHELL: '/usr/local/bin/bash' }), 'bash')
  assert.equal(detectShell({ SHELL: '/usr/bin/fish' }), null)
})

test('install appends the block once, keeps the rest and is idempotent', async () => {
  const path = rc('export A=1\nalias ll="ls -l"')
  assert.equal(await installShellFunction(path, 'zsh'), 'installed')
  assert.equal(readFileSync(path, 'utf8'), `export A=1\nalias ll="ls -l"\n${EXPECTED}`)
  assert.equal(await installShellFunction(path, 'zsh'), 'present')
  assert.equal(readFileSync(path, 'utf8'), `export A=1\nalias ll="ls -l"\n${EXPECTED}`)
})

test('install creates a missing rc file', async () => {
  const path = join(mkdtempSync(join(root, 'none-')), 'nested', '.bashrc')
  assert.equal(await installShellFunction(path, 'bash'), 'installed')
  assert.equal(readFileSync(path, 'utf8'), EXPECTED)
})

test('install replaces an old block between the markers and leaves the rest alone', async () => {
  const before = 'export A=1\n'
  const after = 'export B=2\n'
  const path = rc(`${before}${SHELL_BLOCK_START}\nclaude() { old; }\n${SHELL_BLOCK_END}\n${after}`)
  assert.equal(await installShellFunction(path, 'zsh'), 'updated')
  assert.equal(readFileSync(path, 'utf8'), `${before}${EXPECTED}${after}`)
})

test('remove drops only the block, and says when there is none', async () => {
  const path = rc(`export A=1\n${EXPECTED}export B=2\n`)
  assert.equal(await removeShellFunction(path), 'removed')
  assert.equal(readFileSync(path, 'utf8'), 'export A=1\nexport B=2\n')
  assert.equal(await removeShellFunction(path), 'absent')
  assert.equal(await removeShellFunction(join(root, 'missing-rc')), 'absent')
  assert.equal(existsSync(join(root, 'missing-rc')), false)
})

for (const shell of ['zsh', 'bash'] as const) {
  test(`${shell} -n accepts the block`, (t) => {
    const check = spawnSync(shell, ['-n'], { input: shellBlock(shell), encoding: 'utf8' })
    if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip(`${shell} is not installed`)
      return
    }
    assert.equal(check.status, 0, check.stderr)
  })
}

test('the function sends claude through bita session with every argument', (t) => {
  const dir = mkdtempSync(join(root, 'fn-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const log = join(dir, 'argv')
  writeFileSync(join(binDir, 'bita'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 })
  const check = spawnSync('bash', ['-c', `${shellBlock('bash')}claude -c "two words"`], {
    env: { PATH: [binDir, '/usr/bin', '/bin'].join(delimiter) },
    encoding: 'utf8',
  })
  if (check.error) {
    t.skip('bash is not installed')
    return
  }
  assert.equal(check.status, 0, check.stderr)
  assert.equal(readFileSync(log, 'utf8'), 'session\n--\n-c\ntwo words\n')
})

for (const shell of ['zsh', 'bash'] as const) {
  test(`in ${shell}, the function falls back to the real claude when bita is not on PATH`, (t) => {
    const dir = mkdtempSync(join(root, 'fallback-'))
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const log = join(dir, 'argv')
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 })
    const check = spawnSync(shell, ['-c', `${shellBlock(shell)}claude -c "two words"`], {
      env: { PATH: [binDir, '/usr/bin', '/bin'].join(delimiter) },
      encoding: 'utf8',
    })
    if (check.error) {
      t.skip(`${shell} is not installed`)
      return
    }
    assert.equal(check.status, 0, check.stderr)
    assert.equal(readFileSync(log, 'utf8'), '-c\ntwo words\n')
  })
}

test('a start marker without its end leaves the rc untouched and fails clearly', async () => {
  const content = `export A=1\n${SHELL_BLOCK_START}\nfunction claude { old; }\nexport KEEP=1\n`
  const path = rc(content)
  await assert.rejects(installShellFunction(path, 'zsh'), (error: Error) => {
    assert.match(error.message, /without "# <<< bita session <<<"; it was left untouched/)
    return true
  })
  await assert.rejects(removeShellFunction(path), /left untouched/)
  assert.equal(readFileSync(path, 'utf8'), content)
})

function sandboxEnv(dir: string): NodeJS.ProcessEnv {
  const nodeDir = join(dir, 'node-bin')
  mkdirSync(nodeDir, { recursive: true })
  if (!existsSync(join(nodeDir, 'node'))) symlinkSync(process.execPath, join(nodeDir, 'node'))
  return {
    PATH: [nodeDir, '/usr/bin', '/bin'].join(delimiter),
    HOME: join(dir, 'home'),
    SHELL: '/bin/zsh',
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    KIT_REGISTRY_DIR: join(dir, 'registry'),
    KIT_NO_EVENTS: '1',
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_CONFIG_PATH: join(dir, 'bita-config.json'),
  }
}

function setup(dir: string, ...args: string[]): { status: number | null; data: Record<string, unknown>; stderr: string } {
  const run = spawnSync(process.execPath, [bin, 'setup', '--json', ...args], { cwd: dir, env: sandboxEnv(dir), encoding: 'utf8' })
  const last = run.stdout.trim().split('\n').at(-1) ?? '{}'
  const parsed = JSON.parse(last) as { data?: Record<string, unknown> }
  return { status: run.status, data: parsed.data ?? {}, stderr: run.stderr }
}

test('setup --shell writes the function and setup --remove-shell takes it out', () => {
  const dir = mkdtempSync(join(root, 'setup-'))
  const path = join(dir, 'custom-rc')
  writeFileSync(path, 'alias claude="claude --verbose"\n', 'utf8')

  const installed = setup(dir, '--target', 'claude', '--no-settings', '--no-register', '--shell', 'zsh', '--rc-file', path)
  assert.equal(installed.status, 0, installed.stderr)
  assert.deepEqual(installed.data['shell'], { shell: 'zsh', rcFile: path, state: 'installed', aliasConflict: true })
  assert.ok((installed.data['warnings'] as string[]).some((warning) => warning.includes('alias claude=')))
  assert.equal(readFileSync(path, 'utf8'), `alias claude="claude --verbose"\n${EXPECTED}`)

  const again = setup(dir, '--target', 'claude', '--no-settings', '--no-register', '--shell', 'zsh', '--rc-file', path)
  assert.equal((again.data['shell'] as { state: string }).state, 'present')

  const removed = setup(dir, '--remove-shell', '--rc-file', path)
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(removed.data, { shell: { shell: 'zsh', rcFile: path, state: 'removed', aliasConflict: false } })
  assert.equal(readFileSync(path, 'utf8'), 'alias claude="claude --verbose"\n')
})

test('setup --remove-shell defaults to the rc of $SHELL', () => {
  const dir = mkdtempSync(join(root, 'setup-default-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.zshrc'), `export A=1\n${EXPECTED}`, 'utf8')
  const removed = setup(dir, '--remove-shell')
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n')
})

test('setup rejects an unknown shell and a lone --rc-file', () => {
  const dir = mkdtempSync(join(root, 'setup-bad-'))
  const unknown = setup(dir, '--shell', 'fish')
  assert.equal(unknown.status, 2)
  const lone = setup(dir, '--rc-file', join(dir, 'x'))
  assert.equal(lone.status, 2)
})
