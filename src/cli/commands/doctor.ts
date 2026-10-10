import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { SIBLING_INSTALLS } from '../../kit/manifest.ts'

type KitRegistry = typeof import('@kikedealba/kit/registry')

const SIBLINGS = [
  { name: 'inkwell', role: 'documents the work: entry notes, pages, backlog, diagrams' },
  { name: 'tally', role: 'groups the time and sends it to Jira' },
  { name: 'atl', role: 'Jira and Confluence' },
  { name: 'recap', role: 'records meetings' },
] as const satisfies ReadonlyArray<{ name: keyof typeof SIBLING_INSTALLS; role: string }>

export interface DoctorTool {
  name: string
  role: string
  found: boolean
  version: string | null
  bin: string[] | null
  capabilities: string[]
  install: string
}

export interface DoctorReport {
  kit: boolean
  tools: DoctorTool[]
}

async function loadKit(): Promise<KitRegistry | null> {
  try {
    return await import('@kikedealba/kit/registry')
  } catch {
    return null
  }
}

export async function doctorReport(kit: KitRegistry | null = null): Promise<DoctorReport> {
  const registry = kit ?? (await loadKit())
  const tools: DoctorTool[] = []
  for (const spec of SIBLINGS) {
    const found = registry ? await registry.findTool(spec.name).catch(() => null) : null
    tools.push({
      name: spec.name,
      role: spec.role,
      found: found !== null,
      version: found?.manifest.version ?? null,
      bin: found ? [...found.bin] : null,
      capabilities: found ? [...found.manifest.capabilities] : [],
      install: SIBLING_INSTALLS[spec.name],
    })
  }
  return { kit: registry !== null, tools }
}

function describe(tool: DoctorTool): string {
  const head = tool.found ? `${tool.name} ${tool.version ?? '?'}: ${tool.role}` : `${tool.name}: not found (${tool.role})`
  const lines = [head]
  if (tool.found && tool.bin) lines.push(`  bin: ${tool.bin.join(' ')}`)
  if (!tool.found) lines.push(`  install: ${tool.install}`)
  return lines.join('\n')
}

export async function runDoctor(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const report = await doctorReport()
  if (readBoolean(args, 'json')) {
    writeJson(successEnvelope('doctor', report))
    return 0
  }
  if (!report.kit) writeOut('kit: not available next to bita; sibling tools cannot be found.')
  writeOut('bita only keeps the time. Sibling tools:')
  for (const tool of report.tools) writeOut(describe(tool))
  return 0
}
