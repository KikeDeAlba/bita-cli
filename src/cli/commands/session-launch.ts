import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { writeErr } from '../output.ts'
import { promptLine } from '../prompt.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { resolveMappedProject } from '../resolve-project.ts'
import { currentRepoIdentity } from './repo.ts'
import { listProjects } from '../../db/projects.ts'
import { findCheckoutProject } from '../../db/project-repos.ts'
import type { ProjectRow } from '../../db/rows.ts'
import { readRepoContext } from '../../state/git.ts'
import { readConfig } from '../../state/config.ts'
import {
  HARNESS_ENV,
  SESSION_PROJECT_ENV,
  WRAPPER_ID_ENV,
  closeWrapper,
  isChild,
  startSessionEntry,
  sweepOrphans,
} from '../../domain/session.ts'
import { harnessBinEnvVar, isHarnessId, listAdapters } from '../../harness/registry.ts'
import type { HarnessAdapter, HarnessId } from '../../harness/types.ts'

export const EXIT_INTERRUPTED = 130
export const EXIT_NOT_FOUND = 127

const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'kill',
  'ultrareview',
  'update',
  'upgrade',
  'config',
  'migrate-installer',
])

const PASSTHROUGH_FLAGS = new Set(['-p', '--print', '-v', '--version', '-h', '--help', '--bg', '--background'])

const LAUNCH_OPTIONS = {
  harness: { type: 'string' as const },
  project: { type: 'string' as const },
}

export interface LaunchDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  adapters: readonly HarnessAdapter[]
  ask(question: string): Promise<string | null>
  spawnHarness(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number>
  startEntry: typeof startSessionEntry
  closeWrapper: typeof closeWrapper
  sweepOrphans: typeof sweepOrphans
  projectForCwd(ctx: LocalContext, cwd: string): Promise<number | null>
}

export function isPassthrough(
  args: readonly string[],
  io: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
  env: NodeJS.ProcessEnv,
): boolean {
  if (isChild(env)) return true
  if (env[WRAPPER_ID_ENV]) return true
  if (!io.stdinIsTTY || !io.stdoutIsTTY) return true
  const first = args[0]
  if (first !== undefined && CLAUDE_SUBCOMMANDS.has(first)) return true
  for (const arg of args) {
    if (arg === '--') break
    if (PASSTHROUGH_FLAGS.has(arg)) return true
  }
  return false
}

export function splitLaunchArgv(argv: readonly string[]): { own: string[]; harnessArgs: string[] } {
  const separator = argv.indexOf('--')
  if (separator === -1) return { own: [...argv], harnessArgs: [] }
  return { own: argv.slice(0, separator), harnessArgs: argv.slice(separator + 1) }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0)
}

export function spawnHarness(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: 'inherit', env })
    const ignore = (): void => {}
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    const detach = (): void => {
      process.off('SIGINT', ignore)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
    }
    process.on('SIGINT', ignore)
    process.on('SIGTERM', forward)
    process.on('SIGHUP', forward)
    let settled = false
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      detach()
      if (error.code === 'ENOENT') {
        writeErr(`bita: ${bin} was not found.`)
        resolve(EXIT_NOT_FOUND)
        return
      }
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      detach()
      resolve(signal ? signalExitCode(signal) : (code ?? 1))
    })
  })
}

export async function mappedProjectId(ctx: LocalContext, cwd: string): Promise<number | null> {
  const identity = await currentRepoIdentity(cwd)
  if (!identity) return null
  const mapped = resolveMappedProject(identity.slug, await readConfig())
  if (mapped) return mapped.projectId
  const toplevel = (await readRepoContext(cwd)).toplevel
  return toplevel ? (findCheckoutProject(ctx.db, toplevel, identity.slug)?.projectId ?? null) : null
}

function defaultDeps(): LaunchDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    adapters: listAdapters(),
    ask: promptLine,
    spawnHarness,
    startEntry: startSessionEntry,
    closeWrapper,
    sweepOrphans,
    projectForCwd: mappedProjectId,
  }
}

