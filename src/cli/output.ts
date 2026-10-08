import { SCHEMA_VERSION } from '../config/constants.ts'

export interface Envelope<T> {
  schemaVersion: number
  ok: boolean
  command: string
  generatedAt: string
  meta?: Record<string, unknown>
  data?: T
  error?: { code: string; message: string; hint?: string; status?: number; paths?: string[] }
}

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
  error: { code: string; message: string; hint?: string; status?: number; paths?: string[] },
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
