import type { DatabaseSync } from 'node:sqlite'
import { listPageNotes, type PageNoteRow } from '../db/index-docs.ts'
import { ancestorsOf, listPages, type DocPageRow } from '../db/pages.ts'
import { listProjects } from '../db/projects.ts'
import { projectSlug } from './slug.ts'
import { scanFiles, type Match, type ScanOptions } from './search.ts'

export const DEFAULT_PAGE_MATCHES = 8

export interface PageMatch {
  source: 'page' | 'entry'
  entryId?: number
  section: string | null
  line: number
  prefix: string
  match: string
  suffix: string
}

export interface PageSearchHit {
  pageId: number
  title: string
  projectId: number | null
  projectName: string | null
  projectSlug: string
  relPath: string
  ancestors: { pageId: number; title: string }[]
  matchCount: number
  sources: { page: number; entries: number }
  matches: PageMatch[]
}

export interface PageSearchResult {
  hits: PageSearchHit[]
  scanned: { documents: number; bytes: number; missing: number; elapsedMs: number }
  truncated: boolean
}

export interface PageSearchOptions extends ScanOptions {
  projectId?: number | null
  maxPerPage?: number
}

interface Tally {
  page: DocPageRow
  pageCount: number
  entryCount: number
  pageMatches: PageMatch[]
  entryMatches: PageMatch[]
  recency: string
}

function toPageMatch(match: Match, source: 'page' | 'entry', entryId?: number): PageMatch {
  return {
    source,
    ...(entryId !== undefined ? { entryId } : {}),
    section: match.section,
    line: match.line,
    prefix: match.prefix,
    match: match.match,
    suffix: match.suffix,
  }
}

export async function searchPages(
  db: DatabaseSync,
  docsRoot: string,
  query: string,
  options: PageSearchOptions = {},
): Promise<PageSearchResult> {
  const pages = listPages(db, options.projectId)
  const byId = new Map(pages.map((page) => [page.id, page]))
  const notes = listPageNotes(db, options.projectId).filter((note) => byId.has(note.pageId))

  const uniqueNotes = new Map<string, PageNoteRow>()
  const pagesOfNote = new Map<string, number[]>()
  for (const note of notes) {
    if (!uniqueNotes.has(note.relPath)) uniqueNotes.set(note.relPath, note)
    const list = pagesOfNote.get(note.relPath) ?? []
    if (!list.includes(note.pageId)) list.push(note.pageId)
    pagesOfNote.set(note.relPath, list)
  }

  const scanOptions: ScanOptions = { ...options, skipFrontMatter: true, max: options.maxPerPage ?? options.max ?? DEFAULT_PAGE_MATCHES }
  const pageScan = await scanFiles(docsRoot, pages, (page) => page, query, scanOptions)
  const noteScan = await scanFiles(docsRoot, [...uniqueNotes.values()], (note) => note, query, scanOptions)

  const tallies = new Map<number, Tally>()
  const tallyOf = (page: DocPageRow): Tally => {
    const existing = tallies.get(page.id)
    if (existing) return existing
    const created: Tally = { page, pageCount: 0, entryCount: 0, pageMatches: [], entryMatches: [], recency: page.recordedAt }
    tallies.set(page.id, created)
    return created
  }

  for (const found of pageScan.documents) {
    const tally = tallyOf(found.candidate)
    tally.pageCount += found.matchCount
    tally.pageMatches.push(...found.matches.map((match) => toPageMatch(match, 'page')))
  }

  for (const found of noteScan.documents) {
    for (const pageId of pagesOfNote.get(found.candidate.relPath) ?? []) {
      const page = byId.get(pageId)
      if (!page) continue
      const tally = tallyOf(page)
      tally.entryCount += found.matchCount
      tally.entryMatches.push(...found.matches.map((match) => toPageMatch(match, 'entry', found.candidate.entryId)))
      if (found.candidate.startedAt > tally.recency) tally.recency = found.candidate.startedAt
    }
  }

  const projectNames = new Map(listProjects(db, true).map((project) => [project.id, project.name]))
  const limit = scanOptions.max ?? DEFAULT_PAGE_MATCHES

  const ranked = [...tallies.values()].sort(
    (left, right) =>
      right.pageCount + right.entryCount - (left.pageCount + left.entryCount) ||
      right.recency.localeCompare(left.recency) ||
      left.page.id - right.page.id,
  )

  const hits = ranked.map((tally): PageSearchHit => {
    const projectName = tally.page.projectId === null ? null : (projectNames.get(tally.page.projectId) ?? null)
    return {
      pageId: tally.page.id,
      title: tally.page.title,
      projectId: tally.page.projectId,
      projectName,
      projectSlug: projectSlug(projectName),
      relPath: tally.page.relPath,
      ancestors: ancestorsOf(db, tally.page.id).map((row) => ({ pageId: row.id, title: row.title })),
      matchCount: tally.pageCount + tally.entryCount,
      sources: { page: tally.pageCount, entries: tally.entryCount },
      matches: [...tally.pageMatches, ...tally.entryMatches].slice(0, limit),
    }
  })

  return {
    hits,
    scanned: {
      documents: pageScan.scanned.documents + noteScan.scanned.documents,
      bytes: pageScan.scanned.bytes + noteScan.scanned.bytes,
      missing: pageScan.scanned.missing + noteScan.scanned.missing,
      elapsedMs: pageScan.scanned.elapsedMs + noteScan.scanned.elapsedMs,
    },
    truncated: pageScan.truncated || noteScan.truncated,
  }
}
