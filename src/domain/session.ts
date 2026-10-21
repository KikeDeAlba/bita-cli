import type { LocalContext } from '../cli/local-context.ts'
import { isHarnessId } from '../harness/registry.ts'
import type { HarnessId } from '../harness/types.ts'

export const WRAPPER_ID_ENV = 'BITA_WRAPPER_ID'
export const HARNESS_ENV = 'BITA_HARNESS'
export const SESSION_PROJECT_ENV = 'BITA_SESSION_PROJECT'
export const CHILD_ENV = 'BITA_CHILD'

const SCRUBBED_ENV = [
  WRAPPER_ID_ENV,
  HARNESS_ENV,
  SESSION_PROJECT_ENV,
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
]

export interface WrapperEnv {
  wrapperId: string
  harness: HarnessId
  projectId: number
}

export interface StartSessionInput {
  wrapperId: string
  wrapperPid: number
  harness: HarnessId
  projectId: number
  cwd: string
  sessionId?: string | null
  transcriptPath?: string | null
}

export function isChild(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CHILD_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

export function wrapperEnv(env: NodeJS.ProcessEnv = process.env): WrapperEnv | null {
  if (isChild(env)) return null
  const wrapperId = env[WRAPPER_ID_ENV]
  if (!wrapperId) return null
  const harness = env[HARNESS_ENV]
  if (!isHarnessId(harness)) return null
  const projectId = Number(env[SESSION_PROJECT_ENV])
  if (!Number.isInteger(projectId) || projectId <= 0) return null
  return { wrapperId, harness, projectId }
}

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of SCRUBBED_ENV) delete next[key]
  next[CHILD_ENV] = '1'
  return next
}

export async function startSessionEntry(_ctx: LocalContext, _input: StartSessionInput): Promise<{ entryId: number; rowId: number }> {
  throw new Error('not implemented')
}

export async function closeWrapper(_ctx: LocalContext, _wrapperId: string): Promise<number[]> {
  throw new Error('not implemented')
}

export async function sweepOrphans(_ctx: LocalContext): Promise<number[]> {
  throw new Error('not implemented')
}

export function spawnFinalize(_entryId: number, _options: { cwd: string; databasePath: string }): void {
  throw new Error('not implemented')
}
