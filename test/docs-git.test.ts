import { strict as assert } from 'node:assert'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const base = mkdtempSync(join(tmpdir(), 'bita-docs-git-'))
process.env['GIT_CONFIG_GLOBAL'] = join(base, 'gitconfig')
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
process.env['BITA_CONFIG_PATH'] = join(base, 'config.json')
process.env['BITA_DB_PATH'] = join(base, 'unused.db')
process.env['BITA_DOCS_DIR'] = join(base, 'unused-docs')

const { openMemoryDatabase } = await import('../src/db/open.ts')
const { insertProject } = await import('../src/db/projects.ts')
const { insertPage, requirePage } = await import('../src/db/pages.ts')
const { recordPageDoc } = await import('../src/docs/page-record.ts')
const { writeLocal } = await import('../src/confluence/sync.ts')
const git = await import('../src/docs/git.ts')

const repo = join(import.meta.dirname, '..')
const bin = join(repo, 'src/bin/bita.ts')
const NOW = '2026-10-08T12:00:00.000Z'

function scratch(name: string): string {
  const dir = join(base, `${name}-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function gitIn(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function log(root: string): string[] {
  return gitIn(root, 'log', '--format=%s').trim().split('\n')
}

function filesOf(root: string, rev: string): string[] {
  return gitIn(root, 'show', '--name-only', '--format=', rev).trim().split('\n').filter(Boolean)
}

function trailersOf(root: string, rev: string): Record<string, string> {
  return git.parseTrailers(gitIn(root, 'log', '-1', '--format=%(trailers:only,unfold)', rev))
}

function memoryContext(name: string) {
  const db = openMemoryDatabase()
  const docsRoot = scratch(name)
  const ctx = { db, docsRoot, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const project = insertProject(db, { name: 'CoDi', createdAt: NOW })
  const page = (title: string, slug: string): number =>
    insertPage(db, { projectId: project.id, parentId: null, slug, title, relPath: `codi/${slug}.md`, depth: 0, source: 'cli', now: NOW })
  return { db, docsRoot, ctx, page }
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
  json: { ok: boolean; data?: any; error?: any }
}

function cli(env: Record<string, string>, ...args: string[]): CliResult {
  const run = spawnSync(process.execPath, [bin, ...args, '--json'], {
    cwd: base,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  const last = run.stdout.trim().split('\n').at(-1) ?? '{}'
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json: JSON.parse(last) }
}

function cliRoot(name: string) {
  const dir = scratch(name)
  const env = {
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_DOCS_DIR: join(dir, 'docs'),
    BITA_CONFIG_PATH: join(dir, 'config.json'),
  }
  const ok = (...args: string[]): any => {
    const result = cli(env, ...args)
    assert.equal(result.status, 0, `bita ${args.join(' ')} failed: ${result.stdout} ${result.stderr}`)
    return result.json.data
  }
  ok('project', 'add', 'CoDi')
  const created = ok('docs', 'page', 'new', 'Reglas de negocio', '--project', 'CoDi')
  const pageId = String(created.page.pageId)
  const body = join(dir, 'body.md')
  writeFileSync(body, '## Alcance\n\nPagos con CoDi.\n\n## Límites\n\nTope de 8k.\n\n## Horario\n\nZona CDMX.\n')
  ok('docs', 'page', 'write', pageId, '--md', body)
  return { dir, env, docs: env.BITA_DOCS_DIR, pageId, ok, run: (...args: string[]) => cli(env, ...args) }
}

test('init imports what is there once, ignores backups and keeps its head on a second run', async () => {
  const root = scratch('init')
  writeFileSync(join(root, 'old.md'), '# Old\n')
  writeFileSync(join(root, 'old.md.bkp'), 'backup')
  writeFileSync(join(root, '.DS_Store'), 'finder')

  const first = await git.initDocsRepo(root)
  assert.equal(first.initialized, true)
  assert.match(first.head ?? '', /^[0-9a-f]{40}$/)
  assert.deepEqual(log(root), ['chore: import existing bita docs'])
  assert.deepEqual(filesOf(root, 'HEAD').sort(), ['.gitignore', 'old.md'])
  assert.equal(gitIn(root, 'branch', '--show-current').trim(), 'main')
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.match(ignore, /^\*\.bkp$/m)
  assert.match(ignore, /^\.DS_Store$/m)
  assert.equal(trailersOf(root, 'HEAD')['Bita-Source'], 'import')
  assert.equal(gitIn(root, 'log', '-1', '--format=%an').trim(), 'bita')

  const second = await git.initDocsRepo(root)
  assert.equal(second.initialized, false)
  assert.equal(second.head, first.head)
  assert.equal(log(root).length, 1)
})

test('every page write is one commit holding only its file, with the bita trailers', async () => {
  const { ctx, docsRoot, db, page } = memoryContext('write')
  const one = page('Reglas de negocio', 'reglas')
  const two = page('Runbook', 'runbook')

  const first = await recordPageDoc(ctx, requirePage(db, one), { body: '## Alcance\n\nUno.' })
  assert.ok(existsSync(join(docsRoot, '.git')))
  const second = await recordPageDoc(ctx, requirePage(db, two), { body: '## Pasos\n\nReiniciar.' })
  const updated = await recordPageDoc(ctx, requirePage(db, one), { section: { heading: 'Alcance', body: 'Dos.' } })
  const unchanged = await recordPageDoc(ctx, requirePage(db, one), { section: { heading: 'Alcance', body: 'Dos.' } })

  assert.deepEqual(log(docsRoot), [
    'docs(codi): update reglas de negocio',
    'docs(codi): create runbook',
    'docs(codi): create reglas de negocio',
    'chore: import existing bita docs',
  ])
  assert.equal(first.sha !== null && second.sha !== null && updated.sha !== null, true)
  assert.equal(unchanged.sha, null)
  assert.deepEqual(filesOf(docsRoot, 'HEAD'), ['codi/reglas.md'])
  assert.deepEqual(filesOf(docsRoot, 'HEAD~1'), ['codi/runbook.md'])
  assert.deepEqual(trailersOf(docsRoot, 'HEAD'), { 'Bita-Source': 'manual', 'Bita-Page': String(one) })
  assert.deepEqual(await git.docsStatus(docsRoot), [])
})

test('concurrent writes in one process and across processes all land, one commit each', async () => {
  const { ctx, docsRoot, db, page } = memoryContext('concurrent')
  await git.initDocsRepo(docsRoot)
  const ids = Array.from({ length: 8 }, (_, index) => page(`Página ${index}`, `pagina-${index}`))
  await Promise.all(ids.map((id, index) => recordPageDoc(ctx, requirePage(db, id), { body: `## Uno\n\nTexto ${index}.` })))
  assert.equal(log(docsRoot).length, 9)

  const gitModule = join(repo, 'src/docs/git.ts')
  const children = Array.from({ length: 4 }, (_, index) => {
    writeFileSync(join(docsRoot, `child-${index}.md`), `child ${index}\n`)
    const script = `const { commitDocs } = await import(${JSON.stringify(gitModule)}); const sha = await commitDocs(${JSON.stringify(docsRoot)}, ['child-${index}.md'], { source: 'manual', subject: 'docs: child ${index}' }); if (!sha) process.exit(3)`
    return new Promise<number | null>((done) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'ignore' })
      child.on('close', done)
    })
  })
  assert.deepEqual(await Promise.all(children), [0, 0, 0, 0])
  assert.equal(log(docsRoot).length, 13)
  assert.deepEqual(await git.docsStatus(docsRoot), [])
  assert.equal(existsSync(git.docsLockPath(docsRoot)), false)
})

