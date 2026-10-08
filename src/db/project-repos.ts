import type { DatabaseSync } from 'node:sqlite'
import { queryAll, queryOne } from './query.ts'

export type ProjectRepoSource = 'stop' | 'manual'

export const PROJECT_REPO_SOURCES: readonly ProjectRepoSource[] = ['stop', 'manual']

export interface ProjectRepoRow {
  projectId: number
  projectName: string
  path: string
  slug: string | null
  source: ProjectRepoSource
  addedAt: string
  lastSeenAt: string
}

interface RawProjectRepo {
  project_id: number
  project_name: string
  path: string
  slug: string | null
  source: ProjectRepoSource
  added_at: string
  last_seen_at: string
}

const SELECT_REPOS = `SELECT r.project_id, p.name AS project_name, r.path, r.slug, r.source, r.added_at, r.last_seen_at
  FROM project_repos r JOIN projects p ON p.id = r.project_id`

function toRow(raw: RawProjectRepo): ProjectRepoRow {
  return {
    projectId: raw.project_id,
    projectName: raw.project_name,
    path: raw.path,
    slug: raw.slug,
    source: raw.source,
    addedAt: raw.added_at,
    lastSeenAt: raw.last_seen_at,
  }
}

export function listProjectRepos(db: DatabaseSync, projectId?: number): ProjectRepoRow[] {
  const rows =
    projectId === undefined
      ? queryAll<RawProjectRepo>(db.prepare(`${SELECT_REPOS} ORDER BY p.name COLLATE NOCASE, r.path`))
      : queryAll<RawProjectRepo>(db.prepare(`${SELECT_REPOS} WHERE r.project_id = ? ORDER BY r.path`), projectId)
  return rows.map(toRow)
}

export function findProjectRepo(db: DatabaseSync, projectId: number, path: string): ProjectRepoRow | undefined {
  const raw = queryOne<RawProjectRepo>(
    db.prepare(`${SELECT_REPOS} WHERE r.project_id = ? AND r.path = ?`),
    projectId,
    path,
  )
  return raw ? toRow(raw) : undefined
}

export interface UpsertProjectRepo {
  projectId: number
  path: string
  slug: string | null
  source: ProjectRepoSource
  now: string
}

export function upsertProjectRepo(
  db: DatabaseSync,
  repo: UpsertProjectRepo,
): { row: ProjectRepoRow; created: boolean } {
  const existing = findProjectRepo(db, repo.projectId, repo.path)
  if (existing) {
    db.prepare(
      `UPDATE project_repos SET last_seen_at = ?, slug = COALESCE(?, slug)
       WHERE project_id = ? AND path = ?`,
    ).run(repo.now, repo.slug, repo.projectId, repo.path)
  } else {
    db.prepare(
      `INSERT INTO project_repos (project_id, path, slug, source, added_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(repo.projectId, repo.path, repo.slug, repo.source, repo.now, repo.now)
  }
  const row = findProjectRepo(db, repo.projectId, repo.path)
  if (!row) throw new Error(`project repo ${repo.path} was not stored`)
  return { row, created: existing === undefined }
}

export function deleteProjectRepos(db: DatabaseSync, paths: readonly string[], projectId?: number): number {
  let removed = 0
  for (const path of new Set(paths)) {
    const result =
      projectId === undefined
        ? db.prepare('DELETE FROM project_repos WHERE path = ?').run(path)
        : db.prepare('DELETE FROM project_repos WHERE project_id = ? AND path = ?').run(projectId, path)
    removed += Number(result.changes)
  }
  return removed
}

export function touchedPathsOfEntries(db: DatabaseSync, entryIds: readonly number[]): string[] {
  if (entryIds.length === 0) return []
  const placeholders = entryIds.map(() => '?').join(', ')
  return queryAll<{ path: string }>(
    db.prepare(`SELECT DISTINCT path FROM entry_touches WHERE entry_id IN (${placeholders}) ORDER BY path`),
    ...entryIds,
  ).map((row) => row.path)
}

export function entryIdsOfProject(db: DatabaseSync, projectId: number): number[] {
  return queryAll<{ id: number }>(
    db.prepare('SELECT id FROM entries WHERE project_id = ? ORDER BY id'),
    projectId,
  ).map((row) => row.id)
}

export function repoSlugsOfEntries(db: DatabaseSync, entryIds: readonly number[]): string[] {
  if (entryIds.length === 0) return []
  const placeholders = entryIds.map(() => '?').join(', ')
  return queryAll<{ repo_slug: string }>(
    db.prepare(
      `SELECT DISTINCT repo_slug FROM entry_docs
       WHERE entry_id IN (${placeholders}) AND repo_slug IS NOT NULL AND repo_slug <> ''`,
    ),
    ...entryIds,
  ).map((row) => row.repo_slug)
}
