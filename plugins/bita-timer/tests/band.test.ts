import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-10T18:00:00.000Z')

const ENVELOPE = JSON.stringify({
  ok: true,
  command: 'current',
  data: [
    { id: 7, description: 'Revisar MR', projectName: 'bita', start: '2026-10-10T16:35:00.000Z', durationSeconds: 5100, running: true },
  ],
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('a bita command fills the band with the running timer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: ENVELOPE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)

  await $.tool.call({ tool: 'Bash', command: 'bita start "Revisar MR"' })
  await clock.advance(1000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'bita-timer', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Revisar MR · bita · 1:25/ })).toBeDefined()
    await ui.unmount()
  }
})

test('no bita on the machine leaves the band empty', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('process.run', () => ({ deny: 'not found' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)

  await $.tool.call({ tool: 'Bash', command: 'bita ls' })
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'bita-timer', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /⏱/ })).toBeUndefined()
  await ui.unmount()
})
