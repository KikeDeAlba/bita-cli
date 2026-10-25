import { spawn } from 'node:child_process'
import { openDatabase } from '../../db/open.ts'
import { databasePath } from '../../db/paths.ts'
import { killTree, spawnCommand } from '../../harness/process.ts'
import { isHarnessId } from '../../harness/registry.ts'
import type { HarnessId } from '../../harness/types.ts'
import {
  appendHookLog,
  currentSessionEntryId,
  handleSessionEnd,
  handleSessionStart,
  isHeadless,
  wrapperEnv,
  type WrapperEnv,
} from '../../domain/session.ts'
import { createLocalContext } from '../local-context.ts'
import { runTouched } from '../hooks/touched.ts'

export { currentSessionEntryId } from '../../domain/session.ts'

const SILENT_EVENTS = new Set(['prompt', 'prompt-submit', 'checkpoint'])

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function inputRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function parseInput(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function touchedFiles(input: unknown): string[] {
  const record = inputRecord(input)
  const paths = ['filePath', 'file_path', 'path', 'filename', 'file']
    .map((key) => stringValue(record[key]))
    .filter((path): path is string => path !== undefined)
  const command = stringValue(record.command)
  if (command) {
    for (const match of command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      const path = stringValue(match[1])
      if (path) paths.push(path)
    }
  }
  return [...new Set(paths)]
}

export function touchedFilesFromHookInput(raw: string): string[] {
  const parsed = parseInput(raw)
  return parsed ? touchedFiles(inputRecord(parsed.tool_input)) : []
}

function harnessFlag(argv: readonly string[], fallback: HarnessId): HarnessId | null {
  const inline = argv.find((arg) => arg.startsWith('--harness='))
  const index = argv.indexOf('--harness')
  const value = inline ? inline.slice('--harness='.length) : index === -1 ? undefined : argv[index + 1]
  if (value === undefined) return fallback
  return isHarnessId(value) ? value : null
}

type Lifecycle = 'start' | 'end'

async function withSession(run: (ctx: ReturnType<typeof createLocalContext>) => Promise<unknown>): Promise<void> {
  const ctx = createLocalContext({ values: {}, positionals: [] })
  try {
    await run(ctx)
  } finally {
    ctx.db.close()
  }
}

async function dispatchLifecycle(env: WrapperEnv, harness: HarnessId, lifecycle: Lifecycle, input: Record<string, unknown>): Promise<void> {
  const sessionId = stringValue(input['session_id']) ?? stringValue(input['sessionId'])
  if (!sessionId) return
  if (lifecycle === 'start') {
    await withSession((ctx) =>
      handleSessionStart(ctx, env, {
        harness,
        sessionId,
        transcriptPath: stringValue(input['transcript_path']) ?? null,
        cwd: stringValue(input['cwd']) ?? process.cwd(),
        source: stringValue(input['source']) ?? null,
      }),
    )
    return
  }
  await withSession((ctx) =>
    handleSessionEnd(ctx, env, { harness, sessionId, reason: stringValue(input['reason']) ?? 'other' }),
  )
}

async function runLifecycleHook(argv: readonly string[], lifecycle: Lifecycle): Promise<void> {
  const env = wrapperEnv()
  if (!env) return
  const harness = harnessFlag(argv, 'claude')
  if (!harness) return
  const input = parseInput(await readStdin())
  if (!input) return
  await dispatchLifecycle(env, harness, lifecycle, input)
}

type AgentEvent = 'start' | 'end' | 'tool'

const CODEX_EVENTS: Readonly<Record<string, AgentEvent>> = {
  SessionStart: 'start',
  SessionEnd: 'end',
  PostToolUse: 'tool',
}

const GEMINI_EVENTS: Readonly<Record<string, AgentEvent>> = {
  SessionStart: 'start',
  SessionEnd: 'end',
  AfterTool: 'tool',
}

async function runAgentHook(harness: HarnessId, events: Readonly<Record<string, AgentEvent>>): Promise<void> {
  const input = parseInput(await readStdin())
  if (!input) return
  const name = stringValue(input['hook_event_name'])
  const kind = name !== undefined && Object.hasOwn(events, name) ? events[name] : undefined
  if (kind === undefined) return

  if (kind === 'tool') {
    await touchFiles(touchedFiles(inputRecord(input['tool_input'])))
    return
  }

  const env = wrapperEnv()
  if (!env) return
  await dispatchLifecycle(env, harness, kind, input)
}

function preferredEntryId(): number | null {
  const env = wrapperEnv()
  if (!env) return null
  const db = openDatabase(databasePath())
  try {
    return currentSessionEntryId(db, env)
  } finally {
    db.close()
  }
}

async function touchFiles(files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const preferred = preferredEntryId()
  for (const file of files) await runTouched(file, { preferredEntryId: preferred })
}

async function runTouchedHook(argv: readonly string[]): Promise<void> {
  const flagIndex = argv.indexOf('--file')
  const flagged = flagIndex === -1 ? undefined : argv[flagIndex + 1]
  await touchFiles(flagged ? [flagged] : touchedFilesFromHookInput(await readStdin()))
}

async function route(event: string, argv: readonly string[]): Promise<void> {
  if (SILENT_EVENTS.has(event)) return
  if (event === 'touched') return runTouchedHook(argv)
  if (event === 'session-start') return runLifecycleHook(argv, 'start')
  if (event === 'session-end') return runLifecycleHook(argv, 'end')
  if (event === 'codex') return runAgentHook('codex', CODEX_EVENTS)
  if (event === 'gemini') return runAgentHook('gemini', GEMINI_EVENTS)
}

export const DEN_HOOK_ENV = 'DEN_AGENT_HOOK'

export const DEN_HOOK_TIMEOUT_ENV = 'BITA_DEN_HOOK_TIMEOUT_MS'
const DEN_HOOK_TIMEOUT_MS = 8000
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

function denHookTimeoutMs(): number {
  const raw = Number(process.env[DEN_HOOK_TIMEOUT_ENV])
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, DEN_HOOK_TIMEOUT_MS) : DEN_HOOK_TIMEOUT_MS
}

