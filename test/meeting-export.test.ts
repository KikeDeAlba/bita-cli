import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  exportMeeting,
  findRecapBinary,
  parseRecapShow,
  type MeetingExportEnvironment,
  type ProcessResult,
} from '../src/export/meeting.ts'
import { buildMinutesHtml, isGenericTitle, loadPrintStyles, minutesBody, pickTitle, type MinutesDocument } from '../src/export/minutes.ts'

const TZ = 'America/Mexico_City'
const CHROME = '/fake/Google Chrome'
const RECAP = '/fake/recap'

const SUMMARY = `# Remote meeting

8 de octubre de 2026, 10:13 · 27m03s · reunión presencial

## Resumen
Se revisaron las descargas de SAP.

## Flujo
\`\`\`mermaid
graph LR
  A --> B
\`\`\`

## Pendientes
| # | Pendiente |
|---|---|
| 1 | Revisar la RFC |

## Capturas
![frame 1](frames/frame-001.jpg)
`

function minutes(overrides: Partial<MinutesDocument> = {}): MinutesDocument {
  return {
    title: 'Revisión de descargas SAP',
    projectName: 'DPSuites',
    clientName: 'Dportenis',
    startedAt: '2026-10-08T17:13:28Z',
    durationSeconds: 1623,
    mode: 'in-person',
    timezone: TZ,
    summaryMarkdown: SUMMARY,
    meetingDir: '/Users/me/Recap/2026-10-08-1013-in-person-meeting',
    ...overrides,
  }
}

const svgRenderer = async (_source: string, name: string): Promise<string> =>
  `<?xml version="1.0"?>\n<svg id="${name}" xmlns="http://www.w3.org/2000/svg"><g/></svg>`

test('the minutes body drops everything before the first section', () => {
  assert.equal(minutesBody('# Remote meeting\n\nmeta\n\n## Resumen\nx\n'), '## Resumen\nx\n')
  assert.equal(minutesBody('sin secciones'), 'sin secciones')
})