test('a stale lock is taken over and a live one times out', async () => {
  const root = scratch('lock')
  await git.initDocsRepo(root)
  writeFileSync(git.docsLockPath(root), JSON.stringify({ pid: 2147483646, at: NOW }))
  writeFileSync(join(root, 'a.md'), 'a\n')
  assert.ok(await git.commitDocs(root, ['a.md'], { source: 'manual', subject: 'docs: a' }))

  writeFileSync(git.docsLockPath(root), JSON.stringify({ pid: process.pid, at: NOW }))
  await assert.rejects(() => git.withDocsGitLock(root, async () => 1, 150), { code: 'DOCS_GIT_LOCKED' })
})

test('history, show --rev, diff and restore follow the page through its revisions', () => {
  const { docs, pageId, ok, dir } = cliRoot('history')
  const body = join(dir, 'next.md')
  writeFileSync(body, 'Tope de 10k.')
  ok('docs', 'page', 'write', pageId, '--section', 'Límites', '--md', body)

  const history = ok('docs', 'page', 'history', pageId)
  assert.equal(history.path, 'codi/reglas-de-negocio.md')
  assert.deepEqual(
    history.revisions.map((revision: { source: string }) => revision.source),
    ['manual', 'manual', 'manual'],
  )
  const [latest, previous] = history.revisions
  assert.match(latest.date, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(ok('docs', 'page', 'history', pageId, '--limit', '1').revisions.length, 1)

  const shown = ok('docs', 'page', 'show', pageId, '--rev', previous.sha)
  assert.equal(shown.rev, previous.sha)
  assert.match(shown.markdown, /Tope de 8k\./)
  assert.match(shown.doc.markdown, /Tope de 10k\./)

  const diff = ok('docs', 'page', 'diff', pageId, latest.sha)
  assert.equal(diff.from, previous.sha)
  assert.equal(diff.to, latest.sha)
  const lines = diff.hunks.flatMap((hunk: { lines: { kind: string; text: string }[] }) => hunk.lines)
  assert.ok(lines.some((line: { kind: string; text: string }) => line.kind === 'del' && line.text === 'Tope de 8k.'))
  assert.ok(lines.some((line: { kind: string; text: string }) => line.kind === 'add' && line.text === 'Tope de 10k.'))

  const restored = ok('docs', 'page', 'restore', pageId, previous.sha)
  assert.match(restored.sha, /^[0-9a-f]{40}$/)
  assert.equal(restored.changed, true)
  assert.match(readFileSync(join(docs, 'codi/reglas-de-negocio.md'), 'utf8'), /Tope de 8k\./)
  const after = ok('docs', 'page', 'history', pageId)
  assert.equal(after.revisions[0].source, 'restore')
  assert.equal(after.revisions[0].sha, restored.sha)

  writeFileSync(join(docs, 'codi/reglas-de-negocio.md'), `${readFileSync(join(docs, 'codi/reglas-de-negocio.md'), 'utf8')}\nA mano.\n`)
  const worktree = ok('docs', 'page', 'diff', pageId)
  assert.equal(worktree.to, 'worktree')
  assert.equal(worktree.from, restored.sha)
  assert.ok(worktree.hunks.some((hunk: { lines: { kind: string; text: string }[] }) => hunk.lines.some((line) => line.kind === 'add' && line.text === 'A mano.')))
})

test('status lists outside edits and commit records them', () => {
  const { docs, ok } = cliRoot('status')
  writeFileSync(join(docs, 'codi/suelta.md'), '# Suelta\n')
  writeFileSync(join(docs, 'codi/reglas-de-negocio.md'), 'reescrita\n')
  const status = ok('docs', 'status')
  assert.deepEqual(
    [...status.dirty].sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path)),
    [
      { path: 'codi/reglas-de-negocio.md', status: 'modified' },
      { path: 'codi/suelta.md', status: 'untracked' },
    ],
  )
  const one = ok('docs', 'commit', 'codi/suelta.md', '--message', 'docs(codi): add suelta')
  assert.deepEqual(one.paths, ['codi/suelta.md'])
  assert.equal(log(docs)[0], 'docs(codi): add suelta')
  const rest = ok('docs', 'commit', '--all')
  assert.match(rest.sha, /^[0-9a-f]{40}$/)
  assert.deepEqual(ok('docs', 'status').dirty, [])
  assert.deepEqual(ok('docs', 'commit'), { sha: null, paths: [] })
})

