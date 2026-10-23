import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
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

interface BitaCommand {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
}

function siblingEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'bin', 'bita.ts'), join(here, '..', 'bin', 'bita.js')]) if (existsSync(candidate)) return candidate
  return null
}

function quoteForCmd(arg: string): string | null {
  if (/["%\r\n]/.test(arg)) return null
  return `"${arg}"`
}

export function bitaCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): BitaCommand | null {
  const bin = env['BITA_BIN']
  if (platform !== 'win32') return { command: bin ?? 'bita', args: [...args], windowsVerbatimArguments: false }
  if (!bin) {
    const entry = siblingEntry()
    return entry ? { command: 'node', args: [entry, ...args], windowsVerbatimArguments: false } : { command: 'bita.cmd', args: [...args], windowsVerbatimArguments: false }
  }
  if (!/\.(cmd|bat)$/i.test(bin)) return { command: bin, args: [...args], windowsVerbatimArguments: false }
  const quoted = [bin, ...args].map(quoteForCmd)
  if (quoted.some((part) => part === null)) return null
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return { command: win32.join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], windowsVerbatimArguments: true }
}

function runBita(args: string[], input?: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const spec = bitaCommand(args)
      if (!spec) {
        resolve()
        return
      }
      const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsVerbatimArguments: spec.windowsVerbatimArguments, windowsHide: true })
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
