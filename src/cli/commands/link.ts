import { ConflictError, UsageError } from '../../errors.ts'
import { parseCommandArgs, readBoolean, readString } from '../args.ts'
import { withLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { inTransaction } from '../../db/open.ts'
import { findEntryById, findEntryWithProject, listSegments } from '../../db/entries.ts'
import { findLink, linkEntry, unlinkEntry } from '../../db/jira-links.ts'

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/

const OPTIONS = {
  issue: { type: 'string' as const },
  worklog: { type: 'string' as const, multiple: true },
  ids: { type: 'string' as const },
  unlink: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
}

function readIds(args: import('../args.ts').ParsedArgs, positionals: string[]): number[] {
  const fromFlag = (readString(args, 'ids') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  const raw = [...positionals, ...fromFlag]
  if (raw.length === 0) throw new UsageError('Usage: bita link <entryIds...> --issue <KEY>')

  return raw.map((value) => {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${value}" is not an entry id.`)
    return id
  })
}

export function runLink(argv: string[]): number {
  const args = parseCommandArgs(argv, OPTIONS)
  const json = readBoolean(args, 'json')
  const ids = readIds(args, args.positionals)
  const unlink = readBoolean(args, 'unlink')
  const issueKey = readString(args, 'issue')

  if (!unlink) {
    if (issueKey === undefined) {
      throw new UsageError('bita link needs --issue <KEY>, or --unlink to undo one.')
    }
    if (!ISSUE_KEY_PATTERN.test(issueKey)) {
      throw new UsageError(`Invalid Jira issue key: "${issueKey}". Expected something like DD-1896.`)
    }
  }

  return withLocalContext(args, (ctx) => {
    const missing = ids.filter((id) => findEntryById(ctx.db, id) === undefined)
    if (missing.length > 0) {
      throw new UsageError(`No entry with id ${missing.join(', ')}.`)
    }
    if (!unlink && !readBoolean(args, 'force')) {
      const outside = ids
        .map((id) => findEntryWithProject(ctx.db, id))
        .filter((entry) => entry !== undefined && !entry.projectJira)
      if (outside.length > 0) {
        throw new ConflictError(
          `Entries ${outside.map((entry) => `#${entry?.id}`).join(', ')} belong to ${outside[0]?.projectName ?? 'a project'}, which never goes to Jira.`,
          'NOT_A_JIRA_PROJECT',
          'bita project jira <project> on, or bita link ... --force',
        )
      }
    }
    for (const id of [...ids]) {
      for (const segment of listSegments(ctx.db, id)) {
        if (!ids.includes(segment.id)) ids.push(segment.id)
      }
    }

    const alreadyLinked = unlink
      ? []
      : ids.filter((id) => findLink(ctx.db, id) !== undefined)

    const linkedAt = new Date().toISOString()
    const changed: number[] = []

    inTransaction(ctx.db, () => {
      for (const id of ids) {
        if (unlink) {
          if (unlinkEntry(ctx.db, id)) changed.push(id)
          continue
        }
        linkEntry(ctx.db, { entryId: id, issueKey: issueKey ?? null, linkedAt })
        changed.push(id)
      }
    })

    const payload = {
      action: unlink ? 'unlink' : 'link',
      issueKey: unlink ? null : issueKey,
      entryIds: changed,
      relinked: alreadyLinked,
    }

    if (json) {
      writeJson(successEnvelope('link', payload))
      return 0
    }

    if (unlink) {
      writeOut(`Unlinked ${changed.length} entries.`)
    } else {
      writeOut(`Linked ${changed.length} entries to ${issueKey}.`)
      if (alreadyLinked.length > 0) {
        writeOut(`${alreadyLinked.length} of them were already linked and were overwritten.`)
      }
    }
    return 0
  })
}
