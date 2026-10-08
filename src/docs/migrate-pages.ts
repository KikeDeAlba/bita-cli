import { rm } from 'node:fs/promises'
import { LEGACY_ENTRY_DOC_SECTIONS } from '../config/constants.ts'
import { findEntryWithProject } from '../db/entries.ts'
import { queryAll } from '../db/query.ts'
import {
  deletePage,
  findPage,
  insertPage,
  listPages,
  uniqueSiblingSlug,
  type DocPageRow,
} from '../db/pages.ts'
import { linkEntryToPage, linkIssueToPage, pageOfEntry } from '../db/page-links.ts'
import { readSetting, writeSetting } from '../db/settings.ts'
import { issueUrl } from '../domain/jira.ts'
import { pageRelPath } from './layout.ts'
import { checksumOf, parseDocument, type DocSection } from './markdown.ts'
import { recordPageDoc } from './page-record.ts'
import { commitDocs } from './git.ts'
import { resolveDocPath } from './paths.ts'
import type { DocsContext } from './record.ts'
import { titleSlug } from './slug.ts'
import { readRaw } from './store.ts'

export const MIGRATION_BATCH_KEY = 'docs.migration.batch'
export const MIGRATION_SOURCE = 'migrate'

const TO_BODY = new Set(['Contexto', 'Decisiones', 'Hallazgos'])
const TO_LOG = 'Qué se hizo'

export interface PageMigrationOptions {
  dryRun?: boolean
  projectId?: number | null
  limit?: number
  siteUrl?: string | undefined
}

export interface MigratedPage {
  entryId: number
  pageId: number | null
  title: string
  relPath: string
  migratedFrom: string
  summary: string
  issues: string[]
}

export interface PageMigrationReport {
  batch: string
  dryRun: boolean
  scanned: number
  migrated: MigratedPage[]
  skipped: { entryId: number; reason: string }[]
}

export interface UndoReport {
  batch: string | null
  pagesRemoved: number
  filesRemoved: number
  filesKept: string[]
}

interface LegacyDoc {
  entry_id: number
  rel_path: string
  title: string
  checksum: string
}

function legacyDocs(ctx: DocsContext, projectId?: number | null, limit?: number): LegacyDoc[] {
  const bounded = limit !== undefined && limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''
  const filtered = projectId === undefined ? '' : 'AND IFNULL(e.project_id, 0) = IFNULL(?, 0)'

  const statement = ctx.db.prepare(
    `SELECT d.entry_id, d.rel_path, d.title, d.checksum
     FROM entry_docs d
     JOIN entries e ON e.id = d.entry_id
     LEFT JOIN page_entries pe ON pe.entry_id = d.entry_id
     WHERE d.kind = 'note' AND pe.entry_id IS NULL ${filtered}
     ORDER BY e.started_at ${bounded}`,
  )

  return projectId === undefined
    ? queryAll<LegacyDoc>(statement)
    : queryAll<LegacyDoc>(statement, projectId)
}

export function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

export function splitLegacy(sections: readonly DocSection[]): { body: DocSection[]; said: string } {
  const body: DocSection[] = []
  let said = ''

  for (const section of sections) {
    if (section.heading === TO_LOG) {
      if (said.length === 0) said = firstParagraph(section.body)
      continue
    }
    if (LEGACY_ENTRY_DOC_SECTIONS.includes(section.heading) && !TO_BODY.has(section.heading)) continue
    if (section.body.trim().length === 0) continue
    body.push(section)
  }

  return { body, said }
}

