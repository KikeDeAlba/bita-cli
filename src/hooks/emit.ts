import path from 'node:path'
import type { LocalContext } from '../cli/local-context.ts'
import { readConfig } from '../state/config.ts'
import { pagesOfEntry } from '../db/page-links.ts'
import { eventsDisabled, fireEvents, type HookPayload } from './hooks.ts'

export async function emitHooks(ctx: LocalContext, payloads: readonly HookPayload[]): Promise<number> {
  if (payloads.length === 0 || eventsDisabled()) return 0
  const hooks = (await readConfig()).hooks ?? []
  const withPages = payloads.map((payload) => ({
    ...payload,
    pageIds: payload.pageIds ?? pagesOfEntry(ctx.db, payload.entry.id).map((link) => link.pageId),
  }))
  return fireEvents(hooks, withPages, {
    databasePath: path.resolve(ctx.databasePath),
    docsRoot: path.resolve(ctx.docsRoot),
  })
}
