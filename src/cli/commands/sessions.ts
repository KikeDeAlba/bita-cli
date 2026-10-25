import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, type ParsedArgs } from '../args.ts'
import { withLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { renderTable } from '../table.ts'
import { listSessionDirectories, listSessions, type SessionListing } from '../../db/sessions.ts'
import { toLocalIso } from '../../domain/timezone.ts'
import { isHarnessId } from '../../harness/registry.ts'
import { HARNESS_IDS, type HarnessId } from '../../harness/types.ts'

const LS_OPTIONS = {
  open: { type: 'boolean' as const, default: false },
  all: { type: 'boolean' as const, default: false },
  cwd: { type: 'string' as const },
  harness: { type: 'string' as const },
  limit: { type: 'string' as const },
}

const DIRS_OPTIONS = {
  limit: { type: 'string' as const },
}

const USAGE = 'Usage: bita sessions ls [--open] [--cwd DIR|--all] [--harness ID] [--limit N] [--json] | bita sessions dirs [--limit N] [--json]'

function readLimit(args: ParsedArgs, fallback: number): number {
  const limit = readInteger(args, 'limit') ?? fallback
  if (limit <= 0) throw new UsageError(`--limit takes a positive integer; got ${limit}.`)
  return limit
}

export function canonicalDirectory(path: string, base: string = process.cwd()): string {
  const absolute = resolve(base, path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function readHarness(args: ParsedArgs): HarnessId | null {
  const raw = readString(args, 'harness')
  if (raw === undefined) return null
  if (!isHarnessId(raw)) throw new UsageError(`Unknown harness "${raw}". Valid harnesses: ${HARNESS_IDS.join(', ')}.`)
  return raw
}

function readCwdFilter(args: ParsedArgs, cwd: string): string | null {
  const requested = readString(args, 'cwd')
  if (readBoolean(args, 'all')) {
    if (requested !== undefined) throw new UsageError('--cwd and --all cannot be used together.')
    return null
  }
  return requested === undefined ? cwd : canonicalDirectory(requested, cwd)
}

function state(session: SessionListing): string {
  if (session.open) return 'open'
  return session.resumable ? 'resumable' : 'ended'
}

function runList(argv: string[], cwd: string): number {
  const args = parseCommandArgs(argv, LS_OPTIONS, BASE_OPTIONS)
  if (args.positionals.length > 0) throw new UsageError(USAGE)
  const filter = { cwd: readCwdFilter(args, cwd), open: readBoolean(args, 'open'), harness: readHarness(args), limit: readLimit(args, 50) }
  return withLocalContext(args, (ctx) => {
    const sessions = listSessions(ctx.db, filter)
    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('sessions ls', sessions))
      return 0
    }
    if (sessions.length === 0) {
      writeOut(filter.cwd === null ? 'No sessions yet. Start one with: bita work' : `No sessions in ${filter.cwd}. Start one with: bita work`)
      return 0
    }
    writeOut(
      renderTable(
        [{ header: 'ID', align: 'right' }, { header: 'ENTRY', align: 'right' }, { header: 'HARNESS' }, { header: 'STATE' }, { header: 'STARTED' }, { header: 'PROJECT' }, { header: 'TITLE' }],
        sessions.map((session) => [
          String(session.id),
          String(session.entryId),
          session.harness,
          state(session),
          toLocalIso(session.startedAt, ctx.timezone).slice(0, 16).replace('T', ' '),
          session.entry.projectName ?? '-',
          session.entry.description.trim() || '(untitled)',
        ]),
      ),
    )
    return 0
  })
}

function runDirs(argv: string[]): number {
  const args = parseCommandArgs(argv, DIRS_OPTIONS, BASE_OPTIONS)
  if (args.positionals.length > 0) throw new UsageError(USAGE)
  const limit = readLimit(args, 20)
  return withLocalContext(args, (ctx) => {
    const dirs = listSessionDirectories(ctx.db, limit)
    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('sessions dirs', dirs))
      return 0
    }
    if (dirs.length === 0) {
      writeOut('No sessions yet. Start one with: bita work')
      return 0
    }
    writeOut(
      renderTable(
        [{ header: 'LAST USED' }, { header: 'SESSIONS', align: 'right' }, { header: 'PROJECT' }, { header: 'DIRECTORY' }],
        dirs.map((dir) => [
          toLocalIso(dir.lastUsedAt, ctx.timezone).slice(0, 16).replace('T', ' '),
          String(dir.sessions),
          dir.projectName ?? '-',
          dir.cwd,
        ]),
        120,
      ),
    )
    return 0
  })
}

export function runSessions(argv: string[], cwd: string = process.cwd()): number {
  const [subcommand = 'ls', ...rest] = argv
  if (subcommand === 'ls' || subcommand === 'list') return runList(rest, cwd)
  if (subcommand === 'dirs') return runDirs(rest)
  if (subcommand.startsWith('-')) return runList(argv, cwd)
  throw new UsageError(`Unknown sessions subcommand "${subcommand}". ${USAGE}`)
}
