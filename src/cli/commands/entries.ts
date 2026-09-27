import { parseCommandArgs, readBoolean } from '../args.ts'
import { withLocalContext } from '../local-context.ts'
import { collectEntries } from '../collect.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { formatDuration } from '../../domain/duration.ts'
import { collapseSegments } from '../logical-entry.ts'

export function runEntries(argv: string[]): number {
  const args = parseCommandArgs(argv, {})

  return withLocalContext(args, (ctx) => {
    const result = collectEntries(ctx, args, {
      includeRunning: true,
      requireDescription: false,
      requireProject: false,
    })

    const selected = collapseSegments(result.selected)
    const totalSeconds = selected.reduce((sum, entry) => sum + entry.durationSeconds, 0)

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope('entries', selected, {
          range: { fromDay: result.range.fromDay, toDay: result.range.toDay, timezone: ctx.timezone },
          filter: result.filter,
          entryCount: selected.length,
          totalSeconds,
          totalHuman: formatDuration(totalSeconds),
          excluded: result.excluded,
          alreadyRegistered: result.alreadyRegistered,
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
          { header: 'STATE' },
          { header: 'TIME', align: 'right' },
        ],
        selected.map((entry) => [
          String(entry.id),
          entry.localDay,
          entry.startLocal.slice(11, 16),
          entry.projectName ?? '(no project)',
          entry.description || '(no description)',
          entry.registered ? (entry.issueKey ?? 'registered') : 'pending',
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
