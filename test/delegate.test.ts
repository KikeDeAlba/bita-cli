import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { planDelegation } from '../src/cli/delegate.ts'

const bin = join(import.meta.dirname, '..', 'src', 'bin', 'bita.ts')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'bita-delegate-')))
after(() => rmSync(base, { recursive: true, force: true }))

const FAKE_TOOL = `
import { appendFileSync } from 'node:fs'
const [name, ...args] = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args }) + '\\n')
const json = args.includes('--json')
const envelope = (command, data, ok = true, error) => JSON.stringify({ schemaVersion: 1, ok, command, generatedAt: new Date().toISOString(), ...(ok ? { data } : { error }) })
const words = args.filter((arg) => !arg.startsWith('--'))
if (words[0] === 'capabilities') { console.log(envelope('capabilities', { name, version: '9.0.0', capabilities: [] })); process.exit(0) }
if (words[0] === 'migrate' && words[1] === 'status') { console.log(envelope('migrate status', { migrated: process.env.FAKE_MIGRATED === '1', bitaDatabase: process.env.FAKE_BITA_DB || null, migratedAt: null })); process.exit(0) }
if (words[0] === 'site' && words[1] === 'ls') { console.log(envelope('site ls', [{ name: 'acme', url: 'https://acme.atlassian.net', default: false }])); process.exit(0) }
if (words.includes('PP-404') || words.some((word) => word.endsWith('bad.png'))) {
  if (json) console.log(envelope(words.slice(0, 3).join(' '), undefined, false, { code: 'NOT_FOUND', message: 'PP-404 does not exist' }))
  else process.stderr.write('not found\\n')
  process.exit(5)
}
if (json) console.log(envelope(words.slice(0, 3).join(' '), { from: name, words }))
else console.log(name + ' says ' + words.join(' '))
`

const ATL_CAPABILITIES = ['jira.issue.read', 'jira.issue.write', 'jira.worklog.write', 'confluence.page.read', 'confluence.page.write', 'confluence.attachment.write']
const INKWELL_CAPABILITIES = ['docs.page.read', 'docs.page.write', 'docs.backlog', 'docs.history', 'docs.propose', 'docs.diagrams', 'docs.export.pdf', 'docs.confluence.sync']

interface Sandbox {
  root: string
  registry: string
  log: string
  env: Record<string, string>
}

let counter = 0

function sandbox(tools: Array<{ name: string; capabilities: string[] }>, extra: Record<string, string> = {}): Sandbox {
  counter += 1
  const root = join(base, `s${counter}`)
  const registry = join(root, 'tools.d')
  mkdirSync(registry, { recursive: true })
  const script = join(root, 'fake-tool.mjs')
  writeFileSync(script, FAKE_TOOL)
  for (const tool of tools) {
    writeFileSync(
      join(registry, `${tool.name}.json`),
      JSON.stringify({ manifestVersion: 1, name: tool.name, version: '9.0.0', bin: [process.execPath, script, tool.name], envelope: 1, capabilities: tool.capabilities, emits: [], subscribes: [] }),
    )
  }
  const log = join(root, 'calls.ndjson')
  return {
    root,
    registry,
    log,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      KIT_REGISTRY_DIR: registry,
      KIT_CREDENTIALS: 'file',
      BITA_DB_PATH: join(root, 'bita.db'),
      BITA_CONFIG_PATH: join(root, 'config.json'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      FAKE_LOG: log,
      FAKE_MIGRATED: '1',
      ...extra,
    },
  }
}

function run(box: Sandbox, ...args: string[]) {
  const { BITA_NO_DELEGATE: _ignored, ...inherited } = process.env
  const env: NodeJS.ProcessEnv = { ...inherited, ...box.env }
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: box.root, env, encoding: 'utf8' })
  const lastLine = result.stdout.trim().split('\n').pop() ?? ''
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(lastLine) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function calls(box: Sandbox): Array<{ name: string; args: string[] }> {
  if (!existsSync(box.log)) return []
  return readFileSync(box.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { name: string; args: string[] })
}

function delegatedTo(json: Record<string, unknown> | null): unknown {
  return (json?.['meta'] as { delegatedTo?: unknown } | undefined)?.delegatedTo
}

const both = () => sandbox([{ name: 'atl', capabilities: ATL_CAPABILITIES }, { name: 'inkwell', capabilities: INKWELL_CAPABILITIES }])

