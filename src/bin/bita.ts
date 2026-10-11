#!/usr/bin/env node
import { ConflictError, NotFoundError, UnknownCommandError, UsageError } from '../errors.ts'
import { EXIT_CONFLICT, EXIT_GENERIC, EXIT_USAGE } from '../cli/exit-codes.ts'
import { errorEnvelope, writeErr, writeJson } from '../cli/output.ts'

function exitCodeFor(error: unknown): number {
  if (error instanceof ConflictError) return EXIT_CONFLICT
  if (error instanceof UsageError || error instanceof NotFoundError || error instanceof UnknownCommandError) return EXIT_USAGE
  return EXIT_GENERIC
}

function codeFor(error: unknown): string {
  if (error instanceof UsageError) return 'USAGE_ERROR'
  const candidate = (error as { code?: unknown }).code
  return typeof candidate === 'string' ? candidate : 'UNEXPECTED_ERROR'
}

function hintFor(error: unknown): string | undefined {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof UnknownCommandError) return error.hint
  return undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'statusline') {
    process.exitCode = (await import('../cli/commands/statusline.ts')).runStatusline()
    return
  }
  const { route } = await import('../cli/router.ts')
  const wantsJson = argv.includes('--json')

  try {
    process.exitCode = await route(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = hintFor(error)

    if (wantsJson) {
      writeJson(errorEnvelope('error', { code: codeFor(error), message, ...(hint ? { hint } : {}) }))
    } else {
      writeErr(message)
      if (hint) writeErr(`\n${hint}`)
    }

    process.exitCode = exitCodeFor(error)
  }
}

await main()
