import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DOCS_GIT_LOCK_STALE_MS, DOCS_GIT_LOCK_TIMEOUT_MS } from '../config/constants.ts'
import { ConflictError, MergeConflictError, NotFoundError, UsageError } from '../errors.ts'
import { execGit, type GitResult } from '../state/git.ts'
import { relativeDocPath } from './paths.ts'
import { NO_PROJECT_SLUG } from './slug.ts'

export const DOCS_SOURCES = ['manual', 'meeting', 'confluence-pull', 'restore', 'note', 'import'] as const
export type DocsSource = (typeof DOCS_SOURCES)[number]
export type RevisionSource = DocsSource | 'unknown'

export const MAIN_BRANCH = 'main'
export const IMPORT_SUBJECT = 'chore: import existing bita docs'
export const DOCS_GITIGNORE = ['*.bkp', '.DS_Store', '*.lock', '*.tmp-*']

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const ZERO_SHA = '0000000000000000000000000000000000000000'
const SUBJECT_MAX = 100
const GIT_SLOW_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 30_000
const BACKOFF_MS = [10, 20, 40, 80, 160, 250]
const BASE_FLAGS = [
  '-c', 'core.quotepath=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'color.ui=false',
  '--literal-pathspecs',
]

export interface CommitIntent {
  source: DocsSource
  subject: string
  pageId?: number | null | undefined
  entryId?: number | null | undefined
  reason?: string | null | undefined
  trailers?: Record<string, string> | undefined
}

export interface DocsRepoState {
  root: string
  initialized: boolean
  head: string | null
}

export interface DirtyFile {
  path: string
  status: 'modified' | 'untracked' | 'deleted'
}

export interface Revision {
  sha: string
  date: string
  subject: string
  source: RevisionSource
  reason: string | null
  entryId: number | null
}

