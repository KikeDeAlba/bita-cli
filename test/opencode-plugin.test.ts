import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import plugin, { bitaCommand, readLauncher, viaCmd } from '../src/integrations/opencode.ts'
import { createFakeBin, readFakeBinCalls } from './helpers/fake-bin.ts'

const root = mkdtempSync(join(tmpdir(), 'bita-opencode-plugin-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const ENV_KEYS = ['BITA_BIN', 'FAKE_BIN_LOG', 'BITA_WRAPPER_ID', 'BITA_CHILD', 'BITA_OPENCODE_LAUNCHER']
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

type Callback = (event: never) => Promise<void>

interface FakeContext {
  hooks: Map<string, Callback>
  ctx: Parameters<typeof plugin.setup>[0]
}

function fakeContext(parents: Record<string, string>): FakeContext {
  const hooks = new Map<string, Callback>()
  const ctx = {
    location: { directory: '/work/app' },
    session: {
      hook: async (name: string, callback: Callback) => void hooks.set(`session.${name}`, callback),
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] }),
    },
    tool: {
      hook: async (name: string, callback: Callback) => void hooks.set(`tool.${name}`, callback),
    },
  } as unknown as Parameters<typeof plugin.setup>[0]
  return { hooks, ctx }
}

function useFakeBita(): string {
  const dir = mkdtempSync(join(root, 'case-'))
  process.env['BITA_BIN'] = createFakeBin(dir, 'bita')
  const log = join(dir, 'calls.log')
  process.env['FAKE_BIN_LOG'] = log
  return log
}

async function fire(fake: FakeContext, name: string, event: unknown): Promise<void> {
  const hook = fake.hooks.get(name)
  assert.ok(hook, `${name} is registered`)
  await hook(event as never)
}

test('outside the wrapper the touched hook still records edits, and the session hook is not registered', async () => {
  const log = useFakeBita()
  const fake = fakeContext({})
  await plugin.setup(fake.ctx)
  assert.equal(fake.hooks.has('session.prompt'), false)
  await fire(fake, 'tool.execute.after', { tool: 'edit', input: { filePath: '/work/app/a.ts' } })
  await fire(fake, 'tool.execute.after', { tool: 'read', input: { filePath: '/work/app/b.ts' } })
  assert.deepEqual(readFakeBinCalls(log).map((call) => call.argv), [['hook', 'touched', '--file', '/work/app/a.ts']])
})

test('inside the wrapper subsessions are ignored and only root sessions start or rotate the entry', async () => {
  const log = useFakeBita()
  process.env['BITA_WRAPPER_ID'] = 'w-1'
  const fake = fakeContext({ ses_child: 'ses_root' })
  await plugin.setup(fake.ctx)
  await fire(fake, 'session.prompt', { sessionID: 'ses_root' })
  await fire(fake, 'session.prompt', { sessionID: 'ses_child' })
  await fire(fake, 'session.prompt', { sessionID: 'ses_root' })
  await fire(fake, 'session.prompt', { sessionID: 'ses_next' })
  await fire(fake, 'tool.execute.after', { tool: 'write', input: { filePath: '/work/app/c.ts' } })
  const calls = readFakeBinCalls(log)
  assert.deepEqual(
    calls.map((call) => [call.argv.join(' '), call.stdin ? (JSON.parse(call.stdin) as { session_id: string; source: string }) : null]),
    [
      ['hook session-start --harness opencode', { hook_event_name: 'SessionStart', session_id: 'ses_root', cwd: '/work/app', source: 'startup' }],
      ['hook session-start --harness opencode', { hook_event_name: 'SessionStart', session_id: 'ses_next', cwd: '/work/app', source: 'clear' }],
      ['hook touched --file /work/app/c.ts', null],
    ],
  )
})

function launcherFile(content: unknown): string {
  const dir = mkdtempSync(join(root, 'launcher-'))
  const file = join(dir, 'bita-launcher.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

test('the plugin runs bita through the launcher setup wrote, from the bita data dir', () => {
  const file = launcherFile({ command: '/opt/node/bin/node', args: ['/opt/bita/src/bin/bita.ts'], cwd: '/var/bita', log: '/var/bita/hooks.log' })
  const env = { BITA_OPENCODE_LAUNCHER: file }
  const result = bitaCommand(['hook', 'touched', '--file', '/w/a.ts'], env, 'linux')
  assert.ok(result.ok)
  assert.equal(result.spec.command, '/opt/node/bin/node')
  assert.deepEqual(result.spec.args, ['/opt/bita/src/bin/bita.ts', 'hook', 'touched', '--file', '/w/a.ts'])
  assert.equal(result.spec.cwd, '/var/bita')
  assert.equal(readLauncher({ BITA_OPENCODE_LAUNCHER: launcherFile({ command: 'node', args: [] }) }, 'linux'), null)
})

test('on Windows the plugin never spawns a bare name and passes .cmd arguments through the environment', () => {
  const missing = bitaCommand(['hook', 'touched'], { BITA_OPENCODE_LAUNCHER: join(root, 'none.json') }, 'win32')
  assert.equal(missing.ok, false)
  const launcher = launcherFile({ command: 'C:\\node\\node.exe', args: ['C:\\bita\\src\\bin\\bita.ts'], cwd: 'C:\\data\\bita', log: 'C:\\data\\bita\\hooks.log' })
  const direct = bitaCommand(['hook', 'touched', '--file', 'C:\\w\\100%.ts'], { BITA_OPENCODE_LAUNCHER: launcher }, 'win32')
  assert.ok(direct.ok)
  assert.equal(direct.spec.command, 'C:\\node\\node.exe')
  assert.equal(direct.spec.windowsVerbatimArguments, false)
  const cmd = bitaCommand(['hook', 'touched', '--file', 'C:\\w\\100%PATH%&x.ts'], { BITA_BIN: 'C:\\npm\\bita.cmd', SystemRoot: 'C:\\Windows', BITA_OPENCODE_LAUNCHER: launcher }, 'win32')
  assert.ok(cmd.ok)
  assert.equal(cmd.spec.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(cmd.spec.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(cmd.spec.args[3], '""%BITA_HOOK_ARG_0%" "%BITA_HOOK_ARG_1%" "%BITA_HOOK_ARG_2%" "%BITA_HOOK_ARG_3%" "%BITA_HOOK_ARG_4%""')
  assert.equal(cmd.spec.env['BITA_HOOK_ARG_4'], 'C:\\w\\100%PATH%&x.ts')
  assert.equal(cmd.spec.env['BITA_HOOK_ARG_0'], 'C:\\npm\\bita.cmd')
  assert.equal(viaCmd('C:\\a.cmd', ['say "hi"'], {}), null)
})

test('a relative BITA_BIN is refused and the lost event is logged', async () => {
  const dir = mkdtempSync(join(root, 'lost-'))
  const log = join(dir, 'hooks.log')
  process.env['BITA_OPENCODE_LAUNCHER'] = launcherFile({ command: process.execPath, args: [], cwd: dir, log })
  process.env['BITA_BIN'] = 'bita'
  const refused = bitaCommand(['hook', 'touched'])
  assert.equal(refused.ok, false)
  const fake = fakeContext({})
  await plugin.setup(fake.ctx)
  await fire(fake, 'tool.execute.after', { tool: 'edit', input: { filePath: '/work/app/a.ts' } })
  assert.match(readFileSync(log, 'utf8'), /opencode plugin: bita hook touched was not run: BITA_BIN must be an absolute path/)
})