export async function migratePages(
  ctx: DocsContext,
  options: PageMigrationOptions = {},
): Promise<PageMigrationReport> {
  const dryRun = options.dryRun ?? true
  const batch = ctx.now.toISOString()
  const candidates = legacyDocs(ctx, options.projectId, options.limit)

  const migrated: MigratedPage[] = []
  const skipped: { entryId: number; reason: string }[] = []

  for (const legacy of candidates) {
    const entry = findEntryWithProject(ctx.db, legacy.entry_id)
    if (!entry) {
      skipped.push({ entryId: legacy.entry_id, reason: 'la entrada ya no está' })
      continue
    }
    if (pageOfEntry(ctx.db, entry.id)) {
      skipped.push({ entryId: entry.id, reason: 'ya cuelga de una página' })
      continue
    }

    const raw = await readRaw(resolveDocPath(ctx.docsRoot, legacy.rel_path))
    if (raw === null) {
      skipped.push({ entryId: entry.id, reason: 'el archivo no está en el disco' })
      continue
    }

    const parsed = parseDocument(raw)
    const title = (legacy.title || parsed.title || entry.description || 'Sin título').trim()
    const { body, said } = splitLegacy(parsed.sections)
    const issues = entry.issueKey ? [entry.issueKey] : []

    if (dryRun) {
      const taken = new Set(listPages(ctx.db, entry.projectId).map((page) => page.slug))
      let slug = titleSlug(title)
      for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${titleSlug(title)}-${suffix}`
      migrated.push({
        entryId: entry.id,
        pageId: null,
        title,
        relPath: pageRelPath({ projectName: entry.projectName, ancestorSlugs: [], slug }),
        migratedFrom: legacy.rel_path,
        summary: said,
        issues,
      })
      continue
    }

    const slug = uniqueSiblingSlug(ctx.db, entry.projectId, null, titleSlug(title))
    const relPath = pageRelPath({ projectName: entry.projectName, ancestorSlugs: [], slug })

    const pageId = insertPage(ctx.db, {
      projectId: entry.projectId,
      parentId: null,
      slug,
      title,
      relPath,
      depth: 0,
      source: MIGRATION_SOURCE,
      now: batch,
    })

    linkEntryToPage(ctx.db, pageId, entry.id, said, batch)
    for (const key of issues) {
      linkIssueToPage(ctx.db, { pageId, issueKey: key, url: issueUrl(options.siteUrl, key), now: batch })
    }

    const page = findPage(ctx.db, pageId) as DocPageRow
    await recordPageDoc(ctx, page, {
      body: body.map((section) => `## ${section.heading}\n\n${section.body}`).join('\n\n'),
      frontMatter: { migratedFrom: legacy.rel_path },
    }, false)

    migrated.push({ entryId: entry.id, pageId, title, relPath, migratedFrom: legacy.rel_path, summary: said, issues })
  }

  if (!dryRun && migrated.length > 0) {
    writeSetting(ctx.db, MIGRATION_BATCH_KEY, batch)
    await commitDocs(
      ctx.docsRoot,
      migrated.map((page) => page.relPath),
      { source: 'manual', subject: `docs: turn ${migrated.length} entry documents into pages`, reason: 'docs migrate' },
    )
  }

  return { batch, dryRun, scanned: candidates.length, migrated, skipped }
}

export async function undoMigration(ctx: DocsContext): Promise<UndoReport> {
  const batch = readSetting(ctx.db, MIGRATION_BATCH_KEY) ?? null
  if (batch === null) return { batch: null, pagesRemoved: 0, filesRemoved: 0, filesKept: [] }

  const pages = queryAll<{ id: number; rel_path: string; checksum: string }>(
    ctx.db.prepare(`SELECT id, rel_path, checksum FROM doc_pages WHERE source = ? AND created_at = ?`),
    MIGRATION_SOURCE,
    batch,
  )

  let filesRemoved = 0
  const filesKept: string[] = []
  const removedPaths: string[] = []

  for (const page of pages) {
    const absolutePath = resolveDocPath(ctx.docsRoot, page.rel_path)
    const raw = await readRaw(absolutePath)

    if (raw !== null) {
      if (checksumOf(raw) === page.checksum) {
        await rm(absolutePath, { force: true })
        filesRemoved += 1
        removedPaths.push(page.rel_path)
      } else {
        filesKept.push(page.rel_path)
      }
    }
    deletePage(ctx.db, page.id)
  }

  writeSetting(ctx.db, MIGRATION_BATCH_KEY, '')
  if (filesRemoved > 0) {
    await commitDocs(
      ctx.docsRoot,
      removedPaths,
      { source: 'manual', subject: 'docs: undo the page migration', reason: 'docs migrate --undo' },
    )
  }
  return { batch, pagesRemoved: pages.length, filesRemoved, filesKept }
}
