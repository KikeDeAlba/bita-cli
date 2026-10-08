import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { ensureDrawio, type SetupStep } from '../../setup/drawio.ts'
import { ensureCodexAtlassianMcp, ensureOpenCodeAtlassianMcp, type AtlassianMcpStep } from '../../setup/atlassian.ts'
import { defaultRecapEnvironment, ensureRecap, type RecapStep } from '../../setup/recap.ts'
import { initDocsRepo } from '../../docs/git.ts'
import { docsRoot } from '../../docs/paths.ts'
import { databasePath } from '../../db/paths.ts'

const run = promisify(execFile)
const TARGETS = ['claude', 'opencode', 'codex', 'all'] as const
type SetupTarget = (typeof TARGETS)[number]

const OPTIONS = {
  target: { type: 'string' as const },
  'claude-dir': { type: 'string' as const },
  'opencode-dir': { type: 'string' as const },
  'codex-home': { type: 'string' as const },
  'agents-home': { type: 'string' as const },
  'no-settings': { type: 'boolean' as const, default: false },
  'no-drawio': { type: 'boolean' as const, default: false },
  'no-atlassian': { type: 'boolean' as const, default: false },
  'no-recap': { type: 'boolean' as const, default: false },
  'no-docs-git': { type: 'boolean' as const, default: false },
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const target = readTarget(readString(args, 'target') ?? process.env['BITA_TARGET'])
  const root = packageRoot()
  const skillSource = join(root, 'skill')
  const openCodeSkillSource = join(root, 'skill-opencode')
  const codexSkillSource = join(root, 'skill-codex')
  const commandsSource = join(root, 'commands')

  if (!existsSync(skillSource) || !existsSync(openCodeSkillSource) || !existsSync(codexSkillSource) || !existsSync(commandsSource)) {
    throw new UsageError(
      `This copy of bita has no skill to install (looked in ${root}). Install it from npm or from a clone of the repository.`,
    )
  }

  const targets = target === 'all' ? TARGETS.slice(0, -1) : [target]
  const results: SetupResult[] = []
  for (const current of targets) {
    if (current === 'claude') {
      results.push(await setupClaude(root, skillSource, commandsSource, args))
    } else if (current === 'opencode') {
      results.push(await setupOpenCode(root, openCodeSkillSource, commandsSource, args))
    } else {
      results.push(await setupCodex(root, codexSkillSource, args))
    }
  }

  const drawio: SetupStep[] =
    target === 'claude' || target === 'all'
      ? readBoolean(args, 'no-drawio')
        ? []
        : await ensureDrawio()
      : []

  const recap: RecapStep[] =
    (target === 'claude' || target === 'all') && !readBoolean(args, 'no-recap')
      ? await ensureRecap(defaultRecapEnvironment(json ? undefined : (message) => writeOut(`- ${message}`)))
      : []

  const docsGit = readBoolean(args, 'no-docs-git') ? null : await setupDocsGit(args)

  if (json) {
    const legacy = target === 'claude' ? results[0] : undefined
    writeJson(
      successEnvelope('setup', {
        root,
        target,
        results,
        drawio,
        recap,
        docsGit,
        ...(legacy
          ? { claudeDir: legacy.directory, linked: legacy.linked, settings: legacy.settings }
          : {}),
      }),
    )
    return 0
  }

  for (const result of results) {
    writeOut(`${result.target}: ${result.message}`)
    for (const path of result.linked) writeOut(`- linked ${path}`)
    if (result.settings !== null) writeOut(`- configuration merged into ${result.settings}`)
    if (result.hooks !== null) writeOut(`- hooks merged into ${result.hooks}`)
    if (result.mcp !== null) writeOut(`${result.mcp.state === 'failed' || result.mcp.state === 'unavailable' ? '!' : '-'} ${result.mcp.detail}`)
  }
  for (const step of [...drawio, ...recap]) {
    writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.detail}`)
  }
  if (docsGit !== null) writeOut(`${docsGit.state === 'failed' ? '!' : '-'} ${docsGit.detail}`)
  writeOut('')
  writeOut('Next:')
  writeOut('  bita project add "<name>"     create a project')
  writeOut('  bita scope set . <projectId>  map this repository to it')
  writeOut('  bita app install              install the desktop app')
  return 0
}

interface DocsGitStep {
  state: 'initialized' | 'present' | 'failed'
  root: string
  head: string | null
  detail: string
}

async function setupDocsGit(args: ReturnType<typeof parseCommandArgs>): Promise<DocsGitStep> {
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

interface SetupResult {
  target: Exclude<SetupTarget, 'all'>
  directory: string
  linked: string[]
  settings: string | null
  hooks: string | null
  mcp: AtlassianMcpStep | null
  message: string
}

function readTarget(value: string | undefined): SetupTarget {
  const target = value ?? 'claude'
  if ((TARGETS as readonly string[]).includes(target)) return target as SetupTarget
  throw new UsageError(`Invalid setup target "${target}". Valid targets: ${TARGETS.join(', ')}.`)
}

async function setupClaude(root: string, skillSource: string, commandsSource: string, args: ReturnType<typeof parseCommandArgs>): Promise<SetupResult> {
  const claudeDir = readString(args, 'claude-dir') ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  const linked: string[] = []

  await mkdir(join(claudeDir, 'skills'), { recursive: true })
  const skillPath = join(claudeDir, 'skills', 'bita')
  await link(skillSource, skillPath)
  linked.push(skillPath)

  await mkdir(join(claudeDir, 'commands'), { recursive: true })
  for (const name of await readdir(commandsSource)) {
    if (!name.endsWith('.md')) continue
    const commandPath = join(claudeDir, 'commands', name)
    await link(join(commandsSource, name), commandPath)
    linked.push(commandPath)
  }

  let settings: string | null = null
  if (!readBoolean(args, 'no-settings')) {
    const target = join(claudeDir, 'settings.json')
    const merger = join(root, 'scripts', 'merge-settings.mjs')
    if (existsSync(merger)) {
      await run(process.execPath, [merger, target])
      settings = target
    }
  }

  return { target: 'claude', directory: claudeDir, linked, settings, hooks: null, mcp: null, message: `skill and commands linked into ${claudeDir}` }
}

async function setupOpenCode(root: string, skillSource: string, commandsSource: string, args: ReturnType<typeof parseCommandArgs>): Promise<SetupResult> {
  const configHome = readString(args, 'opencode-dir') ?? join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'opencode')
  const linked: string[] = []

  await mkdir(join(configHome, 'skills'), { recursive: true })
  const skillPath = join(configHome, 'skills', 'bita')
  await link(skillSource, skillPath)
  linked.push(skillPath)

  await mkdir(join(configHome, 'commands'), { recursive: true })
  for (const name of await readdir(commandsSource)) {
    if (!name.endsWith('.md')) continue
    const commandPath = join(configHome, 'commands', name)
    await link(join(commandsSource, name), commandPath)
    linked.push(commandPath)
  }

  const pluginSource = opencodePluginSource(root)
  await mkdir(join(configHome, 'plugins'), { recursive: true })
  const pluginPath = join(configHome, 'plugins', `bita${extname(pluginSource)}`)
  await link(pluginSource, pluginPath)
  linked.push(pluginPath)

  const mcp = readBoolean(args, 'no-atlassian') ? null : await ensureOpenCodeAtlassianMcp()
  return { target: 'opencode', directory: configHome, linked, settings: null, hooks: null, mcp, message: `skill, commands, and plugin linked into ${configHome}` }
}

async function setupCodex(root: string, skillSource: string, args: ReturnType<typeof parseCommandArgs>): Promise<SetupResult> {
  const codexHome = readString(args, 'codex-home') ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const agentsHome = readString(args, 'agents-home') ?? process.env['BITA_AGENTS_HOME'] ?? join(homedir(), '.agents')
  const skillRoot = join(agentsHome, 'skills')
  const skillPath = join(skillRoot, 'bita')
  await mkdir(skillRoot, { recursive: true })
  await link(skillSource, skillPath)

  const hooks = join(codexHome, 'hooks.json')
  const merger = join(root, 'scripts', 'merge-codex-hooks.mjs')
  await mkdir(codexHome, { recursive: true })
  await run(process.execPath, [merger, hooks])

  const mcp = readBoolean(args, 'no-atlassian') ? null : await ensureCodexAtlassianMcp(join(codexHome, 'config.toml'))
  return { target: 'codex', directory: codexHome, linked: [skillPath], settings: null, hooks, mcp, message: `skill linked into ${skillRoot}` }
}

function opencodePluginSource(root: string): string {
  const source = join(root, 'src', 'integrations', 'opencode.ts')
  if (existsSync(source)) return source
  const built = join(root, 'dist', 'integrations', 'opencode.js')
  if (existsSync(built)) return built
  throw new UsageError(`This copy of bita has no OpenCode plugin (looked in ${root}).`)
}

async function link(target: string, linkName: string): Promise<void> {
  try {
    const existing = await readlink(linkName)
    if (existing === target) return
    await rm(linkName)
  } catch {
    if (existsSync(linkName)) await rename(linkName, `${linkName}.backup`)
  }

  await symlink(target, linkName)
}
