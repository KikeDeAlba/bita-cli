import { HARNESS_IDS, type HarnessAdapter, type HarnessId } from './types.ts'

export function listAdapters(): readonly HarnessAdapter[] {
  return []
}

export function getAdapter(id: HarnessId): HarnessAdapter {
  throw new Error(`not implemented: ${id}`)
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
}

export function harnessBinEnvVar(id: HarnessId): string {
  return `BITA_HARNESS_BIN_${id.toUpperCase()}`
}
