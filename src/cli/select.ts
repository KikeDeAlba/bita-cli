import { StringDecoder } from 'node:string_decoder'

export const PAGE_SIZE = 10
export const ESCAPE_TIMEOUT_MS = 50

export interface SelectItem<T> {
  label: string
  hint?: string
  value: T
}

export interface SelectOptions<T> {
  title: string
  items: readonly SelectItem<T>[]
  initialIndex: number
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  env?: NodeJS.ProcessEnv
}

export type Key =
  | { name: 'up' | 'down' | 'home' | 'end' | 'pageup' | 'pagedown' | 'enter' | 'backspace' | 'clear' | 'escape' | 'interrupt' }
  | { name: 'char'; char: string }
  | { name: 'paste'; text: string }

export interface ScannedKey {
  key: Key
  end: number
}

export interface Scan {
  keys: ScannedKey[]
  rest: string
}

export interface SelectState<T> {
  title: string
  items: readonly SelectItem<T>[]
  initialIndex: number
  query: string
  matches: readonly number[]
  cursor: number
  offset: number
  pageSize: number
}

export type SelectStep<T> = SelectState<T> | { done: T } | { cancelled: true }

export interface RenderOptions {
  color: boolean
  width?: number
}

const ESC = '\x1b'
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_DOWN = `${ESC}[J`
const PASTE_MODE_ON = `${ESC}[?2004h`
const PASTE_MODE_OFF = `${ESC}[?2004l`
const PASTE_START = '200~'
const PASTE_OPEN = `${ESC}[${PASTE_START}`
const PASTE_END = `${ESC}[201~`
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g
const FINAL_BYTE = /[\x40-\x7e]/
const ZERO_WIDTH = /^[\p{M}\p{Cf}]*$/u
const EMOJI = /\p{Emoji_Presentation}|️/u
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const CSI_KEYS: Record<string, Key['name']> = {
  A: 'up',
  B: 'down',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '7~': 'home',
  '4~': 'end',
  '8~': 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

function graphemeWidth(grapheme: string): number {
  if (ZERO_WIDTH.test(grapheme)) return 0
  if (EMOJI.test(grapheme)) return 2
  const code = grapheme.codePointAt(0) ?? 0
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1
}

export function displayWidth(text: string): number {
  return graphemes(text).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0)
}

export function sanitize(text: string): string {
  return text.replace(CONTROLS, '')
}

export function pageSizeFor(rows: number | undefined): number {
  return rows ? Math.max(1, Math.min(PAGE_SIZE, rows - 3)) : PAGE_SIZE
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function filterItems<T>(items: readonly SelectItem<T>[], query: string): number[] {
  const needle = fold(query)
  const indexes: number[] = []
  for (const [index, item] of items.entries()) {
    if (needle === '' || fold(item.label).includes(needle) || (item.hint !== undefined && fold(item.hint).includes(needle))) indexes.push(index)
  }
  return indexes
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function scrolled<T>(state: SelectState<T>): SelectState<T> {
  const total = state.matches.length
  const size = state.pageSize
  let offset = state.offset
  if (state.cursor < offset) offset = state.cursor
  if (state.cursor >= offset + size) offset = state.cursor - size + 1
  offset = clamp(offset, 0, Math.max(0, total - size))
  return { ...state, offset }
}

export function createState<T>(title: string, items: readonly SelectItem<T>[], initialIndex: number, pageSize = PAGE_SIZE): SelectState<T> {
  const matches = filterItems(items, '')
  const cursor = matches.length === 0 ? 0 : clamp(initialIndex, 0, matches.length - 1)
  return scrolled({ title, items, initialIndex: cursor, query: '', matches, cursor, offset: 0, pageSize: Math.max(1, pageSize) })
}

function withQuery<T>(state: SelectState<T>, query: string, jumpToFirst: boolean): SelectState<T> {
  const matches = filterItems(state.items, query)
  const current = state.matches[state.cursor]
  let cursor = 0
  if (!jumpToFirst) {
    const kept = current === undefined ? -1 : matches.indexOf(current)
    if (kept >= 0) cursor = kept
    else if (query === '') cursor = state.initialIndex
  }
  return scrolled({ ...state, query, matches, cursor: matches.length === 0 ? 0 : clamp(cursor, 0, matches.length - 1), offset: 0 })
}

function moved<T>(state: SelectState<T>, cursor: number): SelectState<T> {
  return scrolled({ ...state, cursor })
}

export function reduce<T>(state: SelectState<T>, key: Key): SelectStep<T> {
  const total = state.matches.length
  switch (key.name) {
    case 'interrupt':
      return { cancelled: true }
    case 'escape':
      return state.query === '' ? { cancelled: true } : withQuery(state, '', false)
    case 'clear':
      return state.query === '' ? state : withQuery(state, '', false)
    case 'backspace':
      return state.query === '' ? state : withQuery(state, graphemes(state.query).slice(0, -1).join(''), false)
    case 'char':
      return withQuery(state, state.query + key.char, true)
    case 'paste':
      return withQuery(state, state.query + key.text, true)
    case 'enter': {
      const index = state.matches[state.cursor]
      const item = index === undefined ? undefined : state.items[index]
      return item ? { done: item.value } : state
    }
  }
  if (total === 0) return state
  switch (key.name) {
    case 'up':
      return moved(state, (state.cursor - 1 + total) % total)
    case 'down':
      return moved(state, (state.cursor + 1) % total)
    case 'home':
      return moved(state, 0)
    case 'end':
      return moved(state, total - 1)
    case 'pageup':
      return moved(state, Math.max(0, state.cursor - state.pageSize))
    case 'pagedown':
      return moved(state, Math.min(total - 1, state.cursor + state.pageSize))
  }
}

function codePointAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) ?? 0)
}

