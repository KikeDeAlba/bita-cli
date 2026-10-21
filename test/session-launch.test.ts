import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import type { HarnessAdapter, HarnessId } from '../src/harness/types.ts'
import type { StartSessionInput } from '../src/domain/session.ts'
import type { LocalContext } from '../src/cli/local-context.ts'

const root = mkdtempSync(join(tmpdir(), 'bita-session-launch-'))
process.env['HOME'] = root
process.env['BITA_CONFIG_PATH'] = join(root, 'config.json')
process.env['BITA_DB_PATH'] = join(root, 'default.db')
process.env['KIT_NO_EVENTS'] = '1'
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
process.env['GIT_CONFIG_GLOBAL'] = join(root, 'gitconfig')

const { isPassthrough, mappedProjectId, runSessionLaunch, spawnHarness, splitLaunchArgv } = await import('../src/cli/commands/session-launch.ts')
const { openDatabase } = await import('../src/db/open.ts')
const { insertProject, setProjectActive } = await import('../src/db/projects.ts')
const { upsertProjectRepo } = await import('../src/db/project-repos.ts')
const { createLocalContext } = await import('../src/cli/local-context.ts')

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const TTY = { stdinIsTTY: true, stdoutIsTTY: true }

test.after(() => rmSync(root, { recursive: true, force: true }))

function fakeAdapter(id: HarnessId, label: string, available = true): HarnessAdapter {
  return {
    id,
    label,
    bin: id,
    defaultSummaryModel: 'm',
    resolveBin: () => (available ? `/fake/${id}` : null),
    available: () => available,
    launchArgs: (userArgs) => ({ args: [`--${id}-default`, ...userArgs], warnings: [`bita: ${label} warning`] }),
    extractTranscript: async () => [],
    summarize: async () => ({ ok: false, error: 'unused' }),
  }
}

const ALL = [fakeAdapter('claude', 'Claude'), fakeAdapter('opencode', 'OpenCode'), fakeAdapter('codex', 'Codex'), fakeAdapter('gemini', 'Gemini')]

interface Spawned {
  bin: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
}

interface Harness {
  dbPath: string
  projects: { alpha: number; beta: number }
  questions: string[]
  spawned: Spawned[]
  started: StartSessionInput[]
  closed: string[]
  swept: number
  run(argv: string[], options?: Partial<RunOptions>): Promise<number>
}

interface RunOptions {
  answers: Array<string | null>
  adapters: readonly HarnessAdapter[]
  mapped: number | null
  exitCode: number
  spawnError: Error | null
  sweepError: Error | null
  env: NodeJS.ProcessEnv
  tty: boolean
}

function harness(): Harness {
  const dir = mkdtempSync(join(root, 'case-'))
  const dbPath = join(dir, 'bita.db')
  const db = openDatabase(dbPath)
  const now = new Date().toISOString()
  const alpha = insertProject(db, { name: 'Alpha', clientName: null, createdAt: now }).id
  const beta = insertProject(db, { name: 'Beta', clientName: null, createdAt: now }).id
  const archived = insertProject(db, { name: 'Old', clientName: null, createdAt: now }).id
  setProjectActive(db, archived, false)
  db.close()

  const state: Harness = {
    dbPath,
    projects: { alpha, beta },
    questions: [],
    spawned: [],
    started: [],
    closed: [],
    swept: 0,
    async run(argv, options = {}) {
      const answers = [...(options.answers ?? [])]
      return runSessionLaunch(['--db-path', dbPath, ...argv], {
        env: options.env ?? { PATH: '/usr/bin' },
        cwd: dir,
        stdinIsTTY: options.tty ?? true,
        stdoutIsTTY: options.tty ?? true,
        adapters: options.adapters ?? ALL,
        ask: async (question) => {
          state.questions.push(question)
          return answers.length > 0 ? (answers.shift() ?? null) : null
        },
        spawnHarness: async (spawnBin, args, env) => {
          state.spawned.push({ bin: spawnBin, args, env })
          if (options.spawnError) throw options.spawnError
          return options.exitCode ?? 0
        },
        startEntry: async (_ctx: LocalContext, input: StartSessionInput) => {
          state.started.push(input)
          return { entryId: 900 + state.started.length, rowId: state.started.length }
        },
        closeWrapper: async (_ctx: LocalContext, wrapperId: string) => {
          state.closed.push(wrapperId)
          return []
        },
        sweepOrphans: async () => {
          state.swept += 1
          if (options.sweepError) throw options.sweepError
          return []
        },
        projectForCwd: async () => options.mapped ?? null,
      })
    },
  }
  return state
}

