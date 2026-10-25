import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { databasePath } from '../../db/paths.ts'
import { hooksLogPath } from '../../hooks/hooks.ts'
import { LAUNCHER_FILE } from '../../integrations/opencode.ts'
import { bitaDirs } from '../../state/dirs.ts'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { MOVED_OUT, SIBLING_INSTALLS, TOOL_NAME, binCommand, binEntry, packageRoot } from '../../kit/manifest.ts'
import { VERSION } from '../router.ts'
import {
  CLAUDE_MARKETPLACE,
  CLAUDE_MOD_PLUGIN,
  CLAUDE_PLUGIN,
  CODEX_EDIT_MATCHER,
  GEMINI_EDIT_MATCHER,
  RETIRED_COMMANDS,
  claudePermissions,
  denAgentHookCommand,
  integration,
  isDenAgentHookCommand,
  legacyClaudeIntegration,
  manifest,
  retiredIntegration,
} from '../../kit/integration.ts'
import { displayPath, removeLegacyShellFunctions } from '../legacy-shell.ts'

export { packageRoot }

type AgentName = import('@kikedealba/kit/agents').AgentName

const OPTIONS = {
  target: { type: 'string' as const },
  agents: { type: 'string' as const },
  'claude-dir': { type: 'string' as const },
  'opencode-dir': { type: 'string' as const },
  'codex-home': { type: 'string' as const },
  'agents-home': { type: 'string' as const },
  'gemini-home': { type: 'string' as const },
  'antigravity-home': { type: 'string' as const },
  'no-settings': { type: 'boolean' as const, default: false },
  'no-register': { type: 'boolean' as const, default: false },
  mod: { type: 'boolean' as const, default: false },
  'no-atlassian': { type: 'boolean' as const, default: false },
  'no-docs-git': { type: 'boolean' as const, default: false },
  'no-drawio': { type: 'boolean' as const, default: false },
  'no-recap': { type: 'boolean' as const, default: false },
}

const IGNORED_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['no-atlassian', MOVED_OUT.atlassian],
  ['no-docs-git', MOVED_OUT.docs],
  ['no-drawio', MOVED_OUT.drawio],
  ['no-recap', MOVED_OUT.recap],
]

type KitModule = typeof import('@kikedealba/kit')
type Step = Awaited<ReturnType<KitModule['agents']['installIntegration']>>[number]

async function loadKit(): Promise<KitModule> {
  try {
    return await import('@kikedealba/kit')
  } catch (error) {
    throw new UsageError(
      `bita setup needs its dependencies (@kikedealba/kit), which this copy cannot load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. Install bita from npm, or run "pnpm install" in the clone.`,
    )
  }
}

export function readAgents(value: string | undefined, known: readonly AgentName[]): AgentName[] | 'detected' {
  if (value === undefined || value === 'detected') return 'detected'
  const names = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  if (names.includes('all')) return [...known]
  const invalid = names.filter((name) => !(known as readonly string[]).includes(name))
  if (names.length === 0 || invalid.length > 0) {
    throw new UsageError(`Invalid setup target "${value}". Valid targets: ${[...known, 'all'].join(', ')}, or a comma list.`)
  }
  return [...new Set(names)] as AgentName[]
}

