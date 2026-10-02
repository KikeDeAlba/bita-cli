import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  chooseLinkDirectory,
  ensureRecap,
  ensureRecapApp,
  ensureRecapCli,
  ensureRecapPlugin,
  ensureRecapSetup,
  hasRecapPlugin,
  RECAP_MARKETPLACE_ARGS,
  RECAP_PLUGIN_ARGS,
  summarizeRecapSetup,
  type CommandResult,
  type RecapEnvironment,
} from '../src/setup/recap.ts'
import type { Release } from '../src/setup/github-release.ts'

const HOME = '/Users/me'
const APP = `${HOME}/Applications/Recap.app`
const BINARY = `${APP}/Contents/MacOS/recap`
const RELEASE: Release = {
  tag_name: 'v0.2.0',
  name: 'recap 0.2.0',
  assets: [{ name: 'Recap-0.2.0-macos-arm64.zip', browser_download_url: 'https://example.test/zip', size: 1 }],
}

interface Fake extends RecapEnvironment {
  calls: string[][]
  files: Set<string>
  links: Map<string, string>
  versions: Map<string, string>
}

function fake(overrides: Partial<RecapEnvironment> = {}, responses: Record<string, CommandResult> = {}): Fake {
  const calls: string[][] = []
  const files = new Set<string>(['/opt/homebrew/bin'])
  const links = new Map<string, string>()
  const versions = new Map<string, string>()
  const env: Fake = {
    calls,
    files,
    links,
    versions,
    platform: 'darwin',
    arch: 'arm64',
    home: HOME,
    pathEntries: ['/usr/bin', '/opt/homebrew/bin'],
    interactive: true,
    localZip: null,
    exists: (path) => files.has(path),
    writable: () => true,
    linkTarget: (path) => links.get(path) ?? null,
    which: async (command) => (command === 'claude' ? '/bin/claude' : null),
    exec: async (command, args) => {
      calls.push([command, ...args])
      if (command === '/usr/bin/ditto' && args[0] === '-x') files.add(`${args[3]}/Recap.app`)
      if (command === '/usr/bin/ditto' && args[0] !== '-x') {
        files.add(BINARY)
        versions.set(APP, '0.2.0')
      }
      const key = [command, ...args].join(' ')
      return responses[key] ?? { ok: true, stdout: '[]', stderr: '' }
    },
    appVersion: async (path) => versions.get(path) ?? null,
    latestRelease: async () => RELEASE,
    download: async (_release, name, destination) => {
      calls.push(['download', name, destination])
    },
    tempDir: async () => '/tmp/work',
    remove: async (path) => {
      calls.push(['rm', path])
    },
    makeDir: async (path) => {
      files.add(path)
    },
    link: async (target, path) => {
      links.set(path, target)
    },
    progress: () => undefined,
    ...overrides,
  }
  return env
}

test('installs the latest release when Recap.app is missing', async () => {
  const env = fake()
  const step = await ensureRecapApp(env)
  assert.equal(step.state, 'installed')
  assert.match(step.detail, /Installed Recap 0\.2\.0/)
  assert.deepEqual(env.calls[0], ['download', 'Recap-0.2.0-macos-arm64.zip', '/tmp/work/Recap-0.2.0-macos-arm64.zip'])
  assert.deepEqual(env.calls[1], ['/usr/bin/ditto', '-x', '-k', '/tmp/work/Recap-0.2.0-macos-arm64.zip', '/tmp/work/unpacked'])
  assert.ok(env.calls.some((call) => call[0] === '/usr/bin/ditto' && call[2] === APP))
})

test('leaves an up to date app alone and updates an old one', async () => {
  const current = fake()
  current.versions.set(APP, '0.2.0')
  const same = await ensureRecapApp(current)
  assert.equal(same.state, 'present')
  assert.equal(current.calls.length, 0)

  const old = fake()
  old.versions.set(APP, '0.1.0')
  const updated = await ensureRecapApp(old)
  assert.equal(updated.state, 'installed')
  assert.match(updated.detail, /Updated Recap from 0\.1\.0 to 0\.2\.0/)
})

test('a local zip skips the release lookup', async () => {
  const env = fake({
    localZip: '/dist/Recap-0.1.0-macos-arm64.zip',
    latestRelease: async () => {
      throw new Error('should not be called')
    },
  })
  const step = await ensureRecapApp(env)
  assert.equal(step.state, 'installed')
  assert.deepEqual(env.calls[0], ['/usr/bin/ditto', '-x', '-k', '/dist/Recap-0.1.0-macos-arm64.zip', '/tmp/work/unpacked'])
})

