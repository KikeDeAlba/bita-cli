import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ConflictError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { promptHidden, promptText } from '../prompt.ts'
import { readConfig, writeConfig } from '../../state/config.ts'
import { deleteToken, readToken, storeToken } from '../../state/keychain.ts'
import { ConfluenceClient, type AttachmentInfo, type ConfluenceCredentials } from '../../confluence/client.ts'
import { adfImage, displaySize, pngSize, storageImage } from '../../confluence/fragments.ts'
import { addRefToPage } from '../../db/page-refs.ts'
import { renderPageDiagrams } from './diagrams.ts'

const ACTIONS = new Set(['login', 'status', 'logout', 'attach', 'publish-diagrams'])

const OPTIONS = {
  to: { type: 'string' as const },
  email: { type: 'string' as const },
  site: { type: 'string' as const },
  comment: { type: 'string' as const },
  force: { type: 'boolean' as const, default: false },
  'token-stdin': { type: 'boolean' as const, default: false },
}

const LOGIN_HINT =
  'Run "bita confluence login" in a terminal, or copy the API token and run: pbpaste | bita confluence login --token-stdin --email <you@company.com>'

export async function loadCredentials(): Promise<ConfluenceCredentials> {
  const config = await readConfig()
  const siteUrl = config.jira?.siteUrl
  const email = config.jira?.email
  if (!siteUrl || !email) {
    throw new ConflictError('There is no Atlassian login for Confluence yet.', 'CONFLUENCE_LOGIN_REQUIRED', LOGIN_HINT)
  }
  const token = await readToken(email)
  if (token === null) {
    throw new ConflictError(`The Keychain has no Atlassian token for ${email}.`, 'CONFLUENCE_LOGIN_REQUIRED', LOGIN_HINT)
  }
  return { siteUrl, email, token }
}

