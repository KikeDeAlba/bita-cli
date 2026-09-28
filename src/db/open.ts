import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LATEST_VERSION, MIGRATIONS } from './schema.ts'
import { MEMORY_DB_PATH, databasePath } from './paths.ts'

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

export function migrate(db: DatabaseSync): number {
  let current = readSchemaVersion(db)
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      for (const statement of migration.statements) db.exec(statement)
      migration.run?.(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    current = migration.version
  }
  return current
}

export function openDatabase(path: string = databasePath()): DatabaseSync {
  if (path !== MEMORY_DB_PATH) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (path !== MEMORY_DB_PATH) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  const found = readSchemaVersion(db)
  if (found > LATEST_VERSION) {
    db.close()
    throw new Error(
      `the database at ${path} was written by a newer version (schema ${found}, this build understands ${LATEST_VERSION})`,
    )
  }
  migrate(db)
  return db
}

export function openMemoryDatabase(): DatabaseSync {
  return openDatabase(MEMORY_DB_PATH)
}

export function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
