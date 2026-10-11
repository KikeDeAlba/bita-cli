import { parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { collectEntries, type CollectContext } from '../collect.ts'
import { withLocalContext } from '../local-context.ts'
import { resolveProjectArg } from '../project-arg.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { formatDuration } from '../../domain/duration.ts'
import { startOfWeek } from '../../domain/date-range.ts'
import { overlappingKeys, type DayOverlap } from '../../domain/overlap.ts'
import { addDays } from '../../domain/timezone.ts'
import type { EnrichedTimeEntry } from '../../domain/types.ts'

export const NO_PROJECT_NAME = '(no project)'

export interface ProjectSeconds {
  projectId: number | null
  seconds: number
}

export interface ReportProject {
  projectId: number | null
  name: string
  clientName: string | null
  totalSeconds: number
  entryCount: number
}

export interface ReportDay {
  day: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportWeek {
  fromDay: string
  toDay: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportEntry {
  id: number
  title: string
  projectId: number | null
  start: string
  stop: string | null
  localDay: string
  seconds: number
  kind: string | null
  overlapping: boolean
  blockIds: number[]
}

export interface ReportData {
  range: { fromDay: string; toDay: string; timezone: string; weekStartsOn: number }
  totalSeconds: number
  entryCount: number
  activeDays: number
  projects: ReportProject[]
  days: ReportDay[]
  weeks: ReportWeek[]
  overlaps: DayOverlap[]
  entries?: ReportEntry[]
}

export interface ReportOptions {
  projectId?: number | undefined
  entries?: boolean | undefined
}

export interface ReportResult {
  data: ReportData
  warnings: string[]
}

function logicalId(block: EnrichedTimeEntry): number {
  return block.mergedInto ?? block.id
}

function entryDayKey(block: EnrichedTimeEntry): string {
  return `${logicalId(block)}|${block.localDay}`
}

function projectKey(projectId: number | null): string {
  return projectId === null ? 'none' : String(projectId)
}

function rangeDays(fromDay: string, toDay: string): string[] {
  const days: string[] = []
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.push(day)
  return days
}

class SecondsByProject {
  private readonly totals = new Map<string, ProjectSeconds>()
  total = 0

  add(projectId: number | null, seconds: number): void {
    const key = projectKey(projectId)
    const current = this.totals.get(key) ?? { projectId, seconds: 0 }
    current.seconds += seconds
    this.totals.set(key, current)
    this.total += seconds
  }

  list(): ProjectSeconds[] {
    return [...this.totals.values()]
      .filter((item) => item.seconds > 0)
      .sort((left, right) => right.seconds - left.seconds || (left.projectId ?? 0) - (right.projectId ?? 0))
  }
}

function buildEntries(blocks: EnrichedTimeEntry[], overlapping: Set<string>): ReportEntry[] {
  const groups = new Map<string, EnrichedTimeEntry[]>()
  for (const block of blocks) {
    const key = entryDayKey(block)
    const list = groups.get(key) ?? []
    list.push(block)
    groups.set(key, list)
  }

  const entries: ReportEntry[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.start.localeCompare(right.start) || left.id - right.id)
    const first = ordered[0]
    if (!first) continue
    const id = logicalId(first)
    const head = ordered.find((block) => block.id === id) ?? first
    const running = ordered.some((block) => block.stop === null)
    const stops = ordered.map((block) => block.stop).filter((stop): stop is string => stop !== null)
    entries.push({
      id,
      title: head.description,
      projectId: head.projectId,
      start: first.start,
      stop: running ? null : stops.reduce((latest, stop) => (stop > latest ? stop : latest), first.start),
      localDay: first.localDay,
      seconds: ordered.reduce((sum, block) => sum + block.durationSeconds, 0),
      kind: head.kind,
      overlapping: overlapping.has(entryDayKey(first)),
      blockIds: ordered.map((block) => block.id),
    })
  }
  return entries.sort((left, right) => left.start.localeCompare(right.start) || left.id - right.id)
}

export function buildReport(ctx: CollectContext, args: ParsedArgs, options: ReportOptions = {}): ReportResult {
  const collected = collectEntries(ctx, args)
  const blocks =
    options.projectId === undefined
      ? collected.selected
      : collected.selected.filter((block) => block.projectId === options.projectId)
  const { fromDay, toDay } = collected.range
  const weekStartsOn = ctx.beginningOfWeek

  const dayTotals = new Map<string, SecondsByProject>()
  const projectInfo = new Map<string, ReportProject>()
  const projectEntries = new Map<string, Set<number>>()
  const logicalIds = new Set<number>()

  for (const block of blocks) {
    const perDay = dayTotals.get(block.localDay) ?? new SecondsByProject()
    perDay.add(block.projectId, block.durationSeconds)
    dayTotals.set(block.localDay, perDay)

    const key = projectKey(block.projectId)
    const info = projectInfo.get(key) ?? {
      projectId: block.projectId,
      name: block.projectName ?? NO_PROJECT_NAME,
      clientName: block.clientName,
      totalSeconds: 0,
      entryCount: 0,
    }
    info.totalSeconds += block.durationSeconds
    projectInfo.set(key, info)

    const ids = projectEntries.get(key) ?? new Set<number>()
    ids.add(logicalId(block))
    projectEntries.set(key, ids)
    logicalIds.add(logicalId(block))
  }

  for (const [key, info] of projectInfo) info.entryCount = projectEntries.get(key)?.size ?? 0

  const days: ReportDay[] = []
  const weekTotals = new Map<string, { fromDay: string; toDay: string; totals: SecondsByProject }>()
  for (const day of rangeDays(fromDay, toDay)) {
    const perDay = dayTotals.get(day)
    const projects = perDay?.list() ?? []
    const totalSeconds = perDay?.total ?? 0
    days.push({ day, totalSeconds, projects })

    const weekKey = startOfWeek(day, weekStartsOn)
    const week = weekTotals.get(weekKey) ?? { fromDay: day, toDay: day, totals: new SecondsByProject() }
    week.toDay = day
    for (const item of projects) week.totals.add(item.projectId, item.seconds)
    weekTotals.set(weekKey, week)
  }

  const weeks: ReportWeek[] = [...weekTotals.values()].map((week) => ({
    fromDay: week.fromDay,
    toDay: week.toDay,
    totalSeconds: week.totals.total,
    projects: week.totals.list(),
  }))

  const projects = [...projectInfo.values()].sort(
    (left, right) => right.totalSeconds - left.totalSeconds || left.name.localeCompare(right.name),
  )
  const overlaps = collected.overlaps

  const data: ReportData = {
    range: { fromDay, toDay, timezone: ctx.timezone, weekStartsOn },
    totalSeconds: days.reduce((sum, day) => sum + day.totalSeconds, 0),
    entryCount: logicalIds.size,
    activeDays: days.filter((day) => day.totalSeconds > 0).length,
    projects,
    days,
    weeks,
    overlaps,
    ...(options.entries
      ? { entries: buildEntries(blocks, overlappingKeys(collected.selected, overlaps, ctx.now, entryDayKey)) }
      : {}),
  }
  return { data, warnings: collected.warnings }
}

function projectLabel(data: ReportData, projectId: number | null): string {
  return data.projects.find((project) => project.projectId === projectId)?.name ?? NO_PROJECT_NAME
}

function printReport(data: ReportData): void {
  writeOut(`${data.range.fromDay} → ${data.range.toDay} (${data.range.timezone})`)
  writeOut(
    `${formatDuration(data.totalSeconds)} in ${data.entryCount} entries over ${data.activeDays} of ${data.days.length} days.`,
  )
  if (data.projects.length === 0) return

  writeOut('')
  writeOut(
    renderTable(
      [{ header: 'PROJECT' }, { header: 'CLIENT' }, { header: 'ENTRIES', align: 'right' }, { header: 'TIME', align: 'right' }],
      data.projects.map((project) => [
        project.name,
        project.clientName ?? '',
        String(project.entryCount),
        formatDuration(project.totalSeconds),
      ]),
    ),
  )

  writeOut('')
  writeOut(
    renderTable(
      [{ header: 'DAY' }, { header: 'TIME', align: 'right' }, { header: 'PROJECTS' }],
      data.days.map((day) => [
        day.day,
        day.totalSeconds > 0 ? formatDuration(day.totalSeconds) : '-',
        day.projects.map((item) => `${projectLabel(data, item.projectId)} ${formatDuration(item.seconds)}`).join(', '),
      ]),
      96,
    ),
  )

  if (data.weeks.length > 1) {
    writeOut('')
    writeOut(
      renderTable(
        [{ header: 'WEEK' }, { header: 'TIME', align: 'right' }],
        data.weeks.map((week) => [`${week.fromDay} → ${week.toDay}`, formatDuration(week.totalSeconds)]),
      ),
    )
  }

  if (data.entries && data.entries.length > 0) {
    writeOut('')
    writeOut(
      renderTable(
        [
          { header: 'ID', align: 'right' },
          { header: 'DAY' },
          { header: 'PROJECT' },
          { header: 'DESCRIPTION' },
          { header: 'TIME', align: 'right' },
        ],
        data.entries.map((entry) => [
          String(entry.id),
          entry.localDay,
          projectLabel(data, entry.projectId),
          `${entry.title || '(no description)'}${entry.overlapping ? ' (overlapping)' : ''}`,
          `${formatDuration(entry.seconds)}${entry.stop === null ? ' (running)' : ''}`,
        ]),
      ),
    )
  }
}

export function runReport(argv: string[]): number {
  const args = parseCommandArgs(argv, {
    project: { type: 'string' },
    entries: { type: 'boolean', default: false },
  })

  return withLocalContext(args, (ctx) => {
    const rawProject = readString(args, 'project')
    const projectId = rawProject === undefined ? undefined : resolveProjectArg(ctx.db, rawProject).id
    const { data, warnings } = buildReport(ctx, args, { projectId, entries: readBoolean(args, 'entries') })

    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('report', data, { warnings }))
    } else {
      printReport(data)
    }
    for (const warning of warnings) writeErr(`Warning: ${warning}`)
    return 0
  })
}