test('propose builds a branch without touching the files, and apply merges it through the page writer', () => {
  const { docs, pageId, ok, run } = cliRoot('propose')
  const file = join(docs, 'codi/reglas-de-negocio.md')
  const before = readFileSync(file, 'utf8')
  const mainBefore = gitIn(docs, 'rev-parse', 'main').trim()

  const first = ok(
    'docs', 'propose', '--branch', 'proposal/meeting-7', pageId,
    '--section', 'Límites', '--body', 'Tope de 10k.',
    '--reason', 'Se subió el tope', '--source', 'meeting:7',
  )
  const second = ok(
    'docs', 'propose', '--branch', 'proposal/meeting-7', pageId,
    '--section', 'Horario', '--body', 'Zona CDMX, sin horario de verano.',
    '--reason', 'Se aclaró el horario', '--source', 'meeting:7',
  )
  assert.equal(first.base, mainBefore)
  assert.equal(second.base, first.sha)
  assert.equal(first.path, 'codi/reglas-de-negocio.md')
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(gitIn(docs, 'rev-parse', 'main').trim(), mainBefore)
  assert.equal(gitIn(docs, 'branch', '--show-current').trim(), 'main')
  assert.deepEqual(ok('docs', 'status').dirty, [])
  assert.deepEqual(trailersOf(docs, first.sha), {
    'Bita-Source': 'meeting',
    'Bita-Page': pageId,
    'Bita-Entry': '7',
    'Bita-Reason': 'Se subió el tope',
    'Bita-Section': 'Límites',
  })

  const branches = ok('docs', 'branch', 'ls').branches
  assert.equal(branches.length, 1)
  assert.equal(branches[0].name, 'proposal/meeting-7')
  assert.equal(branches[0].head, second.sha)
  assert.deepEqual(branches[0].commits.map((commit: { sha: string }) => commit.sha), [first.sha, second.sha])
  assert.equal(branches[0].commits[0].pageId, Number(pageId))

  const diff = ok('docs', 'branch', 'diff', 'proposal/meeting-7')
  assert.equal(diff.commits.length, 2)
  const only = ok('docs', 'branch', 'diff', 'proposal/meeting-7', '--commit', second.sha)
  assert.equal(only.commits.length, 1)
  assert.equal(only.commits[0].reason, 'Se aclaró el horario')
  assert.equal(only.commits[0].path, 'codi/reglas-de-negocio.md')
  const changed = only.commits[0].hunks.flatMap((hunk: { lines: { kind: string; text: string }[] }) =>
    hunk.lines.filter((line) => line.kind !== 'context').map((line) => `${line.kind}:${line.text}`),
  )
  assert.deepEqual(changed, ['del:Zona CDMX.', 'add:Zona CDMX, sin horario de verano.'])

  const applied = ok('docs', 'branch', 'apply', 'proposal/meeting-7', '--commit', second.sha)
  assert.equal(applied.sha, second.sha)
  assert.equal(applied.pageId, Number(pageId))
  assert.equal(gitIn(docs, 'rev-parse', 'main').trim(), applied.appliedSha)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /sin horario de verano/)
  assert.match(text, /Tope de 8k\./)
  assert.equal(trailersOf(docs, 'main')['Bita-Proposal'], second.sha)
  assert.equal(trailersOf(docs, 'main')['Bita-Source'], 'meeting')
  const shown = ok('docs', 'page', 'show', pageId)
  assert.equal(shown.doc.file.status, 'ok')

  const writeBody = join(docs, '..', 'edit.md')
  writeFileSync(writeBody, 'Tope de 15k.')
  ok('docs', 'page', 'write', pageId, '--section', 'Límites', '--md', writeBody)
  const edited = readFileSync(file, 'utf8')
  const head = gitIn(docs, 'rev-parse', 'main').trim()

  const conflict = run('docs', 'branch', 'apply', 'proposal/meeting-7', '--commit', first.sha)
  assert.equal(conflict.status, 9)
  assert.equal(conflict.json.ok, false)
  assert.equal(conflict.json.error.code, 'MERGE_CONFLICT')
  assert.deepEqual(conflict.json.error.paths, ['codi/reglas-de-negocio.md'])
  assert.equal(readFileSync(file, 'utf8'), edited)
  assert.equal(gitIn(docs, 'rev-parse', 'main').trim(), head)

  assert.deepEqual(ok('docs', 'branch', 'drop', 'proposal/meeting-7'), { branch: 'proposal/meeting-7', dropped: true })
  assert.deepEqual(ok('docs', 'branch', 'ls').branches, [])
  assert.equal(run('docs', 'branch', 'drop', 'proposal/meeting-7').json.error.code, 'BRANCH_NOT_FOUND')
  assert.equal(run('docs', 'propose', '--branch', 'main', pageId, '--body', 'x', '--reason', 'r').json.error.code, 'USAGE_ERROR')
})

