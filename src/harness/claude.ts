import { homedir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '../domain/session.ts'
import { CLAUDE_SKIP_PERMISSION_FLAGS, withDefaultFlag } from './args.ts'
import { describeFailure, errorMessage, resolveHarnessBin, runProcess, withTempDir } from './process.ts'
import { harnessBinEnvVar } from './registry.ts'
import { SESSION_SUMMARY_SCHEMA, buildSummaryPrompt, validateSessionSummary } from './summary.ts'
import { isRecord, parseJsonLines, pushTurn, readTextFile, startsWithAny, textOfBlocks } from './transcript.ts'
import type { HarnessAdapter, LaunchPlan, SummaryInput, SummaryResult, TranscriptRef, Turn } from './types.ts'

const NOISE_PREFIXES = ['<command-name>', '<local-command-', '<system-reminder>'] as const

export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || homedir(), '.claude')
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

export function claudeTranscriptPath(ref: TranscriptRef, env: NodeJS.ProcessEnv = process.env): string | null {
  if (ref.transcriptPath) return ref.transcriptPath
  if (!ref.sessionId) return null
  return join(claudeProjectDir(ref.cwd, env), `${ref.sessionId}.jsonl`)
}

export function parseClaudeTranscript(text: string): Turn[] {
  const turns: Turn[] = []
  for (const record of parseJsonLines(text)) {
    const type = record['type']
    if (type !== 'user' && type !== 'assistant') continue
    if (record['isMeta'] === true || record['isSidechain'] === true) continue
    const message = record['message']
    if (!isRecord(message)) continue
    const body = textOfBlocks(message['content'], (block) => block['type'] === 'text')
    if (!body.trim() || startsWithAny(body, NOISE_PREFIXES)) continue
    pushTurn(turns, type, body)
  }
  return turns
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  const bin = claudeAdapter.resolveBin()
  if (!bin) return { ok: false, error: 'claude not found' }
  const model = input.model ?? claudeAdapter.defaultSummaryModel
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SESSION_SUMMARY_SCHEMA),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns',
    '2',
    '--settings',
    '{"disableAllHooks":true}',
  ]
  return withTempDir('bita-summary-claude-', async (dir) => {
    const result = await runProcess(bin, args, { input: buildSummaryPrompt(input), env: childEnv(), cwd: dir, timeoutMs: input.timeoutMs })
    if (result.timedOut) return { ok: false, error: describeFailure('claude', result) }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      return { ok: false, error: result.code === 0 ? `claude returned invalid JSON: ${errorMessage(error)}` : describeFailure('claude', result) }
    }
    if (!isRecord(parsed)) return { ok: false, error: 'claude returned an unexpected payload' }
    if (parsed['is_error'] === true || result.code !== 0) {
      const detail = typeof parsed['result'] === 'string' ? parsed['result'] : String(parsed['subtype'] ?? 'error')
      return { ok: false, error: `claude failed: ${detail.slice(0, 400)}` }
    }
    if (!('structured_output' in parsed) || parsed['structured_output'] === null) return { ok: false, error: 'claude returned no structured_output' }
    return validateSessionSummary(parsed['structured_output'], input.kinds)
  })
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  label: 'Claude',
  bin: 'claude',
  defaultSummaryModel: 'haiku',
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVar('claude'), 'claude', env)
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return claudeAdapter.resolveBin(env) !== null
  },
  launchArgs(userArgs: readonly string[]): LaunchPlan {
    return withDefaultFlag(CLAUDE_SKIP_PERMISSION_FLAGS[0], userArgs, (token) => (CLAUDE_SKIP_PERMISSION_FLAGS as readonly string[]).includes(token))
  },
  async extractTranscript(ref: TranscriptRef): Promise<Turn[]> {
    const file = claudeTranscriptPath(ref)
    if (!file) return []
    const text = await readTextFile(file)
    return text === null ? [] : parseClaudeTranscript(text)
  },
  summarize,
}
