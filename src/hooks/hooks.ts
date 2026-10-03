import { spawn } from 'node:child_process'
import { appendFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { SCHEMA_VERSION } from '../config/constants.ts'
import type { EnrichedTimeEntry } from '../domain/types.ts'

export type HookEvent = 'start' | 'stop' | 'cancel' | 'amend'

export const HOOK_EVENTS: readonly HookEvent[] = ['start', 'stop', 'cancel', 'amend']

export interface HookConfig {
  on: HookEvent[]
  when?: { kind?: string[] }
  command: string[]
}

export interface HookPayload {
  event: HookEvent
  entry: EnrichedTimeEntry
  previousKind?: string | null
  docPath: string | null
  pageIds?: number[]
}

export interface HookTarget {
  databasePath: string
  docsRoot: string
}

export const NO_HOOKS_ENV_VAR = 'BITA_NO_HOOKS'
export function hooksLogPath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), 'hooks.log')
}
const HANDOFF_TIMEOUT_MS = 2_000

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

export function parseHooks(raw: unknown): HookConfig[] {
  if (!Array.isArray(raw)) return []
  const hooks: HookConfig[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as { on?: unknown; when?: { kind?: unknown }; command?: unknown }
    const on = (Array.isArray(candidate.on) ? candidate.on : [candidate.on]).filter(isHookEvent)
    const command = Array.isArray(candidate.command)
      ? candidate.command.filter((part): part is string => typeof part === 'string')
      : []
    if (on.length === 0 || command.length === 0 || !command[0]) continue
    const rawKind = candidate.when?.kind
    const kinds = (Array.isArray(rawKind) ? rawKind : rawKind === undefined ? [] : [rawKind]).filter(
      (kind): kind is string => typeof kind === 'string' && kind.length > 0,
    )
    hooks.push({ on, ...(kinds.length > 0 ? { when: { kind: kinds } } : {}), command })
  }
  return hooks
}

export function matchingHooks(hooks: readonly HookConfig[], payload: HookPayload): HookConfig[] {
  return hooks.filter((hook) => hook.on.includes(payload.event) && kindMatches(hook, payload))
}

function kindMatches(hook: HookConfig, payload: HookPayload): boolean {
  const wanted = hook.when?.kind
  if (!wanted) return true
  return [payload.entry.kind, payload.previousKind].some((kind) => kind != null && wanted.includes(kind))
}

export function hookEnvironment(payload: HookPayload, target: HookTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BITA_HOOK_EVENT: payload.event,
    BITA_ENTRY_ID: String(payload.entry.id),
    BITA_ENTRY_KIND: payload.entry.kind ?? '',
    BITA_DB_PATH: target.databasePath,
    BITA_DOCS_DIR: target.docsRoot,
  }
}

export function hookDocument(payload: HookPayload, target: HookTarget): string {
  return `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    event: payload.event,
    entry: payload.entry,
    previousKind: payload.previousKind ?? null,
    docPath: payload.docPath,
    pageIds: payload.pageIds ?? [],
    databasePath: target.databasePath,
    docsRoot: target.docsRoot,
    firedAt: new Date().toISOString(),
  })}\n`
}

export async function fireHooks(
  hooks: readonly HookConfig[],
  payloads: readonly HookPayload[],
  target: HookTarget,
  logPath: string = hooksLogPath(target.databasePath),
): Promise<number> {
  if (process.env[NO_HOOKS_ENV_VAR]) return 0
  let launched = 0
  for (const payload of payloads) {
    for (const hook of matchingHooks(hooks, payload)) {
      if (await launch(hook, payload, target, logPath)) launched += 1
    }
  }
  return launched
}

async function launch(hook: HookConfig, payload: HookPayload, target: HookTarget, logPath: string): Promise<boolean> {
  const [command, ...args] = hook.command
  if (!command) return false
  await mkdir(path.dirname(logPath), { recursive: true })
  await appendFile(logPath, `${new Date().toISOString()} ${payload.event} #${payload.entry.id} -> ${hook.command.join(' ')}\n`)
  const log = await open(logPath, 'a')
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      let spawned = false
      let flushed = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(spawned), HANDOFF_TIMEOUT_MS)
      const child = spawn(command, args, {
        detached: true,
        stdio: ['pipe', log.fd, log.fd],
        env: hookEnvironment(payload, target),
        cwd: '/',
      })
      child.once('spawn', () => {
        spawned = true
        if (flushed) finish(true)
      })
      child.once('error', (error) => {
        void appendFile(logPath, `${new Date().toISOString()} ${payload.event} #${payload.entry.id}: ${command} did not start: ${error.message}\n`)
          .finally(() => finish(false))
      })
      const stdin = child.stdin
      if (!stdin) {
        flushed = true
      } else {
        stdin.on('error', () => undefined)
        stdin.end(hookDocument(payload, target), () => {
          flushed = true
          if (spawned) finish(true)
        })
      }
      child.unref()
    })
  } finally {
    await log.close()
  }
}
