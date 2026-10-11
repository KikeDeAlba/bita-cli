import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { databasePath } from '../../db/paths.ts'
import { formatDuration } from '../../domain/duration.ts'

interface RunningRow {
  id: number
  description: string
  started_at: string
  project_name: string | null
}

const TITLE_LIMIT = 40

function shorten(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length === 0) return '(sin título)'
  return clean.length > TITLE_LIMIT ? `${clean.slice(0, TITLE_LIMIT - 1)}…` : clean
}

export function readRunning(path: string): RunningRow[] {
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 200')
    return db
      .prepare(
        `SELECT e.id AS id, e.description AS description, e.started_at AS started_at, p.name AS project_name
         FROM entries e LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.stopped_at IS NULL ORDER BY e.started_at`,
      )
      .all() as unknown as RunningRow[]
  } finally {
    db.close()
  }
}

export function statusLine(rows: readonly RunningRow[], now: Date): string {
  return rows
    .map((row) => {
      const elapsed = formatDuration(Math.max(0, Math.round((now.getTime() - Date.parse(row.started_at)) / 1000)))
      return [`#${row.id} ${shorten(row.description)}`, ...(row.project_name ? [row.project_name] : []), elapsed].join(' · ')
    })
    .join('  |  ')
}

export function runStatusline(): number {
  try {
    const line = statusLine(readRunning(databasePath()), new Date())
    if (line.length > 0) process.stdout.write(`${line}\n`)
  } catch {
    return 0
  }
  return 0
}
