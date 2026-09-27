import { queryAll } from '../db/query.ts'
import { issuesOfPage } from '../db/page-links.ts'
import { refsOfPage, type RefKind } from '../db/page-refs.ts'
import { findPage, type DocPageRow } from '../db/pages.ts'
import { documentBody, parseDocument } from './markdown.ts'
import { resolveDocPath } from './paths.ts'
import type { DocsContext } from './record.ts'
import { readRaw } from './store.ts'

export interface SummaryPageRef {
  url: string
  title: string
  kind: RefKind
}

export interface SummaryPage {
  pageId: number
  title: string
  relPath: string
  path: string
  body: string | null
  issues: string[]
  refs: SummaryPageRef[]
}

export async function pagesForEntries(
  ctx: DocsContext,
  entryIds: readonly number[],
): Promise<Map<number, SummaryPage[]>> {
  const byEntry = new Map<number, SummaryPage[]>()
  if (entryIds.length === 0) return byEntry

  const placeholders = entryIds.map(() => '?').join(', ')
  const links = queryAll<{ entry_id: number; page_id: number }>(
    ctx.db.prepare(
      `SELECT entry_id, page_id FROM page_entries
       WHERE entry_id IN (${placeholders})
       ORDER BY linked_at, page_id`,
    ),
    ...entryIds,
  )
  if (links.length === 0) return byEntry

  const loaded = new Map<number, SummaryPage>()
  for (const link of links) {
    let page = loaded.get(link.page_id)
    if (page === undefined) {
      const row = findPage(ctx.db, link.page_id)
      if (!row) continue
      page = await readPage(ctx, row)
      loaded.set(link.page_id, page)
    }
    const pages = byEntry.get(link.entry_id) ?? []
    pages.push(page)
    byEntry.set(link.entry_id, pages)
  }
  return byEntry
}

async function readPage(ctx: DocsContext, row: DocPageRow): Promise<SummaryPage> {
  const path = resolveDocPath(ctx.docsRoot, row.relPath)
  const raw = await readRaw(path)
  return {
    pageId: row.id,
    title: row.title,
    relPath: row.relPath,
    path,
    body: raw === null ? null : documentBody(parseDocument(raw)),
    issues: issuesOfPage(ctx.db, row.id).map((issue) => issue.issueKey),
    refs: refsOfPage(ctx.db, row.id).map((ref) => ({ url: ref.url, title: ref.title, kind: ref.kind })),
  }
}