export interface HunkLine {
  kind: 'context' | 'add' | 'del'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface Hunk {
  header: string
  lines: HunkLine[]
}

export interface BranchCommit {
  sha: string
  subject: string
  pageId: number | null
  trailers: Record<string, string>
}

export interface BranchSummary {
  name: string
  head: string
  commits: { sha: string; subject: string; pageId: number | null }[]
}

let available: boolean | null = null
let warned = false
let identity: Record<string, string> | null = null

function warn(message: string): void {
  if (warned) return
  warned = true
  process.stderr.write(`Warning: ${message}\n`)
}

export async function gitAvailable(): Promise<boolean> {
  if (available !== null) return available
  const result = await execGit(['--version'], { cwd: tmpdir() })
  available = result.code === 0
  return available
}

async function identityEnv(root: string): Promise<Record<string, string>> {
  if (identity !== null) return identity
  const name = await execGit(['config', 'user.name'], { cwd: root })
  const email = await execGit(['config', 'user.email'], { cwd: root })
  const env: Record<string, string> = {}
  if (name.code !== 0 || name.stdout.trim().length === 0) {
    env['GIT_AUTHOR_NAME'] = 'bita'
    env['GIT_COMMITTER_NAME'] = 'bita'
  }
  if (email.code !== 0 || email.stdout.trim().length === 0) {
    env['GIT_AUTHOR_EMAIL'] = 'bita@localhost'
    env['GIT_COMMITTER_EMAIL'] = 'bita@localhost'
  }
  identity = env
  return env
}

interface RunOptions {
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
}

async function rawGit(root: string, args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
  const env = { ...process.env, ...(await identityEnv(root)), ...(options.env ?? {}) }
  return execGit([...BASE_FLAGS, ...args], {
    cwd: root,
    env,
    input: options.input,
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
  })
}

async function git(root: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  const result = await rawGit(root, args, options)
  if (result.code !== 0) {
    throw new ConflictError(
      `git ${args[0] ?? ''} failed in ${root}: ${(result.stderr || result.stdout).trim()}`,
      'DOCS_GIT_FAILED',
    )
  }
  return result.stdout
}

async function requireGit(): Promise<void> {
  if (!(await gitAvailable())) {
    throw new ConflictError('git is not installed, so the docs have no history.', 'GIT_UNAVAILABLE', 'Install git and run "bita docs git init".')
  }
}

export function isDocsRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

export async function headSha(root: string): Promise<string | null> {
  const result = await rawGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${MAIN_BRANCH}`])
  const sha = result.stdout.trim()
  return result.code === 0 && sha.length > 0 ? sha : null
}

async function writeGitignore(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = ''
  }
  const lines = new Set(current.split('\n').map((line) => line.trim()))
  const missing = DOCS_GITIGNORE.filter((pattern) => !lines.has(pattern))
  if (missing.length === 0) return
  const prefix = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current
  await writeFile(path, `${prefix}${missing.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function initDocsRepo(root: string): Promise<DocsRepoState> {
  await requireGit()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const existed = isDocsRepo(root)
  if (!existed) await git(root, ['init', '-q', '-b', MAIN_BRANCH])

  return withDocsGitLock(root, async () => {
    const current = await headSha(root)
    if (current !== null) return { root, initialized: false, head: current }

    await writeGitignore(root)
    await git(root, ['add', '-A', '--', '.'], { timeoutMs: GIT_SLOW_TIMEOUT_MS })
    await git(root, ['commit', '--no-verify', '-q', '--allow-empty', '-F', '-'], {
      input: commitMessage(IMPORT_SUBJECT, { source: 'import', subject: IMPORT_SUBJECT }),
      timeoutMs: GIT_SLOW_TIMEOUT_MS,
    })
    return { root, initialized: true, head: await headSha(root) }
  })
}

export async function ensureDocsRepo(root: string): Promise<boolean> {
  if (!(await gitAvailable())) {
    warn('git is not installed, so this docs change was saved without a commit.')
    return false
  }
  if (isDocsRepo(root) && (await headSha(root)) !== null) return true
  await initDocsRepo(root)
  return true
}

export async function prepareDocsRepo(root: string): Promise<void> {
  if (isDocsRepo(root)) return
  try {
    await ensureDocsRepo(root)
  } catch (error) {
    warn(`the docs history could not be started: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs > DOCS_GIT_LOCK_STALE_MS) return true
    const raw = await readFile(lockPath, 'utf8')
    const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid)
    return !processAlive(pid)
  } catch {
    return false
  }
}

export function docsLockPath(root: string): string {
  return join(root, '.git', 'bita.lock')
}

export async function withDocsGitLock<T>(
  root: string,
  run: () => Promise<T>,
  timeoutMs: number = DOCS_GIT_LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = docsLockPath(root)
  const deadline = Date.now() + timeoutMs
  let attempt = 0

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      if (await lockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new ConflictError(
          `Another process is committing to the docs history in ${root}.`,
          'DOCS_GIT_LOCKED',
          `Wait for it to finish. If nothing is running, remove ${lockPath}.`,
        )
      }
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 250
      attempt += 1
      await new Promise((done) => setTimeout(done, wait))
    }
  }

  try {
    return await run()
  } finally {
    await unlink(lockPath).catch(() => undefined)
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toLocaleLowerCase('es') + value.slice(1)
}

export function docsSubject(relPath: string, action: string, title?: string): string {
  const scope = relPath.split('/')[0] ?? ''
  const prefix = scope.length > 0 && scope !== NO_PROJECT_SLUG && relPath.includes('/') ? `docs(${scope})` : 'docs'
  const text = oneLine(title === undefined ? action : `${action} ${lowerFirst(oneLine(title))}`)
  const subject = `${prefix}: ${text}`
  return subject.length <= SUBJECT_MAX ? subject : `${subject.slice(0, SUBJECT_MAX - 3).trimEnd()}...`
}

export function commitMessage(subject: string, intent: CommitIntent): string {
  const trailers = [`Bita-Source: ${intent.source}`]
  if (intent.pageId !== undefined && intent.pageId !== null) trailers.push(`Bita-Page: ${intent.pageId}`)
  if (intent.entryId !== undefined && intent.entryId !== null) trailers.push(`Bita-Entry: ${intent.entryId}`)
  if (intent.reason !== undefined && intent.reason !== null && oneLine(intent.reason).length > 0) {
    trailers.push(`Bita-Reason: ${oneLine(intent.reason)}`)
  }
  for (const [key, value] of Object.entries(intent.trailers ?? {})) trailers.push(`${key}: ${oneLine(value)}`)
  return `${oneLine(subject)}\n\n${trailers.join('\n')}\n`
}

export function parseTrailers(text: string): Record<string, string> {
  const trailers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line.trim())
    if (match?.[1] !== undefined) trailers[match[1]] = (match[2] ?? '').trim()
  }
  return trailers
}

function toRelative(root: string, path: string): string {
  return isAbsolute(path) ? relativeDocPath(root, path) : path.split('\\').join('/')
}

async function trackedUnder(root: string, paths: readonly string[]): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--', ...paths])
  return out.split('\0').filter((path) => path.length > 0)
}

export async function commitPaths(root: string, paths: readonly string[], intent: CommitIntent): Promise<string | null> {
  const relPaths = [...new Set(paths.map((path) => toRelative(root, path)))]
  if (relPaths.length === 0) return null

  return withDocsGitLock(root, async () => {
    const tracked = await trackedUnder(root, relPaths)
    const kept = relPaths.filter(
      (path) =>
        existsSync(resolve(root, path)) || tracked.some((file) => file === path || file.startsWith(`${path}/`)),
    )
    if (kept.length === 0) return null

    await git(root, ['add', '-A', '--', ...kept])
    const staged = await rawGit(root, ['diff', '--cached', '--quiet', '--', ...kept])
    if (staged.code === 0) return null

    await git(root, ['commit', '--no-verify', '-q', '-F', '-', '--', ...kept], {
      input: commitMessage(intent.subject, intent),
    })
    return await headSha(root)
  })
}

export async function commitDocs(root: string, paths: readonly string[], intent: CommitIntent): Promise<string | null> {
  try {
    if (!(await ensureDocsRepo(root))) return null
    return await commitPaths(root, paths, intent)
  } catch (error) {
    warn(`the docs change was saved, but it could not be committed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function docsStatus(root: string): Promise<DirtyFile[]> {
  if (!isDocsRepo(root)) return []
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const tokens = out.split('\0')
  const dirty: DirtyFile[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token.length < 4) continue
    const code = token.slice(0, 2)
    const path = token.slice(3)
    if (code.startsWith('R') || code.startsWith('C')) index += 1
    const status: DirtyFile['status'] = code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : 'modified'
    dirty.push({ path, status })
  }
  return dirty
}

export async function resolveRev(root: string, rev: string): Promise<string> {
  if (rev.startsWith('-')) throw new UsageError(`"${rev}" is not a revision.`)
  const result = await rawGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  const sha = result.stdout.trim()
  if (result.code !== 0 || sha.length === 0) {
    throw new NotFoundError(`No revision "${rev}" in the docs history.`, 'REV_NOT_FOUND', 'Run "bita docs page history <id>" to list them.')
  }
  return sha
}

async function parentOf(root: string, sha: string): Promise<string | null> {
  const result = await rawGit(root, ['rev-parse', '--verify', '-q', `${sha}^1`])
  const parent = result.stdout.trim()
  return result.code === 0 && parent.length > 0 ? parent : null
}

const RECORD = '\x1e'
const FIELD = '\x1f'

function revisionSource(value: string | undefined): RevisionSource {
  return value !== undefined && (DOCS_SOURCES as readonly string[]).includes(value) ? (value as DocsSource) : 'unknown'
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function pageHistory(root: string, relPath: string, limit?: number): Promise<Revision[]> {
  if (!isDocsRepo(root) || (await headSha(root)) === null) return []
  const args = [
    'log',
    '--follow',
    `--format=${RECORD}%H${FIELD}%aI${FIELD}%s${FIELD}%(trailers:only,unfold)`,
    ...(limit !== undefined && limit > 0 ? ['-n', String(limit)] : []),
    MAIN_BRANCH,
    '--',
    relPath,
  ]
  const out = await git(root, args)
  return out
    .split(RECORD)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = '', date = '', subject = '', trailerText = ''] = record.split(FIELD)
      const trailers = parseTrailers(trailerText)
      return {
        sha: sha.trim(),
        date: date.trim(),
        subject: subject.trim(),
        source: revisionSource(trailers['Bita-Source']),
        reason: trailers['Bita-Reason'] ?? null,
        entryId: numberOrNull(trailers['Bita-Entry']),
      }
    })
}

async function followedPaths(root: string, relPath: string): Promise<{ sha: string; path: string }[]> {
  const out = await git(root, ['log', '--follow', `--format=${RECORD}%H`, '--name-only', MAIN_BRANCH, '--', relPath])
  return out
    .split(RECORD)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const lines = record.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      return { sha: lines[0] ?? '', path: lines.at(-1) ?? relPath }
    })
}

export async function pathAtRev(root: string, relPath: string, sha: string): Promise<{ path: string; previous: string | null }> {
  const trail = await followedPaths(root, relPath)
  const index = trail.findIndex((item) => item.sha === sha)
  if (index === -1) return { path: relPath, previous: null }
  return { path: trail[index]?.path ?? relPath, previous: trail[index + 1]?.path ?? null }
}

export async function readBlob(root: string, rev: string, relPath: string): Promise<string | null> {
  const result = await rawGit(root, ['cat-file', 'blob', `${rev}:${relPath}`])
  return result.code === 0 ? result.stdout : null
}

async function diffText(root: string, args: readonly string[]): Promise<string> {
  const result = await rawGit(root, ['diff', '--no-color', '--no-ext-diff', '-M', ...args])
  if (result.code !== 0 && result.code !== 1) {
    throw new ConflictError(`git diff failed in ${root}: ${result.stderr.trim()}`, 'DOCS_GIT_FAILED')
  }
  return result.stdout
}

export interface FileDiff {
  from: string
  to: string
  diff: string
  hunks: Hunk[]
}

export async function worktreeDiff(root: string, relPath: string): Promise<FileDiff> {
  const head = await headSha(root)
  if (head === null) throw new NotFoundError('The docs have no history yet.', 'REV_NOT_FOUND', 'Run "bita docs git init".')
  const tracked = (await readBlob(root, head, relPath)) !== null
  const absolute = resolve(root, relPath)
  const diff = tracked || !existsSync(absolute)
    ? await diffText(root, [head, '--', relPath])
    : await diffText(root, ['--no-index', '--', '/dev/null', absolute])
  return { from: head, to: 'worktree', diff, hunks: parseHunks(diff) }
}

export async function revisionDiff(root: string, relPath: string, rev: string): Promise<FileDiff> {
  const sha = await resolveRev(root, rev)
  const parent = await parentOf(root, sha)
  const { path, previous } = await pathAtRev(root, relPath, sha)
  const paths = [...new Set([path, previous ?? path])]
  const diff = await diffText(root, [parent ?? EMPTY_TREE, sha, '--', ...paths])
  return { from: parent ?? EMPTY_TREE, to: sha, diff, hunks: parseHunks(diff) }
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0

  for (const line of diff.split('\n')) {
    if (current !== null && (oldLeft > 0 || newLeft > 0)) {
      const marker = line.charAt(0)
      const text = line.slice(1)
      if (marker === ' ' || (line.length === 0 && oldLeft > 0 && newLeft > 0)) {
        current.lines.push({ kind: 'context', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
        oldLeft -= 1
        newLeft -= 1
        continue
      }
      if (marker === '-') {
        current.lines.push({ kind: 'del', text, oldLine, newLine: null })
        oldLine += 1
        oldLeft -= 1
        continue
      }
      if (marker === '+') {
        current.lines.push({ kind: 'add', text, oldLine: null, newLine })
        newLine += 1
        newLeft -= 1
        continue
      }
      if (marker === '\\') continue
    }

    if (current !== null && line.startsWith('\\')) continue

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      current = { header: line, lines: [] }
      hunks.push(current)
      oldLine = Number(header[1])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLine = Number(header[3])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      if (oldLeft === 0 && oldLine === 0) oldLine = 1
      if (newLeft === 0 && newLine === 0) newLine = 1
    }
  }
  return hunks
}

export async function assertBranchName(root: string, branch: string): Promise<void> {
  if (branch === MAIN_BRANCH || branch.startsWith('-') || branch.trim().length === 0) {
    throw new UsageError(`"${branch}" cannot be used as a proposal branch.`)
  }
  const result = await rawGit(root, ['check-ref-format', '--branch', branch])
  if (result.code !== 0) throw new UsageError(`"${branch}" is not a valid branch name.`)
}

async function branchTip(root: string, branch: string): Promise<string | null> {
  const result = await rawGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])
  const sha = result.stdout.trim()
  return result.code === 0 && sha.length > 0 ? sha : null
}

