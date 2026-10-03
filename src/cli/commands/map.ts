import { UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { findProjectById } from '../../db/projects.ts'
import {
  epicMode,
  NO_EPIC,
  readConfig,
  setProjectMapping,
  setStory,
  unsetProjectMapping,
  type ProjectMapping,
} from '../../state/config.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/
const PARENT_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/

function readIssueKeyOnBoard(raw: string, jiraProjectKey: string, label: string): string {
  const issueKey = raw.toUpperCase()
  if (!PARENT_KEY_PATTERN.test(issueKey)) {
    throw new UsageError(`Invalid ${label} key: "${raw}". Expected something like ${jiraProjectKey}-1213.`)
  }
  const issueProject = issueKey.slice(0, issueKey.lastIndexOf('-'))
  if (issueProject !== jiraProjectKey) {
    throw new UsageError(
      `${label[0]?.toUpperCase()}${label.slice(1)} ${issueKey} belongs to project ${issueProject}, not ${jiraProjectKey}. An issue cannot sit under a parent from another project.`,
    )
  }
  return issueKey
}

function parentColumn(mapping: ProjectMapping): string {
  if (mapping.parentKey) return mapping.parentKey
  return epicMode(mapping) === 'per-run' ? '(board)' : ''
}

export async function runMap(argv: string[]): Promise<number> {
  const subcommand = argv[0] ?? 'list'
  const args = parseCommandArgs(argv.slice(1), {
    'issue-type': { type: 'string' },
    summary: { type: 'string' },
    epic: { type: 'string' },
    parent: { type: 'string' },
    'no-epic': { type: 'boolean', default: false },
    hierarchy: { type: 'string' },
  })

  if (subcommand === 'list') {
    const config = await readConfig()
    const rows = Object.entries(config.projectMapping).map(([id, mapping]) => ({
      projectId: Number(id),
      ...mapping,
      epicMode: epicMode(mapping),
    }))

    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('map list', rows, { jira: config.jira ?? null }))
      return 0
    }

    if (rows.length === 0) {
      writeOut('No Toggl project is mapped to a Jira project yet.')
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'TOGGL ID' },
          { header: 'TOGGL PROJECT' },
          { header: 'JIRA' },
          { header: 'PARENT' },
          { header: 'ISSUE TYPE' },
          { header: 'DONE TRANSITION' },
        ],
        rows.map((row) => [
          String(row.projectId),
          row.projectName,
          row.jiraProjectKey,
          parentColumn(row),
          row.issueTypeName ?? '',
          row.doneTransition?.name ?? '',
        ]),
      ),
    )
    return 0
  }

  if (subcommand === 'set') {
    const [rawProjectId, rawJiraKey] = args.positionals
    if (!rawProjectId || !rawJiraKey) {
      throw new UsageError('Usage: bita map set <projectId> <JIRAKEY> [--issue-type "Tarea"]')
    }

    const projectId = Number(rawProjectId)
    if (!Number.isInteger(projectId)) {
      throw new UsageError(`Invalid Toggl project id: "${rawProjectId}".`)
    }

    const jiraProjectKey = rawJiraKey.toUpperCase()
    if (!JIRA_KEY_PATTERN.test(jiraProjectKey)) {
      throw new UsageError(`Invalid Jira project key: "${rawJiraKey}". Expected something like DPF.`)
    }

    const ctx = createLocalContext(args)
    const project = findProjectById(ctx.db, projectId)
    ctx.db.close()
    if (!project) {
      throw new UsageError(
        `No project with id ${projectId}. Run "bita projects" to list them.`,
      )
    }
    if (!project.jira) {
      throw new UsageError(
        `"${project.name}" never goes to Jira. Turn it on first with: bita project jira ${projectId} on`,
      )
    }

    const issueTypeName = readString(args, 'issue-type')
    const rawParent = readString(args, 'parent') ?? readString(args, 'epic')
    const parentKey =
      rawParent === undefined ? undefined : readIssueKeyOnBoard(rawParent, jiraProjectKey, 'parent')

    const noEpic = readBoolean(args, 'no-epic')
    if (noEpic && parentKey !== undefined) {
      throw new UsageError('Use either --parent or --no-epic, not both.')
    }
    const rawHierarchy = readString(args, 'hierarchy')
    if (
      rawHierarchy !== undefined &&
      rawHierarchy !== 'epic-story-subtask' &&
      rawHierarchy !== 'story-subtask' &&
      rawHierarchy !== 'flat-task'
    ) {
      throw new UsageError(
        `Invalid --hierarchy: "${rawHierarchy}". Use epic-story-subtask, story-subtask or flat-task.`,
      )
    }
    const hierarchy =
      rawHierarchy ?? (parentKey !== undefined ? 'epic-story-subtask' : noEpic ? 'story-subtask' : undefined)

    await setProjectMapping(projectId, {
      projectName: project.name,
      jiraProjectKey,
      ...(parentKey !== undefined ? { parentKey } : noEpic ? { parentKey: null } : {}),
      ...(hierarchy !== undefined ? { hierarchy } : {}),
      ...(parentKey !== undefined || noEpic ? { epicResolved: true } : {}),
      ...(issueTypeName !== undefined ? { issueTypeName } : {}),
      verifiedAt: new Date().toISOString(),
    })

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope('map set', {
          projectId,
          projectName: project.name,
          jiraProjectKey,
          parentKey: parentKey ?? null,
        }),
      )
    } else {
      const under = parentKey ? ` under ${parentKey}` : noEpic ? ', choosing the epic on every run' : ''
      writeOut(`Mapped "${project.name}" (${projectId}) to Jira project ${jiraProjectKey}${under}.`)
    }
    return 0
  }

  if (subcommand === 'unset') {
    const [rawProjectId] = args.positionals
    if (!rawProjectId) throw new UsageError('Usage: bita map unset <projectId>')

    const projectId = Number(rawProjectId)
    if (!Number.isInteger(projectId)) {
      throw new UsageError(`Invalid Toggl project id: "${rawProjectId}".`)
    }

    const removed = await unsetProjectMapping(projectId)
    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('map unset', { projectId, removed }))
    } else {
      writeOut(removed ? `Removed the mapping for ${projectId}.` : `No mapping existed for ${projectId}.`)
    }
    return 0
  }

  if (subcommand === 'story') {
    const [rawProjectId, themeId, rawIssueKey] = args.positionals
    if (!rawProjectId || !themeId || !rawIssueKey) {
      throw new UsageError(
        'Usage: bita map story <projectId> <themeId> <ISSUE-KEY> [--epic <KEY-123> | --no-epic]',
      )
    }

    const projectId = Number(rawProjectId)
    if (!Number.isInteger(projectId)) {
      throw new UsageError(`Invalid Toggl project id: "${rawProjectId}".`)
    }

    const mapping = (await readConfig()).projectMapping[String(projectId)]
    if (!mapping) {
      throw new UsageError(
        `Project ${projectId} is not mapped to a Jira project. Run "bita map set ${projectId} <JIRAKEY>" first.`,
      )
    }

    const issueKey = readIssueKeyOnBoard(rawIssueKey, mapping.jiraProjectKey, 'story')
    const rawEpic = readString(args, 'epic')
    const noEpic = readBoolean(args, 'no-epic')
    if (rawEpic !== undefined && noEpic) {
      throw new UsageError('Use either --epic or --no-epic, not both.')
    }

    let epicKey: string
    if (rawEpic !== undefined) {
      epicKey = readIssueKeyOnBoard(rawEpic, mapping.jiraProjectKey, 'epic')
    } else if (noEpic) {
      epicKey = NO_EPIC
    } else if (epicMode(mapping) === 'per-run') {
      throw new UsageError(
        `Project ${projectId} picks its epic on every run. Say which one the story sits under: bita map story ${projectId} ${themeId} ${issueKey} --epic <${mapping.jiraProjectKey}-123> (or --no-epic for a story without one).`,
      )
    } else {
      epicKey = mapping.parentKey ?? NO_EPIC
    }

    await setStory(
      projectId,
      themeId,
      {
        key: issueKey,
        summary: readString(args, 'summary') ?? themeId,
        verifiedAt: new Date().toISOString(),
      },
      epicKey,
    )

    if (readBoolean(args, 'json')) {
      writeJson(
        successEnvelope('map story', { projectId, themeId, issueKey, epicKey: epicKey || null }),
      )
    } else {
      const under = epicKey ? ` under ${epicKey}` : ' without an epic'
      writeOut(`Theme "${themeId}" of project ${projectId} now points at ${issueKey}${under}.`)
    }
    return 0
  }

  throw new UsageError(`Unknown map subcommand "${subcommand}". Use list, set, unset or story.`)
}
