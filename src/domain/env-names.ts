export const WRAPPER_ID_ENV = 'BITA_WRAPPER_ID'
export const HARNESS_ENV = 'BITA_HARNESS'
export const SESSION_PROJECT_ENV = 'BITA_SESSION_PROJECT'
export const CHILD_ENV = 'BITA_CHILD'
export const HEADLESS_ENV = 'KIT_HEADLESS'
export const ANTIGRAVITY_CONVERSATION_ENV = 'ANTIGRAVITY_CONVERSATION_ID'

export const HARNESS_SESSION_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'GEMINI_CLI',
  'GEMINI_SESSION_ID',
  'GEMINI_PROJECT_DIR',
  'OPENCODE',
  'OPENCODE_SESSION_ID',
]

export const HARNESS_SESSION_ENV_PREFIXES: readonly string[] = ['ANTIGRAVITY_']

export function withoutHarnessSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  const names = new Set(HARNESS_SESSION_ENV.map((name) => name.toUpperCase()))
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (names.has(upper) || HARNESS_SESSION_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    next[key] = value
  }
  return next
}
