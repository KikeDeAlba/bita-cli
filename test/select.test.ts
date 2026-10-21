import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'
import {
  ESCAPE_TIMEOUT_MS,
  collapsed,
  createState,
  displayWidth,
  pageSizeFor,
  parseKeys,
  reduce,
  render,
  scanKeys,
  select,
  type Key,
  type SelectItem,
  type SelectState,
  type SelectStep,
} from '../src/cli/select.ts'

const harnesses: SelectItem<string>[] = [
  { label: 'Claude', value: 'claude' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'Codex', value: 'codex' },
  { label: 'Gemini', value: 'gemini' },
]

const projects: SelectItem<string>[] = [
  { label: 'No timer', value: 'none' },
  { label: 'Apartados', hint: '12', value: 'apartados' },
  { label: 'Ejecución en laboratorio', hint: '7', value: 'lab' },
  { label: 'Beta', hint: '31', value: 'beta' },
]

function many(count: number): SelectItem<number>[] {
  return Array.from({ length: count }, (_, index) => ({ label: `Item ${index + 1}`, value: index }))
}

function asState<T>(step: SelectStep<T>): SelectState<T> {
  assert.ok(!('done' in step) && !('cancelled' in step), `expected a state, got ${JSON.stringify(step)}`)
  return step
}

function press<T>(state: SelectState<T>, ...keys: Key[]): SelectState<T> {
  return keys.reduce((current, key) => asState(reduce(current, key)), state)
}

function type<T>(state: SelectState<T>, text: string): SelectState<T> {
  return press(state, ...Array.from(text, (char): Key => ({ name: 'char', char })))
}

function current<T>(state: SelectState<T>): string | undefined {
  const index = state.matches[state.cursor]
  return index === undefined ? undefined : state.items[index]?.label
}

test('up and down move the cursor and wrap around', () => {
  const start = createState('Harness', harnesses, 0)
  assert.equal(current(press(start, { name: 'down' })), 'OpenCode')
  assert.equal(current(press(start, { name: 'up' })), 'Gemini')
  assert.equal(current(press(start, { name: 'up' }, { name: 'down' })), 'Claude')
  assert.equal(current(press(createState('Harness', harnesses, 3), { name: 'down' })), 'Claude')
})

test('the initial index is clamped to the list', () => {
  assert.equal(current(createState('Harness', harnesses, 2)), 'Codex')
  assert.equal(current(createState('Harness', harnesses, 40)), 'Gemini')
  assert.equal(current(createState('Harness', harnesses, -3)), 'Claude')
})

test('Home, End, PgUp and PgDn jump', () => {
  const start = createState('Project', many(25), 5)
  assert.equal(current(press(start, { name: 'home' })), 'Item 1')
  assert.equal(current(press(start, { name: 'end' })), 'Item 25')
  assert.equal(current(press(start, { name: 'pagedown' })), 'Item 16')
  assert.equal(current(press(start, { name: 'pagedown' }, { name: 'pagedown' }, { name: 'pagedown' })), 'Item 25')
  assert.equal(current(press(start, { name: 'pageup' })), 'Item 1')
  assert.equal(current(press(start, { name: 'end' }, { name: 'pageup' })), 'Item 15')
})

test('typing filters by label and hint, ignoring case and accents, and jumps to the first match', () => {
  const start = createState('Project', projects, 3)
  const accent = type(start, 'EJECUCION')
  assert.equal(accent.query, 'EJECUCION')
  assert.deepEqual(accent.matches, [2])
  assert.equal(current(accent), 'Ejecución en laboratorio')
  assert.deepEqual(type(start, 'cIÓn').matches, [2])
  assert.deepEqual(type(start, '31').matches, [3])
  const several = type(start, 'a')
  assert.equal(several.cursor, 0)
  assert.equal(current(several), 'Apartados')
})

