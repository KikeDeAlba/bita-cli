import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRepoIdentity, slugFromPath, slugFromRemote } from '../src/domain/repo.ts'

const HOME = '/Users/tester'

test('normalises an ssh remote and an https remote to the same slug', () => {
  const ssh = slugFromRemote('git@git.solemti.net:innovacion/budget.git')
  const https = slugFromRemote('https://git.solemti.net/innovacion/budget.git')

  assert.equal(ssh, 'git.solemti.net/innovacion/budget')
  assert.equal(https, ssh)
})

test('strips the git suffix, the port and the user', () => {
  assert.equal(
    slugFromRemote('ssh://git@git.example.com:2222/devops/aws/core.git'),
    'git.example.com/devops/aws/core',
  )
})

test('lowercases the slug so casing never splits a repository in two', () => {
  assert.equal(slugFromRemote('git@GitHub.com:KikeDeAlba/Nana.git'), 'github.com/kikedealba/nana')
})

test('rejects something that is not a remote url', () => {
  assert.equal(slugFromRemote('not a url'), null)
  assert.equal(slugFromRemote(''), null)
})

test('derives the slug from the path under the dev root when there is no remote', () => {
  assert.equal(slugFromPath('/Users/tester/dev/personal/toggl-track-cli', HOME), 'personal/toggl-track-cli')
})

test('handles repositories nested more than two levels deep', () => {
  assert.equal(
    slugFromPath('/Users/tester/dev/git.solemti.net/devops/aws/core', HOME),
    'git.solemti.net/devops/aws/core',
  )
})

test('refuses a path outside the dev root', () => {
  assert.equal(slugFromPath('/Users/tester/other/repo', HOME), null)
  assert.equal(slugFromPath('/tmp/repo', HOME), null)
})

test('prefers the remote over the path', () => {
  const identity = resolveRepoIdentity({
    cwd: '/Users/tester/dev/personal/thing',
    toplevel: '/Users/tester/dev/personal/thing',
    home: HOME,
    remoteUrl: 'git@github.com:kikedealba/thing.git',
  })

  assert.equal(identity?.slug, 'github.com/kikedealba/thing')
  assert.equal(identity?.source, 'remote')
})

test('falls back to the path and then to the basename', () => {
  const byPath = resolveRepoIdentity({
    cwd: '/Users/tester/dev/personal/thing',
    toplevel: '/Users/tester/dev/personal/thing',
    home: HOME,
    remoteUrl: null,
  })
  const byBasename = resolveRepoIdentity({
    cwd: '/opt/work/thing',
    toplevel: '/opt/work/thing',
    home: HOME,
    remoteUrl: null,
  })

  assert.equal(byPath?.slug, 'personal/thing')
  assert.equal(byPath?.source, 'path')
  assert.equal(byBasename?.slug, 'local/thing')
  assert.equal(byBasename?.source, 'basename')
})

test('returns null when the directory is not a repository', () => {
  assert.equal(
    resolveRepoIdentity({ cwd: '/tmp/x', toplevel: null, home: HOME, remoteUrl: null }),
    null,
  )
})

test('carries the branch and the head sha when git reported them', () => {
  const identity = resolveRepoIdentity({
    cwd: '/Users/tester/dev/personal/thing',
    toplevel: '/Users/tester/dev/personal/thing',
    home: HOME,
    remoteUrl: null,
    branch: 'feature/live-timer',
    headSha: '3ca7717',
  })

  assert.equal(identity?.branch, 'feature/live-timer')
  assert.equal(identity?.headSha, '3ca7717')
})
