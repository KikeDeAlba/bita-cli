import { UsageError, NotFoundError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { withLocalContext, type LocalContext } from '../local-context.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { collectEntries } from '../collect.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { formatDuration } from '../../domain/duration.ts'
import { collapseSegments, enrichLogical, type LogicalEntry } from '../logical-entry.ts'

export interface EntryDetail {
  id: number
  description: string
  kind: string | null
  projectId: number | null
  projectName: string | null
  startedAt: string
  stoppedAt: string | null
  durationSeconds: number
  mergedInto: number | null
  segments: LogicalEntry['segments']
}

export function readEntryDetail(ctx: LocalContext, id: number): EntryDetail {
  const row = findEntryWithProject(ctx.db, id)
  if (!row) throw new NotFoundError(`No entry #${id}.`, 'ENTRY_NOT_FOUND', 'Run "bita entries" to see them.')
  const logical = enrichLogical(ctx.db, row, ctx.timezone, ctx.now)
  return {
    id: row.id,
    description: row.description,
    kind: row.kind,
    projectId: row.projectId,
    projectName: row.projectName,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    durationSeconds: logical.durationSeconds,
    mergedInto: row.mergedInto,
    segments: logical.segments,
  }
}

function runEntryGet(argv: string[]): number {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const raw = args.positionals[0]
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0 || args.positionals.length > 1) {
    throw new UsageError('Usage: bita entries get <id> [--json]')
  }
  return withLocalContext(args, (ctx) => {
    const detail = readEntryDetail(ctx, id)
    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('entries get', detail))
      return 0
    }
    writeOut(`#${detail.id} ${detail.description || '(no description)'}`)
    writeOut(`Project : ${detail.projectName ?? '(no project)'}`)
    if (detail.kind) writeOut(`Kind    : ${detail.kind}`)
    writeOut(`Started : ${detail.startedAt}`)
    writeOut(`Stopped : ${detail.stoppedAt ?? '(running)'}`)
    writeOut(`Time    : ${formatDuration(detail.durationSeconds)}${detail.segments.length > 0 ? ` in ${detail.segments.length} blocks` : ''}`)
    if (detail.mergedInto !== null) writeOut(`Part of : #${detail.mergedInto}`)
    return 0
  })
}

export function runEntries(argv: string[]): number {
  if (argv[0] === 'get') return runEntryGet(argv.slice(1))
  const args = parseCommandArgs(argv, {})

  return withLocalContext(args, (ctx) => {
    const result = collectEntries(ctx, args)
    const selected = collapseSegments(result.selected)
    const totalSeconds = selected.reduce((sum, entry) => sum + entry.durationSeconds, 0)

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope('entries', selected, {
          range: { fromDay: result.range.fromDay, toDay: result.range.toDay, timezone: ctx.timezone },
          entryCount: selected.length,
          totalSeconds,
          totalHuman: formatDuration(totalSeconds),
          overlaps: result.overlaps,
          warnings: result.warnings,
        }),
      )
      for (const warning of result.warnings) writeErr(`Warning: ${warning}`)
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'ID', align: 'right' },
          { header: 'DAY' },
          { header: 'START' },
          { header: 'PROJECT' },
          { header: 'DESCRIPTION' },
          { header: 'TIME', align: 'right' },
        ],
        selected.map((entry) => [
          String(entry.id),
          entry.localDay,
          entry.startLocal.slice(11, 16),
          entry.projectName ?? '(no project)',
          entry.description || '(no description)',
          entry.running
            ? `${entry.durationHuman} (running)`
            : entry.segments.length > 0
              ? `${entry.durationHuman} (${entry.segments.length} blocks)`
              : entry.durationHuman,
        ]),
      ),
    )
    writeOut('')
    writeOut(`${selected.length} entries, ${formatDuration(totalSeconds)} total.`)
    for (const warning of result.warnings) writeErr(`Warning: ${warning}`)
    return 0
  })
}
