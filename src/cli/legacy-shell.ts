import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConflictError } from '../errors.ts'

type ShellName = 'zsh' | 'bash'

export const SHELL_BLOCK_START = '# >>> bita session >>>'
export const SHELL_BLOCK_END = '# <<< bita session <<<'

function home(env: NodeJS.ProcessEnv): string {
  return env['HOME'] || homedir()
}

export function defaultRcFile(shell: ShellName, env: NodeJS.ProcessEnv = process.env): string {
  if (shell === 'zsh') return join(env['ZDOTDIR'] || home(env), '.zshrc')
  return join(home(env), '.bashrc')
}

export function legacyRcFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([defaultRcFile('zsh', env), defaultRcFile('bash', env)])]
}

export function displayPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = home(env)
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

async function readRc(rc: string): Promise<string> {
  try {
    return await readFile(rc, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

interface BlockRange {
  start: number
  end: number
}

function findBlock(rc: string, content: string): BlockRange | null {
  const start = content.indexOf(SHELL_BLOCK_START)
  if (start === -1) return null
  const endMarker = content.indexOf(SHELL_BLOCK_END, start)
  if (endMarker === -1) {
    throw new ConflictError(
      `${rc} has "${SHELL_BLOCK_START}" without "${SHELL_BLOCK_END}"; it was left untouched.`,
      'SHELL_BLOCK_UNTERMINATED',
      `Remove the claude function of bita 1.4.0 from ${rc} by hand, or add "${SHELL_BLOCK_END}" after it and run setup again.`,
    )
  }
  let end = endMarker + SHELL_BLOCK_END.length
  if (content[end] === '\n') end += 1
  return { start, end }
}

export async function removeShellFunction(rc: string): Promise<'removed' | 'absent'> {
  const content = await readRc(rc)
  const range = findBlock(rc, content)
  if (!range) return 'absent'
  await writeFile(rc, `${content.slice(0, range.start)}${content.slice(range.end)}`, 'utf8')
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
      if (!(error instanceof ConflictError)) throw error
      result.errors.push(error.hint ? `${error.message} ${error.hint}` : error.message)
    }
  }
  return result
}