test('the mapping table translates bita arguments into the provider CLIs', () => {
  const cases: Array<[string[], string, string[][] | null]> = [
    [['jira', 'myself'], 'atl', [['jira', 'myself']]],
    [['jira', 'project', 'ls', '--query', 'PP'], 'atl', [['jira', 'project', 'ls', '--query=PP']]],
    [['jira', 'issue', 'get', 'pp-1', '--fields', 'summary,status', '--site', 'acme'], 'atl', [['jira', 'issue', 'get', 'PP-1', '--fields=summary,status', '--site=acme']]],
    [
      ['jira', 'issue', 'create', '--project', 'pp', '--type', 'Subtask', '--summary', '--- odd', '--description-file', 'd.md', '--parent', 'pp-2', '--field', 'customfield_1=3', '--field', 'labels=["a"]'],
      'atl',
      [['jira', 'issue', 'create', '--project=PP', '--type=Subtask', '--summary=--- odd', `--description=@${resolve('d.md')}`, '--parent=PP-2', '--fields={"customfield_1":3,"labels":["a"]}']],
    ],
    [['jira', 'issue', 'edit', 'PP-1', '--description', '@literal'], 'atl', [['jira', 'issue', 'edit', 'PP-1', '--description=@@literal']]],
    [['jira', 'issue', 'transition', 'PP-1', '--to', 'Done'], 'atl', [['jira', 'issue', 'transition', 'PP-1', '--to=Done']]],
    [['jira', 'issue', 'search', '--jql', 'project = PP', '--limit', '5'], 'atl', [['jira', 'search', '--jql=project = PP', '--limit=5']]],
    [['jira', 'issue', 'createmeta', '--project', 'pp', '--type', 'Story'], 'atl', [['jira', 'createmeta', '--project=PP', '--type=Story']]],
    [['jira', 'worklog', 'add', 'PP-1', '--started', '2026-10-01T10:00:00.000-0600', '--seconds', '5400', '--comment', 'Hecho'], 'atl', [['jira', 'worklog', 'add', 'PP-1', '--started=2026-10-01T10:00:00.000-0600', '--time-spent=5400', '--comment=Hecho']]],
    [['jira', 'comment', 'add', 'PP-1', '--body-file', 'c.md'], 'atl', [['jira', 'comment', 'add', 'PP-1', `--body=@${resolve('c.md')}`]]],
    [['jira', 'comment', 'rm', 'PP-1', '100'], 'atl', [['jira', 'comment', 'rm', 'PP-1', '100']]],
    [['jira', 'attach', 'PP-1', 'a.png', 'b.png'], 'atl', [['jira', 'attach', 'PP-1', resolve('a.png')], ['jira', 'attach', 'PP-1', resolve('b.png')]]],
    [['jira', 'link', '--from', 'PP-1', '--to', 'PP-2', '--type', 'Blocks'], 'atl', [['jira', 'link', '--type=Blocks', '--inward=PP-1', '--outward=PP-2']]],
    [['confluence', 'page', 'get', '123'], 'atl', [['confluence', 'page', 'get', '123', '--format=storage']]],
    [['confluence', 'page', 'get', '123', '--markdown'], 'atl', [['confluence', 'page', 'get', '123']]],
    [['confluence', 'page', 'create', '--space', 'DOC', '--title', 'T', '--file', 'p.md', '--parent', '9'], 'atl', [['confluence', 'page', 'create', '--space=DOC', '--title=T', `--body=@${resolve('p.md')}`, '--parent-id=9']]],
    [['confluence', 'page', 'update', '123', '--body', '<p/>', '--storage', '--message', 'm'], 'atl', [['confluence', 'page', 'update', '123', '--body=<p/>', '--format=storage', '--message=m']]],
    [['confluence', 'page', 'search', '--cql', 'type = page'], 'atl', [['confluence', 'search', '--cql=type = page']]],
    [['confluence', 'attach', '123', 'x.png', '--comment', 'c'], 'atl', [['confluence', 'attach', '123', resolve('x.png'), '--comment=c']]],
    [['atlassian', 'site', 'add', '--site', 'https://acme.atlassian.net', '--email', 'a@b.c', '--token-stdin'], 'atl', [['site', 'add', 'https://acme.atlassian.net', '--email=a@b.c', '--token-stdin']]],
    [['atlassian', 'site', 'rm', 'acme', '--force'], 'atl', [['site', 'rm', 'acme']]],
    [['docs'], '', null],
    [['docs', 'ls'], '', null],
    [['docs', 'show', '5'], '', null],
    [['docs', 'tree', '--pages', '--json'], 'inkwell', [['tree', '--pages', '--json']]],
    [['docs', 'page', 'write', '4', '--md', 'f.md'], 'inkwell', [['page', 'write', '4', '--md', 'f.md']]],
    [['docs', 'status'], 'inkwell', [['git', 'status']]],
    [['docs', 'propose', '--branch', 'b', '7'], 'inkwell', [['git', 'propose', '--branch', 'b', '7']]],
    [['docs', 'branch', 'apply', 'b', '--commit', 'abc'], 'inkwell', [['branch', 'apply', 'b', '--commit', 'abc']]],
    [['docs', 'diagrams', 'render', '4'], 'inkwell', [['diagrams', 'render', '4']]],
    [['backlog', 'add', '--kind', 'pending'], 'inkwell', [['backlog', 'add', '--kind', 'pending']]],
    [['meeting', 'export', '12', '--out', 'm.pdf'], 'inkwell', [['export', 'meeting', '--bita-entry', '12', '--out=m.pdf']]],
    [['confluence', 'sync', 'CoDi', '--dry-run'], 'inkwell', [['confluence', 'sync', 'CoDi', '--dry-run']]],
    [['confluence', 'sync', 'status', 'CoDi'], 'inkwell', [['confluence', 'status', 'CoDi']]],
    [['confluence', 'conflict', 'resolve', '4', '--keep', 'local'], 'inkwell', [['confluence', 'conflict', 'resolve', '4', '--keep', 'local']]],
    [['docs', 'migrate'], '', null],
    [['docs', 'tree', '--db-path', 'x.db'], '', null],
    [['confluence', 'publish-diagrams', '4', '--to', '5'], '', null],
    [['confluence', 'logout'], '', null],
    [['confluence', 'page', 'create', '--parent', '9', '--title', 'T', '--body', 'b'], '', null],
    [['jira', 'issue', 'get', 'PP-1', '--unknown', 'x'], '', null],
    [['atlassian', 'site', 'ls', '--check'], '', null],
    [['atlassian', 'site', 'rm', 'acme'], '', null],
    [['backlog', 'ls', '--workspace', 'w', '--verbose', '--project', 'X'], 'inkwell', [['backlog', 'ls', '--project', 'X']]],
  ]
  for (const [argv, provider, expected] of cases) {
    const plan = planDelegation(argv)
    if (expected === null) {
      assert.equal(plan, null, `bita ${argv.join(' ')} should stay in bita`)
      continue
    }
    assert.ok(plan, `bita ${argv.join(' ')} should be delegated`)
    assert.equal(plan.provider, provider)
    assert.deepEqual(plan.calls, expected, `bita ${argv.join(' ')}`)
  }
})

