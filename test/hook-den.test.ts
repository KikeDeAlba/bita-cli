import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DEN_HOOK_TIMEOUT_ENV } from '../src/cli/commands/hook.ts'
import { nodeScriptBin, POSIX_ONLY } from './helpers/fake-bin.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')

function withBox<T>(run: (root: string, env: NodeJS.ProcessEnv) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'bita-hook-den-'))
  mkdirSync(join(root, 'home'))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: join(root, 'home'),
    BITA_DB_PATH: join(root, 'bita.db'),
    BITA_CONFIG_PATH: join(root, 'config.json'),
    KIT_NO_EVENTS: '1',
    KIT_REGISTRY_DIR: join(root, 'registry'),
  }
  try {
    return run(root, env)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

function den(env: NodeJS.ProcessEnv, args: string[], input: string, extra: { timeout?: number } = {}) {
  return spawnSync(process.execPath, [bin, 'hook', 'den', ...args], { env, input, encoding: 'utf8', ...extra })
}

test('bita hook den without a harness argument is a silent no-op even when DEN_AGENT_HOOK is set', () => {
  withBox((root, env) => {
    const marker = join(root, 'ran')
    const fake = nodeScriptBin(root, 'den-hook', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
    const run = den({ ...env, DEN_AGENT_HOOK: fake }, [], '{}')
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '')
    assert.equal(existsSync(marker), false)
  })
})

test('bita hook den with an empty DEN_AGENT_HOOK is a silent no-op', () => {
  withBox((_root, env) => {
    const run = den({ ...env, DEN_AGENT_HOOK: '' }, ['codex'], '{"hook_event_name":"PreToolUse"}')
    assert.equal(run.status, 0)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, '')
  })
})

test('bita hook den passes a 2 MB payload through, passes stderr along, and returns the exit code of Den', () => {
  withBox((root, env) => {
    const fake = nodeScriptBin(
      root,
      'den-echo',
      `const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks)
  process.stderr.write('den says no\\n')
  process.stdout.write(String(body.length))
  process.exitCode = 2
})
`,
    )
    const payload = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) })
    const run = den({ ...env, DEN_AGENT_HOOK: fake }, ['codex'], payload)
    assert.equal(run.status, 2)
    assert.equal(run.stdout, String(Buffer.byteLength(payload)))
    assert.match(run.stderr, /den says no/)
  })
})

test('bita hook den survives a Den that exits without reading stdin', () => {
  withBox((root, env) => {
    const fake = nodeScriptBin(root, 'den-deaf', `process.stdout.write('{"ok":true}')\n`)
    const run = den({ ...env, DEN_AGENT_HOOK: fake }, ['gemini'], JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024) }))
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '{"ok":true}')
  })
})

test('bita hook den reports every harness name it is given to Den unchanged', () => {
  withBox((root, env) => {
    const fake = nodeScriptBin(root, 'den-argv', `process.stdout.write(JSON.stringify(process.argv.slice(2)))\n`)
    for (const harness of ['codex', 'gemini', 'claude', 'opencode']) {
      const run = den({ ...env, DEN_AGENT_HOOK: fake }, [harness], '{}')
      assert.deepEqual(JSON.parse(run.stdout), ['--agent-hook', harness])
    }
  })
})

const HANG = (pidFile: string): string =>
  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nprocess.stdin.resume()\nsetTimeout(() => process.exit(0), 60000)\n`

function hooksLog(root: string): string {
  const file = join(root, 'hooks.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await delay(50)
  }
  return check()
}

test('bita hook den kills a Den that hangs past its limit, exits 0 and logs it', { skip: POSIX_ONLY }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bita-hook-den-'))
  try {
    mkdirSync(join(root, 'home'))
    const pidFile = join(root, 'den.pid')
    const fake = nodeScriptBin(root, 'den-hang', HANG(pidFile))
    const env = { PATH: process.env['PATH'], HOME: join(root, 'home'), BITA_DB_PATH: join(root, 'bita.db'), DEN_AGENT_HOOK: fake, [DEN_HOOK_TIMEOUT_ENV]: '500' }
    const started = Date.now()
    const run = den(env, ['codex'], '{}', { timeout: 15000 })
    assert.equal(run.signal, null, `bita hook den was still running after ${Date.now() - started} ms`)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '')
    assert.ok(Date.now() - started < 10000)
    const logged = /hook den codex: Den did not answer within 500 ms; killed it \(pid (\d+)\)/.exec(hooksLog(root))
    assert.ok(logged, hooksLog(root))
    const pid = Number(logged[1])
    assert.ok(await waitFor(() => !alive(pid)), `Den ${pid} is still running`)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bita hook den returns 1 and logs it when Den is ended by a signal', { skip: POSIX_ONLY }, () => {
  withBox((root, env) => {
    const fake = nodeScriptBin(root, 'den-killed', `process.kill(process.pid, 'SIGKILL')\n`)
    const run = den({ ...env, DEN_AGENT_HOOK: fake }, ['gemini'], '{}')
    assert.equal(run.status, 1, run.stderr)
    assert.match(hooksLog(root), /hook den gemini: Den was ended by SIGKILL/)
  })
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`bita hook den kills Den when it receives ${signal}`, { skip: POSIX_ONLY }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bita-hook-den-'))
    try {
      mkdirSync(join(root, 'home'))
      const pidFile = join(root, 'den.pid')
      const fake = nodeScriptBin(root, 'den-hang', HANG(pidFile))
      const env = { PATH: process.env['PATH'], HOME: join(root, 'home'), BITA_DB_PATH: join(root, 'bita.db'), DEN_AGENT_HOOK: fake }
      const child = spawn(process.execPath, [bin, 'hook', 'den', 'codex'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
      child.stdin.end('{}')
      const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, sig) => resolve(sig)))
      try {
        assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== ''), 'Den never started')
        const pid = Number(readFileSync(pidFile, 'utf8'))
        child.kill(signal)
        assert.equal(await exited, signal)
        assert.ok(await waitFor(() => !alive(pid)), `Den ${pid} is still running`)
        assert.match(hooksLog(root), new RegExp(`hook den codex: received ${signal}; killed Den`))
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
}
