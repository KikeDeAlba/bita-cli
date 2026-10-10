import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, test } from 'node:test'
import { assertConformance } from '@kikedealba/kit/conformance'
import { platformContext } from '@kikedealba/kit/platform'
import { manifest } from '../src/kit/integration.ts'
import { packageRoot } from '../src/kit/manifest.ts'

const repo = join(import.meta.dirname, '..')
const bin = join(repo, 'src', 'bin', 'bita.ts')
const root = mkdtempSync(join(tmpdir(), 'bita-kit-'))

after(() => rmSync(root, { recursive: true, force: true }))

function sandbox(name: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = join(root, name)
  mkdirSync(join(dir, 'registry'), { recursive: true })
  return {
    dir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_STATE_HOME: join(dir, 'state'),
      KIT_REGISTRY_DIR: join(dir, 'registry'),
      KIT_CREDENTIALS: 'file',
      BITA_DB_PATH: join(dir, 'bita.db'),
      BITA_DOCS_DIR: join(dir, 'docs'),
      BITA_CONFIG_PATH: join(dir, 'config.json'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    },
  }
}

function bita(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): { status: number | null; json: Record<string, unknown>; stderr: string } {
  const run = spawnSync(process.execPath, [bin, ...args, '--json'], { cwd, env, encoding: 'utf8' })
  const line = run.stdout.trim().split('\n').at(-1) ?? '{}'
  return { status: run.status, json: JSON.parse(line) as Record<string, unknown>, stderr: run.stderr }
}

function recorder(dir: string, out: string): string[] {
  const script = `${out}.recorder.cjs`
  writeFileSync(
    script,
    `let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  const event = JSON.parse(input)
  event.kitEnv = { event: process.env.KIT_EVENT, source: process.env.KIT_EVENT_SOURCE, entry: process.env.BITA_ENTRY_ID }
  require('node:fs').appendFileSync(${JSON.stringify(out)}, JSON.stringify(event) + '\\n')
})
`,
  )
  return [process.execPath, script]
}

async function received(path: string, count: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
      if (lines.length >= count) return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    }
    await sleep(25)
  }
  throw new Error(`expected ${count} events in ${path}, got: ${existsSync(path) ? readFileSync(path, 'utf8').split('\n').map((line) => line.slice(0, 40)).join(' | ') : 'nothing'}`)
}

test('capabilities answers the kit envelope with what bita offers', () => {
  const { dir, env } = sandbox('capabilities')
  const result = bita(env, dir, 'capabilities')
  assert.equal(result.status, 0)
  assert.equal(result.json['command'], 'capabilities')
  assert.equal(result.json['schemaVersion'], 3)
  assert.deepEqual(result.json['data'], {
    name: 'bita',
    version: manifest(packageRoot()).version,
    envelope: 1,
    capabilities: ['time.entries.read', 'time.entries.write', 'time.events'],
    emits: ['start', 'stop', 'cancel', 'amend', 'delete', 'merge'],
  })
})

test('bita passes the kit conformance checks', async () => {
  const { env } = sandbox('conformance')
  await assertConformance([process.execPath, bin], manifest(packageRoot()), platformContext({ env, home: env['HOME'] ?? '' }))
})

test('entries get returns one entry without a note', () => {
  const { dir, env } = sandbox('entries-get')
  assert.equal(bita(env, dir, 'project', 'add', 'Kit').status, 0)
  const started = bita(env, dir, 'start', 'Wire kit', '--project', 'Kit')
  assert.equal(started.status, 0, started.stderr)
  const id = (started.json['data'] as { id: number }).id
  const detail = bita(env, dir, 'entries', 'get', String(id))
  assert.equal(detail.status, 0, detail.stderr)
  assert.equal(detail.json['command'], 'entries get')
  const data = detail.json['data'] as Record<string, unknown>
  assert.deepEqual(Object.keys(data).sort(), ['description', 'durationSeconds', 'id', 'kind', 'mergedInto', 'projectId', 'projectName', 'segments', 'startedAt', 'stoppedAt'])
  assert.equal(data['id'], id)
  assert.equal(data['description'], 'Wire kit')
  assert.equal(data['projectName'], 'Kit')
  assert.equal(data['stoppedAt'], null)

  const missing = bita(env, dir, 'entries', 'get', '9999')
  assert.notEqual(missing.status, 0)
  assert.equal((missing.json['error'] as { code: string }).code, 'ENTRY_NOT_FOUND')
})