test('isPassthrough lets non-interactive and informational calls through untouched', () => {
  const env = {}
  const through: string[][] = [
    ['-p', 'hola'],
    ['--print', 'x'],
    ['-v'],
    ['--version'],
    ['-h'],
    ['--help'],
    ['--bg'],
    ['--background'],
    ['mcp', 'list'],
    ['update'],
    ['plugin', 'install', 'x'],
    ['config'],
    ['doctor'],
    ['--model', 'opus', '-p', 'x'],
  ]
  for (const args of through) assert.equal(isPassthrough(args, TTY, env), true, args.join(' '))

  const wrapped: string[][] = [[], ['-c'], ['--continue'], ['--resume', 'x'], ['update the docs'], ['--model', 'opus'], ['--', '-p'], ['hola', 'mcp']]
  for (const args of wrapped) assert.equal(isPassthrough(args, TTY, env), false, args.join(' '))

  assert.equal(isPassthrough([], { stdinIsTTY: false, stdoutIsTTY: true }, env), true)
  assert.equal(isPassthrough([], { stdinIsTTY: true, stdoutIsTTY: false }, env), true)
  assert.equal(isPassthrough([], TTY, { BITA_CHILD: '1' }), true)
  assert.equal(isPassthrough([], TTY, { BITA_CHILD: '0' }), false)
  assert.equal(isPassthrough([], TTY, { BITA_WRAPPER_ID: 'w' }), true)
})

test('splitLaunchArgv cuts at the first --', () => {
  assert.deepEqual(splitLaunchArgv(['--harness', 'codex', '--', '-c', '--', 'x']), { own: ['--harness', 'codex'], harnessArgs: ['-c', '--', 'x'] })
  assert.deepEqual(splitLaunchArgv(['--project', '0']), { own: ['--project', '0'], harnessArgs: [] })
  assert.deepEqual(splitLaunchArgv(['--']), { own: [], harnessArgs: [] })
})

test('Enter picks Claude and the project mapped to the cwd, and the child gets the session env', async () => {
  const h = harness()
  const code = await h.run(['--', '-c', 'fix it'], { answers: ['', ''], mapped: h.projects.beta, exitCode: 5, env: { PATH: '/usr/bin', KEEP: 'yes' } })
  assert.equal(code, 5)
  assert.equal(h.swept, 1)
  assert.deepEqual(h.questions, ['Pick one [1]: ', 'Pick one [2]: '])
  assert.equal(h.started.length, 1)
  const started = h.started[0]!
  assert.equal(started.harness, 'claude')
  assert.equal(started.projectId, h.projects.beta)
  assert.equal(started.wrapperPid, process.pid)
  assert.equal(h.spawned.length, 1)
  const spawned = h.spawned[0]!
  assert.equal(spawned.bin, '/fake/claude')
  assert.deepEqual(spawned.args, ['--claude-default', '-c', 'fix it'])
  assert.equal(spawned.env['KEEP'], 'yes')
  assert.equal(spawned.env['BITA_WRAPPER_ID'], started.wrapperId)
  assert.equal(spawned.env['BITA_HARNESS'], 'claude')
  assert.equal(spawned.env['BITA_SESSION_PROJECT'], String(h.projects.beta))
  assert.equal(spawned.env['BITA_DB_PATH'], h.dbPath)
  assert.deepEqual(h.closed, [started.wrapperId])
})

test('an unavailable harness is hidden from the list and the numbers follow what is shown', async () => {
  const h = harness()
  const adapters = [fakeAdapter('claude', 'Claude'), fakeAdapter('opencode', 'OpenCode', false), fakeAdapter('codex', 'Codex')]
  await h.run(['--', 'hola'], { answers: ['2', '1'], adapters })
  assert.equal(h.started[0]?.harness, 'codex')
  assert.equal(h.spawned[0]?.bin, '/fake/codex')
  assert.deepEqual(h.spawned[0]?.args, ['--codex-default', 'hola'])
  assert.equal(h.spawned[0]?.env['BITA_HARNESS'], 'codex')
})

