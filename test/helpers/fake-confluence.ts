import type { Fetch } from '../../src/atlassian/runtime.ts'

export interface FakePage {
  id: string
  title: string
  version: number
  spaceId: string
  parentId: string | null
  storage: string
  status?: string
}

export interface FakeCall {
  method: string
  path: string
  body: unknown
}

export class FakeConfluence {
  readonly site: string
  readonly pages = new Map<string, FakePage>()
  readonly spaces = new Map<string, { id: string; key: string; homepageId: string }>()
  readonly calls: FakeCall[] = []
  private nextId = 9000

  constructor(site = 'https://acme.atlassian.net') {
    this.site = site
  }

  add(page: Omit<FakePage, 'version' | 'spaceId'> & { version?: number; spaceId?: string }): FakePage {
    const created: FakePage = { version: 1, spaceId: 'S1', ...page }
    this.pages.set(created.id, created)
    return created
  }

  edit(id: string, storage: string, title?: string): void {
    const page = this.pages.get(id)
    if (!page) throw new Error(`no fake page ${id}`)
    page.storage = storage
    if (title !== undefined) page.title = title
    page.version += 1
  }

  writes(): FakeCall[] {
    return this.calls.filter((call) => call.method !== 'GET')
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  private view(page: FakePage): Record<string, unknown> {
    return {
      id: page.id,
      title: page.title,
      status: page.status ?? 'current',
      spaceId: page.spaceId,
      parentId: page.parentId,
      version: { number: page.version },
      body: { storage: { value: page.storage, representation: 'storage' } },
      _links: { webui: `/spaces/K/pages/${page.id}`, base: `${this.site}/wiki` },
    }
  }

  readonly fetch: Fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    const path = url.pathname.replace(/^\/wiki/, '')
    this.calls.push({ method, path: `${path}${url.search}`, body })

    if (url.pathname === '/rest/api/3/myself') return this.json(200, { accountId: 'a1', displayName: 'Fake User', emailAddress: 'me@acme.com' })
    if (path === '/rest/api/user/current') return this.json(200, { accountId: 'a1', displayName: 'Fake User' })

    if (path === '/api/v2/spaces') {
      const space = this.spaces.get(url.searchParams.get('keys') ?? '')
      return this.json(200, { results: space ? [space] : [] })
    }

    const children = /^\/api\/v2\/pages\/(\d+)\/children$/.exec(path)
    if (children) {
      const results = [...this.pages.values()]
        .filter((page) => page.parentId === children[1])
        .map((page, index) => ({ id: page.id, title: page.title, status: page.status ?? 'current', spaceId: page.spaceId, childPosition: index }))
      return this.json(200, { results, _links: {} })
    }

    const single = /^\/api\/v2\/pages\/(\d+)$/.exec(path)
    if (single) {
      const page = this.pages.get(single[1] ?? '')
      if (!page) return this.json(404, { message: 'Not found' })
      if (method === 'GET') return this.json(200, this.view(page))
      if (method === 'PUT') {
        const update = body as { title: string; version: { number: number }; body: { value: string } }
        if (update.version.number !== page.version + 1) return this.json(409, { message: 'Version conflict' })
        page.title = update.title
        page.version = update.version.number
        page.storage = update.body.value
        return this.json(200, this.view(page))
      }
    }

    if (path === '/api/v2/pages' && method === 'POST') {
      const create = body as { spaceId: string; title: string; parentId?: string; body: { value: string } }
      if ([...this.pages.values()].some((page) => page.title === create.title && page.spaceId === create.spaceId)) {
        return this.json(400, { message: 'A page with this title already exists' })
      }
      this.nextId += 1
      const page = this.add({ id: String(this.nextId), title: create.title, parentId: create.parentId ?? null, storage: create.body.value, spaceId: create.spaceId })
      return this.json(200, this.view(page))
    }

    return this.json(404, { message: `unhandled ${method} ${path}` })
  }) as Fetch
}
