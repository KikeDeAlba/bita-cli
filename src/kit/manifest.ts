import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../cli/router.ts'
import { HOOK_EVENTS } from '../hooks/hooks.ts'

export const TOOL_NAME = 'bita'
export const ENVELOPE_VERSION = 1
export const CAPABILITIES = ['time.entries.read', 'time.entries.write', 'time.events'] as const
export const EMITS: readonly string[] = HOOK_EVENTS
export const INSTALL_HINT = 'npm install -g @kikedealba/bita && bita setup'
export const HOMEPAGE = 'https://github.com/KikeDeAlba/bita-cli'
export const DESCRIPTION = 'Local time tracker: timers, entries and projects'

export const DEN_RELEASES = 'https://github.com/KikeDeAlba/bita-desktop/releases/latest'

export const SIBLING_INSTALLS = {
  inkwell: 'npm i -g @kikedealba/inkwell && inkwell setup',
  tally: 'npm i -g @kikedealba/tally && tally setup',
  atl: 'npm i -g @kikedealba/atl && atl setup',
  recap: 'npm i -g @kikedealba/recap && recap setup',
  Den: DEN_RELEASES,
} as const

export const MOVED_OUT = {
  recap: `bita no longer installs recap. Install it on its own: ${SIBLING_INSTALLS.recap}`,
  atlassian: `bita no longer sets up the Atlassian MCP; Jira and Confluence live in atl (${SIBLING_INSTALLS.atl}).`,
  docs: `bita no longer keeps documents; they live in inkwell (${SIBLING_INSTALLS.inkwell}).`,
  drawio: 'bita no longer sets up draw.io. Add its MCP yourself (claude mcp add --scope user drawio -- npx -y @drawio/mcp) and install draw.io Desktop to render .drawio files.',
}

export interface BitaCapabilities {
  name: string
  version: string
  envelope: number
  capabilities: string[]
  emits: string[]
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function binEntry(root: string = packageRoot()): string {
  const source = join(root, 'src', 'bin', 'bita.ts')
  if (existsSync(source)) return source
  return join(root, 'dist', 'bin', 'bita.js')
}

export function binCommand(root: string = packageRoot()): string[] {
  return [process.execPath, binEntry(root)]
}

export function capabilities(): BitaCapabilities {
  return {
    name: TOOL_NAME,
    version: VERSION,
    envelope: ENVELOPE_VERSION,
    capabilities: [...CAPABILITIES],
    emits: [...EMITS],
  }
}
