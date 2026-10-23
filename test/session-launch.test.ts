import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { test } from 'node:test'
import { nodeScriptBin, POSIX_ONLY } from './helpers/fake-bin.ts'
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
const { insertEntry } = await import('../src/db/entries.ts')
const { insertEntrySession, linkSession, markSessionEnded } = await import('../src/db/sessions.ts')

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const TTY = { stdinIsTTY: true, stdoutIsTTY: true }

test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

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
  cwd?: string | undefined
}

interface Harness {
  dir: string
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
    dir,
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
        spawnHarness: async (spawnBin, args, env, spawnCwd) => {
          state.spawned.push(spawnCwd === undefined ? { bin: spawnBin, args, env } : { bin: spawnBin, args, env, cwd: spawnCwd })
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
    assert.deepEqual(h.spawned, [{ bin: '/fake/claude', args: ['--claude-default', 'hola'], env: { ...env, PATH: `/fake${delimiter}/usr/bin` } }])
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

test('mappedProjectId resolves the cwd through the mapped checkouts', { skip: POSIX_ONLY }, async () => {
  const repo = realpathSync(mkdtempSync(join(root, 'repo-')))
  execFileSync('git', ['init', '-q', repo])
  const dbPath = join(repo, '..', `${basename(repo)}.db`)
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
  return nodeScriptBin(dir, name, `${body}\n`)
}

test('spawnHarness returns the exit code, 128 + signal, and 127 when the binary is missing', async () => {
  const dir = mkdtempSync(join(root, 'spawn-'))
  const exits = script(dir, 'exits', 'process.exit(4)')
  const killed = script(dir, 'killed', "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)")
  const env = { ...process.env }
  assert.equal(await spawnHarness(exits, [], env), 4)
  if (process.platform !== 'win32') assert.equal(await spawnHarness(killed, [], env), 143)
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

test('the wrapper forwards SIGTERM to the agent and exits with its code', { skip: POSIX_ONLY }, async () => {
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

interface SeedOptions {
  harness?: HarnessId
  sessionId?: string | null
  cwd: string
  projectId?: number | null
  description?: string
  startedAt?: string
  ended?: boolean
}

let seedCounter = 0

function seed(dbPath: string, options: SeedOptions): { entryId: number; rowId: number } {
  const db = openDatabase(dbPath)
  try {
    seedCounter += 1
    const startedAt = options.startedAt ?? '2026-09-16T16:00:00Z'
    const entry = insertEntry(db, {
      description: options.description ?? `work ${seedCounter}`,
      projectId: options.projectId === undefined ? null : options.projectId,
      startedAt,
      stoppedAt: startedAt,
      source: 'session',
      now: startedAt,
    })
    const row = insertEntrySession(db, {
      entryId: entry.id,
      wrapperId: `wrapper-${seedCounter}`,
      wrapperPid: 1,
      harness: options.harness ?? 'claude',
      cwd: options.cwd,
      startedAt,
    })
    const sessionId = options.sessionId === undefined ? `sess-${seedCounter}` : options.sessionId
    if (sessionId !== null) linkSession(db, row.id, sessionId, null)
    if (options.ended !== false) markSessionEnded(db, row.id, startedAt, 'exit')
    return { entryId: entry.id, rowId: row.id }
  } finally {
    db.close()
  }
}

test('--resume lists the sessions of the cwd, newest first, with title and hint', async () => {
  const h = harness()
  seed(h.dbPath, { cwd: h.dir, sessionId: 'old', description: 'older task', projectId: h.projects.alpha, startedAt: '2026-09-15T16:00:00Z' })
  const newer = seed(h.dbPath, { cwd: h.dir, sessionId: 'new', description: '', projectId: null, startedAt: '2026-09-16T16:00:00Z' })
  seed(h.dbPath, { cwd: join(h.dir, 'elsewhere'), sessionId: 'other', description: 'other dir' })
  const hints: string[] = []
  const code = await runSessionLaunch(['--db-path', h.dbPath, '--resume'], {
    env: { PATH: '/usr/bin' },
    cwd: h.dir,
    ...TTY,
    adapters: ALL,
    select: async <T,>(options: SelectOptions<T>): Promise<T | null> => {
      h.prompts.push({ title: options.title, labels: options.items.map((item) => item.label), initial: options.initialIndex })
      for (const item of options.items) hints.push(item.hint ?? '')
      return null
    },
    spawnHarness: async () => 0,
    sweepOrphans: async () => [],
  })
  assert.equal(code, 130)
  assert.deepEqual(h.prompts, [{ title: 'Resume session', labels: ['(untitled)', 'older task'], initial: 0 }])
  assert.equal(hints[0], `#${newer.entryId} · No project · Claude · 2026-09-16`)
  assert.match(hints[1] ?? '', /^#\d+ · Alpha · Claude · 2026-09-15$/)
})

test('--resume picks a session and relaunches its harness in its cwd with a new entry on its project', async () => {
  const h = harness()
  seed(h.dbPath, { cwd: h.dir, harness: 'codex', sessionId: 'abc-123', projectId: h.projects.beta, description: 'ship it' })
  const code = await h.run(['--resume', '--', 'keep going'], { picks: [0], exitCode: 4 })
  assert.equal(code, 4)
  assert.deepEqual(h.prompts.map((prompt) => prompt.title), ['Resume session'])
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0]?.bin, '/fake/codex')
  assert.deepEqual(h.spawned[0]?.args, ['--codex-default', '--resume', 'abc-123', 'keep going'])
  assert.equal(h.spawned[0]?.cwd, h.dir)
  assert.equal(h.started.length, 1)
  assert.equal(h.started[0]?.harness, 'codex')
  assert.equal(h.started[0]?.projectId, h.projects.beta)
  assert.equal(h.started[0]?.cwd, h.dir)
  assert.equal(h.spawned[0]?.env['BITA_SESSION_PROJECT'], String(h.projects.beta))
  assert.deepEqual(h.closed, [h.started[0]!.wrapperId])
})

test('--resume ENTRY_ID resumes without a terminal and runs in the stored cwd even from another directory', async () => {
  const h = harness()
  const stored = mkdtempSync(join(root, 'stored-'))
  const picked = seed(h.dbPath, { cwd: stored, harness: 'claude', sessionId: 'sid-1', projectId: h.projects.alpha })
  const code = await h.run(['--resume', String(picked.entryId)], { tty: false })
  assert.equal(code, 0)
  assert.equal(h.prompts.length, 0)
  assert.deepEqual(h.spawned[0]?.args, ['--claude-default', '--resume', 'sid-1'])
  assert.equal(h.spawned[0]?.cwd, stored)
  assert.equal(h.started[0]?.projectId, h.projects.alpha)
  assert.equal(h.started[0]?.cwd, stored)
})

test('--resume accepts the entry id before the flag too', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-2', projectId: h.projects.alpha })
  await h.run([String(picked.entryId), '--resume'], { tty: false })
  assert.deepEqual(h.spawned[0]?.args, ['--claude-default', '--resume', 'sid-2'])
})

test('--resume with --project overrides the project and --project 0 skips the timer', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-3', projectId: h.projects.alpha })
  await h.run(['--resume', String(picked.entryId), '--project', 'Beta'], { tty: false })
  assert.equal(h.started[0]?.projectId, h.projects.beta)
  assert.equal(h.prompts.length, 0)

  const none = harness()
  const other = seed(none.dbPath, { cwd: none.dir, sessionId: 'sid-4', projectId: none.projects.alpha })
  const code = await none.run(['--resume', String(other.entryId), '--project', '0'], { tty: false, exitCode: 6 })
  assert.equal(code, 6)
  assert.equal(none.started.length, 0)
  assert.equal(none.closed.length, 0)
  assert.deepEqual(none.spawned[0]?.args, ['--claude-default', '--resume', 'sid-4'])
  assert.equal(none.spawned[0]?.cwd, none.dir)
  assert.deepEqual(Object.keys(none.spawned[0]!.env).filter((key) => key.startsWith('BITA_')), [])
})

test('--resume of an entry without project asks for the project', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-5', projectId: null })
  const code = await h.run(['--resume', String(picked.entryId)], { picks: ['initial'] })
  assert.equal(code, 0)
  assert.deepEqual(h.prompts.map((prompt) => prompt.title), ['Project'])
})

test('--resume with a different --harness is a usage error, the same one is fine', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, harness: 'claude', sessionId: 'sid-6', projectId: h.projects.alpha })
  await assert.rejects(h.run(['--resume', String(picked.entryId), '--harness', 'codex'], { tty: false }), (error: unknown) => {
    assert.ok(error instanceof UsageError)
    assert.match(error.message, /is a claude session/)
    return true
  })
  assert.equal(h.spawned.length, 0)
  assert.equal(h.started.length, 0)
  await h.run(['--resume', String(picked.entryId), '--harness', 'claude'], { tty: false })
  assert.equal(h.spawned.length, 1)
})

