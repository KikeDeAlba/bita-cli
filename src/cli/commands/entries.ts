import { UsageError, NotFoundError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { createLocalContext, withLocalContext, type LocalContext } from '../local-context.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { listDocsForEntry } from '../../db/docs.ts'
import { readEntryDoc } from '../../docs/record.ts'
import { collectEntries } from '../collect.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { formatDuration } from '../../domain/duration.ts'
import { collapseSegments } from '../logical-entry.ts'
import { summarizeNonJira } from '../../domain/no-jira.ts'

export interface EntryDetail {
  id: number
  description: string
  kind: string | null
  projectId: number | null
  projectName: string | null
  startedAt: string
  stoppedAt: string | null
  note: string | null
}

export async function readEntryDetail(ctx: LocalContext, id: number): Promise<EntryDetail> {
  const row = findEntryWithProject(ctx.db, id)
  if (!row) throw new NotFoundError(`No entry #${id}.`, 'ENTRY_NOT_FOUND', 'Run "bita entries" to see them.')
  const docs = listDocsForEntry(ctx.db, row.id)
  const primary = docs.find((doc) => doc.kind === 'note') ?? docs[0]
  const note = primary ? (await readEntryDoc(ctx, primary)).markdown : null
  return {
    id: row.id,
    description: row.description,
    kind: row.kind,
    projectId: row.projectId,
    projectName: row.projectName,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    note,
  }
}

async function runEntryGet(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const raw = args.positionals[0]
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0) throw new UsageError('Usage: bita entries get <id> [--json]')
  const ctx = createLocalContext(args)
  try {
    const detail = await readEntryDetail(ctx, id)
    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('entries get', detail))
      return 0
    }
    writeOut(`#${detail.id} ${detail.description || '(no description)'}`)
    writeOut(`Project : ${detail.projectName ?? '(no project)'}`)
    if (detail.kind) writeOut(`Kind    : ${detail.kind}`)
    writeOut(`Started : ${detail.startedAt}`)
    writeOut(`Stopped : ${detail.stoppedAt ?? '(running)'}`)
    if (detail.note !== null) {
      writeOut('')
      writeOut(detail.note)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export function runEntries(argv: string[]): number | Promise<number> {
  if (argv[0] === 'get') return runEntryGet(argv.slice(1))
  const args = parseCommandArgs(argv, {})

  return withLocalContext(args, (ctx) => {
    const result = collectEntries(ctx, args, {
      includeRunning: true,
      requireDescription: false,
      requireProject: false,
    })

    const selected = collapseSegments(result.selected)
    const totalSeconds = selected.reduce((sum, entry) => sum + entry.durationSeconds, 0)
    const jiraSeconds = selected.filter((entry) => entry.jira).reduce((sum, entry) => sum + entry.durationSeconds, 0)
    const nonJira = summarizeNonJira([...result.nonJira, ...selected.filter((entry) => !entry.jira)])

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope('entries', selected, {
          range: { fromDay: result.range.fromDay, toDay: result.range.toDay, timezone: ctx.timezone },
          filter: result.filter,
          entryCount: selected.length,
          totalSeconds,
          totalHuman: formatDuration(totalSeconds),
          jiraSeconds,
          nonJiraSeconds: nonJira.totalSeconds,
          nonJira,
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
          entry.registered ? (entry.issueKey ?? 'registered') : entry.jira ? 'pending' : 'no-jira',
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
    if (nonJira.entryCount > 0) writeOut(`Outside Jira: ${nonJira.totalHuman}, never uploaded.`)
    for (const warning of result.warnings) writeErr(`Warning: ${warning}`)
    return 0
  })
}
