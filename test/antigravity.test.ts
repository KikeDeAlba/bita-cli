import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bita-antigravity-'))
process.env['HOME'] = root
process.env['KIT_NO_EVENTS'] = '1'
after(() => rmSync(root, { recursive: true, force: true }))

const { antigravityAdapter, findExitConversation, readAntigravityConversation } = await import('../src/harness/antigravity.ts')
const { harnessBinEnvVar } = await import('../src/harness/registry.ts')
const { taskkillPath, withBinOnPath } = await import('../src/harness/process.ts')
const { childEnv, processStartedAt, wrapperAlive, attachExitSession } = await import('../src/domain/session.ts')
const { bitaDirs } = await import('../src/state/dirs.ts')
const { legacyRcFiles, displayPath } = await import('../src/cli/legacy-shell.ts')
const { openMemoryDatabase } = await import('../src/db/open.ts')
const { insertEntry } = await import('../src/db/entries.ts')
const { findSessionByEntry, insertEntrySession } = await import('../src/db/sessions.ts')
const { binaryCandidates, manifestCommand, registryManifestPath } = await import('../plugins/bita-timer/hooks/timers.ts')

function varint(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

function field(number: number, payload: Uint8Array | string | number): Uint8Array {
  if (typeof payload === 'number') return Uint8Array.from([...varint(number << 3), ...varint(payload)])
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  return Uint8Array.from([...varint((number << 3) | 2), ...varint(bytes.length), ...bytes])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]))
}

function conversationDb(file: string, steps: { type: number; payload: Uint8Array }[]): void {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))')
  const insert = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)')
  steps.forEach((step, index) => insert.run(index, step.type, step.payload))
  db.close()
}

test('reads user and assistant turns from an antigravity conversation database', async () => {
  const file = join(root, 'conv.db')
  conversationDb(file, [
    { type: 14, payload: concat(field(1, 14), field(19, concat(field(2, 'arregla el bug'), field(3, field(1, 'arregla el bug'))))) },
    { type: 15, payload: concat(field(1, 15), field(20, concat(field(3, 'pensando...'), field(7, field(2, 'run_command'))))) },
    { type: 132, payload: field(5, field(4, field(2, 'run_command'))) },
    { type: 15, payload: field(20, concat(field(1, 'Listo, quedó arreglado.'), field(8, 'Listo, quedó arreglado.'))) },
    { type: 15, payload: Uint8Array.from([0xff, 0xff]) },
  ])
  assert.deepEqual(await readAntigravityConversation(file), [
    { role: 'user', text: 'arregla el bug' },
    { role: 'assistant', text: 'Listo, quedó arreglado.' },
  ])
  assert.deepEqual(await readAntigravityConversation(join(root, 'missing.db')), [])
  const ref = { harness: 'antigravity' as const, sessionId: null, transcriptPath: file, cwd: root, startedAt: '', endedAt: '' }
  assert.equal((await antigravityAdapter.extractTranscript(ref)).length, 2)
  assert.deepEqual(await antigravityAdapter.extractTranscript({ ...ref, transcriptPath: null }), [])
})

test('afterExit picks the last conversation of the workspace since the session started', async () => {
  const home = mkdtempSync(join(root, 'home-'))
  const real = realpathSync(mkdtempSync(join(root, 'repo-')))
  const link = join(home, 'repo-link')
  symlinkSync(real, link)
  const history = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(history, { recursive: true })
  const started = Date.parse('2026-10-22T10:00:00.000Z')
  const line = (conversationId: string, workspace: string, at: number) => JSON.stringify({ display: 'x', timestamp: at, workspace, conversationId })
  writeFileSync(
    join(history, 'history.jsonl'),
    [
      line('old', real, started - 60_000),
      line('first', real, started - 500),
      line('other-repo', '/somewhere/else', started + 5_000),
      'not json',
      line('second', real, started + 10_000),
      line('later-elsewhere', '/x', started + 20_000),
    ].join('\n'),
  )
  const env = { HOME: home }
  const ref = { cwd: link, startedAt: new Date(started).toISOString(), endedAt: new Date(started + 60_000).toISOString() }
  assert.deepEqual(await antigravityAdapter.afterExit?.(ref, env), {
    sessionId: 'second',
    transcriptPath: join(history, 'conversations', 'second.db'),
  })
  assert.equal(await findExitConversation({ ...ref, startedAt: new Date(started + 30_000).toISOString() }, env), null)
  assert.equal(await findExitConversation(ref, { HOME: join(root, 'nobody') }), null)
})

test('attachExitSession links only the open unlinked session of the wrapper', () => {
  const db = openMemoryDatabase()
  const at = new Date().toISOString()
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (1, ?, ?)').run('P', at)
  const entry = insertEntry(db, { description: '', projectId: 1, startedAt: at, source: 'session', now: at })
  insertEntrySession(db, { entryId: entry.id, wrapperId: 'w', wrapperPid: 1, harness: 'antigravity', cwd: '/r', startedAt: at })
  const ctx = { db } as Parameters<typeof attachExitSession>[0]
  assert.equal(attachExitSession(ctx, 'other', { sessionId: 'c', transcriptPath: null }), false)
  assert.equal(attachExitSession(ctx, 'w', { sessionId: 'c', transcriptPath: '/t/c.db' }), true)
  assert.equal(findSessionByEntry(db, entry.id)?.sessionId, 'c')
  assert.equal(attachExitSession(ctx, 'w', { sessionId: 'd', transcriptPath: null }), false)
  db.close()
})

