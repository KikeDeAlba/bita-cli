import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { delegationDisabled, inkwellMigration, loadKit, migratedHere, PROVIDER_CAPABILITIES, PROVIDER_HINTS, type MigrationStatus } from '../delegate.ts'

const TOOLS = [
  {
    name: 'atl',
    delegates: ['jira', 'confluence page', 'confluence attach', 'confluence login', 'confluence status', 'atlassian site'],
    capabilities: PROVIDER_CAPABILITIES.atl,
  },
  {
    name: 'inkwell',
    delegates: ['docs', 'backlog', 'meeting export', 'confluence sync', 'confluence conflict'],
    capabilities: PROVIDER_CAPABILITIES.inkwell,
  },
  { name: 'recap', delegates: [], capabilities: [] },
] as const satisfies ReadonlyArray<{ name: 'atl' | 'inkwell' | 'recap'; delegates: readonly string[]; capabilities: readonly string[] }>

export interface DoctorTool {
  name: string
  found: boolean
  version: string | null
  bin: string[] | null
  capabilities: string[]
  missingCapabilities: string[]
  delegates: string[]
  delegating: boolean
  migration?: MigrationStatus | null
  reason: string | null
  install: string
}

export interface DoctorReport {
  kit: boolean
  delegationDisabled: boolean
  tools: DoctorTool[]
}

export async function doctorReport(): Promise<DoctorReport> {
  const kit = await loadKit()
  const disabled = delegationDisabled()
  const tools: DoctorTool[] = []
  for (const spec of TOOLS) {
    const install = PROVIDER_HINTS[spec.name]
    const found = kit ? await kit.findTool(spec.name).catch(() => null) : null
    const capabilities = found?.manifest.capabilities ?? []
    const missingCapabilities = found ? spec.capabilities.filter((capability) => !capabilities.includes(capability)) : []
    const tool: DoctorTool = {
      name: spec.name,
      found: found !== null,
      version: found?.manifest.version ?? null,
      bin: found ? [...found.bin] : null,
      capabilities,
      missingCapabilities,
      delegates: [...spec.delegates],
      delegating: false,
      reason: null,
      install,
    }
    if (spec.name === 'inkwell' && found && kit) tool.migration = await inkwellMigration(kit, found)
    if (!kit) tool.reason = 'kit is not installed next to bita'
    else if (!found) tool.reason = 'not installed'
    else if (spec.delegates.length === 0) tool.reason = null
    else if (disabled) tool.reason = 'BITA_NO_DELEGATE is set'
    else if (spec.name === 'inkwell' && !(await migratedHere(tool.migration ?? null))) tool.reason = tool.migration?.migrated ? `inkwell migrated another bita database (${tool.migration.bitaDatabase ?? '?'})` : 'bita docs not migrated yet (inkwell migrate --from-bita)'
    else if (missingCapabilities.length > 0) tool.reason = `partial: missing ${missingCapabilities.join(', ')}; those commands stay in bita`
    else tool.delegating = true
    tools.push(tool)
  }
  return { kit: kit !== null, delegationDisabled: disabled, tools }
}

function describe(tool: DoctorTool): string {
  const head = tool.found ? `${tool.name} ${tool.version ?? '?'}` : `${tool.name}: not found`
  const lines = [head]
  if (tool.found && tool.bin) lines.push(`  bin: ${tool.bin.join(' ')}`)
  if (tool.delegates.length > 0) {
    lines.push(tool.delegating ? `  delegating: bita ${tool.delegates.join(', bita ')}` : `  delegating: no${tool.reason ? ` (${tool.reason})` : ''}`)
  }
  if (tool.missingCapabilities.length > 0) lines.push(`  missing capabilities: ${tool.missingCapabilities.join(', ')} (those commands stay in bita)`)
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
  if (!report.kit) writeOut('kit: not available; bita runs every command itself.')
  else if (report.delegationDisabled) writeOut('BITA_NO_DELEGATE is set; bita runs every command itself.')
  for (const tool of report.tools) writeOut(describe(tool))
  return 0
}
