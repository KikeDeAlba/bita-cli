import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createState, parseKeys, reduce, render, select, type Key, type SelectItem, type SelectState, type SelectStep } from '../src/cli/select.ts'

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
  assert.deepEqual(parseKeys('\r\n\x03\x7f\b\x15\x1b'), [
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

function terminal(): FakeTerminal {
  const stream = new PassThrough()
  const raw: boolean[] = []
  const fakeInput = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      raw.push(mode)
      fakeInput.isRaw = mode
      return fakeInput
    },
  })
  const chunks: string[] = []
  const fakeOutput = {
    isTTY: true,
    columns: 80,
    hasColors: () => true,
    write(chunk: string) {
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

function assertRestored(fake: FakeTerminal): void {
  assert.deepEqual(fake.raw, [true, false])
  assert.equal(fake.stream.isPaused(), true)
  assert.equal(fake.stream.listenerCount('data'), 0)
  assert.equal(fake.stream.listenerCount('keypress'), 0)
  assert.equal(fake.stream.listenerCount('end'), 0)
  assert.equal(process.listenerCount('SIGTERM'), baseSigterm)
  const output = fake.written()
  assert.ok(output.startsWith('\x1b[?25l'))
  assert.ok(output.endsWith('\x1b[?25h'))
}

test('select accepts with arrows and Enter, collapses to one line and restores the terminal', async () => {
  const fake = terminal()
  const picked = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: fake.input, output: fake.output, env: { NO_COLOR: '1' } })
  fake.send('\x1b[B')
  fake.send('\r')
  assert.equal(await picked, 'opencode')
  assertRestored(fake)
  assert.doesNotMatch(fake.written().replace(/\x1b\[(\?25[lh]|\d*A|J)/g, ''), /\x1b/)
  assert.match(fake.written(), /\x1b\[JHarness: OpenCode\n\x1b\[\?25h$/)
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

test('Esc without a search and EOF also cancel', async () => {
  const esc = terminal()
  const viaEsc = select({ title: 'Harness', items: harnesses, initialIndex: 0, input: esc.input, output: esc.output, env: {} })
  esc.send('\x1b')
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
