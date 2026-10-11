import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { RunningTimer } from '../types'
import { BAND_PREFIX, bandText, isBitaCommand, parseEnvelope } from './timers.ts'

const timers = atom({ plugin: 'bita-timer', key: 'timers' } as const, [] as RunningTimer[])
const now = atom({ plugin: 'bita-timer', key: 'now' } as const, 0)

const REFRESH_MS = 30_000
const TICK_MS = 15_000
const MISSING_BACKOFF_MS = 300_000
const AFTER_COMMAND_MS = 250

let binary: string | null = null
let missingUntil = 0
let inFlight: Promise<void> | null = null
let isQueued = false
let loops: Timer[] = []

async function candidates($: EngineInterface): Promise<string[]> {
  const home = await $.env.get('HOME')
  const list = ['bita']
  if (home) list.push(`${home}/Library/pnpm/bin/bita`, `${home}/.local/bin/bita`)
  return binary === null ? list : [binary, ...list.filter(item => item !== binary)]
}

async function runBita($: EngineInterface, candidate: string): Promise<{ stdout: string; exitCode: number } | null> {
  try {
    return await $.process.run([candidate, 'ls', '--json'], { timeoutMs: 10_000 })
  } catch {
    return null
  }
}

async function fetchTimers($: EngineInterface): Promise<RunningTimer[] | null> {
  for (const candidate of await candidates($)) {
    const ran = await runBita($, candidate)
    if (ran === null) continue
    binary = candidate
    if (ran.exitCode !== 0) return null
    return parseEnvelope(ran.stdout, await $.clock.now())
  }
  binary = null
  return []
}

async function load($: EngineInterface, isForced: boolean): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!isForced && at < missingUntil) return
    const found = await fetchTimers($)
    if (found === null) return
    missingUntil = binary === null ? at + MISSING_BACKOFF_MS : 0
    await update($, now, () => at)
    await update($, timers, () => found)
  } catch {
    return
  }
}

function refresh($: EngineInterface, isForced = false): Promise<void> {
  if (inFlight !== null) {
    if (isForced) isQueued = true
    return inFlight
  }
  inFlight = (async () => {
    await load($, isForced)
    while (isQueued) {
      isQueued = false
      await load($, true)
    }
    inFlight = null
  })()
  return inFlight
}

async function tick($: EngineInterface): Promise<void> {
  try {
    const at = await $.clock.now()
    await update($, now, () => at)
  } catch {
    return
  }
}

function startLoops($: EngineInterface): void {
  for (const loop of loops) loop.cancel()
  loops = [
    $.clock.after(0, () => void refresh($, true)),
    $.clock.every(REFRESH_MS, () => void refresh($)),
    $.clock.every(TICK_MS, () => void tick($)),
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      startLoops($)
    } catch {
      return result
    }
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (isBitaCommand(e.command)) $.clock.after(AFTER_COMMAND_MS, () => void refresh($, true))
    } catch {
      return result
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const text = bandText(await read($, timers), await read($, now), e.props.bodyColumns)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {BAND_PREFIX}
          {text}
        </Text>
      </Box>
    )
  })
}
