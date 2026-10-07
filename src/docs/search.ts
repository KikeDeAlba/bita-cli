import type { SearchCandidateRow } from '../db/index-docs.ts'
import { inspectDocFile, type DocFileRef, type DocFileState } from './inspect.ts'

export interface Match {
  offset: number
  length: number
  line: number
  section: string | null
  prefix: string
  match: string
  suffix: string
  snippet: string
}

export interface MatchOptions {
  caseSensitive?: boolean
  context?: number
  max?: number
  section?: string
  skipFrontMatter?: boolean
}

export interface FoundMatches {
  total: number
  matches: Match[]
}

export interface ScanOptions extends MatchOptions {
  maxScanDocs?: number
  maxScanBytes?: number
  concurrency?: number
}

export interface ScannedFile<T> {
  candidate: T
  matchCount: number
  matches: Match[]
  file: DocFileState
}

export type ScannedDocument = ScannedFile<SearchCandidateRow>

export interface FileScanResult<T> {
  documents: ScannedFile<T>[]
  scanned: { documents: number; bytes: number; missing: number; elapsedMs: number }
  truncated: boolean
}

export interface ScanResult {
  documents: ScannedDocument[]
  scanned: { documents: number; bytes: number; missing: number; elapsedMs: number }
  truncated: boolean
}

export const DEFAULT_CONTEXT = 120
export const DEFAULT_MAX_MATCHES = 5
export const DEFAULT_MAX_SCAN_DOCS = 5_000
export const DEFAULT_MAX_SCAN_BYTES = 33_554_432
export const DEFAULT_CONCURRENCY = 16

const ELLIPSIS = '…'

function foldChar(char: string): string {
  const decomposed = char.normalize('NFD')
  const first = decomposed.codePointAt(0)
  if (first === undefined) return char

  const lowered = String.fromCodePoint(first).toLowerCase()
  if (lowered.length === char.length) return lowered

  const plain = char.toLowerCase()
  return plain.length === char.length ? plain : char
}

export function foldForSearch(text: string): string {
  let folded = ''
  for (const char of text) folded += foldChar(char)
  return folded
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? 0) <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

interface Heading {
  offset: number
  heading: string
}

export function sectionOffsets(raw: string): Heading[] {
  const headings: Heading[] = []
  for (const found of raw.matchAll(/^##[ \t]+(.*\S)[ \t]*$/gm)) {
    if (found.index === undefined || found[1] === undefined) continue
    headings.push({ offset: found.index, heading: found[1] })
  }
  return headings
}

function sectionFor(headings: Heading[], offset: number): string | null {
  let found: string | null = null
  for (const heading of headings) {
    if (heading.offset > offset) break
    found = heading.heading
  }
  return found
}

function trimToCodePoint(text: string, from: number, to: number): string {
  let start = from
  let end = to
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1
  return text.slice(start, end)
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function frontMatterEnd(raw: string): number {
  if (!raw.startsWith('---\n')) return 0
  const closing = raw.indexOf('\n---\n', 3)
  return closing === -1 ? 0 : closing + 5
}

export function findMatches(raw: string, needle: string, options: MatchOptions = {}): FoundMatches {
  if (needle.length === 0) return { total: 0, matches: [] }

  const caseSensitive = options.caseSensitive ?? false
  const context = options.context ?? DEFAULT_CONTEXT
  const max = options.max ?? DEFAULT_MAX_MATCHES

  const haystack = caseSensitive ? raw : foldForSearch(raw)
  const pin = caseSensitive ? needle : foldForSearch(needle)
  if (pin.length === 0) return { total: 0, matches: [] }

  const headings = sectionOffsets(raw)
  const starts = lineStarts(raw)
  const searchFrom = options.skipFrontMatter ? frontMatterEnd(raw) : 0

  let total = 0
  const matches: Match[] = []

  for (let at = haystack.indexOf(pin, searchFrom); at !== -1; at = haystack.indexOf(pin, at + pin.length)) {
    const section = sectionFor(headings, at)
    if (options.section !== undefined && section !== options.section) continue

    total += 1
    if (matches.length >= max) continue

    const from = Math.max(0, at - context)
    const to = Math.min(raw.length, at + pin.length + context)
    const prefix = trimToCodePoint(raw, from, at)
    const suffix = trimToCodePoint(raw, at + pin.length, to)
    const match = raw.slice(at, at + pin.length)

    matches.push({
      offset: at,
      length: pin.length,
      line: lineAt(starts, at),
      section,
      prefix: from > 0 ? `${ELLIPSIS}${prefix}` : prefix,
      match,
      suffix: to < raw.length ? `${suffix}${ELLIPSIS}` : suffix,
      snippet: '',
    })
  }

  for (const found of matches) {
    found.snippet = `${found.prefix}${found.match}${found.suffix}`
  }

  return { total, matches }
}

export async function scanDocuments(
  docsRoot: string,
  candidates: SearchCandidateRow[],
  needle: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  return scanFiles(docsRoot, candidates, (candidate) => candidate.doc, needle, options)
}

export async function scanFiles<T>(
  docsRoot: string,
  candidates: readonly T[],
  fileOf: (candidate: T) => DocFileRef,
  needle: string,
  options: ScanOptions = {},
): Promise<FileScanResult<T>> {
  const started = Date.now()
  const maxScanDocs = options.maxScanDocs ?? DEFAULT_MAX_SCAN_DOCS
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)

  const found = new Array<ScannedFile<T> | null>(candidates.length).fill(null)
  let next = 0
  let documents = 0
  let bytes = 0
  let missing = 0
  let truncated = false

  async function worker(): Promise<void> {
    for (;;) {
      if (truncated) return
      const index = next
      next += 1
      if (index >= candidates.length) return
      const candidate = candidates[index] as T

      if (documents >= maxScanDocs || bytes >= maxScanBytes) {
        truncated = true
        return
      }

      const { state, raw } = await inspectDocFile(docsRoot, fileOf(candidate))
      documents += 1

      if (raw === null) {
        missing += 1
        continue
      }

      bytes += Buffer.byteLength(raw)
      const { total, matches } = findMatches(raw, needle, options)
      if (total === 0) continue

      found[index] = { candidate, matchCount: total, matches, file: state }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))

  return {
    documents: found.filter((entry): entry is ScannedFile<T> => entry !== null),
    scanned: { documents, bytes, missing, elapsedMs: Date.now() - started },
    truncated,
  }
}
