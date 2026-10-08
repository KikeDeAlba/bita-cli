import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { queryAll } from '../db/query.ts'
import { listProjectRepos, repoSlugsOfEntries, touchedPathsOfEntries } from '../db/project-repos.ts'
import { canonicalPath, isInside, RepoRootResolver } from '../state/repo-roots.ts'

export interface RepoSuggestion {
  path: string
  slug: string
  files: number
  mapped: boolean
}

export interface SuggestOptions {
  docsRoot: string
  cwd?: string
  resolver?: RepoRootResolver
}

export function entryWithMerged(db: DatabaseSync, entryId: number): number[] {
  const merged = queryAll<{ id: number }>(
    db.prepare('SELECT id FROM entries WHERE merged_into = ? ORDER BY id'),
    entryId,
  ).map((row) => row.id)
  return [entryId, ...merged]
}

export async function suggestRepos(
  db: DatabaseSync,
  entryIds: readonly number[],
  projectId: number | null,
  options: SuggestOptions,
): Promise<RepoSuggestion[]> {
  const resolver = options.resolver ?? new RepoRootResolver()
  const docsRoot = canonicalPath(options.docsRoot)
  const found = new Map<string, { slug: string; files: number }>()

  for (const touched of touchedPathsOfEntries(db, entryIds)) {
    if (!path.isAbsolute(touched)) continue
    const root = await resolver.resolve(touched)
    if (root === null || isInside(root.path, docsRoot)) continue
    const current = found.get(root.path) ?? { slug: root.slug, files: 0 }
    current.files += 1
    found.set(root.path, current)
  }

  if (options.cwd !== undefined) {
    const slugs = new Set(repoSlugsOfEntries(db, entryIds))
    const own = slugs.size > 0 ? await resolver.resolve(options.cwd) : null
    if (own !== null && slugs.has(own.slug) && !found.has(own.path) && !isInside(own.path, docsRoot)) {
      found.set(own.path, { slug: own.slug, files: 0 })
    }
  }

  const mapped = new Set(projectId === null ? [] : listProjectRepos(db, projectId).map((repo) => repo.path))

  return [...found.entries()]
    .map(([repoPath, value]) => ({ path: repoPath, slug: value.slug, files: value.files, mapped: mapped.has(repoPath) }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
}
