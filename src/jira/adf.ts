import { marked, type Token, type Tokens } from 'marked'

export interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface AdfNode {
  type: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
  text?: string
  marks?: AdfMark[]
}

export interface AdfDocument {
  version: 1
  type: 'doc'
  content: AdfNode[]
}

function textNode(text: string, marks: AdfMark[]): AdfNode[] {
  if (text.length === 0) return []
  return [marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text }]
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function inline(tokens: readonly Token[] | undefined, marks: AdfMark[] = []): AdfNode[] {
  const nodes: AdfNode[] = []
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        nodes.push(...inline((token as Tokens.Strong).tokens, [...marks, { type: 'strong' }]))
        break
      case 'em':
        nodes.push(...inline((token as Tokens.Em).tokens, [...marks, { type: 'em' }]))
        break
      case 'del':
        nodes.push(...inline((token as Tokens.Del).tokens, [...marks, { type: 'strike' }]))
        break
      case 'codespan':
        nodes.push(...textNode(decodeEntities((token as Tokens.Codespan).text), [...marks, { type: 'code' }]))
        break
      case 'link': {
        const link = token as Tokens.Link
        nodes.push(...inline(link.tokens, [...marks, { type: 'link', attrs: { href: link.href } }]))
        break
      }
      case 'image': {
        const image = token as Tokens.Image
        nodes.push(...textNode(image.text || image.href, [...marks, { type: 'link', attrs: { href: image.href } }]))
        break
      }
      case 'br':
        nodes.push({ type: 'hardBreak' })
        break
      case 'text': {
        const text = token as Tokens.Text
        if (text.tokens && text.tokens.length > 0) nodes.push(...inline(text.tokens, marks))
        else nodes.push(...textNode(decodeEntities(text.text), marks))
        break
      }
      case 'escape':
        nodes.push(...textNode((token as Tokens.Escape).text, marks))
        break
      default:
        nodes.push(...textNode(decodeEntities(token.raw), marks))
    }
  }
  return nodes
}

function paragraph(tokens: readonly Token[] | undefined): AdfNode[] {
  const content = inline(tokens)
  return content.length > 0 ? [{ type: 'paragraph', content }] : []
}

function listItem(item: Tokens.ListItem): AdfNode {
  const content: AdfNode[] = []
  for (const child of item.tokens) {
    if (child.type === 'checkbox') continue
    if (child.type === 'text') {
      const text = child as Tokens.Text
      content.push(...paragraph(text.tokens ?? [{ type: 'text', raw: text.text, text: text.text } as Tokens.Text]))
    } else {
      content.push(...block([child]))
    }
  }
  if (item.task) {
    const marker: AdfNode = { type: 'text', text: item.checked ? '[x] ' : '[ ] ' }
    const first = content[0]
    if (first?.type === 'paragraph') first.content = [marker, ...(first.content ?? [])]
    else content.unshift({ type: 'paragraph', content: [marker] })
  }
  return { type: 'listItem', content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }] }
}

function tableCell(cell: Tokens.TableCell, header: boolean): AdfNode {
  return { type: header ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: inline(cell.tokens) }] }
}