function claudeBin(deps: LaunchDeps): string {
  const adapter = deps.adapters.find((candidate) => candidate.id === 'claude')
  return adapter?.resolveBin(deps.env) ?? deps.env[harnessBinEnvVar('claude')] ?? 'claude'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Choice<T> = { value: T } | { interrupted: true }

async function pickHarness(deps: LaunchDeps, requested: string | undefined): Promise<Choice<HarnessAdapter>> {
  const available = deps.adapters.filter((adapter) => adapter.available(deps.env))
  if (requested !== undefined) {
    if (!isHarnessId(requested)) throw new UsageError(`Unknown harness "${requested}". Valid harnesses: claude, opencode, codex, gemini.`)
    const adapter = available.find((candidate) => candidate.id === requested)
    if (!adapter) throw new UsageError(`The ${requested} harness is not installed.`)
    return { value: adapter }
  }
  const [only] = available
  if (!only) throw new UsageError('No harness is installed: claude, opencode, codex or gemini must be on PATH.')
  if (available.length === 1) return { value: only }

  const fallback = available.find((adapter) => adapter.id === 'claude') ?? only
  const defaultIndex = available.indexOf(fallback) + 1
  writeErr('Harness:')
  for (const [index, adapter] of available.entries()) writeErr(`  ${index + 1}. ${adapter.label}`)
  for (;;) {
    const answer = await deps.ask(`Pick one [${defaultIndex}]: `)
    if (answer === null) return { interrupted: true }
    if (answer === '') return { value: fallback }
    const picked = Number(answer)
    const adapter = Number.isInteger(picked) && picked >= 1 ? available[picked - 1] : undefined
    if (adapter) return { value: adapter }
    writeErr(`Pick a number from 1 to ${available.length}.`)
  }
}

async function pickProject(
  ctx: LocalContext,
  deps: LaunchDeps,
  requested: string | undefined,
): Promise<Choice<ProjectRow | null>> {
  if (requested !== undefined) {
    if (requested.trim() === '0') return { value: null }
    return { value: resolveProjectArg(ctx.db, requested) }
  }

  const projects = listProjects(ctx.db)
  let mapped: number | null = null
  try {
    mapped = await deps.projectForCwd(ctx, deps.cwd)
  } catch {
    mapped = null
  }
  const mappedIndex = mapped === null ? -1 : projects.findIndex((project) => project.id === mapped)
  const defaultChoice = mappedIndex >= 0 ? mappedIndex + 1 : projects.length === 0 ? 0 : null

  writeErr('Project:')
  writeErr('  0. No timer')
  for (const [index, project] of projects.entries()) writeErr(`  ${index + 1}. ${project.name} (${project.id})`)
  if (projects.length === 0) writeErr('No projects yet; create one with: bita project add "<name>"')
  const question = defaultChoice === null ? 'Pick one: ' : `Pick one [${defaultChoice}]: `
  for (;;) {
    const answer = await deps.ask(question)
    if (answer === null) return { interrupted: true }
    const picked = answer === '' ? defaultChoice : Number(answer)
    if (picked === 0) return { value: null }
    const project = picked !== null && Number.isInteger(picked) && picked >= 1 ? projects[picked - 1] : undefined
    if (project) return { value: project }
    writeErr(`Pick a number from 0 to ${projects.length}.`)
  }
}

interface Prepared {
  adapter: HarnessAdapter
  project: ProjectRow | null
  entryId: number | null
  databasePath: string
}

async function prepare(args: ParsedArgs, deps: LaunchDeps, wrapperId: string): Promise<Prepared | null> {
  const ctx = createLocalContext(args)
  try {
    try {
      await deps.sweepOrphans(ctx)
    } catch (error) {
      writeErr(`bita: could not close orphan sessions: ${errorMessage(error)}`)
    }
    const harness = await pickHarness(deps, readString(args, 'harness'))
    if ('interrupted' in harness) return null
    const project = await pickProject(ctx, deps, readString(args, 'project'))
    if ('interrupted' in project) return null
    if (!project.value) return { adapter: harness.value, project: null, entryId: null, databasePath: ctx.databasePath }
    try {
      const started = await deps.startEntry(ctx, {
        wrapperId,
        wrapperPid: process.pid,
        harness: harness.value.id,
        projectId: project.value.id,
        cwd: deps.cwd,
      })
      return { adapter: harness.value, project: project.value, entryId: started.entryId, databasePath: ctx.databasePath }
    } catch (error) {
      writeErr(`bita: could not start the timer, launching without it: ${errorMessage(error)}`)
      return { adapter: harness.value, project: null, entryId: null, databasePath: ctx.databasePath }
    }
  } finally {
    ctx.db.close()
  }
}

function sessionEnv(env: NodeJS.ProcessEnv, wrapperId: string, harness: HarnessId, projectId: number, databasePath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    [WRAPPER_ID_ENV]: wrapperId,
    [HARNESS_ENV]: harness,
    [SESSION_PROJECT_ENV]: String(projectId),
    BITA_DB_PATH: databasePath,
  }
}

async function closeSession(args: ParsedArgs, deps: LaunchDeps, wrapperId: string): Promise<void> {
  try {
    const ctx = createLocalContext(args)
    try {
      await deps.closeWrapper(ctx, wrapperId)
    } finally {
      ctx.db.close()
    }
  } catch (error) {
    writeErr(`bita: could not close the session timer: ${errorMessage(error)}`)
  }
}

export async function runSessionLaunch(argv: string[], overrides: Partial<LaunchDeps> = {}): Promise<number> {
  const deps: LaunchDeps = { ...defaultDeps(), ...overrides }
  const { own, harnessArgs } = splitLaunchArgv(argv)
  const args = parseCommandArgs(own, LAUNCH_OPTIONS, BASE_OPTIONS)
  if (args.positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${args.positionals[0]}". Pass the harness arguments after --: bita session -- ${args.positionals.join(' ')}`)
  }

  const requestedHarness = readString(args, 'harness')
  if ((requestedHarness === undefined || requestedHarness === 'claude') && isPassthrough(harnessArgs, deps, deps.env)) {
    return deps.spawnHarness(claudeBin(deps), harnessArgs, deps.env)
  }

  const wrapperId = randomUUID()
  const prepared = await prepare(args, deps, wrapperId)
  if (!prepared) return EXIT_INTERRUPTED

  const { adapter, project, entryId, databasePath } = prepared
  const plan = adapter.launchArgs(harnessArgs)
  for (const warning of plan.warnings) writeErr(warning)
  const bin = adapter.resolveBin(deps.env) ?? adapter.bin

  if (!project || entryId === null) return deps.spawnHarness(bin, plan.args, deps.env)

  try {
    return await deps.spawnHarness(bin, plan.args, sessionEnv(deps.env, wrapperId, adapter.id, project.id, databasePath))
  } finally {
    await closeSession(args, deps, wrapperId)
  }
}
