import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { DEN_RELEASES, MOVED_OUT } from '../../kit/manifest.ts'

export function runApp(argv: string[]): number {
  const args = parseCommandArgs(argv.slice(1), {}, BASE_OPTIONS)
  if (readBoolean(args, 'json')) writeJson(successEnvelope('app', { installed: false, url: DEN_RELEASES, message: MOVED_OUT.app }))
  else writeOut(MOVED_OUT.app)
  return 0
}
