import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { initDocsRepo } from '../../docs/git.ts'
import { docsRoot } from '../../docs/paths.ts'
import { databasePath } from '../../db/paths.ts'
import { DEN_RELEASES, MOVED_OUT, RECAP_INSTALL, packageRoot } from '../../kit/manifest.ts'
import { integration, manifest } from '../../kit/integration.ts'

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
  'no-atlassian': { type: 'boolean' as const, default: false },
  'no-register': { type: 'boolean' as const, default: false },
  'no-docs-git': { type: 'boolean' as const, default: false },
  'no-drawio': { type: 'boolean' as const, default: false },
  'no-recap': { type: 'boolean' as const, default: false },
}

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

interface DocsGitStep {
  state: 'initialized' | 'present' | 'failed'
  root: string
  head: string | null
  detail: string
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const requested = readAgents(readString(args, 'agents') ?? readString(args, 'target') ?? process.env['BITA_TARGET'])
  const root = packageRoot()

  if (!existsSync(join(root, 'skill', 'SKILL.md')) || !existsSync(join(root, 'commands'))) {
    throw new UsageError(
      `This copy of bita has no skill to install (looked in ${root}). Install it from npm or from a clone of the repository.`,
    )
  }

  const warnings: string[] = []
  if (readBoolean(args, 'no-drawio')) warnings.push(`--no-drawio is ignored: ${MOVED_OUT.drawio}`)
  if (readBoolean(args, 'no-recap')) warnings.push(`--no-recap is ignored: ${MOVED_OUT.recap}`)
  for (const warning of warnings) writeErr(`Warning: ${warning}`)

  const kit = await loadKit()
  const ctx = kit.platformContext()
  const homes = kit.agents.agentHomes(ctx, homeOverrides(args))
  let agents: AgentName[] = requested === 'detected' ? await kit.agents.detectAgents(ctx, homes) : requested
  if (agents.length === 0) agents = ['claude']

  const registered = readBoolean(args, 'no-register') ? null : await kit.registerTool(manifest(root), ctx)

  const atlassian = !readBoolean(args, 'no-atlassian')
  const wanted = integration(root, { settings: !readBoolean(args, 'no-settings'), atlassian })
  const steps: Step[] = []
  if (agents.includes('claude')) {
    steps.push(...(await kit.agents.installIntegration(wanted, { agents: ['claude'], ctx, homes, skipMcp: true })))
  }
  const others = agents.filter((agent) => agent !== 'claude')
  if (others.length > 0) {
    steps.push(...(await kit.agents.installIntegration(wanted, { agents: others, ctx, homes, skipMcp: !atlassian })))
  }

  const docsGit = readBoolean(args, 'no-docs-git') ? null : await setupDocsGit(args)

  if (json) {
    writeJson(
      successEnvelope('setup', {
        root,
        agents,
        registered,
        steps,
        docsGit,
        movedOut: MOVED_OUT,
        warnings,
      }),
    )
    return 0
  }

  if (registered) writeOut(`- registered bita for the other tools in ${registered}`)
  for (const step of steps) {
    writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.agent}: ${step.detail}`)
  }
  if (docsGit !== null) writeOut(`${docsGit.state === 'failed' ? '!' : '-'} ${docsGit.detail}`)
  writeOut('')
  writeOut('Installed apart, if you want them:')
  writeOut(`  recap   ${RECAP_INSTALL}`)
  writeOut(`  Den     ${DEN_RELEASES}`)
  writeOut('')
  writeOut('Next:')
  writeOut('  bita project add "<name>"     create a project')
  writeOut('  bita scope set . <projectId>  map this repository to it')
  return 0
}

async function setupDocsGit(args: ParsedArgs): Promise<DocsGitStep> {
  const root = readString(args, 'docs-dir') ?? docsRoot(process.env, readString(args, 'db-path') ?? databasePath())
  try {
    const state = await initDocsRepo(root)
    return {
      state: state.initialized ? 'initialized' : 'present',
      root,
      head: state.head,
      detail: state.initialized ? `docs history started in ${root}` : `docs history already in ${root}`,
    }
  } catch (error) {
    return { state: 'failed', root, head: null, detail: `docs history not started: ${error instanceof Error ? error.message : String(error)}` }
  }
}