export async function requireBranch(root: string, branch: string): Promise<string> {
  await assertBranchName(root, branch)
  const tip = await branchTip(root, branch)
  if (tip === null) throw new NotFoundError(`No docs branch "${branch}".`, 'BRANCH_NOT_FOUND', 'Run "bita docs branch ls".')
  return tip
}

export interface BranchWrite {
  branch: string
  relPath: string
  build: (base: string | null) => string
  intent: CommitIntent
}

export async function commitToBranch(root: string, write: BranchWrite): Promise<{ sha: string; base: string }> {
  await assertBranchName(root, write.branch)
  return withDocsGitLock(root, async () => {
    const main = await headSha(root)
    if (main === null) throw new NotFoundError('The docs have no history yet.', 'REV_NOT_FOUND', 'Run "bita docs git init".')
    const tip = await branchTip(root, write.branch)
    const parent = tip ?? main
    const base = (await readBlob(root, parent, write.relPath)) ?? (await readBlob(root, main, write.relPath))
    const content = write.build(base)
    if (content === base) throw new UsageError('The proposal does not change the page.')

    const index = join(root, '.git', `bita-index-${process.pid}-${randomBytes(4).toString('hex')}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await git(root, ['read-tree', parent], { env })
      const blob = (await git(root, ['hash-object', '-w', '--stdin'], { env, input: content })).trim()
      await git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${write.relPath}`], { env })
      const tree = (await git(root, ['write-tree'], { env })).trim()
      const sha = (
        await git(root, ['commit-tree', tree, '-p', parent, '-F', '-'], {
          env,
          input: commitMessage(write.intent.subject, write.intent),
        })
      ).trim()
      await git(root, ['update-ref', `refs/heads/${write.branch}`, sha, tip ?? ZERO_SHA])
      return { sha, base: parent }
    } finally {
      await rm(index, { force: true }).catch(() => undefined)
    }
  })
}

