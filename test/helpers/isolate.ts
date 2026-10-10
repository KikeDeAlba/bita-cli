import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['KIT_REGISTRY_DIR'] ??= mkdtempSync(join(tmpdir(), 'bita-test-registry-'))
