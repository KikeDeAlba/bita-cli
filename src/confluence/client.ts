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

export interface ConfluencePage {
  id: string
  title: string
  version: number
  spaceId: string | null
  parentId: string | null
  status: string | null
  storage: string
  webUrl: string | null
}

export interface ConfluencePageSummary {
  id: string
  title: string
  status: string | null
  spaceId: string | null
  position: number | null
}

export interface ConfluenceSpace {
  id: string
  key: string
  name: string
  homepageId: string | null
  webUrl: string | null
}

export interface ConfluenceSearchHit {
  id: string
  type: string
  title: string
  space: string | null
  excerpt: string
  lastModified: string | null
  url: string | null
}

export interface NewConfluencePage {
  spaceId: string
  parentId?: string | null | undefined
  title: string
  storage: string
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
  pdf: 'application/pdf',
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
        'Check it with "bita atlassian site test <site>", or add it again: pbpaste | bita atlassian site add --site <url> --email <you@company.com> --token-stdin',
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

  private webUrl(links: { webui?: string; base?: string } | undefined): string | null {
    const webui = links?.webui
    return webui ? `${links?.base ?? `${this.site}/wiki`}${webui}` : null
  }

  private toPage(body: RawPage): ConfluencePage {
    return {
      id: String(body.id),
      title: body.title ?? '',
      version: body.version?.number ?? 1,
      spaceId: body.spaceId === undefined || body.spaceId === null ? null : String(body.spaceId),
      parentId: body.parentId === undefined || body.parentId === null ? null : String(body.parentId),
      status: body.status ?? null,
      storage: body.body?.storage?.value ?? '',
      webUrl: this.webUrl(body._links),
    }
  }

  async page(pageId: string): Promise<ConfluencePage> {
    const body = (await this.request(`/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`)) as RawPage
    return this.toPage(body)
  }

  async children(pageId: string): Promise<ConfluencePageSummary[]> {
    const found: ConfluencePageSummary[] = []
    let path: string | null = `/api/v2/pages/${encodeURIComponent(pageId)}/children?limit=250`
    while (path !== null) {
      const body = (await this.request(path)) as {
        results?: { id: string | number; title?: string; status?: string; spaceId?: string | number; childPosition?: number }[]
        _links?: { next?: string }
      }
      for (const raw of body.results ?? []) {
        found.push({
          id: String(raw.id),
          title: raw.title ?? '',
          status: raw.status ?? null,
          spaceId: raw.spaceId === undefined ? null : String(raw.spaceId),
          position: raw.childPosition ?? null,
        })
      }
      const next = body._links?.next
      path = next ? next.replace(/^\/wiki/, '') : null
    }
    return found
  }

  async spaceByKey(key: string): Promise<ConfluenceSpace> {
    const body = (await this.request(`/api/v2/spaces?keys=${encodeURIComponent(key)}`)) as {
      results?: { id: string | number; key: string; name?: string; homepageId?: string | number | null; _links?: { webui?: string; base?: string } }[]
    }
    const space = body.results?.[0]
    if (!space) throw new ConflictError(`There is no Confluence space ${key}, or it is not visible.`, 'CONFLUENCE_SPACE')
    return {
      id: String(space.id),
      key: space.key,
      name: space.name ?? space.key,
      homepageId: space.homepageId === undefined || space.homepageId === null ? null : String(space.homepageId),
      webUrl: this.webUrl(space._links),
    }
  }

  async createPage(page: NewConfluencePage): Promise<ConfluencePage> {
    const body = (await this.request('/api/v2/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spaceId: page.spaceId,
        status: 'current',
        title: page.title,
        ...(page.parentId ? { parentId: page.parentId } : {}),
        body: { representation: 'storage', value: page.storage },
      }),
    })) as RawPage
    return { ...this.toPage(body), storage: body.body?.storage?.value ?? page.storage }
  }

  async updatePage(update: { id: string; title: string; storage: string; version: number; message?: string | undefined }): Promise<ConfluencePage> {
    const body = (await this.request(`/api/v2/pages/${encodeURIComponent(update.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: update.id,
        status: 'current',
        title: update.title,
        body: { representation: 'storage', value: update.storage },
        version: { number: update.version, ...(update.message ? { message: update.message } : {}) },
      }),
    })) as RawPage
    return { ...this.toPage(body), version: body.version?.number ?? update.version, storage: update.storage }
  }

  async search(cql: string, limit = 25): Promise<ConfluenceSearchHit[]> {
    const body = (await this.request(`/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`)) as {
      results?: {
        content?: { id?: string; type?: string; title?: string }
        title?: string
        excerpt?: string
        url?: string
        lastModified?: string
        resultGlobalContainer?: { title?: string }
      }[]
    }
    return (body.results ?? []).map((raw) => ({
      id: raw.content?.id ?? '',
      type: raw.content?.type ?? '',
      title: raw.content?.title ?? raw.title ?? '',
      space: raw.resultGlobalContainer?.title ?? null,
      excerpt: (raw.excerpt ?? '').replace(/@@@(end)?hl@@@/g, ''),
      lastModified: raw.lastModified ?? null,
      url: raw.url ? `${this.site}/wiki${raw.url}` : null,
    }))
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

interface RawPage {
  id: string | number
  title?: string
  status?: string
  spaceId?: string | number | null
  parentId?: string | number | null
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  _links?: { webui?: string; base?: string }
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
