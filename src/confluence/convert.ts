import { Marked, type Tokens } from 'marked'
import TurndownService from 'turndown'
import domino, { type DomDocument, type DomElement, type DomNode } from '@mixmark-io/domino'

const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']

const CONTAINER_MACROS = new Set(['info', 'note', 'warning', 'tip', 'panel', 'expand'])
const TRANSPARENT_MACROS = new Set(['excerpt', 'section', 'column', 'details', 'div', 'span'])

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
}

const storageMarked = new Marked({
  gfm: true,
  renderer: {
    code(token: Tokens.Code): string {
      const language = token.lang?.trim().split(/\s+/)[0] ?? ''
      const parameter = language.length > 0 ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` : ''
      return `<ac:structured-macro ac:name="code">${parameter}<ac:plain-text-body>${cdata(token.text)}</ac:plain-text-body></ac:structured-macro>\n`
    },
    hr(): string {
      return '<hr />\n'
    },
    br(): string {
      return '<br />'
    },
    checkbox({ checked }: Tokens.Checkbox): string {
      return checked ? '[x] ' : '[ ] '
    },
    image({ href, text }: Tokens.Image): string {
      const target = isExternal(href)
        ? `<ri:url ri:value="${escapeXml(href)}" />`
        : `<ri:attachment ri:filename="${escapeXml(decodeURIComponent(href.split('/').pop() ?? href))}" />`
      return `<ac:image${text ? ` ac:alt="${escapeXml(text)}"` : ''}>${target}</ac:image>`
    },
  },
})

function selfCloseVoids(html: string): string {
  const pattern = new RegExp(`<(${VOID_TAGS.join('|')})(\\s[^<>]*?)?\\s*/?>`, 'gi')
  return html.replace(pattern, (_whole, tag: string, attrs: string | undefined) => `<${tag}${(attrs ?? '').replace(/\s+$/, '')} />`)
}

function normalizeTables(html: string): string {
  return html
    .replace(/<\/?(thead|tbody)>\n?/g, '')
    .replace(/<table>\n?/g, '<table><tbody>')
    .replace(/<\/table>/g, '</tbody></table>')
}

export function markdownToStorage(markdown: string): string {
  const html = storageMarked.parse(markdown, { async: false })
  return normalizeTables(selfCloseVoids(html)).trim()
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function prepareStorage(storage: string): string {
  const voids = new Set(VOID_TAGS)
  return storage
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, text: string) => escapeHtmlText(text))
    .replace(/<([a-zA-Z][\w:-]*)((?:\s[^<>]*?)?)\s*\/>/g, (whole, tag: string, attrs: string) =>
      voids.has(tag.toLowerCase()) ? whole : `<${tag}${attrs}></${tag}>`,
    )
}

function nameOf(node: DomNode): string {
  return node.nodeName.toLowerCase()
}

function elementsOf(root: DomNode): DomElement[] {
  const found: DomElement[] = []
  const walk = (node: DomNode): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        found.push(child as DomElement)
        walk(child)
      }
    }
  }
  walk(root)
  return found
}

function childByName(element: DomElement, name: string, attribute?: [string, string]): DomElement | undefined {
  return Array.from(element.children).find(
    (child) => nameOf(child) === name && (attribute === undefined || child.getAttribute(attribute[0]) === attribute[1]),
  )
}

function replaceWith(target: DomNode, nodes: DomNode[]): void {
  const parent = target.parentNode
  if (parent === null) return
  for (const node of nodes) parent.insertBefore(node, target)
  parent.removeChild(target)
}

function unwrap(element: DomNode): void {
  replaceWith(element, Array.from(element.childNodes))
}

function paragraph(document: DomDocument, text: string): DomElement {
  const p = document.createElement('p')
  p.textContent = text
  return p
}

function convertMacro(document: DomDocument, macro: DomElement): void {
  const name = (macro.getAttribute('ac:name') ?? '').toLowerCase()
  if (name === 'code' || name === 'noformat') {
    const declared = childByName(macro, 'ac:parameter', ['ac:name', 'language'])?.textContent?.trim() ?? ''
    const language = declared.toLowerCase() === 'none' ? '' : declared
    const body = childByName(macro, 'ac:plain-text-body')?.textContent ?? ''
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    if (language.length > 0) code.setAttribute('class', `language-${language}`)
    code.textContent = body
    pre.appendChild(code)
    replaceWith(macro, [pre])
    return
  }

  const rich = childByName(macro, 'ac:rich-text-body')
  if (rich && CONTAINER_MACROS.has(name)) {
    const quote = document.createElement('blockquote')
    const title = childByName(macro, 'ac:parameter', ['ac:name', 'title'])?.textContent?.trim()
    if (title) {
      const strong = document.createElement('p')
      strong.innerHTML = `<strong>${escapeHtmlText(title)}</strong>`
      quote.appendChild(strong)
    }
    for (const child of Array.from(rich.childNodes)) quote.appendChild(child)
    replaceWith(macro, [quote])
    return
  }
  if (rich && TRANSPARENT_MACROS.has(name)) {
    replaceWith(macro, Array.from(rich.childNodes))
    return
  }

  replaceWith(macro, [paragraph(document, `[Confluence macro: ${name || 'unknown'}]`)])
}

function convertImage(document: DomDocument, image: DomElement): void {
  const attachment = childByName(image, 'ri:attachment')
  const url = childByName(image, 'ri:url')
  const src = url?.getAttribute('ri:value') ?? attachment?.getAttribute('ri:filename') ?? ''
  if (src.length === 0) {
    replaceWith(image, [])
    return
  }
  const img = document.createElement('img')
  img.setAttribute('src', url ? src : encodeURI(src))
  img.setAttribute('alt', image.getAttribute('ac:alt') ?? src.split('/').pop() ?? '')
  replaceWith(image, [img])
}

function convertLink(document: DomDocument, link: DomElement): void {
  const body = childByName(link, 'ac:link-body') ?? childByName(link, 'ac:plain-text-link-body')
  const page = childByName(link, 'ri:page')
  const attachment = childByName(link, 'ri:attachment')
  const user = childByName(link, 'ri:user')
  const label =
    body?.textContent?.trim() ||
    page?.getAttribute('ri:content-title') ||
    attachment?.getAttribute('ri:filename') ||
    (user ? '@user' : '') ||
    ''
  replaceWith(link, label.length > 0 ? [document.createTextNode(label)] : [])
}

function convertTaskList(document: DomDocument, list: DomElement): void {
  const ul = document.createElement('ul')
  for (const task of Array.from(list.children).filter((child) => nameOf(child) === 'ac:task')) {
    const done = childByName(task, 'ac:task-status')?.textContent?.trim() === 'complete'
    const body = childByName(task, 'ac:task-body')
    const li = document.createElement('li')
    li.appendChild(document.createTextNode(done ? '[x] ' : '[ ] '))
    for (const child of Array.from(body?.childNodes ?? [])) li.appendChild(child)
    ul.appendChild(li)
  }
  replaceWith(list, [ul])
}

function storageDocument(storage: string): DomDocument {
  const document = domino.createDocument(`<!doctype html><html><body>${prepareStorage(storage)}</body></html>`)
  for (const element of elementsOf(document.body).reverse()) {
    const name = nameOf(element)
    if (name === 'ac:structured-macro' || name === 'ac:macro') convertMacro(document, element)
    else if (name === 'ac:image') convertImage(document, element)
    else if (name === 'ac:link') convertLink(document, element)
    else if (name === 'ac:task-list') convertTaskList(document, element)
    else if (name === 'ac:emoticon' || name === 'ac:placeholder') replaceWith(element, [])
    else if (name === 'time') replaceWith(element, [document.createTextNode(element.getAttribute('datetime') ?? element.textContent ?? '')])
  }
  for (const element of elementsOf(document.body).reverse()) {
    const name = nameOf(element)
    if (name === 'ac:parameter') replaceWith(element, [])
    else if (name.startsWith('ac:') || name.startsWith('ri:')) unwrap(element)
  }
  return document
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (whole) => whole.replace('_', '\\_'))
    .replace(/^(#{1,6})(\s)/gm, '\\$1$2')
    .replace(/^([-+])(\s)/gm, '\\$1$2')
    .replace(/^(\d+)\.(\s)/gm, '$1\\.$2')
    .replace(/^>/gm, '\\>')
    .replace(/^(=+)$/gm, '\\$1')
}

function cellText(service: TurndownService, cell: DomElement): string {
  return service
    .turndown(cell.innerHTML)
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
  })
  service.escape = escapeMarkdown

  service.addRule('listItem', {
    filter: 'li',
    replacement(content, node) {
      const element = node as unknown as DomElement
      const parent = element.parentNode as DomElement | null
      let prefix = '- '
      if (parent && nameOf(parent) === 'ol') {
        const start = Number(parent.getAttribute('start') ?? '1')
        const index = Array.from(parent.children).indexOf(element)
        prefix = `${(Number.isFinite(start) ? start : 1) + index}. `
      }
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, `\n${' '.repeat(prefix.length)}`)
      return `${prefix}${body}${element.nextSibling && !/\n$/.test(body) ? '\n' : ''}`
    },
  })

  service.addRule('table', {
    filter: 'table',
    replacement(_content, node) {
      const rows = elementsOf(node as unknown as DomElement).filter((element) => nameOf(element) === 'tr')
      const cells = rows.map((row) =>
        Array.from(row.children)
          .filter((cell) => nameOf(cell) === 'th' || nameOf(cell) === 'td')
          .map((cell) => cellText(service, cell)),
      )
      const [head, ...body] = cells
      if (!head || head.length === 0) return ''
      const width = Math.max(...cells.map((row) => row.length))
      const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => '')]
      const lines = [
        `| ${pad(head).join(' | ')} |`,
        `| ${pad(head).map(() => '---').join(' | ')} |`,
        ...body.map((row) => `| ${pad(row).join(' | ')} |`),
      ]
      return `\n\n${lines.join('\n')}\n\n`
    },
  })

  return service
}

export function storageToMarkdown(storage: string): string {
  const document = storageDocument(storage)
  return createTurndown().turndown(document.body.innerHTML).trim()
}
