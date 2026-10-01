import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const SESSION_START = {
  matcher: 'startup|resume|clear|compact',
  hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }],
}

const PROMPT_SUBMIT = {
  hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }],
}

const POST_TOOL_USE = {
  matcher: '.*',
  hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }],
}

const HOOKS = {
  SessionStart: [SESSION_START],
  UserPromptSubmit: [PROMPT_SUBMIT],
  PostToolUse: [POST_TOOL_USE],
}

const path = process.argv[2]

function printManualBlock() {
  console.log('  Add this to hooks.json by hand:')
  console.log(JSON.stringify({ hooks: HOOKS }, null, 2).split('\n').map((line) => `    ${line}`).join('\n'))
}

if (!path) {
  printManualBlock()
  process.exit(0)
}

let settings = {}
if (existsSync(path)) {
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.log(`  ! ${path} is not valid JSON, so it was left alone: ${String(error)}`)
    printManualBlock()
    process.exit(0)
  }
  copyFileSync(path, `${path}.backup`)
}

settings.hooks ??= {}
const addedHooks = []

for (const [event, definitions] of Object.entries(HOOKS)) {
  settings.hooks[event] ??= []
  for (const definition of definitions) {
    const command = definition.hooks[0].command
    const present = settings.hooks[event].some((entry) =>
      (entry.hooks ?? []).some((candidate) => candidate.command === command),
    )
    if (!present) {
      settings.hooks[event].push(definition)
      addedHooks.push(`${event}: ${command}`)
    }
  }
}

writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`  ${existsSync(`${path}.backup`) ? `backed up to ${path}.backup; ` : ''}hooks: ${addedHooks.length === 0 ? 'all already there' : `added ${addedHooks.join(', ')}`}`)
