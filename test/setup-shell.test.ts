import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  SHELL_BLOCK_END,
  SHELL_BLOCK_START,
  defaultRcFile,
  displayPath,
  legacyRcFiles,
  removeLegacyShellFunctions,
  removeShellFunction,
} from '../src/cli/legacy-shell.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const root = mkdtempSync(join(tmpdir(), 'bita-legacy-shell-'))

test.after(() => rmSync(root, { recursive: true, force: true }))

function rc(content?: string): string {
  const dir = mkdtempSync(join(root, 'rc-'))
  const path = join(dir, '.zshrc')
  if (content !== undefined) writeFileSync(path, content, 'utf8')
  return path
}

const LEGACY_BLOCK = [
  SHELL_BLOCK_START,
  'function claude {',
  '  if command -v bita >/dev/null 2>&1; then',
  '    command bita session -- "$@"',
  '  else',
  '    command claude "$@"',
  '  fi',
  '}',
  SHELL_BLOCK_END,
  '',
].join('\n')

test('the rc files follow ZDOTDIR for zsh and HOME for bash', () => {
  assert.equal(defaultRcFile('zsh', { HOME: '/h' }), '/h/.zshrc')
  assert.equal(defaultRcFile('zsh', { HOME: '/h', ZDOTDIR: '/z' }), '/z/.zshrc')
  assert.equal(defaultRcFile('bash', { HOME: '/h', ZDOTDIR: '/z' }), '/h/.bashrc')
  assert.deepEqual(legacyRcFiles({ HOME: '/h' }), ['/h/.zshrc', '/h/.bashrc'])
  assert.deepEqual(legacyRcFiles({ HOME: '/h', ZDOTDIR: '/z' }), ['/z/.zshrc', '/h/.zshrc', '/h/.bashrc'])
  assert.deepEqual(legacyRcFiles({ HOME: '/h', ZDOTDIR: '/h' }), ['/h/.zshrc', '/h/.bashrc'])
  assert.equal(displayPath('/h/.zshrc', { HOME: '/h' }), '~/.zshrc')
  assert.equal(displayPath('/z/.zshrc', { HOME: '/h' }), '/z/.zshrc')
})

test('remove drops only the block and keeps the rest of the rc', async () => {
  const path = rc(`export A=1\n${LEGACY_BLOCK}export B=2\n`)
  assert.equal(await removeShellFunction(path), 'removed')
  assert.equal(readFileSync(path, 'utf8'), 'export A=1\nexport B=2\n')
})

test('every block in the rc is removed and reported once', async () => {
  const path = rc(`export A=1\n${LEGACY_BLOCK}export B=2\n${LEGACY_BLOCK}export C=3\n`)
  assert.equal(await removeShellFunction(path), 'removed')
  assert.equal(readFileSync(path, 'utf8'), 'export A=1\nexport B=2\nexport C=3\n')
  const again = rc(`${LEGACY_BLOCK}${LEGACY_BLOCK}`)
  const cleanup = await removeLegacyShellFunctions([again])
  assert.deepEqual(cleanup.removed, [again])
  assert.equal(readFileSync(again, 'utf8'), '')
})

test('markers count only on a line of their own', async () => {
  const foreign = [
    'echo "# >>> bita session >>> note"',
    'export KEEP=1',
    '  # <<< bita session <<< indented',
    '',
  ].join('\n')
  const path = rc(`${foreign}${LEGACY_BLOCK}export B=2\n`)
  assert.equal(await removeShellFunction(path), 'removed')
  assert.equal(readFileSync(path, 'utf8'), `${foreign}export B=2\n`)

  const onlyForeign = rc(foreign)
  assert.equal(await removeShellFunction(onlyForeign), 'absent')
  assert.equal(readFileSync(onlyForeign, 'utf8'), foreign)

  const trailing = rc(`${SHELL_BLOCK_START}  \nfunction claude { old; }\n${SHELL_BLOCK_END}\t\nexport B=2\n`)
  assert.equal(await removeShellFunction(trailing), 'removed')
  assert.equal(readFileSync(trailing, 'utf8'), 'export B=2\n')
})

test('an unterminated block after a valid one leaves the whole rc untouched', async () => {
  const content = `${LEGACY_BLOCK}export A=1\n${SHELL_BLOCK_START}\nfunction claude { old; }\n`
  const path = rc(content)
  await assert.rejects(removeShellFunction(path), /left untouched/)
  assert.equal(readFileSync(path, 'utf8'), content)
})

test('an rc that cannot be read or written is reported and the next one is still cleaned', async () => {
  const dir = mkdtempSync(join(root, 'unwritable-'))
  const asDirectory = join(dir, 'dir-rc')
  mkdirSync(asDirectory)
  const readOnly = join(dir, 'ro-rc')
  writeFileSync(readOnly, LEGACY_BLOCK, 'utf8')
  chmodSync(readOnly, 0o444)
  const fine = rc(`${LEGACY_BLOCK}export B=2\n`)
  try {
    const cleanup = await removeLegacyShellFunctions([asDirectory, readOnly, fine])
    assert.deepEqual(cleanup.removed, [fine])
    assert.equal(cleanup.errors.length, 2)
    assert.match(cleanup.errors[0]!, new RegExp(`${asDirectory}: .*EISDIR`))
    assert.match(cleanup.errors[1]!, new RegExp(`${readOnly}: .*EACCES`))
    assert.equal(readFileSync(fine, 'utf8'), 'export B=2\n')
    assert.equal(readFileSync(readOnly, 'utf8'), LEGACY_BLOCK)
  } finally {
    chmodSync(readOnly, 0o644)
  }
})

