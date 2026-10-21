import type { FoundTool } from '@kikedealba/kit/registry'
import type { SessionNote } from '../harness/types.ts'

export const ENTRY_NOTES_CAPABILITY = 'docs.entry-notes'

export const NOTE_HEADINGS: Readonly<Record<keyof SessionNote, string>> = {
  context: 'Contexto',
  done: 'Qué se hizo',
  decisions: 'Decisiones',
  findings: 'Hallazgos',
  verification: 'Verificación',
  pending: 'Pendiente',
}

const NOTE_ORDER: readonly (keyof SessionNote)[] = ['context', 'done', 'decisions', 'findings', 'verification', 'pending']

const FILE_LIMIT = 50
const NOTE_TIMEOUT_MS = 30_000

export interface NoteWriterOptions {
  cwd: string
  touchedFiles: readonly string[]
  env: NodeJS.ProcessEnv
}

export type NoteWriter = (
  entryId: number,
  note: SessionNote,
  options: NoteWriterOptions,
) => Promise<{ written: number; error: string | null }>

type KitRegistry = typeof import('@kikedealba/kit/registry')
type KitPlatform = typeof import('@kikedealba/kit/platform')

async function loadKit(): Promise<{ registry: KitRegistry; platform: KitPlatform } | null> {
  try {
    const [registry, platform] = await Promise.all([import('@kikedealba/kit/registry'), import('@kikedealba/kit/platform')])
    return { registry, platform }
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const writeEntryNote: NoteWriter = async (entryId, note, options) => {
  const kit = await loadKit()
  if (!kit) return { written: 0, error: 'inkwell not found' }
  const { registry, platform } = kit

  let tool: FoundTool | undefined
  try {
    tool = (await registry.findByCapability(ENTRY_NOTES_CAPABILITY, platform.platformContext({ env: options.env })))[0]
  } catch (error) {
    return { written: 0, error: `inkwell lookup failed: ${errorText(error)}` }
  }
  if (!tool) return { written: 0, error: 'inkwell not found' }

  const files = options.touchedFiles.slice(0, FILE_LIMIT).flatMap((file) => ['--file', file])
  const errors: string[] = []
  let written = 0
  for (const key of NOTE_ORDER) {
    const body = note[key]
    if (body === null || body.trim().length === 0) continue
    const args = ['note', 'save', String(entryId), '--section', NOTE_HEADINGS[key], '--md', '-', '--json', ...(key === 'done' ? files : [])]
    try {
      const result = await registry.invokeTool(tool, args, {
        input: body,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: NOTE_TIMEOUT_MS,
      })
      if (result.envelope.ok) written += 1
      else errors.push(`${NOTE_HEADINGS[key]}: ${JSON.stringify(result.envelope.error ?? null)}`)
    } catch (error) {
      errors.push(`${NOTE_HEADINGS[key]}: ${errorText(error)}`)
    }
  }
  return { written, error: errors.length === 0 ? null : errors.join('; ') }
}
