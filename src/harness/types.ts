export type HarnessId = 'claude' | 'opencode' | 'codex' | 'gemini'

export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'opencode', 'codex', 'gemini']

export interface LaunchPlan {
  args: string[]
  warnings: string[]
}

export interface TranscriptRef {
  harness: HarnessId
  sessionId: string | null
  transcriptPath: string | null
  cwd: string
  startedAt: string
  endedAt: string
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface SessionNote {
  context: string
  done: string
  decisions: string | null
  findings: string | null
  verification: string | null
  pending: string | null
}

export interface SessionSummary {
  title: string
  kind: string | null
  note: SessionNote
}

export interface SummaryMeta {
  harness: HarnessId
  projectName: string | null
  repo: string | null
  branch: string | null
  cwd: string
  durationSeconds: number
  touchedFiles: readonly string[]
}

export interface SummaryInput {
  turns: readonly Turn[]
  meta: SummaryMeta
  kinds: readonly string[]
  model: string | null
  timeoutMs: number
}

export type SummaryResult = { ok: true; summary: SessionSummary } | { ok: false; error: string }

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly label: string
  readonly bin: string
  readonly defaultSummaryModel: string
  resolveBin(env?: NodeJS.ProcessEnv): string | null
  available(env?: NodeJS.ProcessEnv): boolean
  launchArgs(userArgs: readonly string[]): LaunchPlan
  extractTranscript(ref: TranscriptRef): Promise<Turn[]>
  summarize(input: SummaryInput): Promise<SummaryResult>
}
