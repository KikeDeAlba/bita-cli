import { parseArgs, type ParseArgsConfig } from 'node:util'
import { UsageError } from '../errors.ts'
import { RANGE_PRESETS, type DateRangeInput, type RangePreset } from '../domain/date-range.ts'
import type { RegistrationFilter } from '../domain/filter.ts'

type OptionConfig = NonNullable<ParseArgsConfig['options']>

export const BASE_OPTIONS: OptionConfig = {
  json: { type: 'boolean', default: false },
  workspace: { type: 'string' },
  timezone: { type: 'string' },
  'db-path': { type: 'string' },
  'docs-dir': { type: 'string' },
  'no-cache': { type: 'boolean', default: false },
  offline: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
}

export const RANGE_OPTIONS: OptionConfig = {
  from: { type: 'string' },
  to: { type: 'string' },
  'last-days': { type: 'string' },
}

export const FILTER_OPTIONS: OptionConfig = {
  pending: { type: 'boolean', default: false },
  registered: { type: 'boolean', default: false },
  'include-running': { type: 'boolean', default: false },
}

export const GLOBAL_OPTIONS: OptionConfig = {
  ...BASE_OPTIONS,
  ...RANGE_OPTIONS,
  ...FILTER_OPTIONS,
}

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>
  positionals: string[]
}

function nfc(value: string): string {
  return value.normalize('NFC')
}

function normalizeValues(values: ParsedArgs['values']): ParsedArgs['values'] {
  const normalized: ParsedArgs['values'] = {}
  for (const [key, value] of Object.entries(values)) {
    normalized[key] = typeof value === 'string' ? nfc(value) : Array.isArray(value) ? value.map(nfc) : value
  }
  return normalized
}

export function parseCommandArgs(
  argv: string[],
  options: OptionConfig,
  globals: OptionConfig = GLOBAL_OPTIONS,
): ParsedArgs {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...globals, ...options },
      allowPositionals: true,
      strict: true,
    })
    return { values: normalizeValues(parsed.values as ParsedArgs['values']), positionals: parsed.positionals.map(nfc) }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export function readString(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name]
  return typeof value === 'string' ? value : undefined
}

export function readBoolean(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true
}

export function readStringList(args: ParsedArgs, name: string): string[] {
  const value = args.values[name]
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  return []
}

export function readInteger(args: ParsedArgs, name: string): number | undefined {
  const raw = readString(args, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`Invalid value for --${name}: "${raw}". Expected an integer.`)
  }
  return parsed
}

export function readPreset(args: ParsedArgs): RangePreset | undefined {
  const first = args.positionals[0]
  if (!first) return undefined
  if (!RANGE_PRESETS.includes(first as RangePreset)) {
    throw new UsageError(
      `Unknown range preset "${first}". Valid presets: ${RANGE_PRESETS.join(', ')}.`,
    )
  }
  return first as RangePreset
}

export function readRangeInput(args: ParsedArgs): DateRangeInput {
  const preset = readPreset(args)
  const from = readString(args, 'from')
  const to = readString(args, 'to')
  const lastDays = readInteger(args, 'last-days')

  return {
    ...(preset !== undefined ? { preset } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(lastDays !== undefined ? { lastDays } : {}),
  }
}

export function hasExplicitRange(args: ParsedArgs): boolean {
  return (
    readPreset(args) !== undefined ||
    readString(args, 'from') !== undefined ||
    readString(args, 'to') !== undefined ||
    readInteger(args, 'last-days') !== undefined
  )
}

export function readRegistrationFilter(args: ParsedArgs): RegistrationFilter {
  const pending = readBoolean(args, 'pending')
  const registered = readBoolean(args, 'registered')

  if (pending && registered) {
    throw new UsageError('--pending and --registered contradict each other; pass only one.')
  }
  if (pending) return 'pending'
  if (registered) return 'registered'
  return 'any'
}