test('a filter can empty the list; Backspace brings it back and Ctrl+U clears it', () => {
  const start = createState('Project', projects, 1)
  const empty = type(start, 'zz')
  assert.deepEqual(empty.matches, [])
  assert.match(render(empty, { color: false }), /No matches/)
  const partial = press(empty, { name: 'backspace' })
  assert.equal(partial.query, 'z')
  assert.deepEqual(partial.matches, [])
  const back = press(type(start, 'betx'), { name: 'backspace' })
  assert.equal(back.query, 'bet')
  assert.equal(current(back), 'Beta')
  const cleared = press(type(start, 'apart'), { name: 'clear' })
  assert.equal(cleared.query, '')
  assert.equal(cleared.matches.length, projects.length)
  assert.equal(current(cleared), 'Apartados')
  const restored = press(empty, { name: 'clear' })
  assert.equal(current(restored), 'Apartados')
  assert.equal(press(start, { name: 'backspace' }), start)
})

test('Enter accepts the highlighted item and does nothing on an empty list', () => {
  const start = createState('Project', projects, 1)
  assert.deepEqual(reduce(press(start, { name: 'down' }), { name: 'enter' }), { done: 'lab' })
  assert.deepEqual(reduce(type(start, 'beta'), { name: 'enter' }), { done: 'beta' })
  const empty = type(start, 'zz')
  assert.equal(reduce(empty, { name: 'enter' }), empty)
  assert.equal(reduce(empty, { name: 'down' }), empty)
})

test('Esc clears the search first and cancels without one; Ctrl+C always cancels', () => {
  const start = createState('Harness', harnesses, 0)
  const searched = type(start, 'cod')
  const cleared = asState(reduce(searched, { name: 'escape' }))
  assert.equal(cleared.query, '')
  assert.deepEqual(reduce(cleared, { name: 'escape' }), { cancelled: true })
  assert.deepEqual(reduce(searched, { name: 'interrupt' }), { cancelled: true })
  assert.deepEqual(reduce(start, { name: 'interrupt' }), { cancelled: true })
})

test('the window shows 10 rows and scrolls with the cursor', () => {
  const start = createState('Project', many(25), 0)
  const rows = (state: SelectState<number>): string[] => render(state, { color: false }).split('\n').slice(1, 11)
  assert.equal(rows(start).length, 10)
  assert.equal(rows(start)[0], '❯ Item 1')
  assert.match(render(start, { color: false }), /1-10 of 25$/)
  const down = press(start, ...Array.from({ length: 10 }, (): Key => ({ name: 'down' })))
  assert.equal(down.offset, 1)
  assert.equal(rows(down).at(-1), '❯ Item 11')
  const end = press(start, { name: 'end' })
  assert.equal(end.offset, 15)
  assert.match(render(end, { color: false }), /16-25 of 25$/)
  const wrapped = press(end, { name: 'down' })
  assert.equal(wrapped.offset, 0)
  const initial = createState('Project', many(25), 20)
  assert.equal(initial.offset, 11)
  assert.equal(render(createState('Harness', harnesses, 0), { color: false }).split('\n').length, 5)
})

test('render marks the current row, shows the query and the hint, and NO_COLOR-style output has no escapes', () => {
  const state = type(createState('Project', projects, 0), 'apart')
  const plain = render(state, { color: false })
  assert.equal(plain, 'Project: apart▏\n❯ Apartados (12)')
  assert.doesNotMatch(plain, /\x1b/)
  assert.match(render(state, { color: true }), /\x1b\[36m❯ Apartados \(12\)\x1b\[0m/)
  assert.match(render(createState('Harness', harnesses, 0), { color: false }), /^Harness: type to search\n❯ Claude\n  OpenCode/)
  const narrow = render(createState('Project', projects, 2), { color: false, width: 12 })
  assert.match(narrow, /❯ Ejecució…/)
})

test('parseKeys decodes the terminal sequences', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1bOA\x1bOB'), [{ name: 'up' }, { name: 'down' }, { name: 'up' }, { name: 'down' }])
  assert.deepEqual(parseKeys('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[5~\x1b[6~'), [
    { name: 'home' },
    { name: 'end' },
    { name: 'home' },
    { name: 'end' },
    { name: 'pageup' },
    { name: 'pagedown' },
  ])
  assert.deepEqual(parseKeys('\r\n\n\x03\x7f\b\x15\x1b'), [
    { name: 'enter' },
    { name: 'enter' },
    { name: 'interrupt' },
    { name: 'backspace' },
    { name: 'backspace' },
    { name: 'clear' },
    { name: 'escape' },
  ])
  assert.deepEqual(parseKeys('aÓ\x1b[C\x1b[1;5A\x01'), [{ name: 'char', char: 'a' }, { name: 'char', char: 'Ó' }, { name: 'up' }])
})

const baseSigterm = process.listenerCount('SIGTERM')

interface FakeTerminal {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  raw: boolean[]
  written(): string
  send(chunk: string): void
  stream: PassThrough
}

interface TerminalOptions {
  rows?: number
  failWrite?: (chunk: string) => boolean
  failRaw?: (mode: boolean) => boolean
}

function terminal(options: TerminalOptions = {}): FakeTerminal {
  const stream = new PassThrough()
  const raw: boolean[] = []
  const fakeInput = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      raw.push(mode)
      if (options.failRaw?.(mode)) throw new Error('raw mode failed')
      fakeInput.isRaw = mode
      return fakeInput
    },
  })
  const chunks: string[] = []
  const fakeOutput = {
    isTTY: true,
    columns: 80,
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    hasColors: () => true,
    write(chunk: string) {
      if (options.failWrite?.(chunk)) throw new Error('write failed')
      chunks.push(chunk)
      return true
    },
  }
  return {
    input: fakeInput as unknown as NodeJS.ReadStream,
    output: fakeOutput as unknown as NodeJS.WriteStream,
    raw,
    stream,
    written: () => chunks.join(''),
    send: (chunk) => void stream.write(chunk),
  }
}