test('events reach registry subscribers and config hooks with the bita document', async () => {
  const { dir, env } = sandbox('events')
  const fromRegistry = join(dir, 'registry-events.ndjson')
  const fromConfig = join(dir, 'config-events.ndjson')
  writeFileSync(
    join(env['KIT_REGISTRY_DIR'] ?? '', 'listener.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'listener',
      version: '1.0.0',
      bin: [process.execPath],
      envelope: 1,
      capabilities: [],
      emits: [],
      subscribes: [{ tool: 'bita', events: ['start', 'stop', 'amend', 'delete', 'merge'], command: recorder(dir, fromRegistry) }],
    }),
  )
  writeFileSync(
    env['BITA_CONFIG_PATH'] ?? '',
    JSON.stringify({ version: 1, projectMapping: {}, scopeMapping: {}, hooks: [{ on: ['stop'], command: recorder(dir, fromConfig) }] }),
  )

  assert.equal(bita(env, dir, 'project', 'add', 'Events').status, 0)
  const first = bita(env, dir, 'start', 'First', '--project', 'Events')
  assert.equal(first.status, 0, first.stderr)
  const firstId = (first.json['data'] as { id: number }).id
  assert.equal((first.json['meta'] as { hooksFired: number }).hooksFired, 1)
  assert.equal(bita(env, dir, 'stop', String(firstId)).status, 0)
  const amended = bita(env, dir, 'amend', String(firstId), '--title', 'First renamed')
  assert.equal(amended.status, 0, amended.stderr)
  assert.equal((amended.json['data'] as { hooksFired: number }).hooksFired, 1)
  const unchanged = bita(env, dir, 'amend', String(firstId), '--title', 'First renamed')
  assert.equal((unchanged.json['data'] as { hooksFired: number }).hooksFired, 0)
  const second = bita(env, dir, 'start', 'Second', '--project', 'Events')
  const secondId = (second.json['data'] as { id: number }).id
  assert.equal(bita(env, dir, 'stop', String(secondId)).status, 0)
  const merged = bita(env, dir, 'merge', String(firstId), String(secondId))
  assert.equal(merged.status, 0, merged.stderr)
  const third = bita(env, dir, 'start', 'Third', '--project', 'Events')
  const thirdId = (third.json['data'] as { id: number }).id
  assert.equal(bita(env, dir, 'stop', String(thirdId)).status, 0)
  const deleted = bita(env, dir, 'delete', String(thirdId), '--yes')
  assert.equal(deleted.status, 0, deleted.stderr)
  assert.equal((deleted.json['meta'] as { hooksFired: number }).hooksFired, 1)

  const events = await received(fromRegistry, 9)
  assert.deepEqual(events.map((event) => String(event['event'])).sort(), ['amend', 'delete', 'merge', 'start', 'start', 'start', 'stop', 'stop', 'stop'])
  const find = (name: string, id: number) =>
    events.find((event) => event['event'] === name && (event['entry'] as { id: number }).id === id) ?? {}
  const start = find('start', firstId)
  assert.equal(start['source'], 'bita')
  assert.equal(start['schemaVersion'], 3)
  assert.equal((start['entry'] as { id: number }).id, firstId)
  assert.equal(start['databasePath'], env['BITA_DB_PATH'])
  assert.equal(start['docsRoot'], env['BITA_DOCS_DIR'])
  for (const event of events) {
    assert.deepEqual(event['pageIds'], [])
    assert.equal(event['docPath'], null)
    const entry = event['entry'] as Record<string, unknown>
    assert.equal('registered' in entry, false)
    assert.equal('issueKey' in entry, false)
  }
  assert.ok('previousKind' in start)
  const amend = find('amend', firstId)
  assert.equal(amend['previousTitle'], 'First')
  assert.equal((amend['entry'] as { description: string }).description, 'First renamed')
  assert.equal(typeof amend['previousProjectId'], 'number')
  assert.deepEqual(start['kitEnv'], { event: 'start', source: 'bita', entry: String(firstId) })
  assert.deepEqual(find('merge', firstId)['mergedIds'], [secondId])
  assert.equal(find('delete', thirdId)['event'], 'delete')

  const configEvents = await received(fromConfig, 3)
  assert.deepEqual(configEvents.map((event) => event['event']), ['stop', 'stop', 'stop'])
  assert.equal(configEvents[0]?.['source'], 'bita')
})

test('KIT_NO_EVENTS and BITA_NO_HOOKS keep every listener quiet', () => {
  const { dir, env } = sandbox('quiet')
  const out = join(dir, 'events.ndjson')
  writeFileSync(
    env['BITA_CONFIG_PATH'] ?? '',
    JSON.stringify({ version: 1, projectMapping: {}, scopeMapping: {}, hooks: [{ on: ['start'], command: recorder(dir, out) }] }),
  )
  for (const flag of ['KIT_NO_EVENTS', 'BITA_NO_HOOKS']) {
    const started = bita({ ...env, [flag]: '1' }, dir, 'start', `Quiet ${flag}`)
    assert.equal(started.status, 0, started.stderr)
    assert.equal((started.json['meta'] as { hooksFired: number }).hooksFired, 0)
  }
})

test('without node_modules the config hooks still fire', async () => {
  const { dir, env } = sandbox('standalone')
  const copy = join(dir, 'copy')
  cpSync(join(repo, 'src'), join(copy, 'src'), { recursive: true })
  cpSync(join(repo, 'package.json'), join(copy, 'package.json'))
  const out = join(dir, 'events.ndjson')
  writeFileSync(
    env['BITA_CONFIG_PATH'] ?? '',
    JSON.stringify({ version: 1, projectMapping: {}, scopeMapping: {}, hooks: [{ on: ['start'], command: recorder(dir, out) }] }),
  )
  const run = spawnSync(process.execPath, [join(copy, 'src', 'bin', 'bita.ts'), 'start', 'Vendored', '--json'], { cwd: copy, env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const [event] = await received(out, 1)
  assert.equal(event?.['event'], 'start')
  assert.equal(event?.['source'], 'bita')
})
