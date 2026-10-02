import { UsageError } from '../errors.ts'

const KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

export const CLEAR_KIND = 'none'

export function parseKind(raw: string, flag = '--kind'): string {
  const kind = raw.trim().toLowerCase()
  if (!KIND_PATTERN.test(kind) || kind === CLEAR_KIND) {
    throw new UsageError(
      `${flag} takes a lowercase word with dashes, such as remote-meeting; "${raw}" is not one.`,
    )
  }
  return kind
}

export function parseKindOrClear(raw: string, flag = '--kind'): string | null {
  return raw.trim().toLowerCase() === CLEAR_KIND ? null : parseKind(raw, flag)
}
