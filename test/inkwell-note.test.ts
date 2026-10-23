import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NOTE_HEADINGS, writeEntryNote } from '../src/integrations/inkwell.ts'
import type { SessionNote } from '../src/harness/types.ts'

const NOTE: SessionNote = {
  context: 'Por qué',
  done: 'Lo hecho',
  decisions: null,
  findings: 'Algo raro',
  verification: '  ',
  pending: 'Falta X',
}

const FAKE_INKWELL = `const fs = require('node:fs')
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input, child: process.env.BITA_CHILD ?? null }) + '\\n')
  const fail = process.argv.includes('Hallazgos')
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: !fail, command: 'note save', generatedAt: new Date().toISOString(), ...(fail ? { error: { code: 'X', message: 'nope' } } : { data: {} }) }))
  process.exit(fail ? 1 : 0)
})
`

function registry(dir: string, bin: string): string {
  const registryDir = join(dir, 'tools.d')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'inkwell.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'inkwell',
      version: '0.5.0',
      bin: [process.execPath, bin],
      envelope: 1,
      capabilities: ['docs.entry-notes'],
      emits: [],
      subscribes: [],
    }),
  )
  return registryDir
}

test('writeEntryNote saves one section per non-empty field, in order, with the files only on «Qué se hizo»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-inkwell-'))
  try {
    const bin = join(dir, 'inkwell')
    writeFileSync(bin, `#!${process.execPath}\n${FAKE_INKWELL}`)
    chmodSync(bin, 0o755)
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}')
    const log = join(dir, 'calls.jsonl')
    const env = { ...process.env, KIT_REGISTRY_DIR: registry(dir, bin), FAKE_LOG: log, BITA_CHILD: '1' }
    const files = Array.from({ length: 60 }, (_, index) => `/repo/f${index}.ts`)

    const result = await writeEntryNote(42, NOTE, { cwd: dir, touchedFiles: files, env })

    assert.equal(result.written, 3)
    assert.match(result.error ?? '', /Hallazgos/)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string; child: string | null })
    assert.deepEqual(
      calls.map((call) => call.args[call.args.indexOf('--section') + 1]),
      [NOTE_HEADINGS.context, NOTE_HEADINGS.done, NOTE_HEADINGS.findings, NOTE_HEADINGS.pending],
    )
    assert.deepEqual(calls[0]?.args.slice(0, 8), ['note', 'save', '42', '--section', 'Contexto', '--md', '-', '--json'])
    assert.equal(calls[0]?.input, 'Por qué')
    assert.equal(calls[0]?.args.includes('--file'), false)
    assert.equal(calls[1]?.args.filter((arg) => arg === '--file').length, 50)
    assert.equal(calls[1]?.input, 'Lo hecho')
    assert.equal(calls[3]?.args.includes('--file'), false)
    assert.ok(calls.every((call) => call.child === '1'))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('writeEntryNote reports inkwell missing without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-inkwell-none-'))
  try {
    const result = await writeEntryNote(1, NOTE, { cwd: dir, touchedFiles: [], env: { ...process.env, KIT_REGISTRY_DIR: dir } })
    assert.deepEqual(result, { written: 0, error: 'inkwell not found' })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
