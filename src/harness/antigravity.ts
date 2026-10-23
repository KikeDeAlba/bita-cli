import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '../domain/session.ts'
import { homeOf, kitAgents, kitContext } from '../kit/runtime.ts'
import { CLAUDE_SKIP_PERMISSION_FLAGS, droppedWarning, parseClaudeArgs } from './args.ts'
import { errorMessage, remainingMs, resolveHarnessBin } from './process.ts'
import { protoString } from './protobuf.ts'
import { harnessBinEnvVar } from './registry.ts'
import { parseJsonLoose, retryInstructions, summaryContext, summaryInstructions, validateSessionSummary } from './summary.ts'
import { parseJsonLines, pushTurn, readTextFile } from './transcript.ts'
import type { ExitRef, ExitSession, HarnessAdapter, LaunchPlan, SummaryInput, SummaryResult, TranscriptRef, Turn } from './types.ts'

const LABEL = 'Antigravity'
const SKIP_FLAG = CLAUDE_SKIP_PERMISSION_FLAGS[1]
const VALUE_FLAGS = ['--model', '--mode', '--agent', '--effort', '--add-dir', '--project', '--log-file']
const BOOLEAN_FLAGS = ['--sandbox', '--new-project', '--remote-control', '--disable-slash-commands']
const HISTORY_SLACK_MS = 1_000
const USER_STEP = 14
const ASSISTANT_STEP = 15
const USER_TEXT_PATH = [19, 2] as const
const ASSISTANT_TEXT_PATH = [20, 1] as const

export const ANTIGRAVITY_CONVERSATION_ENV = 'ANTIGRAVITY_CONVERSATION_ID'

export function antigravityHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeOf(env), '.gemini', 'antigravity-cli')
}

export function antigravityConversationPath(conversationId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(antigravityHome(env), 'conversations', `${conversationId}.db`)
}

function isKeptFlag(token: string): boolean {
  if (BOOLEAN_FLAGS.includes(token)) return true
  return VALUE_FLAGS.some((flag) => token.startsWith(`${flag}=`))
}

function joinValueFlags(args: readonly string[]): string[] {
  const joined: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (token === '--') {
      joined.push(...args.slice(i))
      break
    }
    const next = args[i + 1]
    if (VALUE_FLAGS.includes(token) && next !== undefined && !next.startsWith('-')) {
      joined.push(`${token}=${next}`)
      i++
    } else joined.push(token)
  }
  return joined
}

function launchArgs(userArgs: readonly string[]): LaunchPlan {
  const parsed = parseClaudeArgs(joinValueFlags(userArgs), isKeptFlag)
  const resume = parsed.resume.kind === 'continue'
    ? ['-c']
    : parsed.resume.kind === 'resume'
      ? parsed.resume.id
        ? ['--conversation', parsed.resume.id]
        : ['-c']
      : []
  const prompt = parsed.prompt !== null ? ['-i', parsed.prompt] : []
  return {
    args: [SKIP_FLAG, ...parsed.extra, ...resume, ...prompt],
    warnings: parsed.extraFlags.map((flag) => droppedWarning(LABEL, flag)),
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

export async function findExitConversation(ref: ExitRef, env: NodeJS.ProcessEnv = process.env): Promise<ExitSession | null> {
  const text = await readTextFile(join(antigravityHome(env), 'history.jsonl'))
  if (text === null) return null
  const from = Date.parse(ref.startedAt) - HISTORY_SLACK_MS
  if (Number.isNaN(from)) return null
  const workspaces = new Set([ref.cwd, await canonical(ref.cwd)])
  let latest: { id: string; at: number } | null = null
  for (const record of parseJsonLines(text)) {
    const id = record['conversationId']
    const at = record['timestamp']
    const workspace = record['workspace']
    if (typeof id !== 'string' || !id || typeof at !== 'number' || typeof workspace !== 'string') continue
    if (at < from || !workspaces.has(workspace)) continue
    if (!latest || at >= latest.at) latest = { id, at }
  }
  return latest ? { sessionId: latest.id, transcriptPath: antigravityConversationPath(latest.id, env) } : null
}

function stepText(stepType: number, payload: Uint8Array): { role: Turn['role']; text: string } | null {
  if (stepType === USER_STEP) {
    const text = protoString(payload, USER_TEXT_PATH)
    return text === null ? null : { role: 'user', text }
  }
  if (stepType === ASSISTANT_STEP) {
    const text = protoString(payload, ASSISTANT_TEXT_PATH)
    return text === null ? null : { role: 'assistant', text }
  }
  return null
}

export async function readAntigravityConversation(file: string): Promise<Turn[]> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return []
  }
  try {
    const rows = db.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx').all() as { step_type: unknown; step_payload: unknown }[]
    const turns: Turn[] = []
    for (const row of rows) {
      if (typeof row.step_type !== 'number' || !(row.step_payload instanceof Uint8Array)) continue
      const turn = stepText(row.step_type, row.step_payload)
      if (turn) pushTurn(turns, turn.role, turn.text)
    }
    return turns
  } catch {
    return []
  } finally {
    db.close()
  }
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  const bin = antigravityAdapter.resolveBin()
  if (!bin) return { ok: false, error: 'agy not found' }
  const agents = kitAgents()
  if (!agents) return { ok: false, error: 'antigravity summary needs @kikedealba/kit' }
  const model = input.model ?? antigravityAdapter.defaultSummaryModel
  const ctx = kitContext(childEnv())
  const deadline = Date.now() + input.timeoutMs
  let cwd: string
  try {
    cwd = await mkdtemp(join(tmpdir(), 'bita-summary-antigravity-'))
  } catch (error) {
    return { ok: false, error: `antigravity workspace: ${errorMessage(error)}` }
  }
  try {
    const context = summaryContext(input)
    let instructions = summaryInstructions(input)
    let last: SummaryResult = { ok: false, error: 'agy was not called' }
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string
      try {
        const result = await agents.runHeadless({
          agent: 'antigravity',
          bin,
          prompt: `${instructions}\n\n${context}`,
          cwd,
          access: 'read',
          model,
          timeoutMs: remainingMs(deadline),
          ...(ctx ? { ctx } : {}),
        })
        text = result.text
      } catch (error) {
        return { ok: false, error: `agy failed: ${errorMessage(error).slice(0, 400)}` }
      }
      last = validateSessionSummary(parseJsonLoose(text), input.kinds)
      if (last.ok) return last
      instructions = retryInstructions(input, last.error)
    }
    return last
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

export const antigravityAdapter: HarnessAdapter = {
  id: 'antigravity',
  label: LABEL,
  bin: 'agy',
  defaultSummaryModel: 'gemini-3.8-flash-low',
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVar('antigravity'), 'agy', env, 'antigravity')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return antigravityAdapter.resolveBin(env) !== null
  },
  launchArgs,
  async extractTranscript(ref: TranscriptRef): Promise<Turn[]> {
    const file = ref.transcriptPath ?? (ref.sessionId ? antigravityConversationPath(ref.sessionId) : null)
    if (!file) return []
    return readAntigravityConversation(file)
  },
  summarize,
  afterExit(ref: ExitRef, env: NodeJS.ProcessEnv = process.env): Promise<ExitSession | null> {
    return findExitConversation(ref, env).catch(() => null)
  },
}