test('an unreachable release keeps an installed app and fails a missing one', async () => {
  const offline = { latestRelease: async (): Promise<Release> => { throw new Error('offline') } }
  const installed = fake(offline)
  installed.versions.set(APP, '0.1.0')
  assert.equal((await ensureRecapApp(installed)).state, 'present')
  assert.equal((await ensureRecapApp(fake(offline))).state, 'failed')
})

test('only Apple Silicon Macs get recap, and nothing else runs elsewhere', async () => {
  const steps = await ensureRecap(fake({ platform: 'linux', arch: 'x64' }))
  assert.deepEqual(steps.map((step) => [step.name, step.state]), [['recap-app', 'unavailable']])
})

test('links recap into the first writable directory on PATH', () => {
  assert.equal(chooseLinkDirectory(fake()).directory, '/opt/homebrew/bin')
  const local = fake({ pathEntries: [`${HOME}/.local/bin`, '/opt/homebrew/bin'] })
  assert.deepEqual(chooseLinkDirectory(local), { directory: `${HOME}/.local/bin`, onPath: true })
  const nothing = fake({ pathEntries: ['/usr/bin'] })
  assert.deepEqual(chooseLinkDirectory(nothing), { directory: `${HOME}/.local/bin`, onPath: false })
  const readOnly = fake({ writable: () => false })
  assert.equal(chooseLinkDirectory(readOnly).onPath, false)
})

test('the cli link explains how to fix PATH when no directory is on it', async () => {
  const env = fake({ pathEntries: ['/usr/bin'] })
  env.files.add(BINARY)
  const step = await ensureRecapCli(env)
  assert.equal(step.state, 'unavailable')
  assert.match(step.detail, /export PATH=/)
  assert.equal(env.links.get(`${HOME}/.local/bin/recap`), BINARY)

  const onPath = fake()
  onPath.files.add(BINARY)
  assert.equal((await ensureRecapCli(onPath)).state, 'installed')
  assert.equal((await ensureRecapCli(onPath)).state, 'present')
})

test('the plugin is added through the marketplace only when missing', async () => {
  assert.equal(hasRecapPlugin('[{"id":"recap@recap"}]'), true)
  assert.equal(hasRecapPlugin('[{"id":"warp@claude-code-warp"}]'), false)
  assert.equal(hasRecapPlugin('nope'), false)

  const missing = fake()
  assert.equal((await ensureRecapPlugin(missing)).state, 'installed')
  assert.deepEqual(missing.calls.slice(-2), [['/bin/claude', ...RECAP_MARKETPLACE_ARGS], ['/bin/claude', ...RECAP_PLUGIN_ARGS]])

  const present = fake({}, { '/bin/claude plugin list --json': { ok: true, stdout: '[{"id":"recap@recap"}]', stderr: '' } })
  assert.equal((await ensureRecapPlugin(present)).state, 'present')
  assert.equal(present.calls.length, 1)

  const noClaude = await ensureRecapPlugin(fake({ which: async () => null }))
  assert.equal(noClaude.state, 'unavailable')
  assert.match(noClaude.detail, /claude plugin install recap@recap/)
})

test('recap setup installs dependencies and skips the permission dialogs without a terminal', async () => {
  const env = fake({ interactive: false }, {
    [`${BINARY} setup --install-deps --json --skip-permissions`]: {
      ok: true,
      stdout: JSON.stringify({ ok: true, data: [{ name: 'ffmpeg', ok: true, detail: '/opt/homebrew/bin/ffmpeg' }] }),
      stderr: '',
    },
  })
  env.files.add(BINARY)
  const step = await ensureRecapSetup(env)
  assert.equal(step.state, 'installed')
  assert.match(step.detail, /grant the microphone and screen permissions/)
})

test('the recap setup summary names what is still missing', () => {
  const failing = summarizeRecapSetup({
    ok: true,
    stdout: JSON.stringify({ ok: true, data: [{ name: 'model:whisper', ok: false, detail: 'missing' }, { name: 'app', ok: true, detail: '' }] }),
    stderr: '',
  })
  assert.equal(failing.state, 'failed')
  assert.match(failing.detail, /model:whisper \(missing\)/)

  const refused = summarizeRecapSetup({
    ok: false,
    stdout: JSON.stringify({ ok: false, error: { code: 'BREW_MISSING', message: 'Install Homebrew' } }),
    stderr: '',
  })
  assert.match(refused.detail, /Install Homebrew/)

  assert.equal(summarizeRecapSetup({ ok: false, stdout: '', stderr: 'boom' }).state, 'failed')
})
