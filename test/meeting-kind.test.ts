import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { matchingHooks, type HookConfig } from '../src/hooks/hooks.ts'
import { parseKind } from '../src/domain/kind.ts'
import { makeEntry } from './helpers/entries.ts'

const root = mkdtempSync(join(tmpdir(), 'bita-meeting-'))
const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const MEETING_KINDS = ['meeting', 'remote-meeting', 'in-person-meeting']

function bita(...args: string[]): { status: number | null; json: Record<string, unknown>; stderr: string } {
  const run = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: root, BITA_DB_PATH: join(root, 'bita.db'), BITA_CONFIG_PATH: join(root, 'config.json'), KIT_NO_EVENTS: '1', KIT_REGISTRY_DIR: join(root, 'registry') },
  })
  return { status: run.status, json: JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>, stderr: run.stderr }
}

test('meeting is a valid kind for start, log and amend', () => {
  assert.equal(parseKind('meeting'), 'meeting')
  const started = bita('start', 'Daily', '--kind', 'meeting', '--json')
  assert.equal(started.status, 0, started.stderr)
  const entry = started.json['data'] as { id: number; kind: string }
  assert.equal(entry.kind, 'meeting')

  const logged = bita('log', '1:1', '--kind', 'meeting', '--from', '08:00', '--for', '30m', '--json')
  assert.equal(logged.status, 0, logged.stderr)

  const amended = bita('amend', String(entry.id), '--kind', 'in-person-meeting', '--json')
  assert.equal(amended.status, 0, amended.stderr)
  const back = bita('amend', String(entry.id), '--kind', 'meeting', '--json')
  assert.equal(back.status, 0, back.stderr)
  assert.equal((bita('entries', 'get', String(entry.id), '--json').json['data'] as { kind: string }).kind, 'meeting')
})

test('a hook filtered by the meeting kinds hears meeting and the two older kinds, and nothing else', () => {
  const hooks: HookConfig[] = [{ on: ['start'], when: { kind: MEETING_KINDS }, command: ['meeting-hook'] }]
  for (const kind of MEETING_KINDS) {
    assert.equal(matchingHooks(hooks, { event: 'start', entry: makeEntry({ kind, running: true }), docPath: null }).length, 1, kind)
  }
  assert.equal(matchingHooks(hooks, { event: 'start', entry: makeEntry({ kind: 'dev', running: true }), docPath: null }).length, 0)
})