function fakeTimers(t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  return (ms) => t.mock.timers.tick(ms)
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  return () => settled
}

function assertRestored(fake: FakeTerminal): void {
  assert.deepEqual(fake.raw, [true, false])
  assert.equal(fake.stream.isPaused(), true)
  assert.equal(fake.stream.listenerCount('data'), 0)
  assert.equal(fake.stream.listenerCount('keypress'), 0)
  assert.equal(fake.stream.listenerCount('end'), 0)
  assert.equal(process.listenerCount('SIGTERM'), baseSigterm)
  const output = fake.written()
  assert.ok(output.startsWith('\x1b[?25l\x1b[?2004h'))
  assert.ok(output.endsWith('\x1b[?2004l\x1b[?25h'))
}

test('select accepts with arrows and Enter, collapses to one line and restores the terminal', async () => {
  const fake = terminal()
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: { NO_COLOR: '1' } })
  fake.send('\x1b[B')
  fake.send('\r')
  assert.equal(await picked, 'opencode')
  assertRestored(fake)
  assert.doesNotMatch(fake.written().replace(/\x1b\[(\?25[lh]|\?2004[hl]|\d*A|J)/g, ''), /\x1b/)
  assert.match(fake.written(), /\x1b\[JHarness: OpenCode\n\x1b\[\?2004l\x1b\[\?25h$/)
})

test('select filters as you type', async () => {
  const fake = terminal()
  const picked = select({ title: 'Project', items: projects, initialIndex: 1, input: fake.input, output: fake.output, env: {} })
  fake.send('BET')
  fake.send('\r')
  assert.equal(await picked, 'beta')
  assert.match(fake.written(), /\x1b\[36m/)
  assert.match(fake.written(), /Project:\x1b\[0m BET▏/)
  assertRestored(fake)
})

test('Ctrl+C cancels with null and restores the terminal', async () => {
  const fake = terminal()
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('\x03')
  assert.equal(await picked, null)
  assertRestored(fake)
  assert.doesNotMatch(fake.written(), /Harness: Claude\n/)
})

test('Esc without a search and EOF also cancel', async (t) => {
  const tick = fakeTimers(t)
  const esc = terminal()
  const viaEsc = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: esc.input, output: esc.output, env: {} })
  esc.send('\x1b')
  await flush()
  tick(ESCAPE_TIMEOUT_MS)
  assert.equal(await viaEsc, null)
  assertRestored(esc)

  const eof = terminal()
  const viaEof = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: eof.input, output: eof.output, env: {} })
  eof.stream.end()
  assert.equal(await viaEof, null)
  assert.deepEqual(eof.raw, [true, false])
  assert.equal(eof.stream.listenerCount('data'), 0)
})