function block(tokens: readonly Token[]): AdfNode[] {
  const nodes: AdfNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading
        nodes.push({ type: 'heading', attrs: { level: Math.min(6, heading.depth) }, content: inline(heading.tokens) })
        break
      }
      case 'paragraph':
        nodes.push(...paragraph((token as Tokens.Paragraph).tokens))
        break
      case 'text': {
        const text = token as Tokens.Text
        nodes.push(...paragraph(text.tokens ?? [token]))
        break
      }
      case 'list': {
        const list = token as Tokens.List
        nodes.push({
          type: list.ordered ? 'orderedList' : 'bulletList',
          ...(list.ordered ? { attrs: { order: typeof list.start === 'number' ? list.start : 1 } } : {}),
          content: list.items.map(listItem),
        })
        break
      }
      case 'code': {
        const code = token as Tokens.Code
        nodes.push({
          type: 'codeBlock',
          ...(code.lang ? { attrs: { language: code.lang } } : {}),
          content: code.text.length > 0 ? [{ type: 'text', text: code.text }] : [],
        })
        break
      }
      case 'blockquote':
        nodes.push({ type: 'blockquote', content: block((token as Tokens.Blockquote).tokens) })
        break
      case 'hr':
        nodes.push({ type: 'rule' })
        break
      case 'table': {
        const table = token as Tokens.Table
        nodes.push({
          type: 'table',
          content: [
            { type: 'tableRow', content: table.header.map((cell) => tableCell(cell, true)) },
            ...table.rows.map((row) => ({ type: 'tableRow', content: row.map((cell) => tableCell(cell, false)) })),
          ],
        })
        break
      }
      case 'space':
        break
      default:
        if (token.raw.trim().length > 0) nodes.push({ type: 'paragraph', content: textNode(token.raw.trim(), []) })
    }
  }
  return nodes
}

export function markdownToAdf(markdown: string): AdfDocument {
  return { version: 1, type: 'doc', content: block(marked.lexer(markdown)) }
}

function applyMarks(text: string, marks: readonly AdfMark[] | undefined): string {
  let out = text
  for (const mark of marks ?? []) {
    if (mark.type === 'strong') out = `**${out}**`
    else if (mark.type === 'em') out = `*${out}*`
    else if (mark.type === 'code') out = `\`${out}\``
    else if (mark.type === 'strike') out = `~~${out}~~`
    else if (mark.type === 'link') out = `[${out}](${String(mark.attrs?.['href'] ?? '')})`
  }
  return out
}

function inlineText(nodes: readonly AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === 'text') return applyMarks(node.text ?? '', node.marks)
      if (node.type === 'hardBreak') return '\n'
      if (node.type === 'mention') return String(node.attrs?.['text'] ?? '@someone')
      if (node.type === 'emoji') return String(node.attrs?.['text'] ?? node.attrs?.['shortName'] ?? '')
      if (node.type === 'inlineCard') return String(node.attrs?.['url'] ?? '')
      return inlineText(node.content)
    })
    .join('')
}

function blockText(nodes: readonly AdfNode[] | undefined, indent = ''): string[] {
  const out: string[] = []
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'heading':
        out.push(`${'#'.repeat(Number(node.attrs?.['level'] ?? 2))} ${inlineText(node.content)}`)
        break
      case 'paragraph':
        out.push(`${indent}${inlineText(node.content)}`)
        break
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList'
        const start = Number(node.attrs?.['order'] ?? 1)
        const lines: string[] = []
        for (const [index, item] of (node.content ?? []).entries()) {
          const marker = ordered ? `${start + index}. ` : '- '
          const inner = blockText(item.content, `${indent}${' '.repeat(marker.length)}`)
          const [first = '', ...rest] = inner
          lines.push(`${indent}${marker}${first.trimStart()}`, ...rest.filter((line) => line.trim().length > 0))
        }
        out.push(lines.join('\n'))
        break
      }
      case 'codeBlock':
        out.push(`\`\`\`${String(node.attrs?.['language'] ?? '')}\n${inlineText(node.content)}\n\`\`\``)
        break
      case 'blockquote':
        out.push(blockText(node.content).map((line) => line.split('\n').map((part) => `> ${part}`).join('\n')).join('\n>\n'))
        break
      case 'rule':
        out.push('---')
        break
      case 'table': {
        const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => blockText(cell.content).join(' ').replace(/\|/g, '\\|')))
        const [head, ...body] = rows
        if (head) {
          out.push([`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((row) => `| ${row.join(' | ')} |`)].join('\n'))
        }
        break
      }
      default:
        if (node.content) out.push(...blockText(node.content, indent))
        else if (node.text) out.push(node.text)
    }
  }
  return out
}

export function adfToMarkdown(document: unknown): string {
  if (document === null || typeof document !== 'object') return typeof document === 'string' ? document : ''
  return blockText((document as AdfDocument).content).join('\n\n').trim()
}
