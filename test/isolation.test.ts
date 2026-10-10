import './helpers/isolate.ts'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

test('tests never reach the real kit registry', () => {
  const registry = process.env['KIT_REGISTRY_DIR']
  assert.ok(registry, 'KIT_REGISTRY_DIR must be set for tests')
  assert.ok(realpathSync(registry).startsWith(realpathSync(tmpdir())), `KIT_REGISTRY_DIR must live under the temp dir, got ${registry}`)
})
