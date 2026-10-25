import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { delimiter } from 'node:path'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeBin, readFakeBinCalls } from './helpers/fake-bin.ts'
import { openDatabase } from '../src/db/open.ts'
import { queryAll } from '../src/db/query.ts'
import { runBita, seededDb, type SeededDb } from './helpers/sessions-seed.ts'

function launchEnv(box: SeededDb): NodeJS.ProcessEnv {
  const nodeDir = join(box.root, 'node-bin')
  mkdirSync(nodeDir, { recursive: true })
  if (!existsSync(join(nodeDir, 'node'))) symlinkSync(process.execPath, join(nodeDir, 'node'))
  return {
    PATH: [nodeDir, '/usr/bin', '/bin'].join(delimiter),
    BITA_HARNESS_BIN_CLAUDE: existsSync(join(box.root, 'fake-claude')) ? join(box.root, 'fake-claude') : createFakeBin(box.root, 'fake-claude'),
    BITA_HARNESS_BIN_CODEX: join(box.root, 'missing'),
    BITA_HARNESS_BIN_GEMINI: join(box.root, 'missing'),
    BITA_HARNESS_BIN_OPENCODE: join(box.root, 'missing'),
    BITA_HARNESS_BIN_ANTIGRAVITY: join(box.root, 'missing'),
    FAKE_BIN_LOG: join(box.root, 'calls.jsonl'),
  }
}

function claudeArgv(box: SeededDb): string[][] {
  return readFakeBinCalls(join(box.root, 'calls.jsonl')).map((call) => call.argv)
}

function entryCount(box: SeededDb): number {
  const db = openDatabase(box.dbPath)
  try {
    return queryAll<{ id: number }>(db.prepare('SELECT id FROM entries')).length
  } finally {
    db.close()
  }
}

const PROMPTS = [
  '-leading-dash',
  '-',
  '--looks-like-a-flag',
  '- bullet list item',
  'say "hello" and \'bye\'',
  `it's "quoted" -- with a double dash`,
  '$HOME `date` $(id) ; echo hi',
  'multi\nline prompt',
  'ñandú — acción',
]

for (const prompt of PROMPTS) {
  test(`work --prompt=${JSON.stringify(prompt)} reaches the harness as one argument after --`, () => {
    const box = seededDb()
    try {
      const here = box.dir('prompt')
      const run = runBita(box, here, ['work', '--harness', 'claude', '--project', '0', `--prompt=${prompt}`], launchEnv(box))
      assert.equal(run.status, 0, run.stderr)
      const [argv] = claudeArgv(box)
      assert.deepEqual(argv?.slice(-2), ['--', prompt])
      assert.equal(argv?.filter((arg) => arg === prompt).length, 1)
    } finally {
      box.cleanup()
    }
  })
}

test('work --prompt with a plain value in the separate form also arrives intact, quotes included', () => {
  const box = seededDb()
  try {
    const run = runBita(box, box.dir('prompt-sep'), ['work', '--harness', 'claude', '--project', '0', '--prompt', 'say "hi" it\'s ok'], launchEnv(box))
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(claudeArgv(box)[0]?.slice(-2), ['--', 'say "hi" it\'s ok'])
  } finally {
    box.cleanup()
  }
})

for (const prompt of ['-x']) {
  test(`work --prompt ${prompt} in the separate form is a usage error that names the --prompt=VALUE form and launches nothing`, () => {
    const box = seededDb()
    try {
      const run = runBita(box, box.dir('prompt-dash'), ['work', '--harness', 'claude', '--project', '0', '--prompt', prompt], launchEnv(box))
      assert.equal(run.status, 2, `${run.stdout}${run.stderr}`)
      assert.match(run.stderr + run.stdout, /--prompt=/)
      assert.deepEqual(claudeArgv(box), [])
      assert.equal(entryCount(box), 0)
    } finally {
      box.cleanup()
    }
  })
}

test('work --prompt with an empty or blank value is a usage error and launches nothing', () => {
  const box = seededDb()
  try {
    for (const value of ['--prompt=', '--prompt=   ']) {
      const run = runBita(box, box.dir('prompt-empty'), ['work', '--harness', 'claude', '--project', '0', value], launchEnv(box))
      assert.equal(run.status, 2, `${value}: ${run.stdout}${run.stderr}`)
    }
    assert.deepEqual(claudeArgv(box), [])
  } finally {
    box.cleanup()
  }
})

