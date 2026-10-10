import { UsageError } from '../../errors.ts'
import { parseKind } from '../../domain/kind.ts'
import type { Listener } from '@kikedealba/kit/events'
import { EVENT_SOURCE, HOOK_EVENTS, hooksLogPath, isHookEvent, loadKitEvents, type HookConfig, type HookEvent } from '../../hooks/hooks.ts'
import { databasePath } from '../../db/paths.ts'
import { readConfig, readConfigForUpdate, writeConfig } from '../../state/config.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const OPTIONS = {
  on: { type: 'string' as const },
  kind: { type: 'string' as const },
}

const USAGE = `Usage:
  bita hooks [list]
  bita hooks add --on start,stop,cancel,amend,delete,merge [--kind a,b] -- <command> [args...]
  bita hooks remove <number>`

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function describe(hook: HookConfig, index: number): string {
  const kinds = hook.when?.kind ? ` kind=${hook.when.kind.join(',')}` : ''
  return `${index + 1}. on=${hook.on.join(',')}${kinds}  ${hook.command.join(' ')}`
}

async function registrySubscribers(): Promise<Listener[]> {
  const kit = await loadKitEvents()
  return kit ? kit.registryListeners(EVENT_SOURCE) : []
}

export async function runHooks(argv: string[]): Promise<number> {
  const separator = argv.indexOf('--')
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  const args = parseCommandArgs(own, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const [action = 'list', ...rest] = args.positionals
  const config = action === 'list' || action === 'ls' ? await readConfig() : await readConfigForUpdate()
  const hooks = config.hooks ?? []
  const logPath = hooksLogPath(readString(args, 'db-path') ?? databasePath())

  if (action === 'list' || action === 'ls') {
    const subscribers = await registrySubscribers()
    if (json) writeJson(successEnvelope('hooks', hooks, { logPath, subscribers }))
    else {
      if (hooks.length === 0) writeOut('No hooks configured.')
      for (const [index, hook] of hooks.entries()) writeOut(describe(hook, index))
      for (const subscriber of subscribers) {
        const kinds = subscriber.filter?.['kind'] ? ` kind=${subscriber.filter['kind'].join(',')}` : ''
        writeOut(`-. ${subscriber.owner}: on=${subscriber.events.join(',')}${kinds}  ${subscriber.command.join(' ')}`)
      }
      writeOut(`Log: ${logPath}`)
    }
    return 0
  }

  if (action === 'add') {
    const on = splitList(readString(args, 'on'))
    const invalid = on.filter((event) => !isHookEvent(event))
    if (on.length === 0 || invalid.length > 0) {
      throw new UsageError(`--on takes a comma list of ${HOOK_EVENTS.join(', ')}.\n${USAGE}`)
    }
    if (command.length === 0 || !command[0]) {
      throw new UsageError(`Pass the command after "--".\n${USAGE}`)
    }
    const kinds = splitList(readString(args, 'kind')).map((kind) => parseKind(kind))
    const hook: HookConfig = {
      on: on as HookEvent[],
      ...(kinds.length > 0 ? { when: { kind: kinds } } : {}),
      command,
    }
    const duplicate = hooks.some((existing) => JSON.stringify(existing) === JSON.stringify(hook))
    if (!duplicate) {
      config.hooks = [...hooks, hook]
      await writeConfig(config)
    }
    if (json) writeJson(successEnvelope('hooks', config.hooks ?? hooks, { added: !duplicate }))
    else writeOut(duplicate ? 'That hook is already configured.' : `Added ${describe(hook, hooks.length)}`)
    return 0
  }

  if (action === 'remove' || action === 'rm') {
    const index = Number(rest[0]) - 1
    const removed = hooks[index]
    if (!Number.isInteger(index) || !removed) {
      throw new UsageError(`No hook number ${rest[0] ?? ''}. Run "bita hooks" to see them.`)
    }
    const remaining = hooks.filter((_, position) => position !== index)
    if (remaining.length > 0) config.hooks = remaining
    else delete config.hooks
    await writeConfig(config)
    if (json) writeJson(successEnvelope('hooks', remaining, { removed }))
    else writeOut(`Removed ${describe(removed, index)}`)
    return 0
  }

  throw new UsageError(`Unknown hooks action "${action}".\n${USAGE}`)
}
