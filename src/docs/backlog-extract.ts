import type { BacklogKind } from '../db/backlog.ts'
import type { DocSection, ParsedDocument } from './markdown.ts'

export interface ExtractedItem {
  kind: BacklogKind
  title: string
  body: string
  done: boolean
  heading: string
}

export interface BacklogSplit {
  items: ExtractedItem[]
  headings: string[]
}

const TITLE_MAX = 160

const PENDING_PREFIXES = [
  'pendiente',
  'pendientes',
  'limitaciones pendientes',
  'proximos pasos',
  'siguientes pasos',
  'por hacer',
  'queda pendiente',
  'lo que falta',
  'todo',
]

const FINDING_PREFIXES = ['hallazgo', 'hallazgos']

export function normalizeHeading(heading: string): string {
  return heading
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function backlogKindOf(heading: string): BacklogKind | null {
  const normalized = normalizeHeading(heading)
  const matches = (prefix: string) => normalized === prefix || normalized.startsWith(`${prefix} `)
  if (FINDING_PREFIXES.some(matches)) return 'finding'
  if (PENDING_PREFIXES.some(matches)) return 'pending'
  return null
}

const BULLET = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/

function cleanTitle(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleAndBody(first: string, rest: string): { title: string; body: string } {
  const cleaned = cleanTitle(first)
  if (cleaned.length <= TITLE_MAX) return { title: cleaned, body: rest.trim() }
  const cut = cleaned.slice(0, TITLE_MAX)
  const boundary = cut.lastIndexOf(' ')
  const title = `${(boundary > 60 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:]+$/, '')}…`
  return { title, body: [first.trim(), rest.trim()].filter((part) => part.length > 0).join('\n\n') }
}

function splitBlocks(body: string): { head: string; lines: string[]; done: boolean }[] {
  const blocks: { head: string; lines: string[]; done: boolean }[] = []
  let current: { head: string; lines: string[]; done: boolean } | null = null
  let inFence = false

  for (const line of body.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence
    const subheading = inFence ? null : /^###\s+(.*\S)\s*$/.exec(line)
    const bullet = inFence ? null : BULLET.exec(line)
    if (subheading?.[1]) {
      current = { head: subheading[1], lines: [], done: false }
      blocks.push(current)
      continue
    }
    if (bullet && !/^\s/.test(line)) {
      current = { head: bullet[2] ?? '', lines: [], done: (bullet[1] ?? ' ').toLowerCase() === 'x' }
      blocks.push(current)
      continue
    }
    if (current) {
      current.lines.push(line.replace(/^ {2,4}/, ''))
      continue
    }
    if (line.trim().length > 0) {
      current = { head: '', lines: [line], done: false }
      blocks.push(current)
    }
  }
  return blocks
}

function firstSentence(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, ' ').trim()
  return /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat
}

function isTable(text: string): boolean {
  return /^\s*\|/.test(text)
}

function describe(text: string, heading: string): { title: string; body: string } {
  const trimmed = text.trim()
  const [paragraph = ''] = trimmed.split(/\n\s*\n/)
  if (isTable(paragraph)) return { title: heading, body: trimmed }
  const lead = /^\s*\*\*(.+?)\*\*/.exec(paragraph)?.[1]
  const { title } = titleAndBody(lead ?? firstSentence(cleanTitle(paragraph)), '')
  const flatParagraph = cleanTitle(paragraph)
  return { title, body: flatParagraph === title && trimmed === paragraph.trim() ? '' : trimmed }
}

function itemsOf(section: DocSection, kind: BacklogKind): ExtractedItem[] {
  const blocks = splitBlocks(section.body)
  const structured = blocks.some((block) => block.head.length > 0)

  if (!structured) {
    if (section.body.trim().length === 0) return []
    const { title, body } = describe(section.body, section.heading)
    return [{ kind, title, body, done: false, heading: section.heading }]
  }

  const items: ExtractedItem[] = []
  for (const block of blocks) {
    if (block.head.length === 0) {
      const orphan = block.lines.join('\n').trim()
      const last = items.at(-1)
      if (orphan.length > 0 && last) last.body = [last.body, orphan].filter((part) => part.length > 0).join('\n\n')
      continue
    }
    const { title, body } = describe([block.head, ...block.lines].join('\n'), section.heading)
    if (title.length === 0) continue
    items.push({ kind, title, body, done: block.done, heading: section.heading })
  }
  return items
}

export function splitBacklog(doc: ParsedDocument): BacklogSplit {
  const items: ExtractedItem[] = []
  const headings: string[] = []
  for (const section of doc.sections) {
    const kind = backlogKindOf(section.heading)
    if (kind === null) continue
    headings.push(section.heading)
    items.push(...itemsOf(section, kind))
  }
  return { items, headings }
}

export function backlogHeadings(doc: ParsedDocument): string[] {
  return doc.sections.filter((section) => backlogKindOf(section.heading) !== null).map((section) => section.heading)
}
