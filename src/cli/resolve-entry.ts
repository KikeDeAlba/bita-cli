import { ConflictError, UsageError } from '../errors.ts'
import type { EntryRow } from '../db/rows.ts'
import { listRunningDrafts } from '../db/entries.ts'
import { readBoolean, type ParsedArgs } from './args.ts'
import type { LocalContext } from './local-context.ts'

export function resolveEntryId(ctx: LocalContext, args: ParsedArgs, usage: string): number {
  if (readBoolean(args, 'draft')) {
    const drafts = listRunningDrafts(ctx.db)
    const only = drafts[0]
    if (!only) throw new UsageError('No running draft. Start one with "bita start".')
    if (drafts.length > 1) {
      const ids = drafts.map((entry) => `#${entry.id}`).join(', ')
      throw new UsageError(`${drafts.length} running drafts (${ids}); name the one you mean.`)
    }
    return only.id
  }

  const [raw] = args.positionals
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(usage)
  return id
}

export function assertNotSegment(entry: EntryRow): void {
  if (entry.mergedInto === null) return
  throw new ConflictError(
    `#${entry.id} is a block of the merged entry #${entry.mergedInto}.`,
    'ENTRY_MERGED',
    `Use #${entry.mergedInto}; the merged entry speaks for all its blocks.`,
  )
}
