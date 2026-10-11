import type { RunningTimer } from '../types/index.d.ts'

export const UNTITLED = 'sin título'

export const BAND_PREFIX = '⏱ '

export function parseEnvelope(text: string, now: number): RunningTimer[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed['ok'] !== true || !Array.isArray(parsed['data'])) return null
  const timers: RunningTimer[] = []
  for (const item of parsed['data']) {
    const timer = toTimer(item, now)
    if (timer) timers.push(timer)
  }
  return timers
}

function toTimer(item: unknown, now: number): RunningTimer | null {
  if (!isRecord(item) || item['running'] === false) return null
  const id = item['id']
  if (typeof id !== 'number') return null
  const description = typeof item['description'] === 'string' ? item['description'].trim() : ''
  const projectName = typeof item['projectName'] === 'string' && item['projectName'].trim() !== '' ? item['projectName'].trim() : null
  const startedAt = startOf(item, now)
  if (startedAt === null) return null
  return { id, title: description === '' ? UNTITLED : description, project: projectName, startedAt }
}

function startOf(item: Record<string, unknown>, now: number): number | null {
  const start = item['start']
  if (typeof start === 'string') {
    const ms = Date.parse(start)
    if (Number.isFinite(ms)) return ms
  }
  const seconds = item['durationSeconds']
  if (typeof seconds === 'number' && Number.isFinite(seconds)) return now - seconds * 1000
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  const hours = Math.floor(minutes / 60)
  return `${hours}:${String(minutes % 60).padStart(2, '0')}`
}

export function elapsedSeconds(timer: RunningTimer, now: number): number {
  return Math.max(0, Math.floor((now - timer.startedAt) / 1000))
}

export function describeTimer(timer: RunningTimer, now: number): string {
  const parts = [timer.title]
  if (timer.project !== null) parts.push(timer.project)
  parts.push(formatElapsed(elapsedSeconds(timer, now)))
  return parts.join(' · ')
}

export function bandText(timers: readonly RunningTimer[], now: number, columns: number): string | null {
  if (timers.length === 0) return null
  const ordered = [...timers].sort((a, b) => b.startedAt - a.startedAt)
  const full = ordered.map((timer) => describeTimer(timer, now)).join('  |  ')
  if (ordered.length === 1 || full.length + BAND_PREFIX.length + 1 <= columns) return full
  const total = ordered.reduce((sum, timer) => sum + elapsedSeconds(timer, now), 0)
  const suffix = `  +${ordered.length - 1} más · ${formatElapsed(total)} en total`
  const [first] = ordered
  return `${describeTimer(first!, now)}${suffix}`
}

const BITA_COMMAND = /(?:^|[;&|(`\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:time|exec|command|nohup)\s+)*(?:\S*\/)?bita(?=\s|$|[;&|)`])/

export function isBitaCommand(command: unknown): boolean {
  return typeof command === 'string' && BITA_COMMAND.test(command)
}