test('a Confluence pull is committed as confluence-pull, rename included', async () => {
  const { ctx, docsRoot, db, page } = memoryContext('pull')
  const id = page('Arquitectura', 'arquitectura')
  await recordPageDoc(ctx, requirePage(db, id), { body: '## Estado\n\nuno' })

  await writeLocal(ctx, requirePage(db, id), {
    id: '101',
    title: 'Arquitectura AWS',
    version: 4,
    spaceId: null,
    parentId: null,
    status: 'current',
    storage: '<h2>Estado</h2><p>dos</p>',
    webUrl: null,
  })

  assert.equal(log(docsRoot)[0], 'docs(codi): pull from confluence arquitectura AWS')
  assert.deepEqual(trailersOf(docsRoot, 'HEAD'), {
    'Bita-Source': 'confluence-pull',
    'Bita-Page': String(id),
    'Bita-Reason': 'confluence 101 v4',
  })
  const files = gitIn(docsRoot, 'show', '--name-status', '--format=', 'HEAD').trim()
  assert.match(files, /arquitectura-aws\.md/)
  assert.deepEqual(await git.docsStatus(docsRoot), [])
  const history = await git.pageHistory(docsRoot, requirePage(db, id).relPath)
  assert.deepEqual(history.map((revision) => revision.source), ['confluence-pull', 'manual'])
})

