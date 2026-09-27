import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DRAWIO_CASK_ARGS,
  DRAWIO_MCP_ARGS,
  ensureDrawioApp,
  ensureDrawioMcp,
  hasDrawioMcp,
  type SetupEnvironment,
} from '../src/setup/drawio.ts'

function env(overrides: Partial<SetupEnvironment> & { files?: Record<string, string>; calls?: string[][] }): SetupEnvironment {
  const files = overrides.files ?? {}
  const calls = overrides.calls ?? []
  return {
    claudeJson: '/home/.claude.json',
    drawioApp: '/Applications/draw.io.app/Contents/MacOS/draw.io',
    exists: (path) => Object.hasOwn(files, path),
    which: async (command) => (command === 'claude' ? '/bin/claude' : null),
    run: async (command, args) => {
      calls.push([command, ...args])
    },
    ...overrides,
  }
}

test('the drawio server is found under the user mcpServers', () => {
  assert.equal(hasDrawioMcp('{"mcpServers":{"drawio":{"command":"npx"}}}'), true)
  assert.equal(hasDrawioMcp('{"mcpServers":{"playwright":{}}}'), false)
  assert.equal(hasDrawioMcp('not json'), false)
  assert.equal(hasDrawioMcp(null), false)
})

test('a missing mcp is added for every project', async () => {
  const calls: string[][] = []
  const present = await ensureDrawioMcp(env({ calls, files: {} }))
  assert.equal(present.state, 'installed')
  assert.deepEqual(calls, [['/bin/claude', ...DRAWIO_MCP_ARGS]])
  assert.ok(DRAWIO_MCP_ARGS.includes('--scope') && DRAWIO_MCP_ARGS.includes('user'))
})

test('without claude on PATH the mcp step explains the command instead', async () => {
  const step = await ensureDrawioMcp(env({ which: async () => null }))
  assert.equal(step.state, 'unavailable')
  assert.match(step.detail, /@drawio\/mcp/)
})

test('draw.io Desktop is installed with brew only when it is missing', async () => {
  const calls: string[][] = []
  const app = '/Applications/draw.io.app/Contents/MacOS/draw.io'
  const present = await ensureDrawioApp(env({ calls, files: { [app]: '' } }))
  assert.equal(present.state, 'present')
  assert.equal(calls.length, 0)

  const files: Record<string, string> = { '/opt/homebrew/bin/brew': '' }
  const installing = env({
    calls,
    files,
    run: async (command, args) => {
      calls.push([command, ...args])
      files[app] = ''
    },
  })
  const installed = await ensureDrawioApp(installing)
  assert.equal(installed.state, 'installed')
  assert.deepEqual(calls, [['/opt/homebrew/bin/brew', ...DRAWIO_CASK_ARGS]])
})

test('without brew the app step points at the download', async () => {
  const step = await ensureDrawioApp(env({}))
  assert.equal(step.state, 'unavailable')
  assert.match(step.detail, /drawio\.com/)
})

test('a failed install is reported, not thrown', async () => {
  const step = await ensureDrawioApp(
    env({
      files: { '/opt/homebrew/bin/brew': '' },
      run: async () => {
        throw new Error('Error: cask not found')
      },
    }),
  )
  assert.equal(step.state, 'failed')
  assert.match(step.detail, /cask not found/)
})