test('the HTML has the cover, the minutes heading and the body without the recap header', async () => {
  const html = await buildMinutesHtml(minutes(), { styles: '#print-root{}', renderMermaid: svgRenderer })

  assert.match(html, /<title>Revisión de descargas SAP<\/title>/)
  assert.match(html, /<div class="print-kicker">DPSuites · Dportenis<\/div>/)
  assert.match(html, /<h1 class="print-cover-title">Revisión de descargas SAP<\/h1>/)
  assert.match(html, /<div class="print-cover-meta">8 de octubre de 2026, 11:13 · 27m · Presencial<\/div>/)
  assert.match(html, /<span class="print-index-number">Modalidad<\/span><span>Presencial<\/span>/)
  assert.match(html, /<span class="print-index-number">Proyecto<\/span><span>DPSuites<\/span>/)
  assert.match(html, /<h1 class="print-title">Minuta de la reunión<\/h1>/)
  assert.match(html, /<h2>Resumen<\/h2>/)
  assert.doesNotMatch(html, /Remote meeting/)
  assert.doesNotMatch(html, /27m03s/)
  assert.match(html, /<style>\n#print-root\{\}\n<\/style>/)
})

test('mermaid blocks become inline SVG, tables are wrapped and images resolve against the meeting folder', async () => {
  const seen: string[] = []
  const html = await buildMinutesHtml(minutes(), {
    styles: '',
    renderMermaid: async (source, name) => {
      seen.push(`${name}:${source}`)
      return svgRenderer(source, name)
    },
  })

  assert.deepEqual(seen, ['mermaid-1:graph LR\n  A --> B'])
  assert.match(html, /<figure class="md-mermaid"><svg id="mermaid-1"/)
  assert.doesNotMatch(html, /<\?xml/)
  assert.doesNotMatch(html, /language-mermaid/)
  assert.match(html, /<div class="md-table-scroll"><table>/)
  const frame = pathToFileURL('/Users/me/Recap/2026-10-08-1013-in-person-meeting/frames/frame-001.jpg').href
  assert.ok(html.includes(`<img src="${frame}" alt="frame 1">`))
})

test('a diagram that fails to render stays as its code block', async () => {
  const html = await buildMinutesHtml(minutes(), {
    styles: '',
    renderMermaid: async () => {
      throw new Error('mmdc exploded')
    },
  })
  assert.match(html, /<pre><code class="language-mermaid">graph LR/)
  assert.doesNotMatch(html, /md-mermaid/)
})

test('the print styles embed the fonts and keep the letter page', async () => {
  const styles = await loadPrintStyles()
  assert.match(styles, /font-family: 'Instrument Sans';\n {2}src: url\(data:font\/woff2;base64,/)
  assert.match(styles, /font-family: 'IBM Plex Mono'/)
  assert.match(styles, /size: letter;\n {2}margin: 0\.5in;/)
  assert.match(styles, /#print-root \{/)
})

test('generic recap titles are never picked', () => {
  assert.equal(isGenericTitle('Remote meeting'), true)
  assert.equal(isGenericTitle('In-person meeting'), true)
  assert.equal(isGenericTitle('Reunión presencial'), true)
  assert.equal(isGenericTitle('Reunión presencial: descargas SAP'), false)
  assert.equal(pickTitle([null, 'Remote meeting', '  ', 'Daily de DPSuites'], 'x'), 'Daily de DPSuites')
  assert.equal(pickTitle(['In-person meeting'], 'Reunión del 2026-10-08'), 'Reunión del 2026-10-08')
})

test('recap errors become clear failures', () => {
  assert.throws(
    () => parseRecapShow('{"ok":false,"error":{"code":"MEETING_NOT_FOUND","message":"No meeting"}}', 7),
    (error: Error & { code?: string }) => error.code === 'MEETING_NOT_FOUND',
  )
  assert.throws(() => parseRecapShow('not json', 7), (error: Error & { code?: string }) => error.code === 'RECAP_FAILED')
})

test('the recap binary honors RECAP_CLI before the usual places', () => {
  assert.equal(findRecapBinary({ RECAP_CLI: '/x/recap', HOME: '/h' }, (path) => path === '/x/recap'), '/x/recap')
  assert.equal(findRecapBinary({ HOME: '/h' }, (path) => path === '/opt/homebrew/bin/recap'), '/opt/homebrew/bin/recap')
  assert.equal(findRecapBinary({ HOME: '/h' }, () => false), null)
})

interface Run {
  command: string
  args: readonly string[]
  html?: string
}

function fixture(recapData: Record<string, unknown>, options: { chrome?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bita-meeting-export-'))
  const meetingDir = join(root, 'meeting')
  const downloads = join(root, 'Downloads')
  const workDir = join(root, 'work')
  writeFileSync(join(root, 'summary.md'), SUMMARY)
  const runs: Run[] = []
  const env: MeetingExportEnvironment = {
    run: async (command, args): Promise<ProcessResult> => {
      const run: Run = { command, args }
      runs.push(run)
      if (command === RECAP) {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { dir: meetingDir, summary: join(root, 'summary.md'), startedAt: '2026-10-08T17:13:28Z', durationSeconds: 1623, mode: 'remote', title: 'Remote meeting', ...recapData },
          }),
          stderr: '',
        }
      }
      const out = args.find((arg) => arg.startsWith('--print-to-pdf='))?.slice('--print-to-pdf='.length)
      const page = args.at(-1) ?? ''
      run.html = readFileSync(new URL(page), 'utf8')
      if (out !== undefined) writeFileSync(out, '%PDF-1.4\n')
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: (path) => (path === CHROME ? options.chrome !== false : existsSync(path)),
    readText: async (path) => readFileSync(path, 'utf8'),
    recapBinary: () => RECAP,
    chromeApp: CHROME,
    renderMermaid: svgRenderer,
    styles: async () => '',
    downloadsDir: downloads,
  }
  return { root, downloads, workDir, runs, env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('exporting asks recap for the entry and prints the HTML with headless Chrome', async () => {
  const f = fixture({ wrapup: { title: 'Reunión presencial: descargas SAP → central' } })
  try {
    const out = join(f.root, 'out', 'm853.pdf')
    const result = await exportMeeting(
      { entryId: 853, out, timezone: TZ, entry: { description: 'In-person meeting', projectName: 'DPSuites', clientName: null }, workDir: f.workDir },
      f.env,
    )

    assert.deepEqual(result, { path: out, title: 'Reunión presencial: descargas SAP → central', entryId: 853 })
    assert.deepEqual(f.runs[0], { command: RECAP, args: ['show', '--bita-entry', '853', '--json'] })
    const chrome = f.runs[1]
    assert.equal(chrome?.command, CHROME)
    const args = chrome?.args ?? []
    for (const flag of ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`]) assert.ok(args.includes(flag), flag)
    assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=')))
    assert.equal(args.at(-1), pathToFileURL(join(f.workDir, 'minuta.html')).href)
    assert.match(chrome?.html ?? '', /<h1 class="print-cover-title">Reunión presencial: descargas SAP → central<\/h1>/)
    assert.match(chrome?.html ?? '', /Remota/)
    assert.equal(existsSync(out), true)
  } finally {
    f.cleanup()
  }
})

test('without --out the PDF lands in Downloads, named by day and title, and the generic title falls back to the entry', async () => {
  const f = fixture({})
  try {
    const result = await exportMeeting(
      { entryId: 9, timezone: TZ, entry: { description: 'Daily de DPSuites', projectName: null, clientName: null }, workDir: f.workDir },
      f.env,
    )
    assert.equal(result.title, 'Daily de DPSuites')
    assert.equal(result.path, join(f.downloads, 'minuta-2026-10-08-daily-de-dpsuites.pdf'))
    assert.equal(existsSync(result.path), true)
  } finally {
    f.cleanup()
  }
})

test('with only generic titles the minutes are named after the day', async () => {
  const f = fixture({ bitaEntry: { title: 'Remote meeting' } })
  try {
    const result = await exportMeeting({ entryId: 9, timezone: TZ, entry: null, workDir: f.workDir }, f.env)
    assert.equal(result.title, 'Reunión del 2026-10-08')
    assert.doesNotMatch(f.runs[1]?.html ?? '', /Remote meeting/)
  } finally {
    f.cleanup()
  }
})

test('a missing Chrome fails with CHROME_MISSING before printing', async () => {
  const f = fixture({}, { chrome: false })
  try {
    await assert.rejects(
      exportMeeting({ entryId: 9, out: join(f.root, 'x.pdf'), timezone: TZ, entry: null, workDir: f.workDir }, f.env),
      (error: Error & { code?: string }) => error.code === 'CHROME_MISSING',
    )
    assert.equal(f.runs.length, 1)
  } finally {
    f.cleanup()
  }
})