export function scanKeys(text: string, final: boolean): Scan {
  const keys: ScannedKey[] = []
  let typed = false
  let index = 0
  const push = (key: Key, end: number): void => {
    keys.push({ key, end })
    index = end
  }
  const incomplete = (): Scan => ({ keys, rest: text.slice(index) })

  while (index < text.length) {
    const char = codePointAt(text, index)
    if (char === ESC) {
      const next = text[index + 1]
      if (next === undefined) {
        if (!final) return incomplete()
        push({ name: 'escape' }, index + 1)
        continue
      }
      if (next === '[' || next === 'O') {
        let end = index + 2
        if (next === '[') while (end < text.length && !FINAL_BYTE.test(text[end]!)) end += 1
        if (end >= text.length) {
          if (!final) return incomplete()
          index = text.length
          continue
        }
        const body = text.slice(index + 2, end + 1)
        if (next === '[' && body === PASTE_START) {
          const close = text.indexOf(PASTE_END, end + 1)
          if (close < 0 && !final) return incomplete()
          const pasted = sanitize(text.slice(end + 1, close < 0 ? text.length : close))
          const after = close < 0 ? text.length : close + PASTE_END.length
          if (pasted === '') index = after
          else {
            push({ name: 'paste', text: pasted }, after)
            typed = true
          }
          continue
        }
        const name = CSI_KEYS[body.replace(/^1;\d+(?=[A-Z]$)/, '')]
        if (name) push({ name } as Key, end + 1)
        else index = end + 1
        continue
      }
      const alt = codePointAt(text, index + 1)
      if (alt === '\r') index += 2
      else if (CONTROL.test(alt)) push({ name: 'escape' }, index + 1)
      else index += 1 + alt.length
      continue
    }
    if (char === '\r' || char === '\n') {
      const end = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1
      if (typed && end < text.length) index = end
      else push({ name: 'enter' }, end)
      continue
    }
    const end = index + char.length
    if (char === '\x03') push({ name: 'interrupt' }, end)
    else if (char === '\x7f' || char === '\b') push({ name: 'backspace' }, end)
    else if (char === '\x15') push({ name: 'clear' }, end)
    else if (!CONTROL.test(char)) {
      push({ name: 'char', char }, end)
      typed = true
    } else index = end
  }
  return { keys, rest: '' }
}

export function parseKeys(text: string): Key[] {
  return scanKeys(text, true).keys.map((scanned) => scanned.key)
}

function paint(color: boolean, code: string, text: string): string {
  return color && text !== '' ? `${ESC}[${code}m${text}${ESC}[0m` : text
}

function fit(parts: readonly string[], width: number | undefined): string[] {
  if (width === undefined || width <= 1) return [...parts]
  if (displayWidth(parts.join('')) < width) return [...parts]
  const budget = width - 2
  let used = 0
  let cut = false
  return parts.map((part) => {
    if (cut) return ''
    let kept = ''
    for (const grapheme of graphemes(part)) {
      const size = graphemeWidth(grapheme)
      if (used + size > budget) {
        cut = true
        return `${kept}…`
      }
      used += size
      kept += grapheme
    }
    return kept
  })
}

function truncate(text: string, width: number | undefined): string {
  return fit([text], width)[0]!
}

function itemText<T>(item: SelectItem<T>): string {
  const label = sanitize(item.label)
  return item.hint === undefined ? label : `${label} (${sanitize(item.hint)})`
}

