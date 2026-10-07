import { ConflictError } from '../errors.ts'
import { ConfluenceClient } from '../confluence/client.ts'
import { JiraClient } from '../jira/client.ts'
import type { Fetch } from './runtime.ts'
import type { AtlassianCredentials } from './sites.ts'

export type SiteStatus = 'ok' | 'auth_failed' | 'unreachable' | 'unknown'

type ProductState = 'ok' | 'auth' | 'missing' | 'unreachable'

export interface SiteCheck {
  status: SiteStatus
  jira: boolean
  confluence: boolean
  displayName: string | null
  errors: string[]
}

async function probe(call: () => Promise<string>): Promise<{ state: ProductState; name: string | null; error: string | null }> {
  try {
    return { state: 'ok', name: await call(), error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ConflictError) {
      if (error.code === 'JIRA_AUTH' || error.code === 'CONFLUENCE_AUTH') return { state: 'auth', name: null, error: message }
      return { state: 'missing', name: null, error: message }
    }
    return { state: 'unreachable', name: null, error: message }
  }
}

export async function checkSite(credentials: AtlassianCredentials, fetch: Fetch): Promise<SiteCheck> {
  const [jira, confluence] = await Promise.all([
    probe(async () => (await new JiraClient(credentials, fetch).myself()).displayName),
    probe(async () => (await new ConfluenceClient(credentials, fetch).currentUser()).displayName),
  ])
  const states = [jira.state, confluence.state]
  const status: SiteStatus = states.includes('auth')
    ? 'auth_failed'
    : states.includes('ok')
      ? 'ok'
      : 'unreachable'
  return {
    status,
    jira: jira.state === 'ok',
    confluence: confluence.state === 'ok',
    displayName: jira.name ?? confluence.name ?? null,
    errors: [jira.error, confluence.error].filter((error): error is string => error !== null),
  }
}