test('--resume fails when the harness of the session is not installed', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, harness: 'codex', sessionId: 'sid-7', projectId: h.projects.alpha })
  const adapters = [fakeAdapter('claude', 'Claude'), fakeAdapter('codex', 'Codex', false)]
  await assert.rejects(h.run(['--resume', String(picked.entryId)], { tty: false, adapters }), /codex harness is not installed/)
  assert.equal(h.spawned.length, 0)
})

for (const flags of [['-r', 'x'], ['--resume', 'x'], ['-c'], ['--continue']]) {
  test(`--resume rejects the resume flag ${flags.join(' ')} after --`, async () => {
    const h = harness()
    const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-8', projectId: h.projects.alpha })
    await assert.rejects(h.run(['--resume', String(picked.entryId), '--', ...flags], { tty: false }), (error: unknown) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /already picks the session/)
      return true
    })
    assert.equal(h.spawned.length, 0)
    assert.equal(h.started.length, 0)
  })
}

test('--resume without a terminal and without an id is a usage error', async () => {
  const h = harness()
  seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-9', projectId: h.projects.alpha })
  await assert.rejects(h.run(['--resume'], { tty: false }), (error: unknown) => {
    assert.ok(error instanceof UsageError)
    assert.match(error.message, /bita work --resume ENTRY_ID/)
    return true
  })
  assert.equal(h.prompts.length, 0)
  assert.equal(h.spawned.length, 0)
})

