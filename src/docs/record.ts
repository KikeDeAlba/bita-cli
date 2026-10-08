import type { DatabaseSync } from 'node:sqlite'
import type { EntryWithProjectRow } from '../db/rows.ts'
import type { NoteSource } from '../state/notes.ts'
import { findDocForEntry, moveDoc, upsertDoc, type EntryDocRow } from '../db/docs.ts'
import {
  DOC_SCHEMA_VERSION,
  LEGACY_ENTRY_DOC_SECTIONS,
  LEGACY_ENTRY_DOC_SECTIONS_REQUIRED,
} from '../config/constants.ts'
import { formatDuration } from '../domain/duration.ts'
import { localDay } from '../domain/timezone.ts'
import { docRelPath } from './layout.ts'
import { resolveDocPath } from './paths.ts'
import { DRAFT_TITLE_SLUG, titleSlug } from './slug.ts'
import {
  checksumOf,
  emptyDocument,
  filledSections,
  parseDocument,
  renderDocument,
  stampFrontMatter,
  upsertSection,
  type ParsedDocument,
} from './markdown.ts'
import { readRaw, renameDocument, withDocLock, writeDocument } from './store.ts'
import { commitDocs, docsSubject, prepareDocsRepo } from './git.ts'

export interface DocsContext {
  db: DatabaseSync
  docsRoot: string
  timezone: string
  now: Date
}

export interface RepoIdentity {
  slug: string
  branch?: string | undefined
  headSha?: string | undefined
}

export interface RecordedDoc {
  entryId: number
  relPath: string
  path: string
  title: string
  created: boolean
  changed: boolean
  renamedFrom: string | null
  sectionCount: number
  byteSize: number
  checksum: string
  frontMatterValid: boolean
}

function durationOf(entry: EntryWithProjectRow): string {
  if (!entry.stoppedAt) return ''
  const seconds = Math.round((Date.parse(entry.stoppedAt) - Date.parse(entry.startedAt)) / 1000)
  return formatDuration(seconds)
}

function ownedFrontMatter(
  entry: EntryWithProjectRow,
  timezone: string,
  identity: RepoIdentity | null,
): Record<string, string> {
  return {
    bita: String(DOC_SCHEMA_VERSION),
    entryId: String(entry.id),
    title: entry.description,
    project: entry.projectName ?? '',
    day: localDay(entry.startedAt, timezone),
    startedAt: entry.startedAt,
    endedAt: entry.stoppedAt ?? '',
    duration: durationOf(entry),
    repo: identity?.slug ?? '',
    branch: identity?.branch ?? '',
    jira: entry.issueKey ?? '',
    kind: entry.kind ?? '',
  }
}

function plannedRelPath(entry: EntryWithProjectRow, timezone: string): string {
  return docRelPath({
    entryId: entry.id,
    startedAt: entry.startedAt,
    timezone,
    projectName: entry.projectName,
    description: entry.description,
  })
}

async function promote(
  ctx: DocsContext,
  entry: EntryWithProjectRow,
  stored: EntryDocRow,
  wanted: string,
): Promise<{ relPath: string; renamedFrom: string | null }> {
  if (stored.relPath === wanted) return { relPath: stored.relPath, renamedFrom: null }
  if (stored.titleSlug !== DRAFT_TITLE_SLUG) return { relPath: stored.relPath, renamedFrom: null }

  const from = resolveDocPath(ctx.docsRoot, stored.relPath)
  const to = resolveDocPath(ctx.docsRoot, wanted)
  const moved = await renameDocument(from, to)
  if (!moved) return { relPath: stored.relPath, renamedFrom: null }

  moveDoc(ctx.db, entry.id, stored.relPath, wanted, titleSlug(entry.description), ctx.now.toISOString())
  return { relPath: wanted, renamedFrom: stored.relPath }
}

