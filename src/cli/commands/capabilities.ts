import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { capabilities } from '../../kit/manifest.ts'

export function runCapabilities(argv: string[]): number {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const data = capabilities()
  if (readBoolean(args, 'json')) {
    writeJson(successEnvelope('capabilities', data))
    return 0
  }
  writeOut(`${data.name} ${data.version} (envelope ${data.envelope})`)
  writeOut(`Capabilities: ${data.capabilities.join(', ')}`)
  writeOut(`Emits: ${data.emits.join(', ')}`)
  return 0
}
