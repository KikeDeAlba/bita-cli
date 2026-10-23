import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConflictError } from '../errors.ts'

type ShellName = 'zsh' | 'bash'

export const SHELL_BLOCK_START = '# >>> bita session >>>'
export const SHELL_BLOCK_END = '# <<< bita session <<<'

function home(env: NodeJS.ProcessEnv): string {
  return env['HOME'] || env['USERPROFILE'] || homedir()
}

export function defaultRcFile(shell: ShellName, env: NodeJS.ProcessEnv = process.env): string {
  if (shell === 'zsh') return join(env['ZDOTDIR'] || home(env), '.zshrc')
  return join(home(env), '.bashrc')
}

export function legacyRcFiles(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return []
  return [...new Set([defaultRcFile('zsh', env), join(home(env), '.zshrc'), defaultRcFile('bash', env)])]
}

export function displayPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = home(env)
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`) ? `~${path.slice(base.length)}` : path
}

async function readRc(rc: string): Promise<string> {
  try {
    return await readFile(rc, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

const BLOCK_START = /^# >>> bita session >>>[ \t]*$/m
const BLOCK_END = /^# <<< bita session <<<[ \t]*$/m

function stripBlocks(rc: string, content: string): string | null {
  let remaining = content
  let changed = false
  for (;;) {
    const start = BLOCK_START.exec(remaining)
    if (!start) return changed ? remaining : null
    const afterStart = start.index + start[0].length
    const end = BLOCK_END.exec(remaining.slice(afterStart))
    if (!end) {
      throw new ConflictError(
        `${rc} has "${SHELL_BLOCK_START}" without "${SHELL_BLOCK_END}"; it was left untouched.`,
        'SHELL_BLOCK_UNTERMINATED',
        `Remove the claude function of bita 1.4.0 from ${rc} by hand, or add "${SHELL_BLOCK_END}" after it and run setup again.`,
      )
    }
    let cut = afterStart + end.index + end[0].length
    if (remaining[cut] === '\n') cut += 1
    remaining = `${remaining.slice(0, start.index)}${remaining.slice(cut)}`
    changed = true
  }
}

export async function removeShellFunction(rc: string): Promise<'removed' | 'absent'> {
  const stripped = stripBlocks(rc, await readRc(rc))
  if (stripped === null) return 'absent'
  await writeFile(rc, stripped, 'utf8')
  return 'removed'
}

export interface LegacyShellCleanup {
  removed: string[]
  errors: string[]
}

export async function removeLegacyShellFunctions(rcFiles: readonly string[] = legacyRcFiles()): Promise<LegacyShellCleanup> {
  const result: LegacyShellCleanup = { removed: [], errors: [] }
  for (const rc of rcFiles) {
    try {
      if ((await removeShellFunction(rc)) === 'removed') result.removed.push(rc)
    } catch (error) {
      if (error instanceof ConflictError) result.errors.push(error.hint ? `${error.message} ${error.hint}` : error.message)
      else result.errors.push(`could not remove the claude shell function from ${rc}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
