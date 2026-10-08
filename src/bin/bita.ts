#!/usr/bin/env node
import { route } from '../cli/router.ts'
import { ConflictError, MergeConflictError, NotFoundError, UsageError } from '../errors.ts'
import { EXIT_CONFLICT, EXIT_GENERIC, EXIT_USAGE } from '../cli/exit-codes.ts'
import { errorEnvelope, writeErr, writeJson } from '../cli/output.ts'

function exitCodeFor(error: unknown): number {
  if (error instanceof ConflictError) return EXIT_CONFLICT
  if (error instanceof UsageError || error instanceof NotFoundError) return EXIT_USAGE
  return EXIT_GENERIC
}

function codeFor(error: unknown): string {
  if (error instanceof UsageError) return 'USAGE_ERROR'
  const candidate = (error as { code?: unknown }).code
  return typeof candidate === 'string' ? candidate : 'UNEXPECTED_ERROR'
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const wantsJson = argv.includes('--json')

  try {
    process.exitCode = await route(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = error instanceof ConflictError || error instanceof NotFoundError ? error.hint : undefined

    if (wantsJson) {
      writeJson(
        errorEnvelope('error', {
          code: codeFor(error),
          message,
          ...(hint ? { hint } : {}),
          ...(error instanceof MergeConflictError ? { paths: error.paths } : {}),
        }),
      )
    } else {
      writeErr(message)
      if (error instanceof MergeConflictError) for (const path of error.paths) writeErr(`  conflict: ${path}`)
      if (hint) writeErr(`\n${hint}`)
    }

    process.exitCode = exitCodeFor(error)
  }
}

await main()
