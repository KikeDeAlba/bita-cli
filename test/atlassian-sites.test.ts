import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeSiteUrl, readConfig, type AppConfig } from '../src/state/config.ts'
import { setAtlassianRuntime } from '../src/atlassian/runtime.ts'
import { chooseSite, dropSite, readSiteToken, siteAccount, storeSiteToken, upsertSite } from '../src/atlassian/sites.ts'
import { parseConfluenceRef } from '../src/atlassian/project-view.ts'

function config(sites: { site: string; email: string }[]): AppConfig {
  return { version: 1, projectMapping: {}, scopeMapping: {}, atlassian: { sites } }
}

test('sites are normalized to their https origin', () => {
  assert.equal(normalizeSiteUrl('acme.atlassian.net'), 'https://acme.atlassian.net')
  assert.equal(normalizeSiteUrl('https://ACME.atlassian.net/wiki/spaces/K'), 'https://acme.atlassian.net')
  assert.equal(normalizeSiteUrl('http://acme.atlassian.net'), null)
  assert.equal(normalizeSiteUrl('nada'), null)
})

test('a 0.14 config with a Jira login reads as one site, and an explicit list wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-sites-'))
  const legacy = join(dir, 'legacy.json')
  writeFileSync(legacy, JSON.stringify({ version: 1, jira: { siteUrl: 'https://acme.atlassian.net/', email: 'me@acme.com' } }))
  assert.deepEqual((await readConfig(legacy)).atlassian, { sites: [{ site: 'https://acme.atlassian.net', email: 'me@acme.com' }] })

  const explicit = join(dir, 'explicit.json')
  writeFileSync(
    explicit,
    JSON.stringify({ version: 1, jira: { siteUrl: 'https://acme.atlassian.net', email: 'me@acme.com' }, atlassian: { sites: [] } }),
  )
  assert.deepEqual((await readConfig(explicit)).atlassian, { sites: [] })
  rmSync(dir, { recursive: true, force: true })
})

test('tokens live under site|email and fall back to the bare e-mail of 0.14', async () => {
  const calls: string[][] = []
  const store = new Map<string, string>([['me@acme.com', 'old']])
  const restore = setAtlassianRuntime({
    security: async (args) => {
      calls.push([...args])
      const account = args[args.indexOf('-a') + 1] ?? ''
      if (args[0] === 'add-generic-password') {
        store.set(account, args[args.indexOf('-w') + 1] ?? '')
        return ''
      }
      const token = store.get(account)
      if (token === undefined) throw Object.assign(new Error('failed'), { code: 44 })
      return token
    },
  })
  try {
    assert.equal(await readSiteToken('https://acme.atlassian.net', 'me@acme.com'), 'old')
    assert.deepEqual(
      calls.map((call) => call[call.indexOf('-a') + 1]),
      ['https://acme.atlassian.net|me@acme.com', 'me@acme.com'],
    )
    await storeSiteToken('https://acme.atlassian.net', 'me@acme.com', 'new')
    assert.equal(store.get(siteAccount('https://acme.atlassian.net', 'me@acme.com')), 'new')
    assert.equal(await readSiteToken('https://acme.atlassian.net', 'me@acme.com'), 'new')
  } finally {
    restore()
  }
})

test('the explicit site wins, then the project site, then the first one', () => {
  const both = config([
    { site: 'https://a.atlassian.net', email: 'a@x.com' },
    { site: 'https://b.atlassian.net', email: 'b@x.com' },
  ])
  assert.equal(chooseSite(both).site, 'https://a.atlassian.net')
  assert.equal(chooseSite(both, { projectSite: 'https://b.atlassian.net' }).site, 'https://b.atlassian.net')
  assert.equal(chooseSite(both, { site: 'a.atlassian.net', projectSite: 'https://b.atlassian.net' }).site, 'https://a.atlassian.net')
  assert.throws(() => chooseSite(both, { site: 'c.atlassian.net' }), /no login for https:\/\/c.atlassian.net/)
  assert.throws(() => chooseSite(config([])), /no Atlassian site yet/)
})

test('adding and dropping sites keeps the legacy Jira site in step', () => {
  const added = upsertSite({ version: 1, projectMapping: {}, scopeMapping: {} }, { site: 'https://a.atlassian.net', email: 'a@x.com' })
  assert.deepEqual(added.jira, { siteUrl: 'https://a.atlassian.net', email: 'a@x.com' })
  const two = upsertSite(added, { site: 'https://b.atlassian.net', email: 'b@x.com', jira: true })
  assert.equal(two.atlassian?.sites.length, 2)
  const dropped = dropSite(two, 'https://a.atlassian.net')
  assert.deepEqual(dropped.jira, { siteUrl: 'https://b.atlassian.net', email: 'b@x.com' })
  assert.deepEqual(dropped.atlassian?.sites.map((entry) => entry.site), ['https://b.atlassian.net'])
})

test('a Confluence reference is a page URL, a space URL or a space key', () => {
  assert.deepEqual(parseConfluenceRef('https://acme.atlassian.net/wiki/spaces/ZDE/pages/1010794497/Motor+de+Acumulacion?x=1'), {
    kind: 'page',
    ref: 'https://acme.atlassian.net/wiki/spaces/ZDE/pages/1010794497/Motor+de+Acumulacion',
    site: 'https://acme.atlassian.net',
  })
  assert.deepEqual(parseConfluenceRef('https://acme.atlassian.net/wiki/spaces/ZDE/overview'), {
    kind: 'space',
    ref: 'ZDE',
    site: 'https://acme.atlassian.net',
  })
  assert.deepEqual(parseConfluenceRef('DDS'), { kind: 'space', ref: 'DDS', site: null })
  assert.equal(parseConfluenceRef('none'), null)
  assert.throws(() => parseConfluenceRef('dos palabras'), /neither a Confluence URL nor a space key/)
})
