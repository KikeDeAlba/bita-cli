import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { constants } from 'node:os'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { writeErr } from '../output.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { resolveMappedProject } from '../resolve-project.ts'
import { select } from '../select.ts'
import { currentRepoIdentity } from './repo.ts'
import { findProjectById, listProjects } from '../../db/projects.ts'
import { findCheckoutProject } from '../../db/project-repos.ts'
import type { ProjectRow } from '../../db/rows.ts'
import { findResumableByEntry, findResumableByRow, findResumableBySessionId, listResumableSessions, type ResumableSession } from '../../db/sessions.ts'
import { localDay } from '../../domain/timezone.ts'
import { readRepoContext } from '../../state/git.ts'
import { readConfig } from '../../state/config.ts'
import {
  HARNESS_ENV,
  SESSION_PROJECT_ENV,
  WRAPPER_ID_ENV,
  attachExitSession,
  closeWrapper,
  withoutHarnessSession,
  isChild,
  startSessionEntry,
  sweepOrphans,
} from '../../domain/session.ts'
import { parseClaudeArgs } from '../../harness/args.ts'
import { spawnCommand, withBinOnPath } from '../../harness/process.ts'
import { isHarnessId, listAdapters } from '../../harness/registry.ts'
import { HARNESS_IDS, type HarnessAdapter, type HarnessId } from '../../harness/types.ts'

export const EXIT_INTERRUPTED = 130
export const EXIT_NOT_FOUND = 127

const LAUNCH_OPTIONS = {
  harness: { type: 'string' as const },
  project: { type: 'string' as const },
  resume: { type: 'boolean' as const },
  session: { type: 'string' as const },
  prompt: { type: 'string' as const },
}

export interface LaunchDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  adapters: readonly HarnessAdapter[]
  select: typeof select
  spawnHarness(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number>
  startEntry: typeof startSessionEntry
  closeWrapper: typeof closeWrapper
  sweepOrphans: typeof sweepOrphans
  projectForCwd(ctx: LocalContext, cwd: string): Promise<number | null>
}

export function splitLaunchArgv(argv: readonly string[]): { own: string[]; harnessArgs: string[] } {
  const separator = argv.indexOf('--')
  if (separator === -1) return { own: [...argv], harnessArgs: [] }
  return { own: argv.slice(0, separator), harnessArgs: argv.slice(separator + 1) }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0)
}