function forward(command: string, args: readonly string[], input: string, log: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const spec = spawnCommand(command, args)
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    const output: Buffer[] = []
    const timeoutMs = denHookTimeoutMs()
    let settled = false
    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') killTree(child, 'SIGKILL')
      else child.kill('SIGKILL')
    }
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal)
      return true
    }
    const onSignal = (signal: NodeJS.Signals): void => {
      kill()
      if (!finish()) return
      log(`received ${signal}; killed Den (pid ${child.pid ?? 'unknown'})`)
      process.kill(process.pid, signal)
    }
    const timer = setTimeout(() => {
      kill()
      if (!finish()) return
      log(`Den did not answer within ${timeoutMs} ms; killed it (pid ${child.pid ?? 'unknown'})`)
      child.stdout.destroy()
      child.stdin.destroy()
      child.unref()
      resolve(0)
    }, timeoutMs)
    for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal)
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      if (finish()) reject(error)
    })
    child.on('close', (code, signal) => {
      if (!finish()) return
      const status = signal !== null ? 1 : (code ?? 1)
      if (signal !== null) log(`Den was ended by ${signal}`)
      process.stdout.write(Buffer.concat(output), () => resolve(status))
    })
    child.stdin.end(input)
  })
}

async function runDenHook(harness: string | undefined): Promise<number> {
  const input = await readStdin()
  const command = process.env[DEN_HOOK_ENV]
  if (!command || !harness) return 0
  const log = (line: string): void => appendHookLog(databasePath(), `hook den ${harness}: ${line}`)
  try {
    return await forward(command, ['--agent-hook', harness], input, log)
  } catch (error) {
    appendHookLog(databasePath(), `hook den ${harness} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}

export async function runHook(argv: string[]): Promise<number> {
  const event = argv[0] ?? 'session-start'
  if (isHeadless()) return 0
  if (event === 'den') return runDenHook(argv[1])
  try {
    await route(event, argv.slice(1))
  } catch (error) {
    appendHookLog(databasePath(), `hook ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 0
}
