import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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

test('bita hook den does not wait forever for a Den that hangs', { skip: POSIX_ONLY, todo: 'forward() in src/cli/commands/hook.ts has no timeout, and the hung Den child is left running' }, () => {
  withBox((root, env) => {
    const fake = nodeScriptBin(root, 'den-hang', `setTimeout(() => process.exit(0), 12000)\nprocess.stdin.resume()\n`)
    const started = Date.now()
    const run = den({ ...env, DEN_AGENT_HOOK: fake }, ['codex'], '{}', { timeout: 5000 })
    assert.notEqual(run.signal, 'SIGTERM', `bita hook den was still running after ${Date.now() - started} ms`)
  })
})