export function spawnHarness(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const spec = spawnCommand(bin, args, env)
    const child = spawn(spec.command, spec.args, {
      stdio: 'inherit',
      env: cwd === undefined ? env : { ...env, PWD: cwd },
      cwd,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
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
    select,
    spawnHarness,
    startEntry: startSessionEntry,
    closeWrapper,
    sweepOrphans,
    projectForCwd: mappedProjectId,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Choice<T> = { value: T } | { interrupted: true }

function requireTerminal(
  deps: LaunchDeps,
  message = 'Picking a harness or project needs a terminal; pass --harness and --project, or run the harness directly.',
): void {
  if (deps.stdinIsTTY && deps.stdoutIsTTY) return
  throw new UsageError(message)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface ResumeRequest {
  entryId: number | null
  session: string | null
}

function readResumeRequest(args: ParsedArgs): ResumeRequest | null {
  const session = readString(args, 'session')
  if (session !== undefined && !readBoolean(args, 'resume')) {
    throw new UsageError('--session picks the session to resume; pass it with --resume: bita work --resume --session ID')
  }
  if (!readBoolean(args, 'resume')) {
    if (args.positionals.length > 0) {
      throw new UsageError(`Unexpected argument "${args.positionals[0]}". Pass the harness arguments after --: bita work -- ${args.positionals.join(' ')}`)
    }
    return null
  }
  const [raw, extra] = args.positionals
  if (extra !== undefined) {
    throw new UsageError(`Unexpected argument "${extra}". --resume takes at most one ENTRY_ID; pass the harness arguments after --.`)
  }
  if (session !== undefined) {
    if (raw !== undefined) throw new UsageError('Pass either ENTRY_ID or --session ID to --resume, not both.')
    if (session.trim() === '') throw new UsageError('--session takes a session id; see bita sessions ls.')
    return { entryId: null, session: session.trim() }
  }
  if (raw === undefined) return { entryId: null, session: null }
  const entryId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(entryId) || entryId <= 0) {
    throw new UsageError(`Invalid ENTRY_ID "${raw}". Expected a positive integer.`)
  }
  return { entryId, session: null }
}

function findResumableBySession(ctx: LocalContext, ref: string): ResumableSession | undefined {
  const rowId = /^\d+$/.test(ref) ? Number(ref) : Number.NaN
  const byRow = Number.isSafeInteger(rowId) && rowId > 0 ? findResumableByRow(ctx.db, rowId) : undefined
  return byRow ?? findResumableBySessionId(ctx.db, ref)
}

export function withPrompt(harnessArgs: readonly string[], prompt: string | undefined): string[] {
  if (prompt === undefined) return [...harnessArgs]
  if (prompt.trim() === '') throw new UsageError('--prompt takes the text of the first message.')
  if (parseClaudeArgs(harnessArgs).prompt !== null) {
    throw new UsageError('Pass the first message either with --prompt or after --, not both.')
  }
  return harnessArgs.includes('--') ? [...harnessArgs, prompt] : [...harnessArgs, '--', prompt]
}

function sessionLabel(session: ResumableSession): string {
  return session.entryId === null ? `Session #${session.rowId}` : `Entry #${session.entryId}`
}

function harnessLabel(deps: LaunchDeps, harness: HarnessId): string {
  return deps.adapters.find((adapter) => adapter.id === harness)?.label ?? harness
}

async function pickResumable(ctx: LocalContext, deps: LaunchDeps, request: ResumeRequest): Promise<Choice<ResumableSession>> {
  if (request.session !== null) {
    const session = findResumableBySession(ctx, request.session)
    if (!session) throw new UsageError(`No finished harness session "${request.session}" to resume; see bita sessions ls.`)
    return { value: session }
  }
  const requested = request.entryId
  if (requested !== null) {
    const session = findResumableByEntry(ctx.db, requested)
    if (!session) throw new UsageError(`Entry #${requested} has no finished harness session to resume.`)
    return { value: session }
  }

  const sessions = listResumableSessions(ctx.db, deps.cwd)
  if (sessions.length === 0) throw new UsageError(`No sessions to resume in ${deps.cwd}. Start one with: bita work`)
  requireTerminal(deps, 'Picking a session to resume needs a terminal; pass the entry id: bita work --resume ENTRY_ID')
  const picked = await deps.select({
    title: 'Resume session',
    items: sessions.map((session) => ({
      label: session.description.trim() || '(untitled)',
      hint: [
        session.entryId === null ? `session #${session.rowId}` : `#${session.entryId}`,
        session.projectName ?? 'No project',
        harnessLabel(deps, session.harness),
        localDay(session.startedAt, ctx.timezone),
      ].join(' · '),
      value: session,
    })),
    initialIndex: 0,
  })
  return picked === null ? { interrupted: true } : { value: picked }
}

function resumeAdapter(deps: LaunchDeps, session: ResumableSession, requested: string | undefined): HarnessAdapter {
  if (requested !== undefined && requested !== session.harness) {
    throw new UsageError(`${sessionLabel(session)} is a ${session.harness} session; drop --harness or pass --harness ${session.harness}.`)
  }
  const adapter = deps.adapters.find((candidate) => candidate.id === session.harness && candidate.available(deps.env))
  if (!adapter) throw new UsageError(`The ${session.harness} harness is not installed.`)
  if (!isDirectory(session.cwd)) throw new UsageError(`The directory of ${sessionLabel(session).toLowerCase()} no longer exists: ${session.cwd}`)
  return adapter
}

async function pickHarness(deps: LaunchDeps, requested: string | undefined): Promise<Choice<HarnessAdapter>> {
  const available = deps.adapters.filter((adapter) => adapter.available(deps.env))
  if (requested !== undefined) {
    if (!isHarnessId(requested)) throw new UsageError(`Unknown harness "${requested}". Valid harnesses: ${HARNESS_IDS.join(', ')}.`)
    const adapter = available.find((candidate) => candidate.id === requested)
    if (!adapter) throw new UsageError(`The ${requested} harness is not installed.`)
    return { value: adapter }
  }
  const [only] = available
  if (!only) throw new UsageError(`No harness is installed: install one of ${HARNESS_IDS.join(', ')} (agy for antigravity), or point BITA_HARNESS_BIN_<ID> to it.`)
  if (available.length === 1) return { value: only }

  const fallback = available.find((adapter) => adapter.id === 'claude') ?? only
  requireTerminal(deps)
  const picked = await deps.select({
    title: 'Harness',
    items: available.map((adapter) => ({ label: adapter.label, value: adapter })),
    initialIndex: available.indexOf(fallback),
  })
  return picked === null ? { interrupted: true } : { value: picked }
}

async function pickProject(
  ctx: LocalContext,
  deps: LaunchDeps,
  requested: string | undefined,
  cwd: string = deps.cwd,
  terminalMessage?: string,
): Promise<Choice<ProjectRow | null>> {
  if (requested !== undefined) {
    if (requested.trim() === '0') return { value: null }
    return { value: resolveProjectArg(ctx.db, requested) }
  }

  requireTerminal(deps, terminalMessage)
  const projects = listProjects(ctx.db)
  let mapped: number | null = null
  try {
    mapped = await deps.projectForCwd(ctx, cwd)
  } catch {
    mapped = null
  }
  const mappedIndex = mapped === null ? -1 : projects.findIndex((project) => project.id === mapped)
  const initialIndex = mappedIndex >= 0 ? mappedIndex + 1 : projects.length > 0 ? 1 : 0

  if (projects.length === 0) writeErr('No projects yet; create one with: bita project add "<name>"')
  const picked = await deps.select<{ project: ProjectRow | null }>({
    title: 'Project',
    items: [
      { label: 'No timer', value: { project: null } },
      ...projects.map((project) => ({ label: project.name, hint: String(project.id), value: { project } })),
    ],
    initialIndex,
  })
  return picked === null ? { interrupted: true } : { value: picked.project }
}

interface Prepared {
  adapter: HarnessAdapter
  project: ProjectRow | null
  sessionRowId: number | null
  databasePath: string
  resumeSessionId: string | null
  cwd: string
}

async function prepareWithoutDatabase(
  args: ParsedArgs,
  deps: LaunchDeps,
  error: unknown,
  resume: ResumeRequest | null,
): Promise<Prepared | null> {
  if (resume) throw new Error(`could not open the database, so there is no session to resume: ${errorMessage(error)}`)
  writeErr(`bita: could not open the database, launching without the timer: ${errorMessage(error)}`)
  const harness = await pickHarness(deps, readString(args, 'harness'))
  if ('interrupted' in harness) return null
  return { adapter: harness.value, project: null, sessionRowId: null, databasePath: '', resumeSessionId: null, cwd: deps.cwd }
}

async function prepare(args: ParsedArgs, deps: LaunchDeps, wrapperId: string, resume: ResumeRequest | null): Promise<Prepared | null> {
  let ctx: LocalContext
  try {
    ctx = createLocalContext(args)
  } catch (error) {
    return prepareWithoutDatabase(args, deps, error, resume)
  }
  try {
    try {
      await deps.sweepOrphans(ctx)
    } catch (error) {
      writeErr(`bita: could not close orphan sessions: ${errorMessage(error)}`)
    }
    const target = resume ? await pickResumable(ctx, deps, resume) : null
    if (target && 'interrupted' in target) return null
    const session = target?.value ?? null
    const harness: Choice<HarnessAdapter> = session
      ? { value: resumeAdapter(deps, session, readString(args, 'harness')) }
      : await pickHarness(deps, readString(args, 'harness'))
    if ('interrupted' in harness) return null
    const requestedProject = readString(args, 'project')
    const entryProject =
      session && requestedProject === undefined && session.projectId !== null ? findProjectById(ctx.db, session.projectId) : undefined
    const project: Choice<ProjectRow | null> = entryProject
      ? { value: entryProject }
      : session && session.entryId === null && requestedProject === undefined
        ? { value: null }
        : session
          ? await pickProject(ctx, deps, requestedProject, session.cwd, `${sessionLabel(session)} has no project; pass --project ID|NAME|0.`)
          : await pickProject(ctx, deps, requestedProject)
    if ('interrupted' in project) return null
    const base = {
      adapter: harness.value,
      databasePath: ctx.databasePath,
      resumeSessionId: session?.sessionId ?? null,
      cwd: session?.cwd ?? deps.cwd,
    }
    try {
      const started = await deps.startEntry(ctx, {
        wrapperId,
        wrapperPid: process.pid,
        harness: harness.value.id,
        projectId: project.value?.id ?? null,
        cwd: base.cwd,
      })
      return { ...base, project: project.value, sessionRowId: started.rowId }
    } catch (error) {
      writeErr(
        project.value
          ? `bita: could not start the timer, launching without it: ${errorMessage(error)}`
          : `bita: could not record the session, launching without it: ${errorMessage(error)}`,
      )
      return { ...base, project: null, sessionRowId: null }
    }
  } finally {
    ctx.db.close()
  }
}

function sessionEnv(env: NodeJS.ProcessEnv, wrapperId: string, harness: HarnessId, projectId: number | null, databasePath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    [WRAPPER_ID_ENV]: wrapperId,
    [HARNESS_ENV]: harness,
    [SESSION_PROJECT_ENV]: String(projectId ?? 0),
    BITA_DB_PATH: databasePath,
  }
}

interface ExitContext {
  adapter: HarnessAdapter
  cwd: string
  startedAt: string
}

async function closeSession(args: ParsedArgs, deps: LaunchDeps, wrapperId: string, exit: ExitContext): Promise<void> {
  try {
    const ctx = createLocalContext(args)
    try {
      if (exit.adapter.afterExit) {
        try {
          const session = await exit.adapter.afterExit({ cwd: exit.cwd, startedAt: exit.startedAt, endedAt: new Date().toISOString() }, deps.env)
          if (session) attachExitSession(ctx, wrapperId, session)
        } catch (error) {
          writeErr(`bita: could not find the ${exit.adapter.label} conversation: ${errorMessage(error)}`)
        }
      }
      await deps.closeWrapper(ctx, wrapperId)
    } finally {
      ctx.db.close()
    }
  } catch (error) {
    writeErr(`bita: could not close the session timer: ${errorMessage(error)}`)
  }
}

function isNested(env: NodeJS.ProcessEnv): boolean {
  return isChild(env) || Boolean(env[WRAPPER_ID_ENV])
}

async function launchNested(args: ParsedArgs, deps: LaunchDeps, harnessArgs: readonly string[]): Promise<number> {
  writeErr('bita: already inside a bita session; launching the harness without a new timer.')
  const harness = await pickHarness(deps, readString(args, 'harness') ?? 'claude')
  if ('interrupted' in harness) return EXIT_INTERRUPTED
  const adapter = harness.value
  const plan = adapter.launchArgs(harnessArgs)
  for (const warning of plan.warnings) writeErr(warning)
  const bin = adapter.resolveBin(deps.env) ?? adapter.bin
  return deps.spawnHarness(bin, plan.args, withBinOnPath(withoutHarnessSession(deps.env), bin))
}

export async function runSessionLaunch(argv: string[], overrides: Partial<LaunchDeps> = {}): Promise<number> {
  const deps: LaunchDeps = { ...defaultDeps(), ...overrides }
  const { own, harnessArgs } = splitLaunchArgv(argv)
  const args = parseCommandArgs(own, LAUNCH_OPTIONS, BASE_OPTIONS)
  const resume = readResumeRequest(args)
  const launchArgs = withPrompt(harnessArgs, readString(args, 'prompt'))
  if (resume && parseClaudeArgs(harnessArgs).resume.kind !== 'none') {
    throw new UsageError('--resume already picks the session; drop -r/--resume/-c/--continue from the harness arguments.')
  }

  if (isNested(deps.env)) {
    if (resume) throw new UsageError('Already inside a bita session; run bita work --resume from a regular terminal.')
    return launchNested(args, deps, launchArgs)
  }

  const wrapperId = randomUUID()
  const prepared = await prepare(args, deps, wrapperId, resume)
  if (!prepared) return EXIT_INTERRUPTED

  const { adapter, project, sessionRowId, databasePath, resumeSessionId, cwd } = prepared
  const plan = adapter.launchArgs(resumeSessionId === null ? launchArgs : ['--resume', resumeSessionId, ...launchArgs])
  for (const warning of plan.warnings) writeErr(warning)
  const bin = adapter.resolveBin(deps.env) ?? adapter.bin
  const env = withBinOnPath(withoutHarnessSession(deps.env), bin)

  if (sessionRowId === null) return deps.spawnHarness(bin, plan.args, env, cwd)

  const startedAt = new Date().toISOString()
  try {
    return await deps.spawnHarness(bin, plan.args, sessionEnv(env, wrapperId, adapter.id, project?.id ?? null, databasePath), cwd)
  } finally {
    await closeSession(args, deps, wrapperId, { adapter, cwd, startedAt })
  }
}
