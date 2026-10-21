import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

export interface RunOptions {
  input?: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
  stdoutPath?: string
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const KILL_GRACE_MS = 2_000
const EXIT_GRACE_MS = 2_000

export function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function resolveHarnessBin(envVar: string, name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[envVar]
  if (override) return isExecutable(override) ? override : null
  return findOnPath(name, env)
}

export function runProcess(bin: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdoutFd: number | null = null
    try {
      if (options.stdoutPath) stdoutFd = openSync(options.stdoutPath, 'w')
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: errorMessage(error), timedOut: false })
      return
    }
    const closeFd = () => {
      if (stdoutFd === null) return
      try {
        closeSync(stdoutFd)
      } catch {}
      stdoutFd = null
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let settled = false
    let killer: NodeJS.Timeout | undefined
    let drain: NodeJS.Timeout | undefined
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', stdoutFd ?? 'pipe', 'pipe'],
      detached: true,
    })
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {}
      }
    }
    const finish = (code: number | null, extra?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killer)
      clearTimeout(drain)
      closeFd()
      let out = Buffer.concat(stdout).toString('utf8')
      if (options.stdoutPath) {
        try {
          out = readFileSync(options.stdoutPath, 'utf8')
        } catch {}
      }
      const err = Buffer.concat(stderr).toString('utf8')
      resolve({ code, stdout: out, stderr: extra ? `${err}${err ? '\n' : ''}${extra}` : err, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      killer.unref()
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => finish(null, errorMessage(error)))
    child.once('close', (code) => finish(code))
    child.once('exit', (code) => {
      drain = setTimeout(() => {
        killGroup('SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code)
      }, EXIT_GRACE_MS)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

export function describeFailure(label: string, result: RunResult): string {
  if (result.timedOut) return `${label} timed out`
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('at '))
  const detail = (lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? '').slice(0, 400)
  return `${label} exited with code ${result.code ?? 'unknown'}${detail ? `: ${detail}` : ''}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}