test('jira commands are forwarded to atl with the bita command label and a deprecation notice', () => {
  const box = both()
  const result = run(box, 'jira', 'issue', 'get', 'PP-1', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json?.['command'], 'jira issue get')
  assert.deepEqual((result.json?.['data'] as { words: string[] }).words, ['jira', 'issue', 'get', 'PP-1'])
  assert.equal((result.json?.['meta'] as { delegatedTo: { tool: string } }).delegatedTo.tool, 'atl')
  assert.match(result.stderr, /deprecated.*atl 9\.0\.0/)
  assert.doesNotMatch(result.stdout, /deprecated/)
  assert.deepEqual(calls(box).map((call) => call.args), [['jira', 'issue', 'get', 'PP-1', '--json']])
})

test('the provider exit code and error envelope come back unchanged', () => {
  const box = both()
  const result = run(box, 'jira', 'issue', 'get', 'PP-404', '--json')
  assert.equal(result.status, 5)
  assert.equal(result.json?.['ok'], false)
  assert.equal(result.json?.['command'], 'jira issue get')
  assert.equal((result.json?.['error'] as { code: string }).code, 'NOT_FOUND')
})

test('several attachments become one call per file, folded into one envelope', () => {
  const box = both()
  const result = run(box, 'jira', 'attach', 'PP-1', 'a.png', 'b.png', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json?.['command'], 'jira attach')
  assert.equal((result.json?.['data'] as unknown[]).length, 2)
  assert.deepEqual(calls(box).map((call) => call.args[3]), [join(box.root, 'a.png'), join(box.root, 'b.png')])
})

test('a failed upload in a batch reports what was already attached', () => {
  const box = both()
  const result = run(box, 'jira', 'attach', 'PP-1', 'a.png', 'bad.png', 'c.png', '--json')
  assert.equal(result.status, 5)
  assert.equal(result.json?.['ok'], false)
  const data = result.json?.['data'] as { completed: unknown[]; skipped: number }
  assert.equal(data.completed.length, 1)
  assert.equal(data.skipped, 1)
})

