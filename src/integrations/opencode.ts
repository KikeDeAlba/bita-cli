import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

interface OpenCodeContext {
  location: { directory: string }
  session: {
    hook(name: 'prompt', callback: (event: { sessionID: string }) => Promise<void>): Promise<unknown>
    get?(input: { sessionID: string }): Promise<{ parentID?: string | null } | null | undefined>
  }
  tool: {
    hook(name: 'execute.after', callback: (event: { tool: string; input: unknown; result?: unknown }) => Promise<void>): Promise<unknown>
  }
}

function flagSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0'
}

function insideWrapper(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagSet(env['BITA_WRAPPER_ID']) && !flagSet(env['BITA_CHILD'])
}

export const LAUNCHER_FILE = 'bita-launcher.json'
export const LAUNCHER_ENV = 'BITA_OPENCODE_LAUNCHER'

interface Launcher {
  command: string
  args: string[]
  cwd: string | null
  log: string | null
}

export interface BitaCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  windowsVerbatimArguments: boolean
}

export type BitaCommandResult = { ok: true; spec: BitaCommand } | { ok: false; reason: string; log: string | null }

export function isUncPath(file: string): boolean {
  return /^[\\/]{2}/.test(file)
}

function isAbsoluteFor(file: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(file) : isAbsolute(file)
}

function launcherCandidates(env: NodeJS.ProcessEnv): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const list: string[] = []
  const add = (file: string | undefined) => {
    if (file && !list.includes(file)) list.push(file)
  }
  const fromEnv = env[LAUNCHER_ENV]
  add(fromEnv && !isUncPath(fromEnv) ? fromEnv : undefined)
  add(join(here, '..', LAUNCHER_FILE))
  add(env['OPENCODE_CONFIG_DIR'] ? join(env['OPENCODE_CONFIG_DIR'], LAUNCHER_FILE) : undefined)
  add(env['XDG_CONFIG_HOME'] ? join(env['XDG_CONFIG_HOME'], 'opencode', LAUNCHER_FILE) : undefined)
  add(env['APPDATA'] ? join(env['APPDATA'], 'opencode', LAUNCHER_FILE) : undefined)
  const home = env['HOME'] || env['USERPROFILE']
  add(home ? join(home, '.config', 'opencode', LAUNCHER_FILE) : undefined)
  return list
}

export function readLauncher(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Launcher | null {
  for (const file of launcherCandidates(env)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const command = record['command']
    const args = record['args']
    if (typeof command !== 'string' || !isAbsoluteFor(command, platform) || isUncPath(command)) continue
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) continue
    return {
      command,
      args: args as string[],
      cwd: typeof record['cwd'] === 'string' && isAbsoluteFor(record['cwd'], platform) ? record['cwd'] : null,
      log: typeof record['log'] === 'string' && isAbsoluteFor(record['log'], platform) ? record['log'] : null,
    }
  }
  return null
}

function cmdExe(env: NodeJS.ProcessEnv): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return win32.join(root, 'System32', 'cmd.exe')
}

export function viaCmd(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): { args: string[]; env: NodeJS.ProcessEnv } | null {
  const values = [bin, ...args]
  if (values.some((value) => /["\r\n\0]/.test(value))) return null
  const next: NodeJS.ProcessEnv = { ...env }
  const parts = values.map((value, index) => {
    const name = `BITA_HOOK_ARG_${index}`
    next[name] = value.replace(/(\\+)$/, '$1$1')
    return `"%${name}%"`
  })
  return { args: ['/d', '/v:off', '/s', '/c', `"${parts.join(' ')}"`], env: next }
}

export function bitaCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): BitaCommandResult {
  const launcher = readLauncher(env, platform)
  const log = launcher?.log ?? null
  const cwd = launcher?.cwd ?? tmpdir()
  const bin = env['BITA_BIN']
  const direct = (command: string, prefix: readonly string[]): BitaCommandResult => {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
      const wrapped = viaCmd(command, [...prefix, ...args], env)
      if (!wrapped) return { ok: false, reason: 'an argument has quotes or line breaks that cmd.exe cannot carry', log }
      return { ok: true, spec: { command: cmdExe(env), args: wrapped.args, env: wrapped.env, cwd, windowsVerbatimArguments: true } }
    }
    return { ok: true, spec: { command, args: [...prefix, ...args], env, cwd, windowsVerbatimArguments: false } }
  }
  if (bin) {
    if (!isAbsoluteFor(bin, platform)) return { ok: false, reason: `BITA_BIN must be an absolute path: ${bin}`, log }
    if (isUncPath(bin)) return { ok: false, reason: `BITA_BIN cannot be a network path: ${bin}`, log }
    return direct(bin, [])
  }
  if (launcher) return direct(launcher.command, launcher.args)
  if (platform === 'win32') return { ok: false, reason: `no ${LAUNCHER_FILE} next to the opencode plugin; run bita setup`, log }
  return direct('bita', [])
}

function logLost(log: string | null, args: readonly string[], reason: string): void {
  if (!log) return
  try {
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, `${new Date().toISOString()} opencode plugin: bita ${args.slice(0, 2).join(' ')} was not run: ${reason}\n`)
  } catch {
    return
  }
}

function runBita(args: string[], input?: string): Promise<void> {
  return new Promise((resolve) => {
    const result = bitaCommand(args)
    if (!result.ok) {
      logLost(result.log, args, result.reason)
      resolve()
      return
    }
    const { spec } = result
    try {
      const child = spawn(spec.command, spec.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: spec.env,
        cwd: spec.cwd,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        windowsHide: true,
      })
      child.once('error', () => resolve())
      child.once('close', () => resolve())
      child.stdin.on('error', () => undefined)
      if (input === undefined) child.stdin.end()
      else child.stdin.end(input)
    } catch {
      resolve()
    }
  })
}

function filePaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  return ['filePath', 'file_path', 'path', 'filename', 'file']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

const EDIT_TOOLS = /^(edit|write|patch|multiedit)$/i

async function isSubsession(ctx: OpenCodeContext, sessionID: string): Promise<boolean> {
  if (typeof ctx.session.get !== 'function') return false
  try {
    const info = await ctx.session.get({ sessionID })
    return typeof info?.parentID === 'string' && info.parentID.length > 0
  } catch {
    return false
  }
}

export default {
  id: 'bita',
  async setup(ctx: OpenCodeContext) {
    await ctx.tool.hook('execute.after', async (event) => {
      if (!EDIT_TOOLS.test(event.tool)) return
      for (const file of filePaths(event.input)) {
        await runBita(['hook', 'touched', '--file', file])
      }
    })

    if (!insideWrapper()) return () => undefined

    const seen = new Set<string>()
    const children = new Set<string>()

    await ctx.session.hook('prompt', async (event) => {
      if (seen.has(event.sessionID) || children.has(event.sessionID)) return
      if (await isSubsession(ctx, event.sessionID)) {
        children.add(event.sessionID)
        return
      }
      if (seen.has(event.sessionID)) return
      const source = seen.size === 0 ? 'startup' : 'clear'
      seen.add(event.sessionID)
      await runBita(
        ['hook', 'session-start', '--harness', 'opencode'],
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: event.sessionID,
          cwd: ctx.location.directory,
          source,
        }),
      )
    })

    return () => {
      seen.clear()
      children.clear()
    }
  },
}
