import { spawn } from 'node:child_process'

interface OpenCodeContext {
  location: { directory: string }
  session: {
    hook(name: 'prompt', callback: (event: { sessionID: string }) => Promise<void>): Promise<unknown>
    hook(name: 'context', callback: (event: { sessionID: string; system: Array<{ type: 'text'; text: string }> }) => Promise<void>): Promise<unknown>
  }
  tool: {
    hook(name: 'execute.after', callback: (event: { tool: string; input: unknown; result?: unknown }) => Promise<void>): Promise<unknown>
  }
}

type HookOutput = {
  hookSpecificOutput?: {
    additionalContext?: string
  }
}

async function runBita(args: string[], input?: string): Promise<HookOutput | null> {
  try {
    const result = await runProcess(process.env['BITA_BIN'] ?? 'bita', args, input)
    try {
      return JSON.parse(result) as HookOutput
    } catch {
      return null
    }
  } catch {
    return null
  }
}

function runProcess(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'))
      else reject(new Error(`bita exited with code ${code ?? 'unknown'}`))
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

function contextOf(output: HookOutput | null): string | undefined {
  const context = output?.hookSpecificOutput?.additionalContext
  return typeof context === 'string' && context.length > 0 ? context : undefined
}

function filePaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  return ['filePath', 'file_path', 'path', 'filename', 'file']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export default {
  id: 'bita',
  async setup(ctx: OpenCodeContext) {
    const started = new Set<string>()
    const pending = new Map<string, string[]>()

    await ctx.session.hook('prompt', async (event) => {
      const output = await runBita(['hook', 'prompt-submit'])
      const context = contextOf(output)
      if (context) pending.set(event.sessionID, [context])
    })

    await ctx.session.hook('context', async (event) => {
      const contexts = pending.get(event.sessionID) ?? []
      pending.delete(event.sessionID)

      if (!started.has(event.sessionID)) {
        started.add(event.sessionID)
        const output = await runBita(['hook', 'session-start'])
        const context = contextOf(output)
        if (context) contexts.unshift(context)
      }

      const checkpoint = await runBita(['hook', 'checkpoint'])
      const checkpointContext = contextOf(checkpoint)
      if (checkpointContext) contexts.push(checkpointContext)

      for (const text of contexts) event.system.push({ type: 'text', text })
    })

    await ctx.tool.hook('execute.after', async (event) => {
      for (const file of filePaths(event.input)) {
        await runBita(['hook', 'touched', '--file', file])
      }
      await runBita(['hook', 'ref'], JSON.stringify({
        cwd: ctx.location.directory,
        tool_name: event.tool,
        tool_input: event.input,
        tool_response: event.result,
      }))
    })

    return () => {
      started.clear()
      pending.clear()
    }
  },
}
