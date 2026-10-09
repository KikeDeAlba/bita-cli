import { createHash } from 'node:crypto'
import { slugify } from './slug.ts'

export interface DocSection {
  heading: string
  body: string
}

export type SectionState = 'written' | 'empty' | 'absent'

export interface DocSectionState {
  heading: string
  state: SectionState
  canonical: boolean
}

export interface DocHeading {
  heading: string
  level: 2 | 3
  anchor: string
  order: number
  empty: boolean
}

export interface ParsedDocument {
  frontMatter: Map<string, string>
  frontMatterValid: boolean
  title: string
  preamble: string
  sections: DocSection[]
}

const FENCE = '---'
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/

function fenceTracker(): (line: string) => boolean {
  let open: { char: string; length: number } | null = null
  return (line: string): boolean => {
    const marker = CODE_FENCE.exec(line)?.[1]
    if (open === null) {
      if (marker === undefined) return false
      open = { char: marker.slice(0, 1), length: marker.length }
      return true
    }
    if (marker !== undefined && marker.slice(0, 1) === open.char && marker.length >= open.length) {
      open = null
    }
    return true
  }
}

function splitFrontMatter(text: string): { raw: string | null; rest: string } {
  const normalized = text.startsWith('﻿') ? text.slice(1) : text
  if (!normalized.startsWith(`${FENCE}\n`)) return { raw: null, rest: normalized }

  const closing = normalized.indexOf(`\n${FENCE}\n`, FENCE.length)
  if (closing === -1) return { raw: null, rest: normalized }

  return {
    raw: normalized.slice(FENCE.length + 1, closing + 1),
    rest: normalized.slice(closing + FENCE.length + 2),
  }
}

function parseFrontMatter(raw: string): { values: Map<string, string>; valid: boolean } {
  const values = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const separator = line.indexOf(':')
    if (separator <= 0 || /^\s/.test(line)) return { values: new Map(), valid: false }
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  return { values, valid: true }
}

function renderFrontMatter(values: Map<string, string>): string {
  const lines = [...values].map(([key, value]) => (value.length === 0 ? `${key}:` : `${key}: ${value}`))
  return [FENCE, ...lines, FENCE, ''].join('\n')
}

export function parseDocument(text: string): ParsedDocument {
  const { raw, rest } = splitFrontMatter(text)
  const { values, valid } = raw === null ? { values: new Map<string, string>(), valid: false } : parseFrontMatter(raw)

  const lines = rest.split('\n')
  const preamble: string[] = []
  const sections: DocSection[] = []
  let title = ''
  let current: { heading: string; body: string[] } | null = null

  const fenced = fenceTracker()

  for (const line of lines) {
    if (fenced(line)) {
      if (current) current.body.push(line)
      else preamble.push(line)
      continue
    }

    const sectionHeading = /^##\s+(.*\S)\s*$/.exec(line)
    if (sectionHeading?.[1]) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })
      current = { heading: sectionHeading[1].normalize('NFC'), body: [] }
      continue
    }

    if (current) {
      current.body.push(line)
      continue
    }

    const documentTitle = /^#\s+(.*\S)\s*$/.exec(line)
    if (documentTitle?.[1] && title.length === 0) {
      title = documentTitle[1].normalize('NFC')
      continue
    }
    preamble.push(line)
  }

  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })

  return {
    frontMatter: values,
    frontMatterValid: raw !== null && valid,
    title,
    preamble: preamble.join('\n').trim(),
    sections,
  }
}

export function renderDocument(doc: ParsedDocument): string {
  const parts: string[] = []
  if (doc.frontMatter.size > 0) parts.push(renderFrontMatter(doc.frontMatter))
  if (doc.title.length > 0) parts.push(`# ${doc.title}\n`)
  if (doc.preamble.length > 0) parts.push(`${doc.preamble}\n`)
  for (const section of doc.sections) {
    parts.push(section.body.length > 0 ? `## ${section.heading}\n\n${section.body}\n` : `## ${section.heading}\n`)
  }
  return parts.join('\n')
}

export function emptyDocument(
  frontMatter: Map<string, string>,
  title: string,
  seed: readonly string[] = [],
): ParsedDocument {
  return {
    frontMatter,
    frontMatterValid: true,
    title,
    preamble: '',
    sections: seed.map((heading) => ({ heading, body: '' })),
  }
}

