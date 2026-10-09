import type { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface NormalizedColumn {
  table: string
  column: string
  rows: number
}

export interface NormalizeReport {
  files: string[]
  columns: NormalizedColumn[]
}

const SKIPPED_COLUMN = /path|slug|checksum|sha/i

async function markdownFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
    }
  }
  await walk(root)
  return found.sort()
}

export async function normalizeDocFiles(root: string, dryRun: boolean): Promise<string[]> {
  const changed: string[] = []
  for (const file of await markdownFiles(root)) {
    const text = await readFile(file, 'utf8')
    const normalized = text.normalize('NFC')
    if (normalized === text) continue
    if (!dryRun) await writeFile(file, normalized, 'utf8')
    changed.push(relative(root, file))
  }
  return changed
}

function textColumns(db: DatabaseSync): { table: string; column: string }[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  const columns: { table: string; column: string }[] = []
  for (const { name } of tables) {
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]
    for (const column of info) {
      if (column.type.toUpperCase() !== 'TEXT' || SKIPPED_COLUMN.test(column.name)) continue
      columns.push({ table: name, column: column.name })
    }
  }
  return columns
}

export function normalizeDatabaseText(db: DatabaseSync, dryRun: boolean): NormalizedColumn[] {
  const report: NormalizedColumn[] = []
  for (const { table, column } of textColumns(db)) {
    const rows = db
      .prepare(`SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`)
      .all() as { id: number; value: unknown }[]
    const stale = rows.filter(
      (row): row is { id: number; value: string } => typeof row.value === 'string' && row.value !== row.value.normalize('NFC'),
    )
    if (stale.length === 0) continue
    if (!dryRun) {
      const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`)
      for (const row of stale) update.run(row.value.normalize('NFC'), row.id)
    }
    report.push({ table, column, rows: stale.length })
  }
  return report
}