export function render<T>(state: SelectState<T>, options: RenderOptions): string {
  const { color, width } = options
  const empty = state.query === ''
  const [head = '', gap = '', prompt = ''] = fit([`${sanitize(state.title)}:`, ' ', empty ? 'type to search' : `${state.query}▏`], width)
  const lines = [`${paint(color, '1', head)}${gap}${empty ? paint(color, '2', prompt) : prompt}`]
  if (state.matches.length === 0) lines.push(paint(color, '2', truncate('  No matches', width)))
  const visible = state.matches.slice(state.offset, state.offset + state.pageSize)
  for (const [position, index] of visible.entries()) {
    const item = state.items[index]!
    const selected = state.offset + position === state.cursor
    const text = truncate(`${selected ? '❯' : ' '} ${itemText(item)}`, width)
    lines.push(selected ? paint(color, '36', text) : text)
  }
  if (state.matches.length > state.pageSize) {
    const footer = `  ${state.offset + 1}-${state.offset + visible.length} of ${state.matches.length}`
    lines.push(paint(color, '2', truncate(footer, width)))
  }
  return lines.join('\n')
}

export function collapsed<T>(title: string, item: SelectItem<T>): string {
  return `${sanitize(title)}: ${sanitize(item.label)}`
}

function useColor(output: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  return typeof output.hasColors === 'function' && output.hasColors()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function select<T>(options: SelectOptions<T>): Promise<T | null> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const color = useColor(output, options.env ?? process.env)
  const wasRaw = input.isRaw === true
  const decoder = new StringDecoder('utf8')
  let state = createState(options.title, options.items, options.initialIndex, pageSizeFor(output.rows))
  let drawnLines = 0
  let pending = ''
  let paste: string | undefined
  let timer: NodeJS.Timeout | undefined

  const erase = (): string => (drawnLines > 1 ? `${ESC}[${drawnLines - 1}A\r${CLEAR_DOWN}` : `\r${CLEAR_DOWN}`)
  const draw = (): void => {
    const frame = render(state, { color, ...(output.columns ? { width: output.columns } : {}) })
    output.write(erase() + frame)
    drawnLines = frame.split('\n').length
  }
  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return new Promise<T | null>((resolve, reject) => {
    let settled = false
    const restore = (): Error | undefined => {
      let failure: Error | undefined
      const steps = [
        stopTimer,
        () => input.off('data', onData),
        () => input.off('end', onEnd),
        () => input.off('error', onError),
        () => process.off('SIGTERM', onTerm),
        () => {
          if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw)
        },
        () => output.write(PASTE_MODE_OFF),
        () => output.write(SHOW_CURSOR),
        () => input.pause(),
      ]
      for (const step of steps) {
        try {
          step()
        } catch (error) {
          failure ??= asError(error)
        }
      }
      return failure
    }
    const finish = (value: T | null, line: string | null, leftover = ''): void => {
      if (settled) return
      settled = true
      let failure: Error | undefined
      try {
        output.write(erase() + (line === null ? '' : `${line}\n`))
      } catch (error) {
        failure = asError(error)
      }
      const restoreFailure = restore()
      failure ??= restoreFailure
      if (leftover !== '') {
        try {
          input.unshift(Buffer.from(leftover, 'utf8'))
        } catch (error) {
          failure ??= asError(error)
        }
      }
      if (failure) reject(failure)
      else resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      restore()
      reject(asError(error))
    }
    const consume = (text: string, final: boolean): void => {
      const scan = scanKeys(text, final)
      for (const { key, end } of scan.keys) {
        const step = reduce(state, key)
        if ('cancelled' in step) return finish(null, null, text.slice(end))
        if ('done' in step) {
          const index = state.matches[state.cursor]!
          return finish(step.done, collapsed(state.title, state.items[index]!), text.slice(end))
        }
        state = step
      }
      if (scan.rest.startsWith(PASTE_OPEN)) paste = scan.rest.slice(PASTE_OPEN.length)
      else {
        pending = scan.rest
        if (pending !== '') timer = setTimeout(onTimeout, ESCAPE_TIMEOUT_MS)
      }
      draw()
    }
    const onData = (chunk: Buffer | string): void => {
      try {
        stopTimer()
        const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk)
        if (paste !== undefined) {
          const from = Math.max(0, paste.length - PASTE_END.length + 1)
          paste += decoded
          if (paste.indexOf(PASTE_END, from) < 0) return
          const text = PASTE_OPEN + paste
          paste = undefined
          return consume(text, false)
        }
        const text = pending + decoded
        pending = ''
        consume(text, false)
      } catch (error) {
        fail(error)
      }
    }
    const onTimeout = (): void => {
      timer = undefined
      try {
        const text = pending
        pending = ''
        consume(text, true)
      } catch (error) {
        fail(error)
      }
    }
    const onEnd = (): void => finish(null, null)
    const onError = (error: Error): void => fail(error)
    const onTerm = (): void => {
      finish(null, null)
      process.kill(process.pid, 'SIGTERM')
    }

    try {
      if (typeof input.setRawMode === 'function') input.setRawMode(true)
      output.write(HIDE_CURSOR + PASTE_MODE_ON)
      process.on('SIGTERM', onTerm)
      input.on('data', onData)
      input.on('end', onEnd)
      input.on('error', onError)
      input.resume()
      draw()
    } catch (error) {
      fail(error)
    }
  })
}
