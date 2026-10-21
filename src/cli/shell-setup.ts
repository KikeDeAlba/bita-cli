import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { UsageError } from '../errors.ts'

export const SHELLS = ['zsh', 'bash'] as const
export type ShellName = (typeof SHELLS)[number]

export const SHELL_BLOCK_START = '# >>> bita session >>>'
export const SHELL_BLOCK_END = '# <<< bita session <<<'
const SHELL_FUNCTION = 'function claude { command bita session -- "$@"; }'

export function isShellName(value: unknown): value is ShellName {
  return typeof value === 'string' && (SHELLS as readonly string[]).includes(value)
}

export function parseShell(raw: string): ShellName {
  if (!isShellName(raw)) throw new UsageError(`Unknown shell "${raw}". Valid shells: ${SHELLS.join(', ')}.`)
  return raw
}

export function detectShell(env: NodeJS.ProcessEnv = process.env): ShellName | null {
  const name = (env['SHELL'] ?? '').split('/').at(-1) ?? ''
  return isShellName(name) ? name : null
}

export function shellBlock(_shell: ShellName): string {
  return `${SHELL_BLOCK_START}\n${SHELL_FUNCTION}\n${SHELL_BLOCK_END}\n`
}

export function defaultRcFile(shell: ShellName, env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] || homedir()
  if (shell === 'zsh') return join(env['ZDOTDIR'] || home, '.zshrc')
  return join(home, '.bashrc')
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

function findBlock(content: string): BlockRange | null {
  const start = content.indexOf(SHELL_BLOCK_START)
  if (start === -1) return null
  const endMarker = content.indexOf(SHELL_BLOCK_END, start)
  if (endMarker === -1) return null
  let end = endMarker + SHELL_BLOCK_END.length
  if (content[end] === '\n') end += 1
  return { start, end }
}

export function hasClaudeAlias(content: string): boolean {
  return /^\s*alias\s+claude=/m.test(content)
}

export async function installShellFunction(rc: string, shell: ShellName): Promise<'installed' | 'updated' | 'present'> {
  const content = await readRc(rc)
  const block = shellBlock(shell)
  const range = findBlock(content)
  if (range) {
    if (content.slice(range.start, range.end) === block) return 'present'
    await writeFile(rc, `${content.slice(0, range.start)}${block}${content.slice(range.end)}`, 'utf8')
    return 'updated'
  }
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n'
  await mkdir(dirname(rc), { recursive: true })
  await writeFile(rc, `${content}${separator}${block}`, 'utf8')
  return 'installed'
}

export async function removeShellFunction(rc: string): Promise<'removed' | 'absent'> {
  const content = await readRc(rc)
  const range = findBlock(content)
  if (!range) return 'absent'
  await writeFile(rc, `${content.slice(0, range.start)}${content.slice(range.end)}`, 'utf8')
  return 'removed'
}

export async function rcHasClaudeAlias(rc: string): Promise<boolean> {
  return hasClaudeAlias(await readRc(rc))
}
