import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fireHooks, matchingHooks, NO_HOOKS_ENV_VAR, parseHooks, type HookConfig } from '../src/hooks/hooks.ts'
import { parseKind, parseKindOrClear } from '../src/domain/kind.ts'
import { readConfig, writeConfig, emptyConfig } from '../src/state/config.ts'
import { makeEntry } from './helpers/entries.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bita-hooks-'))
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8')
      if (content.endsWith('\n')) return content
    }
    await sleep(25)
  }
  throw new Error(`${path} was not written`)
}

const MEETINGS = ['remote-meeting', 'in-person-meeting']

test('normalizes hooks from the config and drops the malformed ones', () => {
  const hooks = parseHooks([
    { on: 'start', command: ['/bin/echo'] },
    { on: ['stop', 'bogus'], when: { kind: 'remote-meeting' }, command: ['/bin/echo', 'x'] },
    { on: ['start'], command: [] },
    { on: ['nope'], command: ['/bin/echo'] },
    'garbage',
  ])
  assert.deepEqual(hooks, [
    { on: ['start'], command: ['/bin/echo'] },
    { on: ['stop'], when: { kind: ['remote-meeting'] }, command: ['/bin/echo', 'x'] },
  ])
  assert.deepEqual(parseHooks(undefined), [])
})

test('matches hooks by event and by the new or previous kind', () => {
  const hooks: HookConfig[] = [
    { on: ['start', 'stop'], when: { kind: MEETINGS }, command: ['meeting'] },
    { on: ['stop'], command: ['every-stop'] },
  ]
  const meeting = makeEntry({ kind: 'remote-meeting', running: true })
  const plain = makeEntry({ kind: null })

  assert.deepEqual(
    matchingHooks(hooks, { event: 'start', entry: meeting, docPath: null }).map((hook) => hook.command[0]),
    ['meeting'],
  )
  assert.deepEqual(matchingHooks(hooks, { event: 'start', entry: plain, docPath: null }), [])
  assert.deepEqual(
    matchingHooks(hooks, { event: 'stop', entry: plain, docPath: null }).map((hook) => hook.command[0]),
    ['every-stop'],
  )

  const amendHooks: HookConfig[] = [{ on: ['amend'], when: { kind: MEETINGS }, command: ['meeting'] }]
  assert.equal(matchingHooks(amendHooks, { event: 'amend', entry: plain, previousKind: 'in-person-meeting', docPath: null }).length, 1)
  assert.equal(matchingHooks(amendHooks, { event: 'amend', entry: plain, previousKind: null, docPath: null }).length, 0)
})

test('hands the event to the hook on stdin and in the environment, without waiting for it', async () => {
  const dir = scratch()
  const out = join(dir, 'received.json')
  const script = `
    let input = ''
    process.stdin.on('data', (chunk) => (input += chunk))
    process.stdin.on('end', () => {
      const event = JSON.parse(input)
      require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
        event, env: { id: process.env.BITA_ENTRY_ID, kind: process.env.BITA_ENTRY_KIND, hook: process.env.BITA_HOOK_EVENT, db: process.env.BITA_DB_PATH },
      }) + '\\n')
    })`
  const entry = makeEntry({ id: 42, kind: 'remote-meeting', running: true })
  const launched = await fireHooks(
    [{ on: ['start'], when: { kind: MEETINGS }, command: [process.execPath, '-e', script] }],
    [{ event: 'start', entry, docPath: '/docs/42.md' }],
    { databasePath: '/data/bita.db', docsRoot: '/docs' },
    join(dir, 'hooks.log'),
  )
  assert.equal(launched, 1)

  const received = JSON.parse(await waitFor(out)) as {
    event: { event: string; entry: { id: number; kind: string }; docPath: string; databasePath: string }
    env: { id: string; kind: string; hook: string; db: string }
  }
  assert.equal(received.event.event, 'start')
  assert.equal(received.event.entry.id, 42)
  assert.equal(received.event.entry.kind, 'remote-meeting')
  assert.equal(received.event.docPath, '/docs/42.md')
  assert.equal(received.event.databasePath, '/data/bita.db')
  assert.deepEqual(received.env, { id: '42', kind: 'remote-meeting', hook: 'start', db: '/data/bita.db' })
  assert.match(readFileSync(join(dir, 'hooks.log'), 'utf8'), /start #42 ->/)
})

test('a hook that cannot start is logged and does not throw', async () => {
  const dir = scratch()
  const log = join(dir, 'hooks.log')
  const launched = await fireHooks(
    [{ on: ['stop'], command: [join(dir, 'missing-binary')] }],
    [{ event: 'stop', entry: makeEntry(), docPath: null }],
    { databasePath: '/data/bita.db', docsRoot: '/docs' },
    log,
  )
  assert.equal(launched, 0)
  assert.match(readFileSync(log, 'utf8'), /did not start/)
})

test('BITA_NO_HOOKS turns every hook off', async () => {
  const dir = scratch()
  process.env[NO_HOOKS_ENV_VAR] = '1'
  try {
    const launched = await fireHooks(
      [{ on: ['stop'], command: ['/usr/bin/true'] }],
      [{ event: 'stop', entry: makeEntry(), docPath: null }],
      { databasePath: '/data/bita.db', docsRoot: '/docs' },
      join(dir, 'hooks.log'),
    )
    assert.equal(launched, 0)
    assert.equal(existsSync(join(dir, 'hooks.log')), false)
  } finally {
    delete process.env[NO_HOOKS_ENV_VAR]
  }
})

test('the config keeps its hooks through a read and a write', async () => {
  const path = join(scratch(), 'config.json')
  await writeConfig({
    ...emptyConfig(),
    hooks: [{ on: ['start', 'stop'], when: { kind: MEETINGS }, command: ['/usr/local/bin/recap', 'bita-hook'] }],
  }, path)
  const read = await readConfig(path)
  await writeConfig(read, path)
  const again = await readConfig(path)
  assert.deepEqual(again.hooks, [
    { on: ['start', 'stop'], when: { kind: MEETINGS }, command: ['/usr/local/bin/recap', 'bita-hook'] },
  ])
})

test('validates kinds and accepts none to clear one', () => {
  assert.equal(parseKind(' Remote-Meeting '), 'remote-meeting')
  assert.throws(() => parseKind('remote meeting'), /lowercase word/)
  assert.throws(() => parseKind('none'), /lowercase word/)
  assert.equal(parseKindOrClear('none'), null)
  assert.equal(parseKindOrClear('in-person-meeting'), 'in-person-meeting')
})