test('--resume without sessions in the cwd is a usage error', async () => {
  const h = harness()
  seed(h.dbPath, { cwd: join(h.dir, 'elsewhere'), sessionId: 'sid-10', projectId: h.projects.alpha })
  await assert.rejects(h.run(['--resume'], {}), (error: unknown) => {
    assert.ok(error instanceof UsageError)
    assert.match(error.message, /No sessions to resume/)
    return true
  })
  assert.equal(h.prompts.length, 0)
  assert.equal(h.spawned.length, 0)
})

test('--resume ENTRY_ID that is unknown, open or without session id is a usage error', async () => {
  const h = harness()
  const open = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-11', ended: false })
  const unlinked = seed(h.dbPath, { cwd: h.dir, sessionId: null })
  for (const id of [open.entryId, unlinked.entryId, 99_999]) {
    await assert.rejects(h.run(['--resume', String(id)], { tty: false }), (error: unknown) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /no finished harness session to resume/)
      return true
    })
  }
  assert.equal(h.spawned.length, 0)
})

for (const bad of ['abc', '0', '-3', '1.5', '12x']) {
  test(`--resume rejects the invalid id ${bad}`, async () => {
    const h = harness()
    await assert.rejects(h.run(['--resume', bad], { tty: false }), UsageError)
    assert.equal(h.spawned.length, 0)
  })
}

test('--resume takes at most one id', async () => {
  const h = harness()
  await assert.rejects(h.run(['--resume', '1', '2'], { tty: false }), /at most one ENTRY_ID/)
})

for (const nested of [{ BITA_WRAPPER_ID: 'outer' }, { BITA_CHILD: '1' }]) {
  test(`--resume inside a session (${Object.keys(nested)[0]}) is a usage error`, async () => {
    const h = harness()
    const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-12', projectId: h.projects.alpha })
    await assert.rejects(h.run(['--resume', String(picked.entryId)], { tty: false, env: { PATH: '/usr/bin', ...nested } }), (error: unknown) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /Already inside a bita session/)
      return true
    })
    assert.equal(h.spawned.length, 0)
    assert.equal(h.started.length, 0)
  })
}

test('--resume fails when the stored directory no longer exists', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: join(h.dir, 'gone'), sessionId: 'sid-13', projectId: h.projects.alpha })
  await assert.rejects(h.run(['--resume', String(picked.entryId)], { tty: false }), (error: unknown) => {
    assert.ok(error instanceof UsageError)
    assert.match(error.message, /no longer exists/)
    return true
  })
  assert.equal(h.spawned.length, 0)
  assert.equal(h.started.length, 0)
})

test('cancelling the --resume picker exits with 130 and launches nothing', async () => {
  const h = harness()
  seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-14', projectId: h.projects.alpha })
  assert.equal(await h.run(['--resume'], { picks: [null] }), 130)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.started.length, 0)
  assert.equal(h.closed.length, 0)
})

