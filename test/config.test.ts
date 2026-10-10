import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseConfig, readConfig, setScopeMapping, unsetScopeMapping } from '../src/state/config.ts'

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bita-cfg-'))
  return path.join(dir, 'config.json')
}

const LEGACY_KEYS = {
  version: 1,
  timezone: 'America/Mexico_City',
  jira: { siteUrl: 'https://acme.atlassian.net', email: 'me@acme.com', cloudId: 'abc' },
  atlassian: { sites: [{ site: 'https://acme.atlassian.net', email: 'me@acme.com', jira: true }] },
  defaults: { issueTypeName: 'Subtarea', storyThemes: [{ id: 'devops', name: 'DevOps' }] },
  projectMapping: {
    '7': {
      projectName: 'Pharma',
      jiraProjectKey: 'INN',
      parentKey: 'INN-1213',
      storiesByEpic: { 'INN-1213': { devops: { key: 'INN-1300', summary: 'DevOps', verifiedAt: '2026-01-01T00:00:00.000Z' } } },
    },
  },
  stories: { legacy: true },
  themes: ['a', 'b'],
  somethingNew: { nested: [1, 2, 3] },
  scopeMapping: { 'git.acme.com/team/app': { projectId: 7, projectName: 'Pharma', slugSource: 'remote' } },
  hooks: [{ on: ['start'], command: ['echo', 'hi'] }],
}

test('writing a scope keeps every key bita no longer uses', async () => {
  const configPath = await tempConfigPath()
  await writeFile(configPath, JSON.stringify(LEGACY_KEYS, null, 2))

  await setScopeMapping('git.acme.com/team/api', { projectId: 8, projectName: 'Api', slugSource: 'remote' }, configPath)

  const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  for (const key of ['jira', 'atlassian', 'defaults', 'projectMapping', 'stories', 'themes', 'somethingNew', 'timezone', 'hooks']) {
    assert.deepEqual(written[key], LEGACY_KEYS[key as keyof typeof LEGACY_KEYS], key)
  }
  assert.deepEqual(Object.keys(written['scopeMapping'] as object).sort(), ['git.acme.com/team/api', 'git.acme.com/team/app'])
})

test('unsetting a scope keeps the unused keys too', async () => {
  const configPath = await tempConfigPath()
  await writeFile(configPath, JSON.stringify(LEGACY_KEYS))

  assert.equal(await unsetScopeMapping('git.acme.com/team/app', configPath), true)

  const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  assert.deepEqual(written['projectMapping'], LEGACY_KEYS.projectMapping)
  assert.deepEqual(written['atlassian'], LEGACY_KEYS.atlassian)
  assert.deepEqual(written['scopeMapping'], {})
})

test('a config that is not valid JSON is never rewritten', async () => {
  const configPath = await tempConfigPath()
  await writeFile(configPath, '{ "projectMapping": ')

  await assert.rejects(
    setScopeMapping('a/one', { projectId: 1, projectName: 'One', slugSource: 'path' }, configPath),
    /not valid JSON/,
  )
  assert.equal(await readFile(configPath, 'utf8'), '{ "projectMapping": ')
  assert.deepEqual((await readConfig(configPath)).scopeMapping, {})
})

test('the config file is written with owner-only permissions', async () => {
  const configPath = await tempConfigPath()
  await setScopeMapping('a/one', { projectId: 1, projectName: 'One', slugSource: 'path' }, configPath)
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600)
})

test('remembers which project a repository belongs to', async () => {
  const configPath = await tempConfigPath()
  await setScopeMapping('personal/bita', { projectId: 22, projectName: 'Pharma STI', slugSource: 'path' }, configPath)

  const config = await readConfig(configPath)

  assert.equal(config.scopeMapping['personal/bita']?.projectId, 22)
  assert.equal(config.scopeMapping['personal/bita']?.slugSource, 'path')
})

test('unsetting one repository leaves the others alone', async () => {
  const configPath = await tempConfigPath()

  await setScopeMapping('a/one', { projectId: 1, projectName: 'One', slugSource: 'path' }, configPath)
  await setScopeMapping('a/two', { projectId: 2, projectName: 'Two', slugSource: 'path' }, configPath)

  assert.equal(await unsetScopeMapping('a/one', configPath), true)
  assert.equal(await unsetScopeMapping('a/nope', configPath), false)

  const config = await readConfig(configPath)

  assert.equal(config.scopeMapping['a/one'], undefined)
  assert.equal(config.scopeMapping['a/two']?.projectId, 2)
})

test('legacy repo mappings and toggl names become scopes', () => {
  const config = parseConfig({
    repoMapping: { 'a/one': { togglProjectId: 5, togglProjectName: 'Five', workspaceId: 9, slugSource: 'path' } },
  })
  assert.deepEqual(config.scopeMapping['a/one'], { projectId: 5, projectName: 'Five', slugSource: 'path' })
  assert.equal('repoMapping' in config, false)
})
