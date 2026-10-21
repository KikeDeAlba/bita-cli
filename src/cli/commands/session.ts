import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { finalizeEntry } from '../../domain/finalize.ts'

export async function runSessionFinalize(argv: string[]): Promise<number> {
  const rest = argv[0] === 'finalize' ? argv.slice(1) : argv
  const args = parseCommandArgs(rest, {}, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const [raw] = args.positionals
  const entryId = Number(raw)
  if (raw === undefined || !Number.isInteger(entryId) || entryId <= 0) {
    throw new UsageError('Usage: bita session finalize <entryId> [--json]')
  }

  const ctx = createLocalContext(args)
  try {
    const result = await finalizeEntry(ctx, entryId)
    if (json) writeJson(successEnvelope('session finalize', result))
    else {
      const title = result.title ? `: ${result.title}` : ''
      writeOut(`#${entryId} ${result.status}${title}${result.error ? ` (${result.error})` : ''}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}
