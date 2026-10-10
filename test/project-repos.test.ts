import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bita-project-repos-')))
const config = join(dir, 'config.json')
process.env['BITA_CONFIG_PATH'] = config
process.chdir(dir)
writeFileSync(config, JSON.stringify({ version: 1, projectMapping: {}, scopeMapping: {} }))

const { runProject } = await import('../src/cli/commands/project.ts')
const { runStart, runStop } = await import('../src/cli/commands/timer.ts')
const { openDatabase, openMemoryDatabase } = await import('../src/db/open.ts')
const { recordTouch } = await import('../src/db/touches.ts')
const { insertProject } = await import('../src/db/projects.ts')
const { upsertProjectRepo, listProjectRepos } = await import('../src/db/project-repos.ts')

const db = join(dir, 'bita.db')
const docs = join(dir, 'docs')
const common = ['--db-path', db, '--docs-dir', docs, '--json']

after(() => rmSync(dir, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function makeRepo(name: string, remote?: string): string {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init')
  if (remote) git(path, 'remote', 'add', 'origin', remote)
  return path
}

async function capture(run: () => Promise<number>): Promise<{ code: number; json: any }> {
  const chunks: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string, ...rest: unknown[]) => {
    const text = String(chunk)
    if (text.startsWith('{"schemaVersion"')) {
      chunks.push(text)
      return true
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    const code = await run()
    const line = chunks
      .join('')
      .split('\n')
      .filter((candidate) => candidate.startsWith('{"schemaVersion"'))
      .at(-1)
    return { code, json: line ? JSON.parse(line) : null }
  } finally {
    process.stdout.write = write
  }
}

const codi = makeRepo('codi', 'git@gitlab.com:acme/codi.git')
const tooling = makeRepo('tooling')
mkdirSync(join(codi, 'src', 'deep'), { recursive: true })
const worktree = join(codi, '.claude', 'worktrees', 'feature+x')
git(codi, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)
mkdirSync(docs, { recursive: true })
git(docs, 'init', '-q', '-b', 'main')

test('migration creates project_repos and cascades when the project goes', () => {
  const memory = openMemoryDatabase()
  const project = insertProject(memory, { name: 'Temp', clientName: null, createdAt: '2026-10-08T00:00:00.000Z' })
  upsertProjectRepo(memory, { projectId: project.id, path: '/tmp/x', slug: null, source: 'manual', now: '2026-10-08T00:00:00.000Z' })
  assert.equal(listProjectRepos(memory).length, 1)
  assert.throws(() =>
    memory
      .prepare(`INSERT INTO project_repos (project_id, path, source, added_at, last_seen_at) VALUES (?, ?, 'hook', ?, ?)`)
      .run(project.id, '/tmp/y', 'a', 'a'),
  )
  memory.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
  assert.equal(listProjectRepos(memory).length, 0)
  memory.close()
})

test('add resolves the toplevel and slug, re-adding refreshes last_seen_at, ls and rm follow', async () => {
  await capture(() => runProject(['add', 'CoDi', ...common]))

  const first = await capture(() => runProject(['repo', 'add', join(codi, 'src', 'deep'), '--project', 'CoDi', ...common]))
  assert.equal(first.code, 0)
  assert.equal(first.json.data.created, true)
  assert.equal(first.json.data.repo.path, codi)
  assert.equal(first.json.data.repo.slug, 'gitlab.com/acme/codi')
  assert.equal(first.json.data.repo.source, 'manual')
  assert.equal(first.json.data.repo.project, 'CoDi')
  assert.equal(first.json.data.repo.exists, true)

  const again = await capture(() => runProject(['repo', 'add', worktree, '--project', 'CoDi', '--source', 'stop', ...common]))
  assert.equal(again.json.data.created, false)
  assert.equal(again.json.data.repo.path, codi)
  assert.equal(again.json.data.repo.source, 'manual')
  assert.ok(again.json.data.repo.lastSeenAt >= first.json.data.repo.lastSeenAt)

  const inferred = await capture(() => runProject(['repo', 'add', codi, ...common]))
  assert.equal(inferred.json.data.repo.project, 'CoDi')

  await assert.rejects(() => capture(() => runProject(['repo', 'add', tooling, ...common])), /Pass --project/)
  await assert.rejects(() => capture(() => runProject(['repo', 'add', dir, '--project', 'CoDi', ...common])), /not inside a git repository/)

  const gone = makeRepo('gone')
  await capture(() => runProject(['repo', 'add', gone, '--project', 'CoDi', ...common]))
  rmSync(gone, { recursive: true, force: true })
  const listed = await capture(() => runProject(['repo', 'ls', '--project', 'CoDi', ...common]))
  assert.deepEqual(
    listed.json.data.repos.map((repo: { path: string; exists: boolean }) => [repo.path, repo.exists]),
    [
      [codi, true],
      [gone, false],
    ],
  )

  const removed = await capture(() => runProject(['repo', 'rm', gone, ...common]))
  assert.equal(removed.json.data.removed, true)
  const missing = await capture(() => runProject(['repo', 'rm', gone, ...common]))
  assert.equal(missing.json.data.removed, false)
  const all = await capture(() => runProject(['repo', 'ls', ...common]))
  assert.equal(all.json.data.repos.length, 1)
})

test('suggest groups touches by repository, stop reports the unmapped ones, history spans the project', async () => {
  const started = await capture(() => runStart(['Conciliar pagos', '--project', 'CoDi', ...common]))
  const id = started.json.data.id as number

  const handle = openDatabase(db)
  const now = '2026-10-08T12:00:00.000Z'
  recordTouch(handle, id, join(codi, 'src', 'deep', 'a.ts'), now)
  recordTouch(handle, id, join(worktree, 'b.ts'), now)
  recordTouch(handle, id, join(codi, 'removed', 'gone.ts'), now)
  recordTouch(handle, id, join(tooling, 'c.ts'), now)
  recordTouch(handle, id, join(docs, 'page.md'), now)
  recordTouch(handle, id, 'relative/file.ts', now)
  recordTouch(handle, id, join(dir, 'loose.txt'), now)
  handle.close()

  const suggested = await capture(() => runProject(['repo', 'suggest', String(id), ...common]))
  assert.equal(suggested.json.data.project, 'CoDi')
  assert.deepEqual(suggested.json.data.suggestions, [
    { path: codi, slug: 'gitlab.com/acme/codi', files: 3, mapped: true },
    { path: tooling, slug: 'local/tooling', files: 1, mapped: false },
  ])

  const stopped = await capture(() => runStop([String(id), ...common]))
  assert.deepEqual(stopped.json.meta.repoSuggestions, [{ path: tooling, slug: 'local/tooling', files: 1, mapped: false }])

  const history = await capture(() => runProject(['repo', 'suggest', '--project', 'CoDi', '--history', ...common]))
  assert.deepEqual(
    history.json.data.suggestions.map((item: { path: string; files: number }) => [item.path, item.files]),
    [
      [codi, 3],
      [tooling, 1],
    ],
  )

  await assert.rejects(() => capture(() => runProject(['repo', 'suggest', '--project', 'CoDi', ...common])), /Usage/)
})

test('stopping several timers keys the suggestions by entry id', async () => {
  const one = await capture(() => runStart(['Uno', '--project', 'CoDi', ...common]))
  const two = await capture(() => runStart(['Dos', '--project', 'CoDi', ...common]))
  const handle = openDatabase(db)
  recordTouch(handle, one.json.data.id, join(tooling, 'd.ts'), '2026-10-08T13:00:00.000Z')
  recordTouch(handle, two.json.data.id, join(codi, 'e.ts'), '2026-10-08T13:00:00.000Z')
  handle.close()

  const stopped = await capture(() => runStop(['--all', ...common]))
  assert.deepEqual(stopped.json.meta.repoSuggestions, {
    [String(one.json.data.id)]: [{ path: tooling, slug: 'local/tooling', files: 1, mapped: false }],
  })
})
