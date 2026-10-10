import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseCommandArgs } from '../src/cli/args.ts'

const composed = 'Ejecución en laboratorio'
const decomposed = composed.normalize('NFD')

test('command arguments arrive composed', () => {
  const args = parseCommandArgs(['--section', decomposed, decomposed], { section: { type: 'string' } }, {})
  assert.equal(args.values.section, composed)
  assert.deepEqual(args.positionals, [composed])
})