test('a failing timer start still resumes the session without the timer', async () => {
  const h = harness()
  const picked = seed(h.dbPath, { cwd: h.dir, sessionId: 'sid-15', projectId: h.projects.alpha })
  const errors = captureStderr()
  let code: number
  try {
    code = await runSessionLaunch(['--db-path', h.dbPath, '--resume', String(picked.entryId)], {
      env: { PATH: '/usr/bin' },
      cwd: h.dir,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      adapters: ALL,
      select: async () => null,
      spawnHarness: async (spawnBin, args, env, spawnCwd) => {
        h.spawned.push({ bin: spawnBin, args, env, cwd: spawnCwd })
        return 0
      },
      startEntry: async () => {
        throw new Error('nope')
      },
      sweepOrphans: async () => [],
    })
  } finally {
    errors.restore()
  }
  assert.equal(code, 0)
  assert.deepEqual(h.spawned[0]?.args, ['--claude-default', '--resume', 'sid-15'])
  assert.match(errors.text(), /could not start the timer/)
})

test('a positional without --resume is still rejected, and --resume with an unreadable database fails', async () => {
  const h = harness()
  await assert.rejects(h.run(['12'], { tty: false }), /after --/)
  const broken = mkdtempSync(join(root, 'broken-resume-'))
  const errors = captureStderr()
  try {
    await assert.rejects(
      runSessionLaunch(['--db-path', broken, '--resume', '1'], {
        env: { PATH: '/usr/bin' },
        cwd: broken,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        adapters: ALL,
        select: async () => null,
        spawnHarness: async () => 0,
      }),
      /no session to resume/,
    )
  } finally {
    errors.restore()
  }
})

test('after the harness exits, afterExit runs before the wrapper closes', async () => {
  const h = harness()
  const calls: { cwd: string; startedAt: string; endedAt: string }[] = []
  const adapter: HarnessAdapter = {
    ...fakeAdapter('antigravity', 'Antigravity'),
    afterExit: async (ref) => {
      calls.push(ref)
      assert.equal(h.closed.length, 0)
      return { sessionId: 'conv-1', transcriptPath: null }
    },
  }
  const before = Date.now()
  const code = await h.run(['--harness', 'antigravity', '--project', 'Alpha'], { adapters: [adapter] })
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.cwd, h.dir)
  assert.ok(Date.parse(calls[0]?.startedAt ?? '') >= before - 1)
  assert.ok(Date.parse(calls[0]?.endedAt ?? '') >= Date.parse(calls[0]?.startedAt ?? ''))
  assert.equal(h.closed.length, 1)
  assert.equal(h.spawned[0]?.env['PATH'], `/fake${delimiter}/usr/bin`)
})

test('bita work does not hand the harness the session markers of another agent', async () => {
  const h = harness()
  const env = {
    PATH: '/usr/bin',
    ANTIGRAVITY_CONVERSATION_ID: 'foreign',
    ANTIGRAVITY_AGENT: '1',
    CODEX_THREAD_ID: 't',
    GEMINI_SESSION_ID: 'g',
    GEMINI_PROJECT_DIR: '/p',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_SSE_PORT: '4242',
    CLAUDE_CODE_IDE_HOST_OVERRIDE: 'h',
    VSCODE_PID: '1',
    TERM_PROGRAM: 'vscode',
    ANTIGRAVITY_USER_SETTING: 'keep',
    ANTIGRAVITY_TRAJECTORY_ID: 'drop',
    KEEP: 'yes',
  }
  await h.run(['--harness', 'antigravity', '--project', 'Alpha'], { env, adapters: [fakeAdapter('antigravity', 'Antigravity')] })
  await h.run(['--', 'x'], { env: { ...env, BITA_WRAPPER_ID: 'outer' }, adapters: [fakeAdapter('claude', 'Claude')] })
  for (const spawned of h.spawned) {
    for (const key of ['CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_IDE_HOST_OVERRIDE', 'VSCODE_PID', 'TERM_PROGRAM', 'ANTIGRAVITY_USER_SETTING']) assert.ok(spawned.env[key], key)
    for (const key of ['ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_TRAJECTORY_ID', 'ANTIGRAVITY_AGENT', 'CODEX_THREAD_ID', 'GEMINI_SESSION_ID', 'GEMINI_PROJECT_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
      assert.equal(spawned.env[key], undefined, key)
    }
    assert.equal(spawned.env['KEEP'], 'yes')
    assert.equal(spawned.env['CLAUDE_CODE_USE_BEDROCK'], '1')
  }
  assert.equal(h.spawned[1]?.env['BITA_WRAPPER_ID'], 'outer')
})