test('an inkwell migrated from another bita database leaves docs in bita', () => {
  const box = sandbox([{ name: 'inkwell', capabilities: INKWELL_CAPABILITIES }], { FAKE_BITA_DB: '/somewhere/else/bita.db' })
  const result = run(box, 'docs', 'tree', '--pages', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(delegatedTo(result.json), undefined)
  const same = sandbox([{ name: 'inkwell', capabilities: INKWELL_CAPABILITIES }])
  same.env['FAKE_BITA_DB'] = same.env['BITA_DB_PATH'] as string
  assert.equal((delegatedTo(run(same, 'docs', 'tree', '--pages', '--json').json) as { tool: string }).tool, 'inkwell')
})

test('without --json the provider output passes straight through', () => {
  const box = both()
  const result = run(box, 'jira', 'worklog', 'add', 'PP-1', '--started', '2026-10-01T10:00:00.000-0600', '--seconds', '60')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'atl says jira worklog add PP-1')
  assert.deepEqual(calls(box)[0]?.args, ['jira', 'worklog', 'add', 'PP-1', '--started=2026-10-01T10:00:00.000-0600', '--time-spent=60'])
})

test('a provider without the needed capability leaves the command in bita', () => {
  const box = sandbox([{ name: 'atl', capabilities: ['jira.issue.read'] }])
  const result = run(box, 'jira', 'worklog', 'add', 'PP-1', '--started', '2026-10-01T10:00:00.000-0600', '--seconds', '60', '--json')
  assert.equal(calls(box).length, 0)
  assert.equal(delegatedTo(result.json), undefined)
})

test('docs commands go to a migrated inkwell', () => {
  const box = both()
  const tree = run(box, 'docs', 'tree', '--pages', '--json')
  assert.equal(tree.status, 0, tree.stderr)
  assert.equal(tree.json?.['command'], 'docs tree')
  assert.equal((tree.json?.['meta'] as { delegatedTo: { tool: string } }).delegatedTo.tool, 'inkwell')
  const exported = run(box, 'meeting', 'export', '12', '--out', 'm.pdf', '--json')
  assert.equal(exported.json?.['command'], 'meeting export')
  const status = run(box, 'docs', 'status', '--json')
  assert.equal(status.json?.['command'], 'docs status')
  const forwarded = calls(box).filter((call) => call.args[0] !== 'migrate').map((call) => call.args)
  assert.deepEqual(forwarded, [
    ['tree', '--pages', '--json'],
    ['export', 'meeting', '--bita-entry', '12', '--out=m.pdf', '--json'],
    ['git', 'status', '--json'],
  ])
})

test('entry-note reads stay in bita even with a migrated inkwell', () => {
  const box = both()
  for (const args of [['docs', 'tree', '--json'], ['docs', 'ls', '--json'], ['docs', 'show', '1', '--json'], ['docs', 'search', 'x', '--json']]) {
    const result = run(box, ...args)
    assert.equal(delegatedTo(result.json), undefined, args.join(' '))
  }
  assert.deepEqual(calls(box), [])
})

test('an inkwell that has not migrated bita leaves docs in bita', () => {
  const box = sandbox([{ name: 'inkwell', capabilities: INKWELL_CAPABILITIES }], { FAKE_MIGRATED: '0' })
  const result = run(box, 'docs', 'tree', '--pages', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json?.['command'], 'docs tree')
  assert.equal(delegatedTo(result.json), undefined)
  assert.deepEqual(calls(box).map((call) => call.args), [['migrate', 'status', '--json']])
  assert.doesNotMatch(result.stderr, /deprecated/)
})

test('without registered tools, or with BITA_NO_DELEGATE, bita runs its own code', () => {
  const empty = sandbox([])
  const tree = run(empty, 'docs', 'tree', '--json')
  assert.equal(tree.status, 0, tree.stderr)
  assert.equal(delegatedTo(tree.json), undefined)
  const jira = run(empty, 'jira', 'issue', 'get', 'PP-1', '--json')
  assert.notEqual(jira.json?.['ok'], true)
  assert.equal(calls(empty).length, 0)

  const disabled = sandbox([{ name: 'atl', capabilities: ATL_CAPABILITIES }], { BITA_NO_DELEGATE: '1' })
  run(disabled, 'jira', 'issue', 'get', 'PP-1', '--json')
  assert.equal(calls(disabled).length, 0)
})

test('doctor lists the tools kit found and whether bita delegates to them', () => {
  const box = sandbox([{ name: 'atl', capabilities: ATL_CAPABILITIES }, { name: 'inkwell', capabilities: INKWELL_CAPABILITIES }], { FAKE_MIGRATED: '0' })
  const result = run(box, 'doctor', '--json')
  assert.equal(result.status, 0, result.stderr)
  const tools = (result.json?.['data'] as { tools: Array<{ name: string; found: boolean; version: string | null; delegating: boolean }> }).tools
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.found, tool.version, tool.delegating]),
    [
      ['atl', true, '9.0.0', true],
      ['inkwell', true, '9.0.0', false],
      ['recap', false, null, false],
    ],
  )
})