test('a single available harness is not asked for', async () => {
  const h = harness()
  await h.run([], { answers: ['1'], adapters: [fakeAdapter('claude', 'Claude'), fakeAdapter('codex', 'Codex', false)] })
  assert.deepEqual(h.questions, ['Pick one: '])
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
})

test('the default harness is Claude even when it is not first', async () => {
  const h = harness()
  await h.run([], { answers: ['', '0'], adapters: [fakeAdapter('codex', 'Codex'), fakeAdapter('claude', 'Claude')] })
  assert.equal(h.questions[0], 'Pick one [2]: ')
  assert.equal(h.spawned[0]?.bin, '/fake/claude')
})

test('0 launches without a timer and without BITA_* in the env', async () => {
  const h = harness()
  const code = await h.run(['--', 'x'], { answers: ['', '0'], mapped: h.projects.alpha, exitCode: 2, env: { PATH: '/usr/bin' } })
  assert.equal(code, 2)
  assert.equal(h.started.length, 0)
  assert.equal(h.closed.length, 0)
  const env = h.spawned[0]!.env
  assert.deepEqual(Object.keys(env).filter((key) => key.startsWith('BITA_')), [])
})

test('an invalid answer asks again, and without a mapping Enter asks again too', async () => {
  const h = harness()
  await h.run([], { answers: ['9', 'x', '3', '', '7', '2'] })
  assert.deepEqual(h.questions, ['Pick one [1]: ', 'Pick one [1]: ', 'Pick one [1]: ', 'Pick one: ', 'Pick one: ', 'Pick one: '])
  assert.equal(h.started[0]?.harness, 'codex')
  assert.equal(h.started[0]?.projectId, h.projects.beta)
})

test('the archived projects are not offered', async () => {
  const h = harness()
  await h.run([], { answers: ['', '3', '1'] })
  assert.equal(h.questions.length, 3)
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
})

test('EOF or Ctrl+C in a picker exits with 130 and launches nothing', async () => {
  const atHarness = harness()
  assert.equal(await atHarness.run([], { answers: [null] }), 130)
  const atProject = harness()
  assert.equal(await atProject.run([], { answers: [''] }), 130)
  for (const h of [atHarness, atProject]) {
    assert.equal(h.spawned.length, 0)
    assert.equal(h.started.length, 0)
    assert.equal(h.closed.length, 0)
  }
})

test('--harness and --project skip the pickers, and --project 0 skips the timer', async () => {
  const h = harness()
  await h.run(['--harness', 'gemini', '--project', 'Beta'], {})
  assert.equal(h.questions.length, 0)
  assert.equal(h.started[0]?.harness, 'gemini')
  assert.equal(h.started[0]?.projectId, h.projects.beta)

  const none = harness()
  await none.run(['--harness', 'codex', '--project', '0'], {})
  assert.equal(none.started.length, 0)
  assert.equal(none.spawned[0]?.bin, '/fake/codex')

  const missing = harness()
  await assert.rejects(missing.run(['--harness', 'gemini'], { adapters: [fakeAdapter('claude', 'Claude'), fakeAdapter('gemini', 'Gemini', false)] }), /not installed/)
  await assert.rejects(missing.run(['--harness', 'vim'], {}), /Unknown harness/)
  await assert.rejects(missing.run(['loose'], {}), /after --/)
})

test('closeWrapper runs even when the spawn fails', async () => {
  const h = harness()
  await assert.rejects(h.run(['--project', 'Alpha'], { answers: [''], spawnError: new Error('boom') }), /boom/)
  assert.equal(h.started.length, 1)
  assert.deepEqual(h.closed, [h.started[0]!.wrapperId])
})

test('a failing orphan sweep does not stop the launch', async () => {
  const h = harness()
  const code = await h.run(['--project', 'Alpha'], { answers: [''], sweepError: new Error('stub') })
  assert.equal(code, 0)
  assert.equal(h.started.length, 1)
})

