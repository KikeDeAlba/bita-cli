import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  UNTITLED,
  bandText,
  describeTimer,
  formatElapsed,
  isBitaCommand,
  parseEnvelope,
} from '../plugins/bita-timer/hooks/timers.ts'

const NOW = Date.parse('2026-10-10T18:00:00.000Z')

function envelope(data: unknown[], ok = true): string {
  return JSON.stringify({ schemaVersion: 3, ok, command: 'current', meta: { runningCount: data.length }, data })
}

describe('bita-timer formatElapsed', () => {
  it('formats hours and zero-padded minutes', () => {
    assert.equal(formatElapsed(0), '0:00')
    assert.equal(formatElapsed(59), '0:00')
    assert.equal(formatElapsed(60), '0:01')
    assert.equal(formatElapsed(5100), '1:25')
    assert.equal(formatElapsed(36000 + 540), '10:09')
    assert.equal(formatElapsed(-30), '0:00')
  })
})

describe('bita-timer parseEnvelope', () => {
  it('reads running timers from the ls --json envelope', () => {
    const timers = parseEnvelope(
      envelope([
        { id: 1, description: ' Revisar MR ', projectName: 'bita', start: '2026-10-10T16:35:00.000Z', durationSeconds: 5100, running: true },
        { id: 2, description: '', projectName: null, start: '2026-10-10T17:50:00.000Z', durationSeconds: 600, running: true },
      ]),
      NOW,
    )
    assert.deepEqual(timers, [
      { id: 1, title: 'Revisar MR', project: 'bita', startedAt: Date.parse('2026-10-10T16:35:00.000Z') },
      { id: 2, title: UNTITLED, project: null, startedAt: Date.parse('2026-10-10T17:50:00.000Z') },
    ])
  })

  it('falls back to durationSeconds when start is unusable', () => {
    const [timer] = parseEnvelope(envelope([{ id: 3, description: 'x', projectName: 'p', start: 'nope', durationSeconds: 120, running: true }]), NOW) ?? []
    assert.equal(timer?.startedAt, NOW - 120_000)
  })

  it('drops stopped and malformed entries', () => {
    const timers = parseEnvelope(
      envelope([
        { id: 4, description: 'done', projectName: 'p', start: '2026-10-10T10:00:00.000Z', running: false },
        { description: 'no id', start: '2026-10-10T10:00:00.000Z', running: true },
        { id: 5, description: 'no time', running: true },
        null,
        'text',
      ]),
      NOW,
    )
    assert.deepEqual(timers, [])
  })

  it('returns an empty list when nothing runs', () => {
    assert.deepEqual(parseEnvelope(envelope([], true), NOW), [])
  })

  it('returns null for errors and output that is not an envelope', () => {
    assert.equal(parseEnvelope(envelope([{ id: 1, description: 'x', start: '2026-10-10T10:00:00.000Z', running: true }], false), NOW), null)
    assert.equal(parseEnvelope('bita: command not found', NOW), null)
    assert.equal(parseEnvelope('', NOW), null)
    assert.equal(parseEnvelope('[]', NOW), null)
    assert.equal(parseEnvelope('{"ok":true,"data":[{"id":1', NOW), null)
  })
})

describe('bita-timer bandText', () => {
  const older = { id: 1, title: 'Revisar MR', project: 'bita', startedAt: NOW - 5_100_000 }
  const newer = { id: 2, title: UNTITLED, project: null, startedAt: NOW - 600_000 }

  it('draws nothing when no timer runs', () => {
    assert.equal(bandText([], NOW, 120), null)
  })

  it('draws title, project and elapsed time for one timer', () => {
    assert.equal(bandText([older], NOW, 120), 'Revisar MR · bita · 1:25')
    assert.equal(describeTimer(newer, NOW), `${UNTITLED} · 0:10`)
  })

  it('lists every timer, newest first, when they fit', () => {
    assert.equal(bandText([older, newer], NOW, 120), `${UNTITLED} · 0:10  |  Revisar MR · bita · 1:25`)
  })

  it('counts the band prefix when deciding whether the list fits', () => {
    const full = `${UNTITLED} · 0:10  |  Revisar MR · bita · 1:25`
    assert.equal(bandText([older, newer], NOW, full.length), `${UNTITLED} · 0:10  +1 más · 1:35 en total`)
    assert.equal(bandText([older, newer], NOW, full.length + 3), full)
  })

  it('condenses several timers when they do not fit', () => {
    assert.equal(bandText([older, newer], NOW, 30), `${UNTITLED} · 0:10  +1 más · 1:35 en total`)
  })

  it('updates the elapsed time from the local clock alone', () => {
    assert.equal(bandText([older], NOW + 60_000, 120), 'Revisar MR · bita · 1:26')
  })
})

describe('bita-timer isBitaCommand', () => {
  it('matches commands that run bita', () => {
    assert.equal(isBitaCommand('bita start "x"'), true)
    assert.equal(isBitaCommand('  bita ls --json'), true)
    assert.equal(isBitaCommand('cd repo && bita stop'), true)
    assert.equal(isBitaCommand('git status; bita amend 3 --title y'), true)
    assert.equal(isBitaCommand('bita'), true)
    assert.equal(isBitaCommand('cd repo\nbita stop'), true)
    assert.equal(isBitaCommand('echo $(bita ls --json)'), true)
    assert.equal(isBitaCommand('TZ=UTC bita entries'), true)
    assert.equal(isBitaCommand('time bita ls'), true)
    assert.equal(isBitaCommand('~/.local/bin/bita start x'), true)
    assert.equal(isBitaCommand('/Users/me/Library/pnpm/bin/bita stop'), true)
  })

  it('ignores other commands', () => {
    assert.equal(isBitaCommand('git commit -m "bita fix"'), false)
    assert.equal(isBitaCommand('echo bitacora'), false)
    assert.equal(isBitaCommand('bitacora start'), false)
    assert.equal(isBitaCommand('ls ~/bita-cli'), false)
    assert.equal(isBitaCommand('cat bita.db'), false)
    assert.equal(isBitaCommand(undefined), false)
  })
})
