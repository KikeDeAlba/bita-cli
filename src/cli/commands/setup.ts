import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { MOVED_OUT, SIBLING_INSTALLS, TOOL_NAME, binCommand, packageRoot } from '../../kit/manifest.ts'
import { VERSION } from '../router.ts'
import {
  CLAUDE_MARKETPLACE,
  CLAUDE_MOD_PLUGIN,
  CLAUDE_PLUGIN,
  CODEX_EDIT_MATCHER,
  GEMINI_EDIT_MATCHER,
  RETIRED_COMMANDS,
  claudePermissions,
  integration,
  legacyClaudeIntegration,
  manifest,
  retiredIntegration,
} from '../../kit/integration.ts'

export { packageRoot }

const AGENT_NAMES = ['claude', 'opencode', 'codex', 'gemini'] as const
type AgentName = (typeof AGENT_NAMES)[number]

const OPTIONS = {
  target: { type: 'string' as const },
  agents: { type: 'string' as const },
  'claude-dir': { type: 'string' as const },
  'opencode-dir': { type: 'string' as const },
  'codex-home': { type: 'string' as const },
  'agents-home': { type: 'string' as const },
  'gemini-home': { type: 'string' as const },
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

function readAgents(value: string | undefined): AgentName[] | 'detected' {
  if (value === undefined || value === 'detected') return 'detected'
  const names = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  if (names.includes('all')) return [...AGENT_NAMES]
  const invalid = names.filter((name) => !(AGENT_NAMES as readonly string[]).includes(name))
  if (names.length === 0 || invalid.length > 0) {
    throw new UsageError(`Invalid setup target "${value}". Valid targets: ${[...AGENT_NAMES, 'all'].join(', ')}, or a comma list.`)
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
  if (claude) homes['claude'] = claude
  if (opencode) homes['opencode'] = opencode
  if (codex) homes['codex'] = codex
  if (agentsHome) homes['agentsSkills'] = join(agentsHome, 'skills')
  if (gemini) homes['gemini'] = join(gemini, '.gemini')
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

export function codexHooksStale(codexHome: string, editMatcher: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
  } catch {
    return false
  }
  const groups = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks?.['PostToolUse']
  if (!Array.isArray(groups)) return false
  return groups.some((group) => {
    const record = group as { matcher?: unknown; hooks?: Array<{ command?: unknown }> }
    const ours = Array.isArray(record.hooks) && record.hooks.some((hook) => hook.command === 'bita hook codex')
    return ours && record.matcher !== editMatcher
  })
}

function healthy(steps: readonly Step[]): boolean {
  return steps.length > 0 && steps.every((step) => step.state !== 'failed' && step.state !== 'unavailable')
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const requested = readAgents(readString(args, 'agents') ?? readString(args, 'target') ?? process.env['BITA_TARGET'])
  const root = packageRoot()

  if (!existsSync(join(root, 'skills', TOOL_NAME, 'SKILL.md')) || !existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    throw new UsageError(
      `This copy of bita has no skills to install (looked in ${root}). Install it from npm or from a clone of the repository.`,
    )
  }

  const warnings = IGNORED_FLAGS.filter(([flag]) => readBoolean(args, flag)).map(([flag, reason]) => `--${flag} is ignored: ${reason}`)
  for (const warning of warnings) writeErr(`Warning: ${warning}`)

  const kit = await loadKit()
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
    if (healthy(plugin)) {
      const legacy = legacyClaudeIntegration(root)
      if (!settings) delete legacy.claude
      steps.push(...(await kit.agents.removeLegacyClaude(legacy, { ctx, homes })).filter((step) => step.state === 'removed'))
    }
    if (settings) steps.push(...(await kit.agents.installIntegration(claudePermissions(), { agents: ['claude'], ctx, homes })))
  }

  const others = agents.filter((agent) => agent !== 'claude')
  if (others.length > 0) {
    const wanted = integration(root, { codexEditMatcher, geminiEditMatcher: matchers?.gemini ?? GEMINI_EDIT_MATCHER })
    const cleanup = others.filter((agent) => agent !== 'gemini')
    if (cleanup.length > 0 && retiredCommandsPresent(homes)) {
      steps.push(
        ...(await kit.agents.uninstallIntegration(retiredIntegration(root), { agents: cleanup, ctx, homes })).filter(
          (step) => step.state === 'removed' && step.item !== 'extension',
        ),
      )
    }
    if (others.includes('codex') && codexHooksStale(homes.codex, codexEditMatcher)) {
      steps.push(
        ...(await kit.agents.uninstallIntegration({ tool: TOOL_NAME, version: VERSION, codex: { hooks: wanted.codex?.hooks ?? {} } }, { agents: ['codex'], ctx, homes })).filter(
          (step) => step.state === 'removed',
        ),
      )
    }
    steps.push(...(await kit.agents.installIntegration(wanted, { agents: others, ctx, homes, skipMcp: true, claudeCompat: 'auto' })))
  }

  if (json) {
    writeJson(successEnvelope('setup', { root, agents, registered, steps, movedOut: MOVED_OUT, warnings }))
    return 0
  }

  if (registered) writeOut(`- registered bita for the other tools in ${registered}`)
  for (const step of steps) {
    writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.agent}: ${step.detail}`)
  }
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