async function commitsBetween(root: string, range: string): Promise<BranchCommit[]> {
  const out = await git(root, ['log', '--reverse', `--format=${RECORD}%H${FIELD}%s${FIELD}%(trailers:only,unfold)`, range])
  return out
    .split(RECORD)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = '', subject = '', trailerText = ''] = record.split(FIELD)
      const trailers = parseTrailers(trailerText)
      return { sha: sha.trim(), subject: subject.trim(), pageId: numberOrNull(trailers['Bita-Page']), trailers }
    })
}

export async function branchCommits(root: string, branch: string): Promise<BranchCommit[]> {
  await requireBranch(root, branch)
  return commitsBetween(root, `refs/heads/${MAIN_BRANCH}..refs/heads/${branch}`)
}

export async function commitInfo(root: string, sha: string): Promise<BranchCommit> {
  const [commit] = await commitsBetween(root, `${sha}^!`)
  if (!commit) throw new NotFoundError(`No revision "${sha}" in the docs history.`, 'REV_NOT_FOUND')
  return commit
}

export async function listBranches(root: string): Promise<BranchSummary[]> {
  if (!isDocsRepo(root)) return []
  const out = await git(root, ['for-each-ref', `--format=%(refname:short)${FIELD}%(objectname)`, 'refs/heads'])
  const branches: BranchSummary[] = []
  for (const line of out.split('\n')) {
    const [name = '', head = ''] = line.split(FIELD)
    if (name.length === 0 || name === MAIN_BRANCH) continue
    const commits = await commitsBetween(root, `refs/heads/${MAIN_BRANCH}..refs/heads/${name}`)
    branches.push({ name, head: head.trim(), commits: commits.map(({ sha, subject, pageId }) => ({ sha, subject, pageId })) })
  }
  return branches
}

