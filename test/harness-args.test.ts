import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getAdapter, harnessBinEnvVar, listAdapters } from '../src/harness/registry.ts'
import type { HarnessId, LaunchPlan } from '../src/harness/types.ts'
import { createFakeBin } from './helpers/fake-bin.ts'

const plan = (id: HarnessId, args: string[]): LaunchPlan => getAdapter(id).launchArgs(args)

test('registry lists the adapters in the fixed order', () => {
  assert.deepEqual(listAdapters().map((adapter) => adapter.id), ['claude', 'opencode', 'codex', 'gemini'])
  assert.deepEqual(listAdapters().map((adapter) => adapter.bin), ['claude', 'opencode', 'codex', 'gemini'])
  assert.equal(getAdapter('codex').label, 'Codex')
})

test('resolveBin prefers an executable override and falls back to PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-harness-bin-'))
  try {
    const fake = createFakeBin(dir, 'gemini-fake')
    const onPath = createFakeBin(dir, 'opencode')
    const adapter = getAdapter('gemini')
    assert.equal(adapter.resolveBin({ PATH: '', [harnessBinEnvVar('gemini')]: fake }), fake)
    assert.equal(adapter.resolveBin({ PATH: '', [harnessBinEnvVar('gemini')]: join(dir, 'missing') }), null)
    assert.equal(adapter.available({ PATH: '' }), false)
    assert.equal(getAdapter('opencode').resolveBin({ PATH: `/nonexistent:${dir}` }), onPath)
    assert.equal(getAdapter('opencode').available({ PATH: dir }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claude passes everything through and adds the permission flag once', () => {
  assert.deepEqual(plan('claude', []), { args: ['--allow-dangerously-skip-permissions'], warnings: [] })
  assert.deepEqual(plan('claude', ['-c', '--model', 'opus', 'hola']).args, ['--allow-dangerously-skip-permissions', '-c', '--model', 'opus', 'hola'])
  assert.deepEqual(plan('claude', ['--allow-dangerously-skip-permissions', '-r', 'x']).args, ['--allow-dangerously-skip-permissions', '-r', 'x'])
  assert.deepEqual(plan('claude', ['--dangerously-skip-permissions']).args, ['--dangerously-skip-permissions'])
  assert.deepEqual(plan('claude', ['--', '--dangerously-skip-permissions']).args, ['--allow-dangerously-skip-permissions', '--', '--dangerously-skip-permissions'])
})

test('codex translates continue, resume and the prompt', () => {
  const flag = '--dangerously-bypass-approvals-and-sandbox'
  assert.deepEqual(plan('codex', []), { args: [flag], warnings: [] })
  assert.deepEqual(plan('codex', ['-c']).args, ['resume', '--last', flag])
  assert.deepEqual(plan('codex', ['--continue', 'sigue']).args, ['resume', '--last', flag, 'sigue'])
  assert.deepEqual(plan('codex', ['-r', 'abc']).args, ['resume', 'abc', flag])
  assert.deepEqual(plan('codex', ['--resume=abc']).args, ['resume', 'abc', flag])
  assert.deepEqual(plan('codex', ['-r']).args, ['resume', flag])
  assert.deepEqual(plan('codex', ['-r', '--verbose']).args, ['resume', flag])
  assert.deepEqual(plan('codex', ['update', 'the', 'docs']).args, [flag, 'update the docs'])
  assert.deepEqual(plan('codex', ['--dangerously-skip-permissions', 'x']), { args: [flag, 'x'], warnings: [] })
})

test('gemini translates and keeps its own approval flags', () => {
  assert.deepEqual(plan('gemini', []), { args: ['--approval-mode=yolo'], warnings: [] })
  assert.deepEqual(plan('gemini', ['-c']).args, ['--approval-mode=yolo', '--resume', 'latest'])
  assert.deepEqual(plan('gemini', ['-r']).args, ['--approval-mode=yolo', '--resume', 'latest'])
  assert.deepEqual(plan('gemini', ['--resume', 'abc']).args, ['--approval-mode=yolo', '--resume', 'abc'])
  assert.deepEqual(plan('gemini', ['arregla', 'el', 'bug']).args, ['--approval-mode=yolo', '-i', 'arregla el bug'])
  assert.deepEqual(plan('gemini', ['--yolo', 'x']).args, ['--yolo', '-i', 'x'])
  assert.deepEqual(plan('gemini', ['-y']).args, ['-y'])
  assert.deepEqual(plan('gemini', ['--approval-mode', 'auto_edit', 'x']).args, ['--approval-mode=auto_edit', '-i', 'x'])
  assert.deepEqual(plan('gemini', ['--approval-mode=plan']).args, ['--approval-mode=plan'])
  assert.deepEqual(plan('gemini', ['--allow-dangerously-skip-permissions']).warnings, [])
})

test('opencode translates continue, resume with id and the prompt', () => {
  assert.deepEqual(plan('opencode', []), { args: ['--auto'], warnings: [] })
  assert.deepEqual(plan('opencode', ['-c']).args, ['--auto', '--continue'])
  assert.deepEqual(plan('opencode', ['-r', 'ses_1']).args, ['--auto', '--session', 'ses_1'])
  assert.deepEqual(plan('opencode', ['hola', 'mundo']).args, ['--auto', '--prompt', 'hola mundo'])
  assert.deepEqual(plan('opencode', ['-r']), { args: ['--auto'], warnings: ['bita: OpenCode has no equivalent for --resume; dropped.'] })
})

test('unknown flags are dropped with one warning each and consume their values', () => {
  for (const id of ['codex', 'gemini', 'opencode'] as const) {
    const label = getAdapter(id).label
    const result = plan(id, ['--model', 'opus', '--verbose', '--settings={"a":1}', '--add-dir', '/tmp/x', 'prompt'])
    assert.deepEqual(result.warnings, [
      `bita: ${label} has no equivalent for --model; dropped.`,
      `bita: ${label} has no equivalent for --verbose; dropped.`,
      `bita: ${label} has no equivalent for --settings; dropped.`,
      `bita: ${label} has no equivalent for --add-dir; dropped.`,
    ])
    assert.ok(!result.args.includes('opus'))
    assert.ok(!result.args.includes('/tmp/x'))
    assert.ok(result.args.some((arg) => arg === 'prompt'))
  }
})

test('tokens after a literal -- are positional', () => {
  assert.deepEqual(plan('codex', ['--', '-c', 'texto']).args, ['--dangerously-bypass-approvals-and-sandbox', '-c texto'])
})
