import { StringDecoder } from 'node:string_decoder'

export const PAGE_SIZE = 10

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

export interface SelectState<T> {
  title: string
  items: readonly SelectItem<T>[]
  initialIndex: number
  query: string
  matches: readonly number[]
  cursor: number
  offset: number
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
  let offset = state.offset
  if (state.cursor < offset) offset = state.cursor
  if (state.cursor >= offset + PAGE_SIZE) offset = state.cursor - PAGE_SIZE + 1
  offset = clamp(offset, 0, Math.max(0, total - PAGE_SIZE))
  return { ...state, offset }
}

export function createState<T>(title: string, items: readonly SelectItem<T>[], initialIndex: number): SelectState<T> {
  const matches = filterItems(items, '')
  const cursor = matches.length === 0 ? 0 : clamp(initialIndex, 0, matches.length - 1)
  return scrolled({ title, items, initialIndex: cursor, query: '', matches, cursor, offset: 0 })
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
      return state.query === '' ? state : withQuery(state, Array.from(state.query).slice(0, -1).join(''), false)
    case 'char':
      return withQuery(state, state.query + key.char, true)
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
      return moved(state, Math.max(0, state.cursor - PAGE_SIZE))
    case 'pagedown':
      return moved(state, Math.min(total - 1, state.cursor + PAGE_SIZE))
  }
}

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  const chars = Array.from(chunk)
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!
    if (char === ESC) {
      const next = chars[index + 1]
      if (next === '[' || next === 'O') {
        let end = index + 2
        while (end < chars.length && !/[\x40-\x7e]/.test(chars[end]!)) end += 1
        const body = chars.slice(index + 2, end + 1).join('')
        const name = CSI_KEYS[body.replace(/^1;\d+(?=[A-Z]$)/, '')]
        if (name) keys.push({ name } as Key)
        index = end
        continue
      }
      keys.push({ name: 'escape' })
      continue
    }
    if (char === '\r' || char === '\n') keys.push({ name: 'enter' })
    else if (char === '\x03') keys.push({ name: 'interrupt' })
    else if (char === '\x7f' || char === '\b') keys.push({ name: 'backspace' })
    else if (char === '\x15') keys.push({ name: 'clear' })
    else if (char >= ' ') keys.push({ name: 'char', char })
  }
  return keys
}

function paint(color: boolean, code: string, text: string): string {
  return color ? `${ESC}[${code}m${text}${ESC}[0m` : text
}

function truncate(text: string, width: number | undefined): string {
  if (width === undefined || width <= 1) return text
  const chars = Array.from(text)
  return chars.length < width ? text : `${chars.slice(0, width - 2).join('')}…`
}

function itemText<T>(item: SelectItem<T>): string {
  return item.hint === undefined ? item.label : `${item.label} (${item.hint})`
}

export function render<T>(state: SelectState<T>, options: RenderOptions): string {
  const { color, width } = options
  const prompt = state.query === '' ? paint(color, '2', 'type to search') : `${state.query}▏`
  const lines = [`${paint(color, '1', `${state.title}:`)} ${prompt}`]
  if (state.matches.length === 0) lines.push(paint(color, '2', truncate('  No matches', width)))
  const visible = state.matches.slice(state.offset, state.offset + PAGE_SIZE)
  for (const [position, index] of visible.entries()) {
    const item = state.items[index]!
    const selected = state.offset + position === state.cursor
    const text = truncate(`${selected ? '❯' : ' '} ${itemText(item)}`, width)
    lines.push(selected ? paint(color, '36', text) : text)
  }
  if (state.matches.length > PAGE_SIZE) {
    const footer = `  ${state.offset + 1}-${state.offset + visible.length} of ${state.matches.length}`
    lines.push(paint(color, '2', truncate(footer, width)))
  }
  return lines.join('\n')
}

export function collapsed<T>(title: string, item: SelectItem<T>): string {
  return `${title}: ${item.label}`
}

function useColor(output: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  return typeof output.hasColors === 'function' && output.hasColors()
}

export function select<T>(options: SelectOptions<T>): Promise<T | null> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const color = useColor(output, options.env ?? process.env)
  const wasRaw = input.isRaw === true
  const decoder = new StringDecoder('utf8')
  let state = createState(options.title, options.items, options.initialIndex)
  let drawnLines = 0

  const erase = (): string => (drawnLines > 1 ? `${ESC}[${drawnLines - 1}A\r${CLEAR_DOWN}` : `\r${CLEAR_DOWN}`)
  const draw = (): void => {
    const frame = render(state, { color, ...(output.columns ? { width: output.columns } : {}) })
    output.write(erase() + frame)
    drawnLines = frame.split('\n').length
  }

  return new Promise<T | null>((resolve, reject) => {
    let settled = false
    const restore = (): void => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      process.off('SIGTERM', onTerm)
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw)
      output.write(SHOW_CURSOR)
      input.pause()
    }
    const finish = (value: T | null, line: string | null): void => {
      if (settled) return
      settled = true
      try {
        output.write(erase() + (line === null ? '' : `${line}\n`))
      } finally {
        restore()
      }
      resolve(value)
    }
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (const key of parseKeys(text)) {
        const step = reduce(state, key)
        if ('cancelled' in step) return finish(null, null)
        if ('done' in step) {
          const index = state.matches[state.cursor]!
          return finish(step.done, collapsed(state.title, state.items[index]!))
        }
        state = step
      }
      draw()
    }
    const onEnd = (): void => finish(null, null)
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      restore()
      reject(error)
    }
    const onTerm = (): void => {
      finish(null, null)
      process.kill(process.pid, 'SIGTERM')
    }

    try {
      if (typeof input.setRawMode === 'function') input.setRawMode(true)
      output.write(HIDE_CURSOR)
      process.on('SIGTERM', onTerm)
      input.on('data', onData)
      input.on('end', onEnd)
      input.on('error', onError)
      input.resume()
      draw()
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
