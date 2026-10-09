import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Marked, type Token, type Tokens } from 'marked'
import { formatDuration } from '../domain/duration.ts'

export type MeetingMode = 'remote' | 'in-person'

export interface MinutesDocument {
  title: string
  projectName: string | null
  clientName: string | null
  startedAt: string
  durationSeconds: number | null
  mode: MeetingMode | null
  timezone: string
  summaryMarkdown: string
  meetingDir: string
}

export type MermaidRenderer = (source: string, name: string) => Promise<string | null>

export interface MinutesOptions {
  styles: string
  renderMermaid: MermaidRenderer
}

export const MINUTES_HEADING = 'Minuta de la reunión'
export const ASSETS_DIR = fileURLToPath(new URL('../../assets/export/', import.meta.url))

const FONTS = [
  { family: 'Instrument Sans', weight: '400 700', file: 'instrument-sans-var.woff2' },
  { family: 'IBM Plex Mono', weight: '400', file: 'ibm-plex-mono-400.woff2' },
  { family: 'IBM Plex Mono', weight: '500', file: 'ibm-plex-mono-500.woff2' },
  { family: 'IBM Plex Mono', weight: '600', file: 'ibm-plex-mono-600.woff2' },
]

const GENERIC_TITLES = [/^(remote|in[- ]person)\s+meeting$/i, /^reuni[oó]n(\s+(remota|presencial))?$/i, /^meeting$/i]

const MODALITY: Record<MeetingMode, string> = { remote: 'Remota', 'in-person': 'Presencial' }

export function isGenericTitle(title: string): boolean {
  const trimmed = title.trim()
  return GENERIC_TITLES.some((pattern) => pattern.test(trimmed))
}

export function pickTitle(candidates: readonly (string | null | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (trimmed.length > 0 && !isGenericTitle(trimmed)) return trimmed
  }
  return fallback
}

export function minutesBody(markdown: string): string {
  const start = markdown.search(/^##\s+/m)
  return start === -1 ? markdown : markdown.slice(start)
}

export async function loadPrintStyles(assetsDir: string = ASSETS_DIR): Promise<string> {
  const css = await readFile(resolve(assetsDir, 'print.css'), 'utf8')
  const faces: string[] = []
  for (const font of FONTS) {
    try {
      const data = (await readFile(resolve(assetsDir, 'fonts', font.file))).toString('base64')
      faces.push(
        `@font-face {\n  font-family: '${font.family}';\n  src: url(data:font/woff2;base64,${data}) format('woff2');\n  font-weight: ${font.weight};\n  font-style: normal;\n}`,
      )
    } catch {
      continue
    }
  }
  return `${faces.join('\n\n')}\n\n${css}`
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}

export function meetingDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-MX', { timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
}

export function meetingTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-MX', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
}

function resolveAsset(href: string, meetingDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href
  const [path = '', ...rest] = href.split(/(?=[?#])/)
  const absolute = isAbsolute(path) ? path : resolve(meetingDir, decodeURI(path))
  return `${pathToFileURL(absolute).href}${rest.join('')}`
}

async function renderDiagrams(tokens: Token[], marked: Marked, render: MermaidRenderer): Promise<Map<string, string>> {
  const sources: string[] = []
  marked.walkTokens(tokens, (token) => {
    if (token.type === 'code' && (token as Tokens.Code).lang?.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
      const text = (token as Tokens.Code).text
      if (!sources.includes(text)) sources.push(text)
    }
  })
  const rendered = new Map<string, string>()
  for (const [index, source] of sources.entries()) {
    try {
      const svg = await render(source, `mermaid-${index + 1}`)
      if (svg !== null && svg.includes('<svg')) rendered.set(source, svg.slice(svg.indexOf('<svg')))
    } catch {
      continue
    }
  }
  return rendered
}

export async function minutesBodyHtml(markdown: string, meetingDir: string, renderMermaid: MermaidRenderer): Promise<string> {
  const marked = new Marked({ gfm: true })
  const tokens = marked.lexer(minutesBody(markdown))
  const diagrams = await renderDiagrams(tokens, marked, renderMermaid)
  marked.use({
    renderer: {
      code(token: Tokens.Code): string | false {
        const svg = diagrams.get(token.text)
        return svg === undefined ? false : `<figure class="md-mermaid">${svg}</figure>\n`
      },
      image(token: Tokens.Image): string {
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<img src="${escapeHtml(resolveAsset(token.href, meetingDir))}" alt="${escapeHtml(token.text)}"${title}>`
      },
    },
  })
  const html = marked.parser(tokens)
  return html.replace(/<table>/g, '<div class="md-table-scroll"><table>').replace(/<\/table>/g, '</table></div>')
}

export async function buildMinutesHtml(doc: MinutesDocument, options: MinutesOptions): Promise<string> {
  const date = meetingDate(doc.startedAt, doc.timezone)
  const time = meetingTime(doc.startedAt, doc.timezone)
  const duration = doc.durationSeconds === null ? null : formatDuration(doc.durationSeconds)
  const modality = doc.mode === null ? null : MODALITY[doc.mode]
  const kicker = [doc.projectName ?? 'Sin proyecto', doc.clientName].filter(Boolean).join(' · ')
  const meta = [`${date}, ${time}`, duration, modality].filter((part): part is string => part !== null).join(' · ')
  const details: [string, string][] = [
    ['Fecha', capitalize(date)],
    ['Hora', time],
    ...(duration === null ? [] : ([['Duración', duration]] as [string, string][])),
    ...(modality === null ? [] : ([['Modalidad', modality]] as [string, string][])),
    ['Proyecto', doc.projectName ?? 'Sin proyecto'],
  ]
  const body = await minutesBodyHtml(doc.summaryMarkdown, doc.meetingDir, options.renderMermaid)

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
${options.styles}
</style>
</head>
<body>
<div id="print-root" class="print-root">
<section class="print-cover">
<div class="print-kicker">${escapeHtml(kicker)}</div>
<h1 class="print-cover-title">${escapeHtml(doc.title)}</h1>
<div class="print-cover-meta">${escapeHtml(meta)}</div>
<div class="print-index">
<h2 class="print-index-title">Reunión</h2>
${details.map(([label, value]) => `<div class="print-index-line"><span class="print-index-number">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`).join('\n')}
</div>
</section>
<section class="print-page">
<div class="print-crumb">${escapeHtml(`${doc.projectName ?? 'Sin proyecto'} / ${doc.title}`)}</div>
<h1 class="print-title">${MINUTES_HEADING}</h1>
<article class="article">
${body}
</article>
</section>
</div>
</body>
</html>
`
}
