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
import type { SelectOptions } from '../src/cli/select.ts'
import { UsageError } from '../src/errors.ts'

const root = mkdtempSync(join(tmpdir(), 'bita-session-launch-'))
process.env['HOME'] = root
process.env['BITA_CONFIG_PATH'] = join(root, 'config.json')
process.env['BITA_DB_PATH'] = join(root, 'default.db')
process.env['KIT_NO_EVENTS'] = '1'
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
process.env['GIT_CONFIG_GLOBAL'] = join(root, 'gitconfig')

const { mappedProjectId, runSessionLaunch, spawnHarness, splitLaunchArgv } = await import('../src/cli/commands/session-launch.ts')
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
  prompts: Prompt[]
  spawned: Spawned[]
  started: StartSessionInput[]
  closed: string[]
  swept: number
  run(argv: string[], options?: Partial<RunOptions>): Promise<number>
}

interface Prompt {
  title: string
  labels: string[]
  initial: number
}

type Pick = 'initial' | number | null

interface RunOptions {
  picks: Pick[]
  adapters: readonly HarnessAdapter[]
  mapped: number | null
  exitCode: number
  spawnError: Error | null
  sweepError: Error | null
  env: NodeJS.ProcessEnv
  tty: boolean
}

function captureStderr(): { text(): string; restore(): void } {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return { text: () => chunks.join(''), restore: () => void (process.stderr.write = original) }
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
    prompts: [],
    spawned: [],
    started: [],
    closed: [],
    swept: 0,
    async run(argv, options = {}) {
      const picks = [...(options.picks ?? [])]
      return runSessionLaunch(['--db-path', dbPath, ...argv], {
        env: options.env ?? { PATH: '/usr/bin' },
        cwd: dir,
        stdinIsTTY: options.tty ?? true,
        stdoutIsTTY: options.tty ?? true,
        adapters: options.adapters ?? ALL,
        select: async <T,>(select: SelectOptions<T>): Promise<T | null> => {
          state.prompts.push({ title: select.title, labels: select.items.map((item) => item.label), initial: select.initialIndex })
          const pick = picks.length > 0 ? picks.shift() : null
          if (pick === null || pick === undefined) return null
          return select.items[pick === 'initial' ? select.initialIndex : pick]?.value ?? null
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

test('splitLaunchArgv cuts at the first --', () => {
  assert.deepEqual(splitLaunchArgv(['--harness', 'codex', '--', '-c', '--', 'x']), { own: ['--harness', 'codex'], harnessArgs: ['-c', '--', 'x'] })
  assert.deepEqual(splitLaunchArgv(['--project', '0']), { own: ['--project', '0'], harnessArgs: [] })
  assert.deepEqual(splitLaunchArgv(['--']), { own: [], harnessArgs: [] })
})

test('Enter picks Claude and the project mapped to the cwd, and the child gets the session env', async () => {
  const h = harness()
  const code = await h.run(['--', '-c', 'fix it'], { picks: ['initial', 'initial'], mapped: h.projects.beta, exitCode: 5, env: { PATH: '/usr/bin', KEEP: 'yes' } })
  assert.equal(code, 5)
  assert.equal(h.swept, 1)
  assert.deepEqual(h.prompts, [
    { title: 'Harness', labels: ['Claude', 'OpenCode', 'Codex', 'Gemini'], initial: 0 },
    { title: 'Project', labels: ['No timer', 'Alpha', 'Beta'], initial: 2 },
  ])
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

test('an unavailable harness is hidden from the list', async () => {
  const h = harness()
  const adapters = [fakeAdapter('claude', 'Claude'), fakeAdapter('opencode', 'OpenCode', false), fakeAdapter('codex', 'Codex')]
  await h.run(['--', 'hola'], { picks: [1, 1], adapters })
  assert.deepEqual(h.prompts[0]?.labels, ['Claude', 'Codex'])
  assert.equal(h.started[0]?.harness, 'codex')
  assert.equal(h.spawned[0]?.bin, '/fake/codex')
  assert.deepEqual(h.spawned[0]?.args, ['--codex-default', 'hola'])
  assert.equal(h.spawned[0]?.env['BITA_HARNESS'], 'codex')
})

test('a single available harness is not asked for', async () => {
  const h = harness()
  await h.run([], { picks: ['initial'], adapters: [fakeAdapter('claude', 'Claude'), fakeAdapter('codex', 'Codex', false)] })
  assert.deepEqual(h.prompts.map((prompt) => prompt.title), ['Project'])
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
})

test('the cursor starts on Claude even when it is not first', async () => {
  const h = harness()
  await h.run([], { picks: ['initial', 0], adapters: [fakeAdapter('codex', 'Codex'), fakeAdapter('claude', 'Claude')] })
  assert.equal(h.prompts[0]?.initial, 1)
  assert.equal(h.spawned[0]?.bin, '/fake/claude')
})

test('No timer launches without a timer and without BITA_* in the env', async () => {
  const h = harness()
  const code = await h.run(['--', 'x'], { picks: ['initial', 0], mapped: h.projects.alpha, exitCode: 2, env: { PATH: '/usr/bin' } })
  assert.equal(code, 2)
  assert.equal(h.prompts[1]?.labels[0], 'No timer')
  assert.equal(h.started.length, 0)
  assert.equal(h.closed.length, 0)
  const env = h.spawned[0]!.env
  assert.deepEqual(Object.keys(env).filter((key) => key.startsWith('BITA_')), [])
})

test('without a mapping the project cursor starts on the first project, not on No timer', async () => {
  const h = harness()
  await h.run([], { picks: ['initial', 'initial'] })
  assert.equal(h.prompts[1]?.initial, 1)
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
})

test('a mapping to a project that is not offered falls back to the first project', async () => {
  const h = harness()
  await h.run([], { picks: ['initial', 'initial'], mapped: 99_999 })
  assert.equal(h.prompts[1]?.initial, 1)
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
})

test('the archived projects are not offered and the id is the hint', async () => {
  const h = harness()
  const seen: Array<string | undefined> = []
  await runSessionLaunch(['--db-path', h.dbPath], {
    env: { PATH: '/usr/bin' },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    adapters: [fakeAdapter('claude', 'Claude')],
    select: async <T,>(options: SelectOptions<T>): Promise<T | null> => {
      for (const item of options.items) seen.push(`${item.label}:${item.hint ?? ''}`)
      return null
    },
    spawnHarness: async () => 0,
    sweepOrphans: async () => [],
    projectForCwd: async () => null,
  })
  assert.deepEqual(seen, ['No timer:', `Alpha:${h.projects.alpha}`, `Beta:${h.projects.beta}`])
})

test('without projects the cursor stays on No timer and the hint to add one is shown', async () => {
  const dir = mkdtempSync(join(root, 'empty-'))
  const prompts: Prompt[] = []
  const spawned: Spawned[] = []
  const errors = captureStderr()
  let code: number
  try {
    code = await runSessionLaunch(['--db-path', join(dir, 'bita.db')], {
      env: { PATH: '/usr/bin' },
      cwd: dir,
      ...TTY,
      adapters: [fakeAdapter('claude', 'Claude')],
      select: async <T,>(options: SelectOptions<T>): Promise<T | null> => {
        prompts.push({ title: options.title, labels: options.items.map((item) => item.label), initial: options.initialIndex })
        return options.items[options.initialIndex]?.value ?? null
      },
      spawnHarness: async (spawnBin, args, env) => {
        spawned.push({ bin: spawnBin, args, env })
        return 0
      },
      sweepOrphans: async () => [],
      projectForCwd: async () => null,
    })
  } finally {
    errors.restore()
  }
  assert.equal(code, 0)
  assert.deepEqual(prompts, [{ title: 'Project', labels: ['No timer'], initial: 0 }])
  assert.equal(spawned[0]?.env['BITA_WRAPPER_ID'], undefined)
  assert.match(errors.text(), /bita project add/)
})

test('cancelling a picker exits with 130 and launches nothing', async () => {
  const atHarness = harness()
  assert.equal(await atHarness.run([], { picks: [null] }), 130)
  const atProject = harness()
  assert.equal(await atProject.run([], { picks: ['initial', null] }), 130)
  assert.equal(atProject.prompts.length, 2)
  for (const h of [atHarness, atProject]) {
    assert.equal(h.spawned.length, 0)
    assert.equal(h.started.length, 0)
    assert.equal(h.closed.length, 0)
  }
})

test('--harness and --project skip the pickers, and --project 0 skips the timer', async () => {
  const h = harness()
  await h.run(['--harness', 'gemini', '--project', 'Beta'], {})
  assert.equal(h.prompts.length, 0)
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
  await assert.rejects(h.run(['--project', 'Alpha'], { picks: ['initial'], spawnError: new Error('boom') }), /boom/)
  assert.equal(h.started.length, 1)
  assert.deepEqual(h.closed, [h.started[0]!.wrapperId])
})

test('a failing orphan sweep does not stop the launch', async () => {
  const h = harness()
  const code = await h.run(['--project', 'Alpha'], { picks: ['initial'], sweepError: new Error('stub') })
  assert.equal(code, 0)
  assert.equal(h.started.length, 1)
})

test('a database that cannot be opened still launches the harness, without the timer', async () => {
  const h = harness()
  const broken = mkdtempSync(join(root, 'broken-db-'))
  const errors = captureStderr()
  let code: number
  try {
    code = await runSessionLaunch(['--db-path', broken, '--harness', 'codex', '--', 'hola'], {
      env: { PATH: '/usr/bin' },
      cwd: broken,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      adapters: ALL,
      select: async () => null,
      spawnHarness: async (spawnBin, args, env) => {
        h.spawned.push({ bin: spawnBin, args, env })
        return 0
      },
    })
  } finally {
    errors.restore()
  }
  assert.equal(code, 0)
  assert.equal(h.spawned[0]?.bin, '/fake/codex')
  assert.deepEqual(h.spawned[0]?.args, ['--codex-default', 'hola'])
  assert.equal(h.spawned[0]?.env['BITA_WRAPPER_ID'], undefined)
  assert.match(errors.text(), /could not open the database, launching without the timer/)
})

for (const args of [['--harness', 'gemini'], ['--project', 'Alpha'], []]) {
  test(`a picker without a terminal is a usage error and prints no menu (${args.join(' ') || 'no flags'})`, async () => {
    const h = harness()
    const errors = captureStderr()
    try {
      await assert.rejects(h.run(args, { tty: false, picks: [1] }), (error: unknown) => {
        assert.ok(error instanceof UsageError)
        assert.match(error.message, /needs a terminal; pass --harness and --project/)
        return true
      })
    } finally {
      errors.restore()
    }
    assert.equal(h.prompts.length, 0)
    assert.equal(h.spawned.length, 0)
    assert.equal(h.started.length, 0)
    assert.doesNotMatch(errors.text(), /Harness:|Project:|No timer/)
  })
}

test('without a terminal, --harness and --project still launch', async () => {
  const h = harness()
  const code = await h.run(['--harness', 'gemini', '--project', 'Alpha'], { tty: false })
  assert.equal(code, 0)
  assert.equal(h.prompts.length, 0)
  assert.equal(h.started.length, 1)
})

test('-- --version with a terminal still asks and passes the flag to the harness', async () => {
  const h = harness()
  const code = await h.run(['--', '--version'], { picks: ['initial', 1] })
  assert.equal(code, 0)
  assert.equal(h.prompts.length, 2)
  assert.equal(h.started.length, 1)
  assert.deepEqual(h.spawned[0]?.args, ['--claude-default', '--version'])
})

for (const nested of [{ BITA_WRAPPER_ID: 'outer' }, { BITA_CHILD: '1' }]) {
  test(`inside a session (${Object.keys(nested)[0]}) it warns and launches without a timer`, async () => {
    const h = harness()
    const env = { PATH: '/usr/bin', ...nested }
    const errors = captureStderr()
    let code: number
    try {
      code = await h.run(['--', 'hola'], { env, exitCode: 9 })
    } finally {
      errors.restore()
    }
    assert.equal(code, 9)
    assert.equal(h.prompts.length, 0)
    assert.equal(h.swept, 0)
    assert.equal(h.started.length, 0)
    assert.equal(h.closed.length, 0)
    assert.deepEqual(h.spawned, [{ bin: '/fake/claude', args: ['--claude-default', 'hola'], env }])
    assert.match(errors.text(), /already inside a bita session; launching the harness without a new timer/)
  })
}

test('inside a session --harness picks which harness to launch', async () => {
  const h = harness()
  const errors = captureStderr()
  try {
    await h.run(['--harness', 'codex', '--project', 'Alpha'], { env: { BITA_WRAPPER_ID: 'outer' } })
  } finally {
    errors.restore()
  }
  assert.equal(h.started.length, 0)
  assert.equal(h.spawned[0]?.bin, '/fake/codex')
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

for (const command of ['work', 'session']) {
  test(`bita ${command} routes to the launcher and starts the agent with a timer`, () => {
    const dir = mkdtempSync(join(root, `e2e-${command}-`))
    const binDir = join(dir, 'bin')
    mkdirSync(binDir)
    const log = join(dir, 'argv.log')
    script(binDir, 'claude', `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), wrapper: process.env.BITA_WRAPPER_ID ?? null })); process.exit(3)`)
    const env = e2eEnv(dir, binDir)
    const add = spawnSync(process.execPath, [bin, 'project', 'add', 'Alpha', '--json'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(add.status, 0, add.stderr)
    const run = spawnSync(process.execPath, [bin, command, '--harness', 'claude', '--project', 'Alpha', '--', '--version'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(run.status, 3, run.stderr)
    const seen = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; wrapper: string | null }
    assert.ok(seen.argv.includes('--version'))
    assert.ok(seen.wrapper)
  })
}

test('bita work --help prints the bita help', () => {
  const dir = mkdtempSync(join(root, 'e2e-help-'))
  const run = spawnSync(process.execPath, [bin, 'work', '--help'], { cwd: dir, env: e2eEnv(dir, join(dir, 'none')), encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /work \[--harness ID\]/)
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
  const child = spawn(process.execPath, [bin, 'work', '--harness', 'claude', '--project', '0', '--', '-p', 'x'], { cwd: dir, env: e2eEnv(dir, binDir), stdio: 'ignore' })
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  const deadline = Date.now() + 15_000
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(existsSync(ready), 'the fake claude never started')
  child.kill('SIGTERM')
  assert.equal(await exited, 42)
})