export function upsertSection(
  doc: ParsedDocument,
  heading: string,
  body: string,
  order: readonly string[] = [],
): { doc: ParsedDocument; created: boolean; changed: boolean } {
  heading = heading.normalize('NFC')
  const index = doc.sections.findIndex((section) => section.heading.normalize('NFC') === heading)
  const trimmed = body.trim()

  if (index === -1) {
    const at = placementFor(doc, heading, order)
    const sections = [...doc.sections]
    sections.splice(at, 0, { heading, body: trimmed })
    return { doc: { ...doc, sections }, created: true, changed: true }
  }

  const existing = doc.sections[index]
  if (existing && existing.body === trimmed) return { doc, created: false, changed: false }

  const sections = [...doc.sections]
  sections[index] = { heading, body: trimmed }
  return { doc: { ...doc, sections }, created: false, changed: true }
}

function placementFor(doc: ParsedDocument, heading: string, order: readonly string[]): number {
  const canonical = order.indexOf(heading)
  if (canonical === -1) return doc.sections.length

  for (const [index, section] of doc.sections.entries()) {
    const position = order.indexOf(section.heading)
    if (position !== -1 && position > canonical) return index
  }
  return doc.sections.length
}

export function stampFrontMatter(doc: ParsedDocument, values: Record<string, string>): ParsedDocument {
  const frontMatter = new Map(doc.frontMatter)
  for (const [key, value] of Object.entries(values)) frontMatter.set(key, value)
  return { ...doc, frontMatter }
}

export function documentBody(doc: ParsedDocument): string {
  const parts: string[] = []
  if (doc.preamble.length > 0) parts.push(doc.preamble)
  for (const section of doc.sections) {
    if (section.body.length === 0) continue
    parts.push(`## ${section.heading}\n\n${section.body}`)
  }
  return parts.join('\n\n')
}

export function filledSections(doc: ParsedDocument): string[] {
  return doc.sections.filter((section) => section.body.length > 0).map((section) => section.heading)
}

export function sectionStates(doc: ParsedDocument, canonical: readonly string[]): DocSectionState[] {
  const seen = new Map<string, DocSection>()
  for (const section of doc.sections) {
    if (!seen.has(section.heading)) seen.set(section.heading, section)
  }

  const states: DocSectionState[] = canonical.map((heading) => {
    const section = seen.get(heading)
    if (!section) return { heading, state: 'absent', canonical: true }
    return { heading, state: section.body.length > 0 ? 'written' : 'empty', canonical: true }
  })

  for (const [heading, section] of seen) {
    if (canonical.includes(heading)) continue
    states.push({ heading, state: section.body.length > 0 ? 'written' : 'empty', canonical: false })
  }

  return states
}

export function outline(doc: ParsedDocument): DocHeading[] {
  const headings: DocHeading[] = []
  const taken = new Map<string, number>()

  const anchorFor = (heading: string): string => {
    const base = slugify(heading) || 'seccion'
    const used = taken.get(base) ?? 0
    taken.set(base, used + 1)
    return used === 0 ? base : `${base}-${used + 1}`
  }

  for (const section of doc.sections) {
    const subheadings = subheadingsOf(section.body)
    headings.push({
      heading: section.heading,
      level: 2,
      anchor: anchorFor(section.heading),
      order: headings.length,
      empty: bodyIsEmpty(section.body),
    })
    for (const sub of subheadings) {
      headings.push({
        heading: sub.heading,
        level: 3,
        anchor: anchorFor(sub.heading),
        order: headings.length,
        empty: sub.empty,
      })
    }
  }

  return headings
}

function subheadingsOf(body: string): { heading: string; empty: boolean }[] {
  const found: { heading: string; empty: boolean }[] = []
  const fenced = fenceTracker()

  for (const line of body.split('\n')) {
    if (fenced(line)) {
      if (found.length > 0) found[found.length - 1]!.empty = false
      continue
    }
    const match = /^###\s+(.*\S)\s*$/.exec(line)
    if (match?.[1]) {
      found.push({ heading: match[1], empty: true })
      continue
    }
    if (found.length > 0 && line.trim().length > 0) found[found.length - 1]!.empty = false
  }

  return found
}

function bodyIsEmpty(body: string): boolean {
  return body.trim().length === 0
}

export function checksumOf(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}
