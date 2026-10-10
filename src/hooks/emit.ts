import path from 'node:path'
import type { LocalContext } from '../cli/local-context.ts'
import { readConfig } from '../state/config.ts'
import { eventsDisabled, fireEvents, type HookPayload } from './hooks.ts'

export async function emitHooks(ctx: LocalContext, payloads: readonly HookPayload[]): Promise<number> {
  if (payloads.length === 0 || eventsDisabled()) return 0
  const hooks = (await readConfig()).hooks ?? []
  return fireEvents(
    hooks,
    payloads.map((payload) => ({ ...payload, docPath: null, pageIds: [] })),
    {
      databasePath: path.resolve(ctx.databasePath),
      docsRoot: path.resolve(ctx.docsRoot),
    },
  )
}