function homeOverrides(args: ParsedArgs): Record<string, string> {
  const homes: Record<string, string> = {}
  const claude = readString(args, 'claude-dir')
  const opencode = readString(args, 'opencode-dir')
  const codex = readString(args, 'codex-home')
  const agentsHome = readString(args, 'agents-home') ?? process.env['BITA_AGENTS_HOME']
  const gemini = readString(args, 'gemini-home')
  const antigravity = readString(args, 'antigravity-home')
  if (claude) homes['claude'] = claude
  if (opencode) homes['opencode'] = opencode
  if (codex) homes['codex'] = codex
  if (agentsHome) homes['agentsSkills'] = join(agentsHome, 'skills')
  if (gemini) homes['gemini'] = join(gemini, '.gemini')
  if (antigravity) homes['antigravity'] = antigravity
  return homes
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function retiredCommandsPresent(homes: { opencode: string; codex: string }): boolean {
  return RETIRED_COMMANDS.some(
    (name) => present(join(homes.opencode, 'commands', `${name}.md`)) || present(join(homes.codex, 'prompts', `${name}.md`)),
  )
}

function readCodexHooks(codexHome: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    const hooks = (parsed as { hooks?: unknown } | null)?.hooks
    return typeof hooks === 'object' && hooks !== null ? (hooks as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function hookCommands(group: unknown): string[] {
  const record = group as { hooks?: Array<{ command?: unknown }> } | null
  if (!Array.isArray(record?.hooks)) return []
  return record.hooks.map((hook) => hook.command).filter((command): command is string => typeof command === 'string')
}

export function staleDenHookCommands(hooks: Record<string, unknown> | undefined, current: string): string[] {
  const commands = Object.values(hooks ?? {})
    .flatMap((groups) => (Array.isArray(groups) ? groups.flatMap(hookCommands) : []))
    .filter((command) => isDenAgentHookCommand(command) && command !== current)
  return [...new Set(commands)]
}

export function codexStaleDenHookCommands(codexHome: string): string[] {
  return staleDenHookCommands(readCodexHooks(codexHome), denAgentHookCommand('codex'))
}

export function codexHooksStale(codexHome: string, editMatcher: string): boolean {
  const hooks = readCodexHooks(codexHome)
  if (!hooks) return false
  const ours = (group: unknown): boolean => hookCommands(group).includes('bita hook codex')
  const groups = (event: string): unknown[] => {
    const value = hooks[event]
    return Array.isArray(value) ? value : []
  }
  if (groups('UserPromptSubmit').some(ours)) return true
  if (staleDenHookCommands(hooks, denAgentHookCommand('codex')).length > 0) return true
  return groups('PostToolUse').some((group) => ours(group) && (group as { matcher?: unknown }).matcher !== editMatcher)
}

function pluginInPlace(steps: readonly Step[], plugin: string): boolean {
  return steps.some((step) => step.item === `plugin ${plugin}@${CLAUDE_MARKETPLACE.marketplaceName}` && (step.state === 'installed' || step.state === 'present'))
}

export interface OpenCodeLauncher {
  command: string
  args: string[]
  cwd: string
  log: string
}

export function openCodeLauncher(root: string): OpenCodeLauncher {
  const data = bitaDirs().data
  return { command: process.execPath, args: [binEntry(root)], cwd: data, log: hooksLogPath(databasePath()) }
}

export function writeOpenCodeLauncher(opencodeHome: string, launcher: OpenCodeLauncher): string {
  const file = join(opencodeHome, LAUNCHER_FILE)
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(launcher.cwd, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(launcher, null, 2)}\n`)
  renameSync(temp, file)
  return file
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  const kit = await loadKit()
  const requested = readAgents(readString(args, 'agents') ?? readString(args, 'target') ?? process.env['BITA_TARGET'], kit.agents.AGENTS)
  const root = packageRoot()

  if (!existsSync(join(root, 'skills', TOOL_NAME, 'SKILL.md')) || !existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new UsageError(
      `This copy of bita has no skills to install (looked in ${root}). Install it from npm or from a clone of the repository.`,
    )
  }

  const warnings = IGNORED_FLAGS.filter(([flag]) => readBoolean(args, flag)).map(([flag, reason]) => `--${flag} is ignored: ${reason}`)
  for (const warning of warnings) writeErr(`Warning: ${warning}`)

  const ctx = kit.platformContext()
  const homes = kit.agents.agentHomes(ctx, homeOverrides(args))
  let agents: AgentName[] = requested === 'detected' ? await kit.agents.detectAgents(ctx, homes) : requested
  if (agents.length === 0) agents = ['claude']

  const registered = readBoolean(args, 'no-register')
    ? null
    : await kit.registerTool(manifest(root, await kit.stableBin(TOOL_NAME, VERSION, binCommand(root), ctx)), ctx)

  const settings = !readBoolean(args, 'no-settings')
  const matchers = kit.agents.EDIT_TOOL_MATCHERS
  const codexEditMatcher = matchers?.codex ?? CODEX_EDIT_MATCHER
  const steps: Step[] = []

  if (agents.includes('claude')) {
    const plugin = await kit.agents.installClaudePlugin({ ...CLAUDE_MARKETPLACE, plugin: CLAUDE_PLUGIN }, { ctx, homes })
    steps.push(...plugin)
    if (readBoolean(args, 'mod')) steps.push(...(await kit.agents.installClaudePlugin({ ...CLAUDE_MARKETPLACE, plugin: CLAUDE_MOD_PLUGIN }, { ctx, homes })))
    if (pluginInPlace(plugin, CLAUDE_PLUGIN)) {
      const legacy = legacyClaudeIntegration(root)
      if (!settings && legacy.claude) delete legacy.claude.permissions
      steps.push(...(await kit.agents.removeLegacyClaude(legacy, { ctx, homes })).filter((step) => step.state === 'removed'))
    }
    if (settings) steps.push(...(await kit.agents.installIntegration(claudePermissions(), { agents: ['claude'], ctx, homes })))
  }

  const others = agents.filter((agent) => agent !== 'claude')
  if (others.length > 0) {
    const wanted = integration(root, { codexEditMatcher, geminiEditMatcher: matchers?.gemini ?? GEMINI_EDIT_MATCHER })
    const cleanup = others.filter((agent) => agent === 'opencode' || agent === 'codex')
    if (cleanup.length > 0 && retiredCommandsPresent(homes)) {
      steps.push(
        ...(await kit.agents.uninstallIntegration(retiredIntegration(root), { agents: cleanup, ctx, homes })).filter(
          (step) => step.state === 'removed' && step.item !== 'extension',
        ),
      )
    }
    if (others.includes('codex') && codexHooksStale(homes.codex, codexEditMatcher)) {
      const staleDen = codexStaleDenHookCommands(homes.codex).map((command) => ({ type: 'command' as const, command }))
      const hooks = { ...(wanted.codex?.hooks ?? {}), ...(staleDen.length > 0 ? { StaleDen: [{ hooks: staleDen }] } : {}) }
      steps.push(
        ...(await kit.agents.uninstallIntegration({ tool: TOOL_NAME, version: VERSION, codex: { hooks } }, { agents: ['codex'], ctx, homes })).filter(
          (step) => step.state === 'removed',
        ),
      )
    }
    steps.push(...(await kit.agents.installIntegration(wanted, { agents: others, ctx, homes, skipMcp: true, claudeCompat: 'auto' })))
    if (others.includes('opencode')) {
      try {
        const file = writeOpenCodeLauncher(homes.opencode, openCodeLauncher(root))
        steps.push({ agent: 'opencode', item: 'launcher', state: 'installed', detail: `bita launcher for the opencode plugin in ${file}`, path: file })
      } catch (error) {
        steps.push({ agent: 'opencode', item: 'launcher', state: 'failed', detail: `could not write the bita launcher: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }

  const legacyShell = await removeLegacyShellFunctions()
  for (const error of legacyShell.errors) {
    writeErr(`Warning: ${error}`)
    warnings.push(error)
  }
  const shell = { removed: legacyShell.removed }

  if (json) {
    writeJson(successEnvelope('setup', { root, agents, registered, steps, shell, movedOut: MOVED_OUT, warnings }))
    return 0
  }

  if (registered) writeOut(`- registered bita for the other tools in ${registered}`)
  for (const step of steps) {
    writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.agent}: ${step.detail}`)
  }
  for (const rc of shell.removed) writeOut(`- shell: removed the claude wrapper from ${displayPath(rc)}`)
  writeOut('')
  writeOut('bita only keeps the time. The rest is installed apart, if you want it:')
  for (const [name, install] of Object.entries(SIBLING_INSTALLS)) writeOut(`  ${name.padEnd(8)}${install}`)
  writeOut('')
  writeOut('Next:')
  writeOut('  bita project add "<name>"     create a project')
  writeOut('  bita scope set . <projectId>  map this repository to it')
  if (agents.includes('claude')) {
    writeOut('  Claude Code status line: "statusLine": { "type": "command", "command": "bita statusline" } in ~/.claude/settings.json')
  }
  return 0
}