test('a note save is committed as a note of its entry', () => {
  const { docs, ok, dir } = cliRoot('note')
  const logged = ok('log', 'Revisar pagos', '--from', '09:00', '--for', '30m', '--project', 'CoDi')
  const entryId = String((Array.isArray(logged) ? logged[0] : logged).id)
  const seed = join(dir, 'seed.md')
  writeFileSync(seed, 'Se revisaron los pagos.')
  ok('note', 'save', entryId, '--note-md', seed, '--command', 'pnpm test')
  const trailers = trailersOf(docs, 'HEAD')
  assert.equal(trailers['Bita-Source'], 'note')
  assert.equal(trailers['Bita-Entry'], entryId)
  assert.deepEqual(ok('docs', 'status').dirty, [])
})

test('without git a write still lands and only warns', () => {
  const dir = scratch('nogit')
  const env = {
    BITA_DB_PATH: join(dir, 'bita.db'),
    BITA_DOCS_DIR: join(dir, 'docs'),
    BITA_CONFIG_PATH: join(dir, 'config.json'),
    PATH: join(dir, 'empty-path'),
  }
  assert.equal(cli(env, 'project', 'add', 'CoDi').status, 0)
  const created = cli(env, 'docs', 'page', 'new', 'Reglas', '--project', 'CoDi')
  assert.equal(created.status, 0)
  assert.match(created.stderr, /git is not installed/)
  const written = cli(env, 'docs', 'page', 'write', String(created.json.data.page.pageId), '--body', '## Uno\n\nTexto.')
  assert.equal(written.status, 0)
  assert.equal(written.json.data.sha, null)
  assert.equal(existsSync(join(dir, 'docs', '.git')), false)
  assert.match(readFileSync(join(dir, 'docs', 'codi', 'reglas.md'), 'utf8'), /Texto\./)
})

test('parseHunks numbers lines and keeps content that looks like a header', () => {
  const diff = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,3 +1,3 @@ title',
    ' uno',
    '---- dos',
    '+++ dos',
    ' tres',
    '\\ No newline at end of file',
    '@@ -10 +10,2 @@',
    ' diez',
    '+once',
    '',
  ].join('\n')
  assert.deepEqual(git.parseHunks(diff), [
    {
      header: '@@ -1,3 +1,3 @@ title',
      lines: [
        { kind: 'context', text: 'uno', oldLine: 1, newLine: 1 },
        { kind: 'del', text: '--- dos', oldLine: 2, newLine: null },
        { kind: 'add', text: '++ dos', oldLine: null, newLine: 2 },
        { kind: 'context', text: 'tres', oldLine: 3, newLine: 3 },
      ],
    },
    {
      header: '@@ -10 +10,2 @@',
      lines: [
        { kind: 'context', text: 'diez', oldLine: 10, newLine: 10 },
        { kind: 'add', text: 'once', oldLine: null, newLine: 11 },
      ],
    },
  ])
})
