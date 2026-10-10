import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../db/open.ts'
import { databasePath, docsRoot } from '../db/paths.ts'
import { resolveBeginningOfWeek, resolveTimezone } from '../db/settings.ts'
import { readString, type ParsedArgs } from './args.ts'

export interface LocalContext {
  db: DatabaseSync
  timezone: string
  beginningOfWeek: number
  now: Date
  databasePath: string
  docsRoot: string
}

export function createLocalContext(args: ParsedArgs): LocalContext {
  const path = readString(args, 'db-path') ?? databasePath()
  const db = openDatabase(path)
  return {
    db,
    timezone: resolveTimezone(db, readString(args, 'timezone')),
    beginningOfWeek: resolveBeginningOfWeek(db),
    now: new Date(),
    databasePath: path,
    docsRoot: readString(args, 'docs-dir') ?? docsRoot(process.env, path),
  }
}

export function withLocalContext<T>(args: ParsedArgs, run: (ctx: LocalContext) => T): T {
  const ctx = createLocalContext(args)
  try {
    return run(ctx)
  } finally {
    ctx.db.close()
  }
}
