import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import plugin from '../src/integrations/opencode.ts'
import { createFakeBin, readFakeBinCalls } from './helpers/fake-bin.ts'

const root = mkdtempSync(join(tmpdir(), 'bita-opencode-plugin-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const ENV_KEYS = ['BITA_BIN', 'FAKE_BIN_LOG', 'BITA_WRAPPER_ID', 'BITA_CHILD']
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