test('summarize asks agy headless in read mode and validates the answer', async () => {
  const dir = mkdtempSync(join(root, 'agy-'))
  const log = join(dir, 'argv.json')
  const reply = JSON.stringify({
    response: JSON.stringify({ title: 'Arreglar el bug', kind: 'dev', note: { context: 'c', done: 'd', decisions: null, findings: null, verification: null, pending: null } }),
    conversation_id: 'c1',
  })
  const fake = join(dir, 'agy')
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), headless: process.env.KIT_HEADLESS ?? null, wrapper: process.env.BITA_WRAPPER_ID ?? null }))\nprocess.stdout.write(${JSON.stringify(reply)})\n`)
  chmodSync(fake, 0o755)
  process.env[harnessBinEnvVar('antigravity')] = fake
  process.env['BITA_WRAPPER_ID'] = 'w-1'
  try {
    const result = await antigravityAdapter.summarize({
      turns: [{ role: 'user', text: 'arregla el bug' }],
      meta: { harness: 'antigravity', projectName: 'P', repo: null, branch: null, cwd: root, durationSeconds: 60, touchedFiles: [] },
      kinds: ['dev'],
      model: null,
      timeoutMs: 20_000,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const call = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; headless: string | null; wrapper: string | null }
    assert.ok(call.argv.includes('--mode'), call.argv.join(' '))
    assert.ok(!call.argv.includes('--dangerously-skip-permissions'))
    assert.ok(call.argv.includes('gemini-3.8-flash-low'))
    assert.equal(call.headless, '1')
    assert.equal(call.wrapper, null)
  } finally {
    delete process.env[harnessBinEnvVar('antigravity')]
    delete process.env['BITA_WRAPPER_ID']
  }
})

test('children lose the ANTIGRAVITY_ variables and get the binary dir first on PATH', () => {
  const env = childEnv({ PATH: '/usr/bin', ANTIGRAVITY_CONVERSATION_ID: 'c', ANTIGRAVITY_AGENT: '1', HOME: '/h' })
  assert.equal(env['ANTIGRAVITY_CONVERSATION_ID'], undefined)
  assert.equal(env['ANTIGRAVITY_AGENT'], undefined)
  assert.equal(env['HOME'], '/h')
  assert.equal(withBinOnPath({ PATH: '/usr/bin' }, '/opt/nvm/bin/gemini')['PATH'], `/opt/nvm/bin${delimiter}/usr/bin`)
  assert.equal(withBinOnPath({ PATH: `/opt/nvm/bin${delimiter}/usr/bin` }, '/opt/nvm/bin/gemini')['PATH'], `/opt/nvm/bin${delimiter}/usr/bin`)
  assert.deepEqual(withBinOnPath({ PATH: '/usr/bin' }, 'gemini'), { PATH: '/usr/bin' })
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\taskkill.exe')
  assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe')
})

test('a wrapper whose start time cannot be read counts as orphan after 24 hours', () => {
  const since = '2026-10-20T10:00:00.000Z'
  const probe = { alive: () => true, startedAt: () => null }
  assert.equal(wrapperAlive(1, since, { ...probe, now: Date.parse(since) + 23 * 3_600_000 }), true)
  assert.equal(wrapperAlive(1, since, { ...probe, now: Date.parse(since) + 25 * 3_600_000 }), false)
  assert.equal(wrapperAlive(1, since, { alive: () => false, startedAt: () => null, now: Date.parse(since) }), false)
  assert.equal(wrapperAlive(1, since, { alive: () => true, startedAt: () => Date.parse(since) + 60_000 }), false)
  assert.equal(processStartedAt(process.pid, 'win32'), null)
})

test('data and config dirs follow kit, but an existing older unix location wins', () => {
  const win = bitaDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a', exists: () => false })
  assert.deepEqual(win, { config: 'C:\\Users\\a\\AppData\\Roaming\\bita', data: 'C:\\Users\\a\\AppData\\Local\\bita' })
  assert.deepEqual(bitaDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/config' }, home: '/home/a', exists: () => false }), {
    config: '/x/config/bita',
    data: '/home/a/.local/share/bita',
  })
  assert.deepEqual(bitaDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/config' }, home: '/home/a', exists: (file) => file === '/home/a/.config/bita' }), {
    config: '/home/a/.config/bita',
    data: '/home/a/.local/share/bita',
  })
  assert.deepEqual(legacyRcFiles({ HOME: '/h' }, 'win32'), [])
  assert.equal(displayPath('C:\\Users\\a\\.zshrc', { HOME: 'C:\\Users\\a' }), '~\\.zshrc')
})

test('bita-timer looks for bita in the kit registry and the usual install dirs', () => {
  assert.equal(registryManifestPath({ HOME: '/h' }), '/h/.config/kikedealba/tools.d/bita.json')
  assert.equal(registryManifestPath({ HOME: '/h', XDG_CONFIG_HOME: '/c' }), '/c/kikedealba/tools.d/bita.json')
  assert.equal(registryManifestPath({ USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }), 'C:\\Users\\a\\AppData\\Roaming\\kikedealba\\tools.d\\bita.json')
  assert.deepEqual(manifestCommand(JSON.stringify({ bin: ['/usr/bin/node', '/x/bita.js'] })), ['/usr/bin/node', '/x/bita.js'])
  assert.equal(manifestCommand('{"bin":[]}'), null)
  assert.equal(manifestCommand('nope'), null)
  const unix = binaryCandidates({ HOME: '/h', NVM_BIN: '/h/.nvm/versions/node/v24/bin' })
  assert.deepEqual(unix[0], ['bita'])
  assert.ok(unix.some((candidate) => candidate[0] === '/h/.nvm/versions/node/v24/bin/bita'))
  assert.ok(unix.some((candidate) => candidate[0] === '/h/.local/bin/bita'))
  const windows = binaryCandidates({ USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })
  assert.ok(windows.some((candidate) => candidate[0] === 'C:\\Users\\a\\AppData\\Roaming\\npm\\bita.cmd'))
})
