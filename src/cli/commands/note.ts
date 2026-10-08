import { readFile } from 'node:fs/promises'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, readStringList } from '../args.ts'
import { createLocalContext, type LocalContext } from '../local-context.ts'
import { resolveEntryId } from '../resolve-entry.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { findEntryWithProject } from '../../db/entries.ts'
import { listDocsForEntry } from '../../db/docs.ts'
import { recordTouch } from '../../db/touches.ts'
import { docPathFor, readEntryDoc, recordEntryDoc } from '../../docs/record.ts'
import { readRaw } from '../../docs/store.ts'
import { commitDocs, docsSubject } from '../../docs/git.ts'
import { currentRepoIdentity } from './repo.ts'
import type { EntryWithProjectRow } from '../../db/rows.ts'

const OPTIONS = {
  draft: { type: 'boolean' as const, default: false },
  create: { type: 'boolean' as const, default: false },
  raw: { type: 'boolean' as const, default: false },
  'note-json': { type: 'string' as const },
  'note-md': { type: 'string' as const },
  section: { type: 'string' as const },
  file: { type: 'string' as const, multiple: true },
  command: { type: 'string' as const, multiple: true },
  resource: { type: 'string' as const, multiple: true },
}

const SUBCOMMANDS = new Set(['path', 'save', 'get', 'ls', 'set'])

function requireEntry(ctx: LocalContext, entryId: number): EntryWithProjectRow {
  const entry = findEntryWithProject(ctx.db, entryId)
  if (!entry) throw new UsageError(`No entry #${entryId}.`)
  return entry
}

async function identity() {
  const found = await currentRepoIdentity()
  if (!found) return null
  return {
    slug: found.slug,
    ...(found.branch !== undefined ? { branch: found.branch } : {}),
    ...(found.headSha !== undefined ? { headSha: found.headSha } : {}),
  }
}

function recordArtifacts(ctx: LocalContext, entryId: number, files: string[]): void {
  const now = ctx.now.toISOString()
  for (const file of files) recordTouch(ctx.db, entryId, file, now)
}

function artifactSection(commands: string[], resources: string[]): string {
  const parts: string[] = []
  if (commands.length > 0) {
    parts.push('### Comandos', '', ...commands.map((command) => `- \`${command}\``))
  }
  if (resources.length > 0) {
    if (parts.length > 0) parts.push('')
    parts.push('### Recursos', '', ...resources.map((resource) => `- ${resource}`))
  }
  return parts.join('\n')
}

export async function runNote(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'get'
  const subcommand = SUBCOMMANDS.has(first) ? first : 'get'
  const rest = SUBCOMMANDS.has(first) ? argv.slice(1) : argv
  const args = parseCommandArgs(rest, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    const entryId = resolveEntryId(ctx, args, `Usage: bita note ${subcommand} <id|--draft>`)
    const entry = requireEntry(ctx, entryId)

    if (subcommand === 'path') return await runPath(ctx, entry, args, json)
    if (subcommand === 'save' || subcommand === 'set') return await runSave(ctx, entry, args, json)
    if (subcommand === 'ls') return runList(ctx, entry, json)
    return await runGet(ctx, entry, args, json)
  } finally {
    ctx.db.close()
  }
}

async function runPath(
  ctx: LocalContext,
  entry: EntryWithProjectRow,
  args: import('../args.ts').ParsedArgs,
  json: boolean,
): Promise<number> {
  if (readBoolean(args, 'create')) {
    const recorded = await recordEntryDoc(ctx, entry, {
      source: 'manual',
      identity: await identity(),
      create: true,
    })
    if (!recorded) throw new UsageError(`Could not create the document for entry #${entry.id}.`)

    if (json) writeJson(successEnvelope('note path', recorded))
    else writeOut(recorded.path)
    return 0
  }

  const located = docPathFor(ctx, entry)
  if (json) {
    const exists = (await readRaw(located.path)) !== null
    writeJson(successEnvelope('note path', { entryId: entry.id, ...located, exists }))
  } else {
    writeOut(located.path)
  }
  return 0
}

