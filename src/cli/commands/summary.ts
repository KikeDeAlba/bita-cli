import { parseCommandArgs, readBoolean, readInteger, readString } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { collectEntries } from '../collect.ts'
import { groupEntries } from '../../domain/group.ts'
import { formatDuration } from '../../domain/duration.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { MAX_TASK_SECONDS } from '../../config/constants.ts'
import { NOTES_PATH, readNotes } from '../../state/notes.ts'
import { countDocs, docsByEntry } from '../../db/docs.ts'
import { pagesForEntries, type SummaryPage } from '../../docs/page-read.ts'
import { loadSummaryDocs, parseNotesMode } from '../../docs/read.ts'
import { touchesByEntry } from '../../db/touches.ts'
import { jiraTarget, readConfig, storyThemes } from '../../state/config.ts'
import { partitionByJira, summarizeNonJira } from '../../domain/no-jira.ts'

export async function runSummary(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {
    'case-insensitive': { type: 'boolean', default: false },
    'max-task-hours': { type: 'string' },
    'estimate-step-minutes': { type: 'string' },
    'no-notes': { type: 'boolean', default: false },
    'notes-mode': { type: 'string' },
    'notes-budget-kb': { type: 'string' },
  })

  const ctx = createLocalContext(args)
  try {
    const config = await readConfig()

    const result = collectEntries(ctx, args, {
      includeRunning: readBoolean(args, 'include-running'),
      requireDescription: true,
      requireProject: false,
    })

    const maxTaskHours = readInteger(args, 'max-task-hours')
    const maxTaskSeconds = maxTaskHours === undefined ? MAX_TASK_SECONDS : maxTaskHours * 3600
    const estimateStepMinutes = readInteger(args, 'estimate-step-minutes')
    const estimateStep = estimateStepMinutes === undefined ? undefined : estimateStepMinutes * 60

    const groups = groupEntries(result.selected, {
      timezone: ctx.timezone,
      maxTaskSeconds,
      caseInsensitive: readBoolean(args, 'case-insensitive'),
      ...(estimateStep !== undefined ? { estimateStepSeconds: estimateStep } : {}),
    })

    const allEntryIds = groups.flatMap((group) => group.entryIds)
    const skipNotes = readBoolean(args, 'no-notes')
    const budgetKb = readInteger(args, 'notes-budget-kb')

    const docRows = skipNotes ? new Map() : docsByEntry(ctx.db, allEntryIds)
    const loaded = skipNotes
      ? { byEntry: new Map(), inlinedBytes: 0, truncatedEntryIds: [], missingFiles: [] }
      : await loadSummaryDocs(ctx.docsRoot, docRows, {
          mode: parseNotesMode(readString(args, 'notes-mode')),
          ...(budgetKb === undefined ? {} : { budgetBytes: budgetKb * 1024 }),
        })

    const touchedById = skipNotes
      ? new Map<number, string[]>()
      : touchesByEntry(ctx.db, allEntryIds)
    const missingNotes = allEntryIds.filter(
      (id) => !loaded.byEntry.has(id) && (touchedById.get(id)?.length ?? 0) === 0,
    )

    if (!skipNotes && countDocs(ctx.db) === 0 && (await readNotes()).length > 0) {
      result.warnings.push(
        `There are notes in ${NOTES_PATH} and no documents yet. Run "bita notes migrate".`,
      )
    }

    const pagesById = skipNotes ? new Map<number, SummaryPage[]>() : await pagesForEntries(ctx, allEntryIds)

    const withMapping = groups.map((group) => {
      const mapping =
        group.projectId === null ? undefined : config.projectMapping[String(group.projectId)]
      return {
        ...group,
        ...jiraTarget(mapping),
        jiraStoryIssueTypeName: mapping?.storyIssueTypeName ?? 'Historia',
        jiraWorkIssueTypeName: mapping?.workIssueTypeName ?? 'Subtarea',
        jiraIssueTypeName: mapping?.issueTypeName ?? config.defaults?.issueTypeName ?? null,
        docs: group.entryIds.flatMap((id) => loaded.byEntry.get(id) ?? []),
        pages: [
          ...new Map(
            group.entryIds
              .flatMap((id) => (pagesById.get(id) ?? []).map((page) => [page.pageId, page] as const)),
          ).values(),
        ],
        touchedFiles: [
          ...new Set(group.entryIds.flatMap((id) => touchedById.get(id) ?? [])),
        ],
        noteCoverage: {
          withNote: group.entryIds.filter((id) => loaded.byEntry.has(id) || pagesById.has(id)).length,
          withoutNote: group.entryIds.filter((id) => !loaded.byEntry.has(id) && !pagesById.has(id)).length,
        },
      }
    })

    const unmappedProjects = [
      ...new Map(
        withMapping
          .filter((group) => group.jira && group.projectId !== null && group.jiraProjectKey === null)
          .map((group) => [
            group.projectId,
            { projectId: group.projectId, projectName: group.projectName },
          ]),
      ).values(),
    ]

    const totalSeconds = groups.reduce((sum, group) => sum + group.totalSeconds, 0)
    const jiraSeconds = groups.filter((group) => group.jira).reduce((sum, group) => sum + group.totalSeconds, 0)
    const nonJira = summarizeNonJira([...result.nonJira, ...partitionByJira(result.selected).nonJira])
    const nonJiraSeconds = nonJira.totalSeconds
    const splitCount = groups.filter((group) => group.partCount > 1).length

    if (splitCount > 0) {
      result.warnings.push(
        `${splitCount} tasks were split to stay under the ${maxTaskSeconds / 3600}h per-task cap.`,
      )
    }

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope(
          'summary',
          {
            totalSeconds,
            totalHuman: formatDuration(totalSeconds),
            jiraSeconds,
            jiraHuman: formatDuration(jiraSeconds),
            nonJiraSeconds,
            nonJiraHuman: formatDuration(nonJiraSeconds),
            groups: withMapping,
          },
          {
            range: {
              fromDay: result.range.fromDay,
              toDay: result.range.toDay,
              timezone: ctx.timezone,
            },
            filter: result.filter,
            jira: config.jira ?? null,
            storyThemes: storyThemes(config),
            entryCount: result.selected.length,
            groupCount: groups.length,
            maxTaskSeconds,
            excluded: result.excluded,
            alreadyRegistered: result.alreadyRegistered,
            overlaps: result.overlaps,
            unmappedProjects,
            nonJira,
            notes: {
              root: ctx.docsRoot,
              matched: loaded.byEntry.size,
              missing: missingNotes,
              missingFiles: loaded.missingFiles,
              inlinedBytes: loaded.inlinedBytes,
              truncatedEntryIds: loaded.truncatedEntryIds,
              legacyPath: NOTES_PATH,
            },
            warnings: result.warnings,
          },
        ),
      )
      for (const warning of result.warnings) writeErr(`Warning: ${warning}`)
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'PROJECT' },
          { header: 'JIRA' },
          { header: 'PARENT' },
          { header: 'SUMMARY' },
          { header: 'DAYS' },
          { header: 'LOGS', align: 'right' },
          { header: 'TIME', align: 'right' },
          { header: 'EST', align: 'right' },
        ],
        withMapping.map((group) => [
          group.projectName ?? '(no project)',
          group.jira ? (group.jiraProjectKey ?? '?') : 'never',
          group.jiraParentKey ?? (group.epicMode === 'per-run' ? '(board)' : ''),
          group.summary,
          group.days.length === 1
            ? (group.days[0] ?? '')
            : `${group.days[0]} .. ${group.days.at(-1)}`,
          String(group.worklogs.length),
          group.totalHuman,
          group.estimateHuman,
        ]),
      ),
    )
    writeOut('')
    writeOut(
      `${groups.length} tasks, ${result.selected.length} entries, ${formatDuration(totalSeconds)} total.`,
    )

    if (nonJira.entryCount > 0) {
      writeOut('')
      writeOut(
        `Outside Jira: ${nonJira.totalHuman} (${nonJira.projects.map((project) => `${project.name ?? '(no project)'} ${project.totalHuman}`).join(', ')}), never uploaded.`,
      )
    }

    if (result.excluded.length > 0) {
      writeOut('')
      writeOut('Excluded:')
      const byReason = new Map<string, number>()
      for (const entry of result.excluded) {
        byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1)
      }
      for (const [reason, count] of byReason) writeOut(`  ${count} ${reason}`)
    }

    if (unmappedProjects.length > 0) {
      writeOut('')
      writeOut('Projects without a Jira project mapped:')
      for (const project of unmappedProjects) {
        writeOut(`  ${project.projectId}  ${project.projectName ?? '(unnamed)'}`)
      }
    }

    for (const warning of result.warnings) writeErr(`Warning: ${warning}`)
    return 0
  } finally {
    ctx.db.close()
  }
}
