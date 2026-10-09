import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { defaultMeetingExportEnvironment, exportMeeting, withWorkDir, type MeetingEntryInfo } from '../../export/meeting.ts'

const OPTIONS = {
  out: { type: 'string' as const },
}

const USAGE = `Usage:
  bita meeting export <entryId> [--out FILE.pdf] [--json]`

export async function runMeeting(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const [action, target] = args.positionals
  if (action !== 'export' || target === undefined || !/^\d+$/.test(target)) throw new UsageError(USAGE)
  const entryId = Number(target)

  const ctx = createLocalContext(args)
  let entry: MeetingEntryInfo | null = null
  let timezone: string
  try {
    timezone = ctx.timezone
    const row = findEntryWithProject(ctx.db, entryId)
    if (row !== undefined) entry = { description: row.description, projectName: row.projectName, clientName: row.clientName }
  } finally {
    ctx.db.close()
  }

  const result = await withWorkDir((workDir) =>
    exportMeeting({ entryId, out: readString(args, 'out'), timezone, entry, workDir }, defaultMeetingExportEnvironment(workDir)),
  )
  if (json) writeJson(successEnvelope('meeting export', result))
  else writeOut(`Exported the minutes of entry ${entryId} to ${result.path}`)
  return 0
}
