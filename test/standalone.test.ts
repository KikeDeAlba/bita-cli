import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const repo = join(import.meta.dirname, '..')

test('the core commands run from the sources without installed dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'bita-standalone-'))
  try {
    cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(repo, 'package.json'), join(root, 'package.json'))
    const env = {
      ...process.env,
      BITA_DB_PATH: join(root, 'bita.db'),
      BITA_DOCS_DIR: join(root, 'docs'),
      BITA_CONFIG_PATH: join(root, 'config.json'),
    }
    for (const args of [['--version'], ['projects', '--json'], ['docs', 'tree', '--pages', '--json'], ['backlog', 'ls', '--json']]) {
      const run = spawnSync(process.execPath, [join(root, 'src/bin/bita.ts'), ...args], { cwd: root, env, encoding: 'utf8' })
      assert.equal(run.status, 0, `bita ${args.join(' ')} failed: ${run.stderr}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
