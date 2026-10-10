import { spawn } from 'node:child_process'
import { appendFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { SCHEMA_VERSION } from '../config/constants.ts'
import type { Listener as KitListener } from '@kikedealba/kit/events'
import type { EnrichedTimeEntry } from '../domain/types.ts'

export type HookEvent = 'start' | 'stop' | 'cancel' | 'amend' | 'delete' | 'merge'

export const HOOK_EVENTS: readonly HookEvent[] = ['start', 'stop', 'cancel', 'amend', 'delete', 'merge']

export const EVENT_SOURCE = 'bita'

export interface HookConfig {
  on: HookEvent[]
  when?: { kind?: string[] }
  command: string[]
}

export interface HookPayload {
  event: HookEvent
  entry: EnrichedTimeEntry
  previousKind?: string | null
  previousTitle?: string
  previousProjectId?: number | null
  docPath: string | null
  pageIds?: number[]
  mergedIds?: number[]
}

export interface HookTarget {
  databasePath: string
  docsRoot: string
}

export const NO_HOOKS_ENV_VAR = 'BITA_NO_HOOKS'
export const NO_EVENTS_ENV_VAR = 'KIT_NO_EVENTS'
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

export function eventDocument(payload: HookPayload, target: HookTarget): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    event: payload.event,
    entry: payload.entry,
    previousKind: payload.previousKind ?? null,
    ...(payload.previousTitle !== undefined ? { previousTitle: payload.previousTitle } : {}),
    ...(payload.previousProjectId !== undefined ? { previousProjectId: payload.previousProjectId } : {}),
    docPath: payload.docPath,
    pageIds: payload.pageIds ?? [],
    ...(payload.mergedIds ? { mergedIds: payload.mergedIds } : {}),
    databasePath: target.databasePath,
    docsRoot: target.docsRoot,
  }
}

export function hookDocument(payload: HookPayload, target: HookTarget): string {
  return `${JSON.stringify({
    ...eventDocument(payload, target),
    source: EVENT_SOURCE,
    firedAt: new Date().toISOString(),
  })}\n`
}

function flagSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0'
}

export function eventsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagSet(env[NO_HOOKS_ENV_VAR]) || flagSet(env[NO_EVENTS_ENV_VAR])
}

export function configListeners(hooks: readonly HookConfig[]): KitListener[] {
  const grouped = new Map<string, { events: string[]; command: string[]; kinds: Set<string> | null }>()
  for (const hook of hooks) {
    const events = [...new Set(hook.on)].sort()
    const key = `${events.join(',')}|${hook.command.join('\u0000')}`
    const existing = grouped.get(key)
    const kinds = hook.when?.kind ? new Set(hook.when.kind) : null
    if (!existing) grouped.set(key, { events, command: [...hook.command], kinds })
    else if (existing.kinds === null || kinds === null) existing.kinds = null
    else for (const kind of kinds) existing.kinds.add(kind)
  }
  return [...grouped.values()].map((group) => ({
    source: 'config',
    owner: 'config.json',
    events: group.events,
    ...(group.kinds ? { filter: { kind: [...group.kinds] } } : {}),
    command: group.command,
  }))
}

type KitEvents = typeof import('@kikedealba/kit/events')

let kitEvents: Promise<KitEvents | null> | undefined

export function loadKitEvents(): Promise<KitEvents | null> {
  kitEvents ??= import('@kikedealba/kit/events').then(
    (module) => module,
    () => null,
  )
  return kitEvents
}

export async function fireEvents(
  hooks: readonly HookConfig[],
  payloads: readonly HookPayload[],
  target: HookTarget,
  logPath: string = hooksLogPath(target.databasePath),
  kit: KitEvents | null | undefined = undefined,
): Promise<number> {
  if (payloads.length === 0 || eventsDisabled()) return 0
  const events = kit === undefined ? await loadKitEvents() : kit
  if (!events) return fireHooks(hooks, payloads, target, logPath)
  const result = await events.fireEvents(
    payloads.map((payload) => ({
      tool: EVENT_SOURCE,
      event: payload.event,
      attributes: { kind: [payload.entry.kind, payload.previousKind] },
      document: eventDocument(payload, target),
      env: hookEnvironment(payload, target),
    })),
    { logPath, extraListeners: configListeners(hooks), suppressEnvVars: [NO_HOOKS_ENV_VAR] },
  )
  return result.launched
}

export async function fireHooks(
  hooks: readonly HookConfig[],
  payloads: readonly HookPayload[],
  target: HookTarget,
  logPath: string = hooksLogPath(target.databasePath),
): Promise<number> {
  if (eventsDisabled()) return 0
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
