import { spawn } from 'node:child_process'

export interface RepoContext {
  toplevel: string | null
  remoteUrl: string | null
  branch: string | null
  headSha: string | null
}

export type GitRunner = (args: string[], cwd: string) => Promise<string | null>

export interface GitDeps {
  run?: GitRunner
}

const GIT_TIMEOUT_MS = 3000

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
  missing: boolean
}

export interface GitExecOptions {
  cwd: string
  env?: NodeJS.ProcessEnv | undefined
  input?: string | undefined
  timeoutMs?: number | undefined
}

export function execGit(args: readonly string[], options: GitExecOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? GIT_TIMEOUT_MS)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout: '', stderr: error.message, missing: error.code === 'ENOENT' })
    })
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        missing: false,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

const runGit: GitRunner = async (args, cwd) => {
  const result = await execGit(args, { cwd })
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

export async function readRepoContext(cwd: string, deps: GitDeps = {}): Promise<RepoContext> {
  const run = deps.run ?? runGit

  const toplevel = await run(['rev-parse', '--show-toplevel'], cwd)
  if (!toplevel) return { toplevel: null, remoteUrl: null, branch: null, headSha: null }

  const remoteUrl = await run(['remote', 'get-url', 'origin'], cwd)
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const headSha = await run(['rev-parse', '--short', 'HEAD'], cwd)

  return { toplevel, remoteUrl, branch, headSha }
}