test('without a block nothing is touched', async () => {
  const content = 'export A=1\nalias ll="ls -l"'
  const path = rc(content)
  assert.equal(await removeShellFunction(path), 'absent')
  assert.equal(readFileSync(path, 'utf8'), content)
  assert.equal(await removeShellFunction(join(root, 'missing-rc')), 'absent')
  assert.equal(existsSync(join(root, 'missing-rc')), false)
})

test('a start marker without its end leaves the rc untouched and fails clearly', async () => {
  const content = `export A=1\n${SHELL_BLOCK_START}\nfunction claude { old; }\nexport KEEP=1\n`
  const path = rc(content)
  await assert.rejects(removeShellFunction(path), /without "# <<< bita session <<<"; it was left untouched/)
  const cleanup = await removeLegacyShellFunctions([path])
  assert.deepEqual(cleanup.removed, [])
  assert.equal(cleanup.errors.length, 1)
  assert.match(cleanup.errors[0]!, /left untouched/)
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

function setup(dir: string, ...args: Array<string | NodeJS.ProcessEnv>): { status: number | null; stdout: string; stderr: string } {
  const flags = args.filter((arg): arg is string => typeof arg === 'string')
  const extraEnv = args.find((arg): arg is NodeJS.ProcessEnv => typeof arg !== 'string') ?? {}
  const run = spawnSync(process.execPath, [bin, 'setup', '--target', 'claude', '--no-settings', '--no-register', ...flags], {
    cwd: dir,
    env: { ...sandboxEnv(dir), ...extraEnv },
    encoding: 'utf8',
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function jsonData(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { data?: Record<string, unknown> }
  return parsed.data ?? {}
}

function homeWith(dir: string, files: Record<string, string>): string {
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(home, name), content, 'utf8')
  return home
}

test('setup removes the 1.4.0 block from ~/.zshrc and ~/.bashrc, and says so only when it did', () => {
  const dir = mkdtempSync(join(root, 'setup-'))
  const home = homeWith(dir, { '.zshrc': `export A=1\n${LEGACY_BLOCK}`, '.bashrc': `${LEGACY_BLOCK}export B=2\n` })

  const first = setup(dir)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /- shell: removed the claude wrapper from ~\/\.zshrc/)
  assert.match(first.stdout, /- shell: removed the claude wrapper from ~\/\.bashrc/)
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n')
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), 'export B=2\n')

  const second = setup(dir)
  assert.equal(second.status, 0, second.stderr)
  assert.doesNotMatch(second.stdout, /- shell:/)
})

test('setup --json lists the rc files it cleaned', () => {
  const dir = mkdtempSync(join(root, 'setup-json-'))
  const home = homeWith(dir, { '.zshrc': LEGACY_BLOCK })
  const run = setup(dir, '--json')
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(jsonData(run.stdout)['shell'], { removed: [join(home, '.zshrc')] })
  const again = setup(dir, '--json')
  assert.deepEqual(jsonData(again.stdout)['shell'], { removed: [] })
})

test('setup warns about an unterminated block and leaves it alone', () => {
  const dir = mkdtempSync(join(root, 'setup-broken-'))
  const content = `${SHELL_BLOCK_START}\nfunction claude { old; }\n`
  const home = homeWith(dir, { '.zshrc': content })
  const run = setup(dir)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /without "# <<< bita session <<<"; it was left untouched/)
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), content)
})

test('setup cleans both $ZDOTDIR/.zshrc and ~/.zshrc', () => {
  const dir = mkdtempSync(join(root, 'setup-zdotdir-'))
  const home = homeWith(dir, { '.zshrc': `${LEGACY_BLOCK}export H=1\n` })
  const zdotdir = join(dir, 'zdot')
  mkdirSync(zdotdir)
  writeFileSync(join(zdotdir, '.zshrc'), `${LEGACY_BLOCK}export Z=1\n`, 'utf8')
  const run = setup(dir, '--json', { ZDOTDIR: zdotdir })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(jsonData(run.stdout)['shell'], { removed: [join(zdotdir, '.zshrc'), join(home, '.zshrc')] })
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export H=1\n')
  assert.equal(readFileSync(join(zdotdir, '.zshrc'), 'utf8'), 'export Z=1\n')
})

test('setup warns about an rc it cannot write, cleans the rest and finishes', () => {
  const dir = mkdtempSync(join(root, 'setup-unwritable-'))
  const home = homeWith(dir, { '.bashrc': `${LEGACY_BLOCK}export B=2\n` })
  mkdirSync(join(home, '.zshrc'))
  const run = setup(dir)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /Warning: could not remove the claude shell function from .*\.zshrc: .*EISDIR/)
  assert.match(run.stdout, /- shell: removed the claude wrapper from ~\/\.bashrc/)
  assert.match(run.stdout, /Next:/)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), 'export B=2\n')
})

test('setup no longer takes --shell, --rc-file or --remove-shell', () => {
  const dir = mkdtempSync(join(root, 'setup-gone-'))
  for (const args of [['--shell', 'zsh'], ['--rc-file', join(dir, 'x')], ['--remove-shell']]) {
    const run = setup(dir, ...args)
    assert.equal(run.status, 2, args.join(' '))
    assert.match(run.stderr, /unknown option/i, args.join(' '))
  }
})
