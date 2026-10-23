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

export type CandidateEnv = Partial<
  Record<
    'HOME' | 'USERPROFILE' | 'APPDATA' | 'LOCALAPPDATA' | 'XDG_CONFIG_HOME' | 'KIT_REGISTRY_DIR' | 'PNPM_HOME' | 'NVM_BIN' | 'VOLTA_HOME' | 'BUN_INSTALL' | 'NPM_CONFIG_PREFIX',
    string
  >
>

function joinPath(windows: boolean, ...parts: string[]): string {
  return parts.join(windows ? '\\' : '/')
}

function isWindows(env: CandidateEnv): boolean {
  return env.HOME === undefined && (env.USERPROFILE !== undefined || env.APPDATA !== undefined)
}

export function registryManifestPath(env: CandidateEnv): string | null {
  const windows = isWindows(env)
  if (env.KIT_REGISTRY_DIR) return joinPath(windows, env.KIT_REGISTRY_DIR, 'bita.json')
  const config = windows ? env.APPDATA : (env.XDG_CONFIG_HOME ?? (env.HOME ? joinPath(false, env.HOME, '.config') : undefined))
  return config ? joinPath(windows, config, 'kikedealba', 'tools.d', 'bita.json') : null
}

export function manifestCommand(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const bin = typeof parsed === 'object' && parsed !== null ? (parsed as { bin?: unknown }).bin : undefined
    if (!Array.isArray(bin) || bin.length === 0 || !bin.every(part => typeof part === 'string' && part.length > 0)) return null
    return bin as string[]
  } catch {
    return null
  }
}

export function binaryCandidates(env: CandidateEnv): string[][] {
  const windows = isWindows(env)
  const home = windows ? (env.USERPROFILE ?? env.HOME) : env.HOME
  const name = windows ? 'bita.cmd' : 'bita'
  const dirs: string[] = []
  const add = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  add(env.PNPM_HOME)
  add(env.NVM_BIN)
  if (env.VOLTA_HOME) add(joinPath(windows, env.VOLTA_HOME, 'bin'))
  if (env.NPM_CONFIG_PREFIX) add(windows ? env.NPM_CONFIG_PREFIX : joinPath(false, env.NPM_CONFIG_PREFIX, 'bin'))
  if (env.BUN_INSTALL) add(joinPath(windows, env.BUN_INSTALL, 'bin'))
  if (windows) {
    if (env.APPDATA) add(joinPath(true, env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) add(joinPath(true, env.LOCALAPPDATA, 'pnpm'))
  } else if (home) {
    add(joinPath(false, home, '.local', 'share', 'pnpm'))
    add(joinPath(false, home, 'Library', 'pnpm'))
    add(joinPath(false, home, '.npm-global', 'bin'))
    add(joinPath(false, home, '.volta', 'bin'))
    add(joinPath(false, home, '.bun', 'bin'))
    add(joinPath(false, home, '.local', 'bin'))
  }
  return [['bita'], ...dirs.map(dir => [joinPath(windows, dir, name)])]
}