test('passthrough runs claude with the args and env as they came, without the DB', async () => {
  const h = harness()
  const env = { PATH: '/usr/bin', BITA_HARNESS_BIN_CLAUDE: '/opt/claude' }
  const code = await h.run(['--', '-p', 'hola'], { env, exitCode: 9, adapters: [] })
  assert.equal(code, 9)
  assert.equal(h.swept, 0)
  assert.deepEqual(h.spawned, [{ bin: '/opt/claude', args: ['-p', 'hola'], env }])

  const piped = harness()
  await piped.run(['--', 'hola'], { tty: false })
  assert.deepEqual(piped.spawned[0]?.args, ['hola'])
  assert.equal(piped.spawned[0]?.bin, '/fake/claude')
  assert.equal(piped.questions.length, 0)
})

test('mappedProjectId resolves the cwd through the mapped checkouts', async () => {
  const repo = realpathSync(mkdtempSync(join(root, 'repo-')))
  execFileSync('git', ['init', '-q', repo])
  const dbPath = join(repo, '..', `${repo.split('/').at(-1)}.db`)
  const db = openDatabase(dbPath)
  const project = insertProject(db, { name: 'Mapped', clientName: null, createdAt: new Date().toISOString() })
  upsertProjectRepo(db, { projectId: project.id, path: repo, slug: null, source: 'manual', now: new Date().toISOString() })
  db.close()
  const sub = join(repo, 'src')
  mkdirSync(sub)
  const ctx = createLocalContext({ values: { 'db-path': dbPath }, positionals: [] })
  try {
    assert.equal(await mappedProjectId(ctx, sub), project.id)
    assert.equal(await mappedProjectId(ctx, root), null)
  } finally {
    ctx.db.close()
  }
})

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

test('spawnHarness returns the exit code, 128 + signal, and 127 when the binary is missing', async () => {
  const dir = mkdtempSync(join(root, 'spawn-'))
  const exits = script(dir, 'exits', 'process.exit(4)')
  const killed = script(dir, 'killed', "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)")
  const env = { ...process.env }
  assert.equal(await spawnHarness(exits, [], env), 4)
  assert.equal(await spawnHarness(killed, [], env), 143)
  assert.equal(await spawnHarness(join(dir, 'missing'), [], env), 127)
})

function e2eEnv(dir: string, binDir: string): NodeJS.ProcessEnv {
  return {
    PATH: [binDir, '/usr/bin', '/bin'].join(delimiter),
    HOME: dir,
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_CONFIG_PATH: join(dir, 'config.json'),
    KIT_NO_EVENTS: '1',
    KIT_REGISTRY_DIR: join(dir, 'registry'),
  }
}

test('bita session -- --version runs the real claude and exits with its code', () => {
  const dir = mkdtempSync(join(root, 'e2e-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const log = join(dir, 'argv.log')
  script(binDir, 'claude', `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); process.exit(3)`)
  const run = spawnSync(process.execPath, [bin, 'session', '--', '--version'], { cwd: dir, env: e2eEnv(dir, binDir), encoding: 'utf8' })
  assert.equal(run.status, 3, run.stderr)
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['--version'])

  const help = spawnSync(process.execPath, [bin, 'session', '--', '--help'], { cwd: dir, env: e2eEnv(dir, binDir), encoding: 'utf8' })
  assert.equal(help.status, 3, help.stderr)
  assert.doesNotMatch(help.stdout, /Usage: bita/)
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['--help'])
})

test('the wrapper forwards SIGTERM to the agent and exits with its code', async () => {
  const dir = mkdtempSync(join(root, 'e2e-signal-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const ready = join(dir, 'ready')
  script(
    binDir,
    'claude',
    `process.on('SIGTERM', () => process.exit(42)); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setTimeout(() => process.exit(1), 20000)`,
  )
  const child = spawn(process.execPath, [bin, 'session', '--', '-p', 'x'], { cwd: dir, env: e2eEnv(dir, binDir), stdio: 'ignore' })
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  const deadline = Date.now() + 15_000
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(existsSync(ready), 'the fake claude never started')
  child.kill('SIGTERM')
  assert.equal(await exited, 42)
})
