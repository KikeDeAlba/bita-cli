import { existsSync } from 'node:fs'
import { DOC_SCHEMA_VERSION } from '../config/constants.ts'
import { assetsRelDir } from './diagrams.ts'
import { ancestorsOf, recordPageFile, repointPage, type DocPageRow } from '../db/pages.ts'
import { issuesOfPage } from '../db/page-links.ts'
import type { DocsContext } from './record.ts'
import {
  checksumOf,
  emptyDocument,
  filledSections,
  outline,
  parseDocument,
  renderDocument,
  stampFrontMatter,
  upsertSection,
  type ParsedDocument,
} from './markdown.ts'
import { resolveDocPath } from './paths.ts'
import { readRaw, renameDocument, withDocLock, writeDocument } from './store.ts'

export interface PageWrite {
  section?: { heading: string; body: string } | undefined
  body?: string | undefined
  frontMatter?: Record<string, string> | undefined
  dropSections?: readonly string[] | undefined
}

export interface RecordedPage {
  page: DocPageRow
  path: string
  relPath: string
  created: boolean
  changed: boolean
  sectionCount: number
  headingCount: number
}

function ownedFrontMatter(ctx: DocsContext, page: DocPageRow, parentTitle: string | null): Record<string, string> {
  const issues = issuesOfPage(ctx.db, page.id)
  return {
    bita: String(DOC_SCHEMA_VERSION),
    pageId: String(page.id),
    title: page.title,
    parent: parentTitle ?? '',
    issues: issues.map((issue) => issue.issueKey).join(', '),
    updatedAt: ctx.now.toISOString(),
  }
}

export async function recordPageDoc(
  ctx: DocsContext,
  page: DocPageRow,
  write: PageWrite = {},
): Promise<RecordedPage> {
  const absolutePath = resolveDocPath(ctx.docsRoot, page.relPath)
  const parents = ancestorsOf(ctx.db, page.id)
  const parentTitle = parents.at(-1)?.title ?? null

  return withDocLock(absolutePath, async () => {
    const raw = await readRaw(absolutePath)
    let doc: ParsedDocument = raw === null ? emptyDocument(new Map(), page.title) : parseDocument(raw)

    if (write.body !== undefined) {
      const replacement = parseDocument(write.body)
      doc = { ...doc, preamble: replacement.preamble, sections: replacement.sections }
    }
    if (write.section) {
      doc = upsertSection(doc, write.section.heading, write.section.body).doc
    }
    if (write.dropSections && write.dropSections.length > 0) {
      const dropped = new Set(write.dropSections)
      doc = { ...doc, sections: doc.sections.filter((section) => !dropped.has(section.heading)) }
    }
    if (doc.title !== page.title) doc = { ...doc, title: page.title }
    if (doc.frontMatterValid || raw === null) {
      doc = stampFrontMatter(doc, { ...ownedFrontMatter(ctx, page, parentTitle), ...(write.frontMatter ?? {}) })
    }

    const result = await writeDocument(absolutePath, doc)
    const headingCount = outline(doc).filter((heading) => heading.level === 2).length

    recordPageFile(ctx.db, page.id, {
      sectionCount: filledSections(doc).length,
      headingCount,
      byteSize: result.byteSize,
      checksum: result.checksum,
      recordedAt: ctx.now.toISOString(),
    })

    return {
      page,
      path: absolutePath,
      relPath: page.relPath,
      created: result.created,
      changed: result.changed,
      sectionCount: result.sectionCount,
      headingCount,
    }
  })
}

export async function movePageFile(ctx: DocsContext, page: DocPageRow, toRelPath: string): Promise<boolean> {
  if (page.relPath === toRelPath) return false

  const from = resolveDocPath(ctx.docsRoot, page.relPath)
  const to = resolveDocPath(ctx.docsRoot, toRelPath)
  const moved = await renameDocument(from, to)
  if (!moved) return false

  const fromAssets = resolveDocPath(ctx.docsRoot, assetsRelDir(page.relPath))
  if (existsSync(fromAssets)) {
    await renameDocument(fromAssets, resolveDocPath(ctx.docsRoot, assetsRelDir(toRelPath)))
  }

  repointPage(ctx.db, page.id, toRelPath)
  return true
}

export function checksumFor(doc: ParsedDocument): string {
  return checksumOf(renderDocument(doc))
}