test('two pickers in a row each get their keys', async () => {
  const fake = terminal()
  const first = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('\x1b[B\r')
  assert.equal(await first, 'opencode')
  const second = select({ title: 'Project', items: projects, initialIndex: 1, input: fake.input, output: fake.output, env: {} })
  fake.send('\x1b[A\r')
  assert.equal(await second, 'none')
  assert.deepEqual(fake.raw, [true, false, true, false])
  assert.equal(fake.stream.listenerCount('data'), 0)
  assert.equal(fake.stream.isPaused(), true)
})

test('SIGTERM during the picker restores the terminal, then re-raises the signal', async () => {
  const fake = terminal()
  const kills: Array<[number, string | number | undefined]> = []
  const realKill = process.kill
  process.kill = ((pid: number, signal?: string | number) => {
    kills.push([pid, signal])
    return true
  }) as typeof process.kill
  try {
    const picked = select({ title: 'Project', items: projects, initialIndex: 1, input: fake.input, output: fake.output, env: {} })
    assert.equal(process.listenerCount('SIGTERM'), baseSigterm + 1)
    assert.deepEqual(fake.raw, [true])
    process.emit('SIGTERM')
    assert.equal(await picked, null)
    assertRestored(fake)
    assert.deepEqual(kills, [[process.pid, 'SIGTERM']])
  } finally {
    process.kill = realKill
  }
})

test('scanKeys keeps an incomplete escape sequence for the next chunk', () => {
  assert.deepEqual(scanKeys('a\x1b', false), { keys: [{ key: { name: 'char', char: 'a' }, end: 1 }], rest: '\x1b' })
  assert.deepEqual(scanKeys('\x1b[', false), { keys: [], rest: '\x1b[' })
  assert.deepEqual(scanKeys('\x1b[1;5', false), { keys: [], rest: '\x1b[1;5' })
  assert.deepEqual(scanKeys('\x1b[B', false).keys, [{ key: { name: 'down' }, end: 3 }])
  assert.deepEqual(scanKeys('\x1b', true).keys, [{ key: { name: 'escape' }, end: 1 }])
  assert.deepEqual(scanKeys('\x1b[', true), { keys: [], rest: '' })
  assert.deepEqual(parseKeys('\x1bx\x1bé'), [])
  assert.deepEqual(parseKeys('\x1b\x03'), [{ name: 'escape' }, { name: 'interrupt' }])
})

test('an arrow split across chunks moves the cursor instead of cancelling or typing', async (t) => {
  const tick = fakeTimers(t)
  const split = terminal()
  const first = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: split.input, output: split.output, env: {} })
  split.send('\x1b')
  await flush()
  tick(ESCAPE_TIMEOUT_MS - 1)
  split.send('[B')
  await flush()
  split.send('\r')
  assert.equal(await first, 'opencode')
  assertRestored(split)

  const csi = terminal()
  const second = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: csi.input, output: csi.output, env: { NO_COLOR: '1' } })
  csi.send('\x1b[')
  await flush()
  tick(ESCAPE_TIMEOUT_MS - 1)
  csi.send('B')
  await flush()
  csi.send('\r')
  assert.equal(await second, 'opencode')
  assert.doesNotMatch(csi.written(), /Harness: B▏/)
  assertRestored(csi)
})

test('Alt+key and Alt+Enter are ignored and do not cancel', async (t) => {
  const tick = fakeTimers(t)
  assert.deepEqual(parseKeys('\x1b\r'), [])
  assert.deepEqual(parseKeys('\x1b\ra'), [{ name: 'char', char: 'a' }])
  const fake = terminal()
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  const settled = settledFlag(picked)
  fake.send('\x1bx')
  await flush()
  fake.send('\x1b\r')
  await flush()
  tick(ESCAPE_TIMEOUT_MS * 2)
  await flush()
  assert.equal(settled(), false)
  fake.send('\x1b[B\r')
  assert.equal(await picked, 'opencode')
  assertRestored(fake)
})

test('a pending Esc timer is cleared when the picker ends', async (t) => {
  const tick = fakeTimers(t)
  const fake = terminal()
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('cod\x1b')
  await flush()
  fake.stream.end()
  assert.equal(await picked, null)
  const before = fake.written()
  assert.match(before, /cod▏/)
  tick(ESCAPE_TIMEOUT_MS * 10)
  await flush()
  assert.equal(fake.written(), before)
  assert.ok(before.endsWith('\x1b[?25h'))
})