test('work --resume --session by row id and by harness session id resumes the same conversation without a terminal', () => {
  const box = seededDb()
  try {
    const stored = box.dir('resume-stored')
    const row = box.add({ cwd: stored, sessionId: 'conv-uuid-1', projectId: box.alpha, startedAt: '2026-09-10T10:00:00Z' })
    const byRow = runBita(box, box.dir('elsewhere'), ['work', '--resume', '--session', String(row.rowId)], launchEnv(box))
    assert.equal(byRow.status, 0, byRow.stderr)
    const byId = runBita(box, box.dir('elsewhere-2'), ['work', '--resume', '--session', 'conv-uuid-1'], launchEnv(box))
    assert.equal(byId.status, 0, byId.stderr)
    const calls = readFakeBinCalls(join(box.root, 'calls.jsonl'))
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.deepEqual(call.argv.slice(-2), ['--resume', 'conv-uuid-1'])
      assert.equal(call.cwd, stored)
    }
  } finally {
    box.cleanup()
  }
})

test('work --resume --session of an unknown row id or session id fails with a usage error, launches nothing and creates no entry', () => {
  const box = seededDb()
  try {
    const stored = box.dir('resume-missing')
    box.add({ cwd: stored, sessionId: 'known', startedAt: '2026-09-10T10:00:00Z' })
    const before = entryCount(box)
    for (const ref of ['424242', 'no-such-session', '0', '1.5', 'KNOWN']) {
      const run = runBita(box, stored, ['work', '--resume', '--session', ref], launchEnv(box))
      assert.equal(run.status, 2, `${ref}: ${run.stdout}${run.stderr}`)
      assert.match(run.stderr + run.stdout, /No finished harness session/, ref)
    }
    const negative = runBita(box, stored, ['work', '--resume', '--session', '-1'], launchEnv(box))
    assert.equal(negative.status, 2)
    assert.deepEqual(claudeArgv(box), [])
    assert.equal(entryCount(box), before)
  } finally {
    box.cleanup()
  }
})

test('work --resume --session trims the id and rejects blank ones', () => {
  const box = seededDb()
  try {
    const stored = box.dir('resume-trim')
    box.add({ cwd: stored, sessionId: 'trim-me', startedAt: '2026-09-10T10:00:00Z' })
    const padded = runBita(box, stored, ['work', '--resume', '--session', '  trim-me  '], launchEnv(box))
    assert.equal(padded.status, 0, padded.stderr)
    const blank = runBita(box, stored, ['work', '--resume', '--session', '   '], launchEnv(box))
    assert.equal(blank.status, 2)
  } finally {
    box.cleanup()
  }
})

test('work --resume --session: a harness session id that is numeric loses against a row with that number, never silently resuming the wrong row', () => {
  const box = seededDb()
  try {
    const stored = box.dir('resume-collision')
    const first = box.add({ cwd: stored, sessionId: 'plain-uuid', startedAt: '2026-09-10T10:00:00Z' })
    const second = box.add({ cwd: stored, sessionId: String(first.rowId), startedAt: '2026-09-11T10:00:00Z' })
    assert.notEqual(first.rowId, second.rowId)
    const run = runBita(box, stored, ['work', '--resume', '--session', String(first.rowId)], launchEnv(box))
    assert.equal(run.status, 0, run.stderr)
    const resumed = claudeArgv(box)[0]?.at(-1)
    assert.ok(resumed === 'plain-uuid' || resumed === String(first.rowId))
    assert.equal(resumed, 'plain-uuid', 'a number is documented as a row id (sessions ls "id"), so it must win')
  } finally {
    box.cleanup()
  }
})

test('work --resume --session combined with --prompt keeps both, in order', () => {
  const box = seededDb()
  try {
    const stored = box.dir('resume-prompt')
    const row = box.add({ cwd: stored, sessionId: 'rp-1', startedAt: '2026-09-10T10:00:00Z' })
    const run = runBita(box, stored, ['work', '--resume', '--session', String(row.rowId), '--prompt=-keep going "now"'], launchEnv(box))
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(claudeArgv(box)[0]?.slice(-4), ['--resume', 'rp-1', '--', '-keep going "now"'])
  } finally {
    box.cleanup()
  }
})
