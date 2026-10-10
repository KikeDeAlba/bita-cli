import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FakeConfluence } from './helpers/fake-confluence.ts'
import { macosKeychain } from '@kikedealba/kit/credentials'

const dir = mkdtempSync(join(tmpdir(), 'bita-atlassian-cmd-'))
const configPath = join(dir, 'config.json')
const dbPath = join(dir, 'bita.db')
const docsDir = join(dir, 'docs')
process.env['BITA_CONFIG_PATH'] = configPath
writeFileSync(
  configPath,
  JSON.stringify({ version: 1, jira: { siteUrl: 'https://acme.atlassian.net', email: 'me@acme.com' }, projectMapping: {}, scopeMapping: {} }),
)

const { route } = await import('../src/cli/router.ts')
const { setAtlassianRuntime } = await import('../src/atlassian/runtime.ts')

const keychain = new Map<string, string>([['me@acme.com', 'legacy-token']])
const fake = new FakeConfluence('https://acme.atlassian.net')
fake.add({ id: '100', title: 'Apartados', parentId: null, storage: '<p>root</p>' })
fake.add({ id: '101', title: 'Arquitectura', parentId: '100', storage: '<p>uno</p>' })

const restore = setAtlassianRuntime({
  fetch: fake.fetch,
  configPath,
  credentials: async () => macosKeychain(async (_command, args) => {
    const account = args[args.indexOf('-a') + 1] ?? ''
    if (args[0] === 'find-generic-password') {
      const token = keychain.get(account)
      if (token === undefined) throw Object.assign(new Error('failed'), { code: 44 })
      return `${token}\n`
    }
    if (args[0] === 'add-generic-password') {
      keychain.set(account, args[args.indexOf('-w') + 1] ?? '')
      return ''
    }
    if (args[0] === 'delete-generic-password') {
      if (!keychain.delete(account)) throw Object.assign(new Error('failed'), { code: 44 })
      return ''
    }
    throw new Error(`unexpected security call ${args.join(' ')}`)
  }),
})

after(() => {
  restore()
  rmSync(dir, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const chunks: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
    chunks.push(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    const code = await route([...argv, '--json', '--db-path', dbPath, '--docs-dir', docsDir])
    return { code, json: JSON.parse(chunks.join('')) as Record<string, unknown> }
  } finally {
    process.stdout.write = write
  }
}

test('a project points at a Confluence page and the setting round-trips', async () => {
  await run(['project', 'add', 'Apartados'])
  const set = await run([
    'project',
    'atlassian',
    'Apartados',
    '--via',
    'cli',
    '--confluence',
    'https://acme.atlassian.net/wiki/spaces/K/pages/100/Apartados+Home',
    '--pull',
    'on',
    '--push',
    'on',
  ])
  assert.deepEqual((set.json['data'] as Record<string, unknown>)['atlassian'], {
    site: 'https://acme.atlassian.net',
    via: 'cli',
    confluence: {
      kind: 'page',
      url: 'https://acme.atlassian.net/wiki/spaces/K/pages/100/Apartados+Home',
      spaceKey: 'K',
      pageId: '100',
      title: 'Apartados Home',
    },
    sync: { pull: true, push: true, lastSyncAt: null },
  })

  const shown = await run(['project', 'show', 'Apartados'])
  const data = shown.json['data'] as Record<string, unknown>
  assert.equal(data['name'], 'Apartados')
  assert.deepEqual(data['atlassian'], (set.json['data'] as Record<string, unknown>)['atlassian'])

  const space = await run(['project', 'atlassian', 'Apartados', '--confluence', 'K', '--via', 'mcp'])
  assert.deepEqual(((space.json['data'] as Record<string, unknown>)['atlassian'] as Record<string, unknown>)['confluence'], {
    kind: 'space',
    url: 'https://acme.atlassian.net/wiki/spaces/K',
    spaceKey: 'K',
    pageId: null,
    title: null,
  })
  await run(['project', 'atlassian', 'Apartados', '--confluence', 'https://acme.atlassian.net/wiki/spaces/K/pages/100/Apartados', '--via', 'cli'])
})

test('the legacy login shows up as the first site, and checking it persists the sites', async () => {
  const listed = await run(['atlassian', 'site', 'ls'])
  assert.deepEqual(listed.json['data'], [
    {
      site: 'https://acme.atlassian.net',
      email: 'me@acme.com',
      tokenStored: true,
      jira: null,
      confluence: null,
      projects: ['Apartados'],
      status: 'unknown',
      displayName: null,
      checkedAt: null,
    },
  ])

  const checked = await run(['atlassian', 'site', 'ls', '--check'])
  const [site] = checked.json['data'] as Record<string, unknown>[]
  assert.equal(site?.['status'], 'ok')
  assert.equal(site?.['jira'], true)
  assert.equal(site?.['confluence'], true)
  const saved = JSON.parse(readFileSync(configPath, 'utf8')) as { atlassian: { sites: { site: string; jira: boolean }[] } }
  assert.equal(saved.atlassian.sites[0]?.site, 'https://acme.atlassian.net')
  assert.equal(saved.atlassian.sites[0]?.jira, true)
})

test('the page tree carries the Atlassian settings of every space', async () => {
  await run(['docs', 'page', 'new', 'Runbook', '--project', 'Apartados'])
  const tree = await run(['docs', 'tree', '--pages'])
  const spaces = (tree.json['data'] as { spaces: Record<string, unknown>[] }).spaces
  const apartados = spaces.find((space) => space['projectName'] === 'Apartados')
  assert.ok(apartados)
  assert.equal((apartados['atlassian'] as Record<string, unknown>)['via'], 'cli')
  assert.equal(((apartados['atlassian'] as Record<string, unknown>)['confluence'] as Record<string, unknown>)['pageId'], '100')
})

test('a dry-run sync through the CLI reports per project and writes nothing', async () => {
  const synced = await run(['confluence', 'sync', '--all', '--dry-run'])
  assert.equal(synced.json['command'], 'confluence sync')
  assert.deepEqual(synced.json['meta'], { dryRun: true })
  const [report] = synced.json['data'] as Record<string, unknown>[]
  assert.equal(report?.['project'], 'Apartados')
  assert.deepEqual(report?.['created'], [
    { confluenceId: '101', title: 'Arquitectura', reason: 'from Confluence' },
    { pageId: 1, title: 'Runbook', reason: 'from bita' },
  ])
  assert.equal(fake.writes().length, 0)

  const status = await run(['confluence', 'sync', 'status', 'Apartados'])
  assert.deepEqual(status.json['data'], [])
})

test('a site in use is only removed with --force, and takes its token with it', async () => {
  await assert.rejects(run(['atlassian', 'site', 'rm', 'acme.atlassian.net']), /is the site of Apartados/)
  const removed = await run(['atlassian', 'site', 'rm', 'acme.atlassian.net', '--force'])
  assert.deepEqual(removed.json['data'], {
    site: 'https://acme.atlassian.net',
    email: 'me@acme.com',
    tokenRemoved: true,
    releasedProjects: ['Apartados'],
  })
  assert.equal(keychain.size, 0)
  const listed = await run(['atlassian', 'site', 'ls'])
  assert.deepEqual(listed.json['data'], [])
})
