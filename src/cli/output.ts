import type { Envelope as KitEnvelope, EnvelopeError } from '@kikedealba/kit/envelope'
import { SCHEMA_VERSION } from '../config/constants.ts'

export type Envelope<T> = KitEnvelope<T>

export function successEnvelope<T>(
  command: string,
  data: T,
  meta?: Record<string, unknown>,
): Envelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    command,
    generatedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
    data,
  }
}

export function errorEnvelope(
  command: string,
  error: EnvelopeError,
  data?: unknown,
  meta?: Record<string, unknown>,
): Envelope<unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    command,
    generatedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
    ...(data !== undefined ? { data } : {}),
    error,
  }
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function writeOut(line: string): void {
  process.stdout.write(`${line}\n`)
}

export function writeErr(line: string): void {
  process.stderr.write(`${line}\n`)
}