export async function assertOnBranch(root: string, branch: string, sha: string): Promise<void> {
  const result = await rawGit(root, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`])
  if (result.code !== 0) throw new NotFoundError(`${sha.slice(0, 7)} is not on branch "${branch}".`, 'REV_NOT_FOUND')
}

export async function commitDiff(root: string, sha: string): Promise<{ path: string | null; diff: string; hunks: Hunk[] }> {
  const parent = (await parentOf(root, sha)) ?? EMPTY_TREE
  const names = await git(root, ['diff', '--name-only', '-z', parent, sha])
  const path = names.split('\0').find((name) => name.length > 0) ?? null
  const diff = await diffText(root, [parent, sha])
  return { path, diff, hunks: parseHunks(diff) }
}

export async function mergeCommitIntoMain(root: string, sha: string): Promise<string> {
  const parent = await parentOf(root, sha)
  if (parent === null) throw new UsageError(`${sha.slice(0, 7)} has no parent to merge from.`)
  const result = await rawGit(root, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '--merge-base',
    parent,
    `refs/heads/${MAIN_BRANCH}`,
    sha,
  ])
  const lines = result.stdout.split('\n')
  const tree = (lines[0] ?? '').trim()
  if (result.code === 0 && tree.length > 0) return tree
  if (result.code === 1) {
    const paths: string[] = []
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) break
      if (!paths.includes(line.trim())) paths.push(line.trim())
    }
    throw new MergeConflictError(
      `The proposal ${sha.slice(0, 7)} conflicts with what main has now.`,
      paths,
      'The page changed after the proposal. Propose it again over the current page.',
    )
  }
  throw new ConflictError(`git merge-tree failed in ${root}: ${result.stderr.trim()}`, 'DOCS_GIT_FAILED')
}

export async function dropBranch(root: string, branch: string): Promise<void> {
  const tip = await requireBranch(root, branch)
  await withDocsGitLock(root, async () => {
    await git(root, ['update-ref', '-d', `refs/heads/${branch}`, tip])
  })
}

export async function requireDocsRepo(root: string): Promise<void> {
  await requireGit()
  if (!isDocsRepo(root) || (await headSha(root)) === null) await initDocsRepo(root)
}