export interface RecordOptions {
  source: NoteSource
  identity?: RepoIdentity | null
  create?: boolean
  section?: { heading: string; body: string } | undefined
  commit?: false | { reason?: string } | undefined
}

export async function recordEntryDoc(
  ctx: DocsContext,
  entry: EntryWithProjectRow,
  options: RecordOptions,
): Promise<RecordedDoc | null> {
  const identity = options.identity ?? null
  const stored = findDocForEntry(ctx.db, entry.id)
  const wanted = plannedRelPath(entry, ctx.timezone)

  const placement = stored
    ? await promote(ctx, entry, stored, wanted)
    : { relPath: wanted, renamedFrom: null }

  const absolutePath = resolveDocPath(ctx.docsRoot, placement.relPath)
  if (options.commit !== false) await prepareDocsRepo(ctx.docsRoot)

  return withDocLock(absolutePath, async () => {
    const raw = await readRaw(absolutePath)
    if (raw === null && options.create !== true && !options.section) return null

    let doc: ParsedDocument =
      raw === null
        ? emptyDocument(new Map(), entry.description || '(sin título)', LEGACY_ENTRY_DOC_SECTIONS_REQUIRED)
        : parseDocument(raw)

    if (options.section) {
      doc = upsertSection(
        doc,
        options.section.heading,
        options.section.body,
        LEGACY_ENTRY_DOC_SECTIONS,
      ).doc
    }

    if (doc.frontMatterValid || raw === null) {
      doc = stampFrontMatter(doc, ownedFrontMatter(entry, ctx.timezone, identity))
      if (entry.description.length > 0 && doc.title !== entry.description) {
        doc = { ...doc, title: entry.description }
      }
    }

    const written = await writeDocument(absolutePath, doc)
    const now = ctx.now.toISOString()

    upsertDoc(ctx.db, {
      entryId: entry.id,
      relPath: placement.relPath,
      title: entry.description,
      titleSlug: titleSlug(entry.description),
      source: options.source,
      sectionCount: written.sectionCount,
      byteSize: written.byteSize,
      checksum: written.checksum,
      repoSlug: identity?.slug ?? null,
      branch: identity?.branch ?? null,
      headSha: identity?.headSha ?? null,
      now,
    })

    if (options.commit !== false && (written.changed || placement.renamedFrom !== null)) {
      await commitDocs(
        ctx.docsRoot,
        [placement.relPath, ...(placement.renamedFrom !== null ? [placement.renamedFrom] : [])],
        {
          source: 'note',
          subject: docsSubject(placement.relPath, written.created ? 'create note' : 'update note', entry.description || `#${entry.id}`),
          entryId: entry.id,
          reason: options.commit?.reason ?? null,
        },
      )
    }

    return {
      entryId: entry.id,
      relPath: placement.relPath,
      path: absolutePath,
      title: entry.description,
      created: written.created,
      changed: written.changed,
      renamedFrom: placement.renamedFrom,
      sectionCount: written.sectionCount,
      byteSize: written.byteSize,
      checksum: written.checksum,
      frontMatterValid: doc.frontMatterValid || raw === null,
    }
  })
}

export function docPathFor(ctx: DocsContext, entry: EntryWithProjectRow): { relPath: string; path: string } {
  const stored = findDocForEntry(ctx.db, entry.id)
  const relPath = stored?.relPath ?? plannedRelPath(entry, ctx.timezone)
  return { relPath, path: resolveDocPath(ctx.docsRoot, relPath) }
}

export async function readEntryDoc(
  ctx: DocsContext,
  doc: EntryDocRow,
): Promise<{ path: string; markdown: string | null }> {
  const path = resolveDocPath(ctx.docsRoot, doc.relPath)
  return { path, markdown: await readRaw(path) }
}

export function documentChecksum(doc: ParsedDocument): string {
  return checksumOf(renderDocument(doc))
}

export function documentSections(doc: ParsedDocument): string[] {
  return filledSections(doc)
}