function confluencePageId(raw: string | undefined, usage: string): string {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new UsageError(usage)
  return raw
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function runLogin(args: ParsedArgs, json: boolean): Promise<number> {
  const config = await readConfig()
  const fromStdin = readBoolean(args, 'token-stdin')
  if (!fromStdin && !process.stdin.isTTY) {
    throw new ConflictError(
      'Logging in asks for the API token, which needs a terminal or --token-stdin.',
      'CONFIRMATION_REQUIRED',
      'Copy the token and run: pbpaste | bita confluence login --token-stdin --email <you@company.com>',
    )
  }

  const siteUrl =
    readString(args, 'site') ?? config.jira?.siteUrl ?? (fromStdin ? undefined : await promptText('Atlassian site (https://….atlassian.net): '))
  if (!siteUrl) throw new UsageError('Pass --site https://<name>.atlassian.net.')

  const suggested = readString(args, 'email') ?? config.jira?.email
  const email = fromStdin
    ? (suggested ?? '')
    : (await promptText(suggested ? `Atlassian e-mail [${suggested}]: ` : 'Atlassian e-mail: ')) || suggested || ''
  if (email.length === 0) throw new UsageError('An e-mail is needed: pass --email.')

  const token = fromStdin
    ? await readStdin()
    : await promptHidden('API token (https://id.atlassian.com/manage-profile/security/api-tokens): ')
  if (token.length === 0) throw new UsageError('An API token is needed.')
  if (/\s/.test(token)) throw new UsageError('The token has spaces or line breaks in it; copy only the token.')

  const user = await new ConfluenceClient({ siteUrl, email, token }).currentUser()
  await storeToken(email, token)
  await writeConfig({ ...config, jira: { ...config.jira, siteUrl, email } })

  if (json) {
    writeJson(successEnvelope('confluence login', { siteUrl, email, displayName: user.displayName }))
    return 0
  }
  writeOut(`Logged in to ${siteUrl} as ${user.displayName} (${email}). The token lives in the Keychain.`)
  return 0
}

async function runStatus(json: boolean): Promise<number> {
  const credentials = await loadCredentials()
  const user = await new ConfluenceClient(credentials).currentUser()
  const data = { siteUrl: credentials.siteUrl, email: credentials.email, displayName: user.displayName, ok: true }
  if (json) {
    writeJson(successEnvelope('confluence status', data))
    return 0
  }
  writeOut(`${credentials.siteUrl}: ${user.displayName} (${credentials.email}), token OK.`)
  return 0
}

async function runLogout(json: boolean): Promise<number> {
  const config = await readConfig()
  const email = config.jira?.email
  const removed = email ? await deleteToken(email) : false
  if (json) {
    writeJson(successEnvelope('confluence logout', { email: email ?? null, removed }))
    return 0
  }
  writeOut(removed ? `Removed the Atlassian token for ${email} from the Keychain.` : 'There was no token to remove.')
  return 0
}

export interface PlacedImage {
  attachment: AttachmentInfo
  adf: Record<string, unknown> | null
  storage: string
  width: number | null
  height: number | null
}

async function attachImage(client: ConfluenceClient, pageId: string, path: string, comment?: string): Promise<PlacedImage> {
  const attachment = await client.attach(pageId, path, comment)
  const size = attachment.mediaType === 'image/png' ? displaySize(pngSize(await readFile(path))) : null
  return {
    attachment,
    adf: adfImage(pageId, attachment, size),
    storage: storageImage(attachment.filename, size),
    width: size?.width ?? null,
    height: size?.height ?? null,
  }
}

async function runAttach(args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: bita confluence attach <confluencePageId> <files...>'
  const pageId = confluencePageId(args.positionals[0], usage)
  const files = args.positionals.slice(1)
  if (files.length === 0) throw new UsageError(usage)
  for (const file of files) if (!existsSync(file)) throw new UsageError(`No file at ${file}.`)

  const client = new ConfluenceClient(await loadCredentials())
  const placed: PlacedImage[] = []
  for (const file of files) placed.push(await attachImage(client, pageId, file, readString(args, 'comment')))

  if (json) {
    writeJson(successEnvelope('confluence attach', placed, { confluencePageId: pageId }))
    return 0
  }
  for (const item of placed) writeOut(`${item.attachment.filename} → ${item.attachment.attachmentId}`)
  return 0
}

async function runPublishDiagrams(args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: bita confluence publish-diagrams <bitaPageId> --to <confluencePageId>'
  const bitaPageId = Number(args.positionals[0])
  if (!Number.isInteger(bitaPageId) || bitaPageId <= 0) throw new UsageError(usage)
  const pageId = confluencePageId(readString(args, 'to'), usage)

  const client = new ConfluenceClient(await loadCredentials())
  const ctx = createLocalContext(args)
  try {
    const { diagrams, results } = await renderPageDiagrams(ctx, bitaPageId, { force: readBoolean(args, 'force') })
    const failed = results.filter((result) => result.state === 'failed' || result.state === 'missing-source')
    if (failed.length > 0) {
      const names = failed.map((result) => `${result.kind} ${result.name}${result.error ? ` (${result.error})` : ''}`)
      throw new ConflictError(
        `Some diagrams could not be rendered: ${names.join('; ')}.`,
        'DIAGRAM_RENDER_FAILED',
        'Fix them and run "bita docs diagrams render" first; nothing was uploaded.',
      )
    }

    const published = []
    for (const [at, result] of results.entries()) {
      const block = diagrams.blocks[at]!
      const image = await attachImage(client, pageId, result.imagePath, `bita: ${block.kind} ${block.name}`)
      const source = await client.attach(pageId, result.sourcePath, `bita: source of ${block.imageFile}`)
      published.push({
        index: block.index,
        kind: block.kind,
        name: block.name,
        line: block.line,
        image,
        source,
      })
    }

    const page = await client.pageStorage(pageId)
    if (page.webUrl) {
      addRefToPage(ctx.db, bitaPageId, {
        url: page.webUrl,
        title: page.title,
        kind: 'confluence',
        source: 'manual',
        now: ctx.now.toISOString(),
      })
    }

    const data = { bitaPageId, confluencePageId: pageId, confluenceTitle: page.title, confluenceUrl: page.webUrl, diagrams: published }
    if (json) {
      writeJson(successEnvelope('confluence publish-diagrams', data))
      return 0
    }
    if (published.length === 0) writeOut(`Page #${bitaPageId} has no diagrams to publish.`)
    for (const item of published) {
      writeOut(`#${item.index} ${item.kind} ${item.name}: ${item.image.attachment.filename} + ${item.source.filename}`)
    }
    return 0
  } finally {
    ctx.db.close()
  }
}

export async function runConfluence(argv: string[]): Promise<number> {
  const action = argv[0]
  if (action === undefined || !ACTIONS.has(action)) {
    throw new UsageError(`Usage: bita confluence <${[...ACTIONS].join('|')}>`)
  }
  const args = parseCommandArgs(argv.slice(1), OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  if (action === 'login') return runLogin(args, json)
  if (action === 'status') return runStatus(json)
  if (action === 'logout') return runLogout(json)
  if (action === 'attach') return runAttach(args, json)
  return runPublishDiagrams(args, json)
}
