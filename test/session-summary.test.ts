import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SESSION_SUMMARY_SCHEMA, buildSummaryPrompt, parseJsonLoose, renderTranscript, validateSessionSummary } from '../src/harness/summary.ts'
import type { SummaryInput, Turn } from '../src/harness/types.ts'

const note = { context: 'Hacía falta exportar', done: '- Agregué el comando', decisions: null, findings: null, verification: null, pending: null }

function input(turns: Turn[]): SummaryInput {
  return {
    turns,
    meta: {
      harness: 'claude',
      projectName: 'Bita',
      repo: 'KikeDeAlba/bita-cli',
      branch: 'feature/x',
      cwd: '/work/bita-cli',
      durationSeconds: 5_400,
      touchedFiles: ['src/a.ts', 'src/b.ts'],
    },
    kinds: ['dev', 'meeting'],
    model: null,
    timeoutMs: 1_000,
  }
}

test('the schema is strict-mode compatible: every property required and no extras', () => {
  const visit = (node: Record<string, unknown>) => {
    if (node['type'] !== 'object') return
    const properties = node['properties'] as Record<string, Record<string, unknown>>
    assert.equal(node['additionalProperties'], false)
    assert.deepEqual([...(node['required'] as string[])].sort(), Object.keys(properties).sort())
    for (const child of Object.values(properties)) {
      assert.equal('minLength' in child || 'maxLength' in child, false)
      visit(child)
    }
  }
  visit(SESSION_SUMMARY_SCHEMA as unknown as Record<string, unknown>)
  assert.deepEqual(Object.keys(SESSION_SUMMARY_SCHEMA.properties.note.properties), ['context', 'done', 'decisions', 'findings', 'verification', 'pending'])
})

test('validator normalizes the title, nulls empty optionals and unknown kinds', () => {
  const result = validateSessionSummary(
    { title: '  "Agregar   export\n CSV"  ', kind: 'research', note: { ...note, decisions: '   ', findings: 'Un hallazgo' } },
    ['dev'],
  )
  assert.deepEqual(result, {
    ok: true,
    summary: { title: 'Agregar export CSV', kind: null, note: { ...note, findings: 'Un hallazgo' } },
  })
  const kept = validateSessionSummary({ title: 'Título válido', kind: 'dev', note }, ['dev'])
  assert.equal(kept.ok && kept.summary.kind, 'dev')
  const long = validateSessionSummary({ title: 'x'.repeat(150), kind: null, note }, [])
  assert.equal(long.ok && long.summary.title.length, 100)
})

test('validator rejects short titles, empty required sections and wrong shapes', () => {
  assert.deepEqual(validateSessionSummary({ title: ' "a" ', kind: null, note }, []), { ok: false, error: 'title must have at least 3 characters' })
  assert.equal(validateSessionSummary({ title: 'Válido', kind: null, note: { ...note, done: '  ' } }, []).ok, false)
  assert.equal(validateSessionSummary({ title: 'Válido', kind: null, note: { ...note, context: 3 } }, []).ok, false)
  assert.equal(validateSessionSummary({ title: 'Válido', kind: null, note: { ...note, pending: 7 } }, []).ok, false)
  assert.equal(validateSessionSummary({ title: 'Válido', kind: null }, []).ok, false)
  assert.equal(validateSessionSummary([], []).ok, false)
  assert.equal(validateSessionSummary(undefined, []).ok, false)
  assert.equal(validateSessionSummary({ title: 5, note }, []).ok, false)
})

test('parseJsonLoose strips fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonLoose('Claro, aquí va: {"a":{"b":2}} ¡listo!'), { a: { b: 2 } })
  assert.equal(parseJsonLoose('sin json'), undefined)
  assert.equal(parseJsonLoose('{roto'), undefined)
})

test('renderTranscript labels turns, clips each one and keeps head and tail when too long', () => {
  const short = renderTranscript([{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'qué tal' }])
  assert.equal(short, '### Usuario\nhola\n\n### Asistente\nqué tal')
  const clipped = renderTranscript([{ role: 'user', text: 'a'.repeat(5_000) }])
  assert.ok(clipped.length < 4_100)
  const turns: Turn[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `${i}:${'z'.repeat(3_000)}` }))
  turns.push({ role: 'assistant', text: 'FINAL' })
  const long = renderTranscript(turns)
  assert.ok(long.length <= 60_000)
  assert.ok(long.startsWith('### Usuario\n0:'))
  assert.ok(long.includes('[… recortado …]'))
  assert.ok(long.endsWith('FINAL'))
  assert.ok(renderTranscript(turns, 20_000).length <= 20_000)
})

test('the prompt is in Spanish and carries kinds, metadata and the transcript', () => {
  const prompt = buildSummaryPrompt(input([{ role: 'user', text: 'Agrega export' }]))
  assert.match(prompt, /80 caracteres o menos/)
  assert.match(prompt, /no inventes/)
  assert.match(prompt, /"dev", "meeting"/)
  assert.match(prompt, /Proyecto: Bita/)
  assert.match(prompt, /Rama: feature\/x/)
  assert.match(prompt, /Duración: 1 h 30 min/)
  assert.match(prompt, /src\/a\.ts, src\/b\.ts/)
  assert.match(prompt, /### Usuario\nAgrega export/)
  const noKinds = buildSummaryPrompt({ ...input([]), kinds: [] })
  assert.match(noKinds, /usa null/)
})