async function runSave(
  ctx: LocalContext,
  entry: EntryWithProjectRow,
  args: import('../args.ts').ParsedArgs,
  json: boolean,
): Promise<number> {
  const markdownPath = readString(args, 'note-md')
  const jsonPath = readString(args, 'note-json')
  const files = readStringList(args, 'file')
  const commands = readStringList(args, 'command')
  const resources = readStringList(args, 'resource')

  let section: { heading: string; body: string } | undefined
  if (markdownPath) {
    const heading = readString(args, 'section') ?? 'Qué se hizo'
    section = { heading, body: await readSeed(markdownPath) }
  } else if (jsonPath) {
    section = { heading: 'Resumen', body: await readLegacyNote(jsonPath) }
  }

  const artifacts = artifactSection(commands, resources)
  recordArtifacts(ctx, entry.id, files)

  const recorded = await recordEntryDoc(ctx, entry, {
    source: 'manual',
    identity: await identity(),
    create: true,
    section,
    commit: false,
  })
  if (!recorded) throw new UsageError(`No document for entry #${entry.id}.`)

  const withArtifacts =
    artifacts.length === 0
      ? recorded
      : await recordEntryDoc(ctx, entry, {
          source: 'manual',
          identity: await identity(),
          section: { heading: 'Tocado', body: artifacts },
          commit: false,
        })

  const result = withArtifacts ?? recorded
  await commitDocs(ctx.docsRoot, [result.relPath, ...(recorded.renamedFrom !== null ? [recorded.renamedFrom] : [])], {
    source: 'note',
    subject: docsSubject(result.relPath, 'update note', entry.description || `#${entry.id}`),
    entryId: entry.id,
  })
  if (json) writeJson(successEnvelope('note save', result))
  else {
    writeOut(`Saved ${result.relPath}`)
    writeOut(`Sections: ${result.sectionCount}, ${result.byteSize} bytes`)
    if (!result.frontMatterValid) {
      writeOut('The front matter could not be read, so it was left untouched.')
    }
  }
  return 0
}

async function readSeed(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new UsageError(`Could not read the markdown at ${path}: ${String(error)}`)
  }
}

async function readLegacyNote(path: string): Promise<string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new UsageError(`Could not read the note at ${path}: ${String(error)}`)
  }
  const body = (raw as { body?: unknown })?.body
  if (typeof body !== 'string') throw new UsageError('The note needs a "body" string.')
  return body
}

function runList(ctx: LocalContext, entry: EntryWithProjectRow, json: boolean): number {
  const docs = listDocsForEntry(ctx.db, entry.id)
  if (json) {
    writeJson(successEnvelope('note ls', docs, { entryId: entry.id, root: ctx.docsRoot }))
    return 0
  }
  if (docs.length === 0) {
    writeOut(`No document recorded for entry #${entry.id}.`)
    return 0
  }
  for (const doc of docs) writeOut(`${doc.kind === 'note' ? ' ' : '+'} ${doc.relPath}`)
  return 0
}

async function runGet(
  ctx: LocalContext,
  entry: EntryWithProjectRow,
  args: import('../args.ts').ParsedArgs,
  json: boolean,
): Promise<number> {
  const docs = listDocsForEntry(ctx.db, entry.id)
  const primary = docs.find((doc) => doc.kind === 'note') ?? docs[0]

  if (!primary) {
    if (json) writeJson(successEnvelope('note get', null, { entryId: entry.id }))
    else writeOut(`No document recorded for entry #${entry.id}.`)
    return 0
  }

  const { path, markdown } = await readEntryDoc(ctx, primary)

  if (json) {
    writeJson(
      successEnvelope('note get', { ...primary, path, markdown }, { entryId: entry.id, root: ctx.docsRoot }),
    )
    return 0
  }

  if (markdown === null) {
    writeOut(`The document was recorded at ${path}, but the file is gone.`)
    return 0
  }

  if (readBoolean(args, 'raw')) writeOut(markdown)
  else {
    writeOut(path)
    writeOut('')
    writeOut(markdown)
  }
  return 0
}
