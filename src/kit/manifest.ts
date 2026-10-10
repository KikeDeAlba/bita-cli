import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../cli/router.ts'
import { HOOK_EVENTS } from '../hooks/hooks.ts'

export const TOOL_NAME = 'bita'
export const ENVELOPE_VERSION = 1
export const CAPABILITIES = ['time.entries.read', 'time.entries.write', 'time.notes', 'time.events'] as const
export const EMITS: readonly string[] = HOOK_EVENTS
export const INSTALL_HINT = 'npm install -g @kikedealba/bita && bita setup'
export const HOMEPAGE = 'https://github.com/KikeDeAlba/bita-cli'
export const DESCRIPTION = 'Local time tracker that documents the work and sends it to Jira'

export const RECAP_INSTALL = 'npm i -g @kikedealba/recap && recap setup'
export const DEN_RELEASES = 'https://github.com/KikeDeAlba/bita-desktop/releases/latest'

export const MOVED_OUT = {
  recap: `bita no longer installs recap. Install it on its own: ${RECAP_INSTALL}`,
  drawio: 'bita no longer sets up draw.io. Add its MCP yourself (claude mcp add --scope user drawio -- npx -y @drawio/mcp) and install draw.io Desktop to render .drawio files.',
  app: `bita no longer installs the desktop app. Download Den from ${DEN_RELEASES}`,
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
