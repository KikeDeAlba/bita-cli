import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ConflictError } from '../errors.ts'

export type Fetch = typeof globalThis.fetch

export interface ConfluenceCredentials {
  siteUrl: string
  email: string
  token: string
}

export interface ConfluenceUser {
  accountId: string
  displayName: string
}

export interface AttachmentInfo {
  attachmentId: string
  filename: string
  fileId: string | null
  mediaType: string
  downloadUrl: string | null
}

export interface PageStorage {
  id: string
  title: string
  version: number
  storage: string
  webUrl: string | null
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  drawio: 'application/vnd.jgraph.mxfile',
  mmd: 'text/plain',
}

export function mediaTypeOf(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

export function siteBase(siteUrl: string): string {
  const trimmed = siteUrl.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/]+$/.test(trimmed)) {
    throw new ConflictError(`"${siteUrl}" is not an Atlassian site URL.`, 'CONFLUENCE_SITE', 'Expected something like https://gruposti.atlassian.net.')
  }
  return trimmed
}

export class ConfluenceClient {
  readonly site: string
  private readonly authorization: string
  private readonly fetch: Fetch

  constructor(credentials: ConfluenceCredentials, fetch: Fetch = globalThis.fetch) {
    this.site = siteBase(credentials.siteUrl)
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`
    this.fetch = fetch
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(`${this.site}/wiki${path}`, {
      ...init,
      headers: { Authorization: this.authorization, Accept: 'application/json', ...(init.headers ?? {}) },
    })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      throw new ConflictError(
        `Confluence refused the credentials (HTTP ${response.status}).`,
        'CONFLUENCE_AUTH',
        'Run "bita confluence login" in a terminal, or: pbpaste | bita confluence login --token-stdin --email <you@company.com>',
      )
    }
    if (!response.ok) {
      const detail = text.replace(/\s+/g, ' ').slice(0, 240)
      throw new ConflictError(`Confluence answered HTTP ${response.status}: ${detail}`, 'CONFLUENCE_HTTP')
    }
    return text.length === 0 ? null : (JSON.parse(text) as unknown)
  }

  async currentUser(): Promise<ConfluenceUser> {
    const body = (await this.request('/rest/api/user/current')) as { accountId?: string; displayName?: string }
    return { accountId: body.accountId ?? '', displayName: body.displayName ?? '' }
  }

  async attach(pageId: string, filePath: string, comment?: string): Promise<AttachmentInfo> {
    const filename = basename(filePath)
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mediaTypeOf(filename) }), filename)
    form.append('minorEdit', 'true')
    if (comment) form.append('comment', comment)

    const body = (await this.request(`/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`, {
      method: 'PUT',
      headers: { 'X-Atlassian-Token': 'no-check' },
      body: form,
    })) as { results?: RawAttachment[] } & RawAttachment

    const raw = body.results?.[0] ?? body
    return toAttachment(raw, filename, this.site)
  }

  async pageStorage(pageId: string): Promise<PageStorage> {
    const body = (await this.request(`/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`)) as {
      id: string
      title: string
      version?: { number?: number }
      body?: { storage?: { value?: string } }
      _links?: { webui?: string; base?: string }
    }
    const webui = body._links?.webui
    return {
      id: body.id,
      title: body.title,
      version: body.version?.number ?? 1,
      storage: body.body?.storage?.value ?? '',
      webUrl: webui ? `${body._links?.base ?? `${this.site}/wiki`}${webui}` : null,
    }
  }

  async replaceStorage(page: PageStorage, storage: string, message: string): Promise<number> {
    const body = (await this.request(`/api/v2/pages/${encodeURIComponent(page.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: page.id,
        status: 'current',
        title: page.title,
        body: { representation: 'storage', value: storage },
        version: { number: page.version + 1, message },
      }),
    })) as { version?: { number?: number } }
    return body.version?.number ?? page.version + 1
  }
}

interface RawAttachment {
  id?: string
  title?: string
  extensions?: { fileId?: string; mediaType?: string }
  metadata?: { mediaType?: string }
  _links?: { download?: string }
}

function toAttachment(raw: RawAttachment, filename: string, site: string): AttachmentInfo {
  const download = raw._links?.download
  return {
    attachmentId: raw.id ?? '',
    filename: raw.title ?? filename,
    fileId: raw.extensions?.fileId ?? null,
    mediaType: raw.extensions?.mediaType ?? raw.metadata?.mediaType ?? mediaTypeOf(filename),
    downloadUrl: download ? `${site}/wiki${download}` : null,
  }
}
