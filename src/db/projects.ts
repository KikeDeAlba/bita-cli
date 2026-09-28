import type { DatabaseSync } from 'node:sqlite'
import type { ProjectRow } from './rows.ts'
import { fromBoolean, toBoolean } from './rows.ts'
import { LOCAL_PROJECT_ID_CEILING } from './schema.ts'
import { queryAll, queryOne } from './query.ts'
import { ensureProjectKey } from './project-keys.ts'

interface RawProject {
  id: number
  name: string
  key: string | null
  client_name: string | null
  active: number
  external_id: number | null
  created_at: string
}

function toProject(raw: RawProject): ProjectRow {
  return {
    id: raw.id,
    name: raw.name,
    key: raw.key,
    clientName: raw.client_name,
    active: toBoolean(raw.active),
    externalId: raw.external_id,
    createdAt: raw.created_at,
  }
}

export function nextLocalProjectId(db: DatabaseSync): number {
  const row = queryOne<{ next: number }>(
    db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM projects WHERE id < ?'),
    LOCAL_PROJECT_ID_CEILING,
  )
  return row?.next ?? 1
}

export interface NewProject {
  name: string
  clientName?: string | null
  active?: boolean
  id?: number
  externalId?: number | null
  createdAt: string
}

export function insertProject(db: DatabaseSync, project: NewProject): ProjectRow {
  const id = project.id ?? nextLocalProjectId(db)
  db.prepare(
    `INSERT INTO projects (id, name, client_name, active, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project.name,
    project.clientName ?? null,
    fromBoolean(project.active ?? true),
    project.externalId ?? null,
    project.createdAt,
  )
  ensureProjectKey(db, id)
  const created = findProjectById(db, id)
  if (!created) throw new Error(`project ${id} vanished right after being inserted`)
  return created
}

export function findProjectById(db: DatabaseSync, id: number): ProjectRow | undefined {
  const raw = queryOne<RawProject>(db.prepare('SELECT * FROM projects WHERE id = ?'), id)
  return raw ? toProject(raw) : undefined
}

export function findProjectByName(db: DatabaseSync, name: string): ProjectRow | undefined {
  const raw = queryOne<RawProject>(
    db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE'),
    name,
  )
  return raw ? toProject(raw) : undefined
}

export function findProjectByKey(db: DatabaseSync, key: string): ProjectRow | undefined {
  const raw = queryOne<RawProject>(
    db.prepare('SELECT * FROM projects WHERE key = ? COLLATE NOCASE'),
    key,
  )
  return raw ? toProject(raw) : undefined
}

export function setProjectKey(db: DatabaseSync, id: number, key: string): void {
  db.prepare('UPDATE projects SET key = ? WHERE id = ?').run(key.toUpperCase(), id)
}

export function listProjects(db: DatabaseSync, includeInactive = false): ProjectRow[] {
  const sql = includeInactive
    ? 'SELECT * FROM projects ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM projects WHERE active = 1 ORDER BY name COLLATE NOCASE'
  return queryAll<RawProject>(db.prepare(sql)).map(toProject)
}

export function renameProject(db: DatabaseSync, id: number, name: string): void {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}

export function setProjectActive(db: DatabaseSync, id: number, active: boolean): void {
  db.prepare('UPDATE projects SET active = ? WHERE id = ?').run(fromBoolean(active), id)
}

export function deleteProject(db: DatabaseSync, id: number): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0
}