test('displayWidth counts terminal columns', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('日本'), 4)
  assert.equal(displayWidth('ＡＢ'), 4)
  assert.equal(displayWidth('한국'), 4)
  assert.equal(displayWidth('👍🏽'), 2)
  assert.equal(displayWidth('👨‍👩‍👧'), 2)
  assert.equal(displayWidth('🇲🇽'), 2)
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('́'), 0)
  assert.equal(displayWidth('©'), 1)
  assert.equal(displayWidth('❯ Ejecución'), 11)
})

test('render truncates by columns, including the title line', () => {
  const wide: SelectItem<string>[] = [
    { label: '日本語のプロジェクト名', value: 'jp' },
    { label: '🚀🚀🚀🚀🚀🚀🚀', value: 'rocket' },
  ]
  const lines = render(createState('Project', wide, 0), { color: false, width: 12 }).split('\n')
  for (const line of lines) assert.ok(displayWidth(line) < 12, `${line} is ${displayWidth(line)} columns`)
  assert.equal(lines[1], '❯ 日本語の…')
  assert.equal(lines[2], '  🚀🚀🚀🚀…')
  const title = render(createState('A very long project title', wide, 0), { color: true, width: 12 }).split('\n')[0]!
  assert.equal(title.replace(/\x1b\[\d+m/g, ''), 'A very lon…')
  const query = type(createState('Project', projects, 0), 'laboratorio')
  assert.equal(render(query, { color: false, width: 16 }).split('\n')[0], 'Project: labor…')
})

test('the window fits the terminal height', async () => {
  assert.equal(pageSizeFor(undefined), 10)
  assert.equal(pageSizeFor(40), 10)
  assert.equal(pageSizeFor(8), 5)
  assert.equal(pageSizeFor(3), 1)
  assert.equal(pageSizeFor(1), 1)
  const small = createState('Project', many(25), 0, 2)
  assert.equal(render(small, { color: false }).split('\n').length, 4)
  assert.equal(current(press(small, { name: 'pagedown' })), 'Item 3')
  assert.equal(press(small, { name: 'down' }, { name: 'down' }).offset, 1)

  const fake = terminal({ rows: 5 })
  const picked = select({ title: 'Project', items: projects, initialIndex: 0, input: fake.input, output: fake.output, env: { NO_COLOR: '1' } })
  fake.send('\x1b[B')
  await flush()
  fake.send('\r')
  assert.equal(await picked, 'apartados')
  assert.match(fake.written(), /1-2 of 4/)
  assert.doesNotMatch(fake.written(), /Beta/)
})

test('a write failure after a key rejects and still restores the terminal', async () => {
  const fake = terminal({ failWrite: (chunk) => chunk.includes('zz▏') })
  const picked = select({ title: 'Project', items: projects, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('zz')
  await assert.rejects(picked, /write failed/)
  assertRestored(fake)
})

test('a write failure on the collapsed line rejects and still restores the terminal', async () => {
  const fake = terminal({ failWrite: (chunk) => chunk.includes('Harness: Claude\n') })
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('\r')
  await assert.rejects(picked, /write failed/)
  assertRestored(fake)
})

test('a raw mode failure on restore rejects but the cursor, listeners and pause still happen', async () => {
  const fake = terminal({ failRaw: (mode) => !mode })
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('\r')
  await assert.rejects(picked, /raw mode failed/)
  assertRestored(fake)
})

test('keys typed after Enter in the same chunk reach the next picker', async () => {
  const fake = terminal()
  const first = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  fake.send('\rabc\r')
  assert.equal(await first, 'claude')
  const items: SelectItem<string>[] = [
    { label: 'Alpha', value: 'alpha' },
    { label: 'Xabcx', value: 'abc' },
  ]
  const second = select({ title: 'Project', items, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  assert.equal(await second, 'abc')
  assert.match(fake.written(), /Project: Xabcx\n/)
  assert.deepEqual(fake.raw, [true, false, true, false])
  assert.equal(fake.stream.listenerCount('data'), 0)
})

test('pasted text with line breaks becomes the search; only a final Enter accepts', () => {
  assert.deepEqual(parseKeys('be\nta'), Array.from('beta', (char): Key => ({ name: 'char', char })))
  assert.deepEqual(parseKeys('ab\r').at(-1), { name: 'enter' })
  assert.deepEqual(parseKeys('ab\r\n'), [{ name: 'char', char: 'a' }, { name: 'char', char: 'b' }, { name: 'enter' }])
  assert.deepEqual(parseKeys('\r\n'), [{ name: 'enter' }])
  assert.deepEqual(parseKeys('\x1b[200~be\r\nta\x1b[201~'), [{ name: 'paste', text: 'beta' }])
  assert.deepEqual(scanKeys('\x1b[200~be', false), { keys: [], rest: '\x1b[200~be' })
  assert.deepEqual(parseKeys('\x1b[200~\x1b[201~\r'), [{ name: 'enter' }])
})

test('select treats a multi-line paste as search text', async () => {
  const plain = terminal()
  const first = select({ title: 'Project', items: projects, initialIndex: 0, input: plain.input, output: plain.output, env: {} })
  plain.send('be\nta')
  await flush()
  plain.send('\r')
  assert.equal(await first, 'beta')

  const bracketed = terminal()
  const second = select({ title: 'Project', items: projects, initialIndex: 0, input: bracketed.input, output: bracketed.output, env: {} })
  bracketed.send('\x1b[200~apar')
  await flush()
  bracketed.send('\ntados\x1b[201~')
  await flush()
  bracketed.send('\r')
  assert.equal(await second, 'apartados')
  assert.match(bracketed.written(), /apartados▏/)
})

test('a paste split in three chunks with a line break inside filters and does not accept', async (t) => {
  fakeTimers(t)
  const fake = terminal()
  const picked = select({ title: 'Project', items: projects, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  const settled = settledFlag(picked)
  fake.send('\x1b[200~ap')
  await flush()
  fake.send('\nart')
  await flush()
  fake.send('ados\x1b[201~')
  await flush()
  assert.equal(settled(), false)
  assert.match(fake.written(), /apartados▏/)
  assert.doesNotMatch(fake.written(), /ap▏|apart▏/)
  fake.send('\r')
  assert.equal(await picked, 'apartados')
  assertRestored(fake)
})

test('a paste still open after the Esc timeout is not flushed early', async (t) => {
  const tick = fakeTimers(t)
  const fake = terminal()
  const picked = select({ title: 'Project', items: projects, initialIndex: 0, input: fake.input, output: fake.output, env: {} })
  const settled = settledFlag(picked)
  fake.send('\x1b[200~be')
  await flush()
  tick(ESCAPE_TIMEOUT_MS * 10)
  await flush()
  assert.equal(settled(), false)
  assert.doesNotMatch(fake.written(), /be▏/)
  fake.send('ta\x1b[20')
  await flush()
  tick(ESCAPE_TIMEOUT_MS * 10)
  await flush()
  assert.doesNotMatch(fake.written(), /be▏|beta▏/)
  fake.send('1~')
  await flush()
  assert.match(fake.written(), /beta▏/)
  fake.send('\r')
  assert.equal(await picked, 'beta')
  assertRestored(fake)
})

test('control characters are stripped from the title, labels and hints', () => {
  const evil: SelectItem<string>[] = [{ label: 'Evil\x1b[31m\x9b2J\x07', hint: '\x1b]0;x\x07id', value: 'evil' }]
  const frame = render(createState('Pro\x1bject', evil, 0), { color: false })
  assert.doesNotMatch(frame, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/)
  assert.equal(frame, 'Project: type to search\n❯ Evil[31m2J (]0;xid)')
  assert.equal(collapsed('Pro\x1bject', evil[0]!), 'Project: Evil[31m2J')
  assert.deepEqual(parseKeys('\x85\x9b\x9fa'), [{ name: 'char', char: 'a' }])
})

test('Backspace removes a whole grapheme', () => {
  const start = createState('Project', projects, 0)
  const emoji = press(start, ...Array.from('ab👍🏽', (char): Key => ({ name: 'char', char })), { name: 'backspace' })
  assert.equal(emoji.query, 'ab')
  const accent = press(start, { name: 'char', char: 'e' }, { name: 'char', char: '́' }, { name: 'backspace' })
  assert.equal(accent.query, '')
  const flag = press(start, { name: 'paste', text: 'x🇲🇽' }, { name: 'backspace' })
  assert.equal(flag.query, 'x')
})
