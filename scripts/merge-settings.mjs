import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'

const ALLOW = [
  'Bash(bita projects:*)',
  'Bash(bita project:*)',
  'Bash(bita entries:*)',
  'Bash(bita summary:*)',
  'Bash(bita ls:*)',
  'Bash(bita current:*)',
  'Bash(bita start:*)',
  'Bash(bita stop:*)',
  'Bash(bita log:*)',
  'Bash(bita link:*)',
  'Bash(bita note:*)',
  'Bash(bita notes:*)',
  'Bash(bita repo:*)',
  'Bash(bita map list:*)',
  'Bash(bita map set:*)',
  'Bash(bita map unset:*)',
  'Bash(bita map story:*)',
  'Bash(bita config get:*)',
  'Bash(bita config set-jira:*)',
  'Bash(bita hook:*)',
  'Bash(bita amend:*)',
  'Bash(bita scope list:*)',
  'Bash(bita scope set:*)',
  'Bash(bita scope unset:*)',
  'Bash(bita scope which:*)',
  'Bash(bita --version)',
]

const ASK = ['Bash(bita cancel:*)']

const SESSION_START_HOOK = {
  matcher: 'startup|resume|clear|compact',
  hooks: [{ type: 'command', command: 'bita hook session-start', timeout: 5 }],
}

const PROMPT_SUBMIT_HOOK = {
  hooks: [{ type: 'command', command: 'bita hook prompt-submit', timeout: 5 }],
}

const CHECKPOINT_HOOK = {
  hooks: [{ type: 'command', command: 'bita hook checkpoint', timeout: 5 }],
}

const TOUCHED_HOOK = {
  matcher: 'Edit|Write',
  hooks: [
    {
      type: 'command',
      command:
        'jq -r \'.tool_input.file_path // empty\' | { read -r f; [ -n "$f" ] && bita hook touched --file "$f"; } 2>/dev/null || true',
      timeout: 10,
    },
  ],
}

const REF_HOOK = {
  matcher: 'mcp__.*Atlassian.*|mcp__.*Google_Drive.*',
  hooks: [{ type: 'command', command: 'bita hook ref', timeout: 10 }],
}

const EVENT_HOOKS = [
  ['SessionStart', SESSION_START_HOOK],
  ['UserPromptSubmit', PROMPT_SUBMIT_HOOK],
  ['UserPromptSubmit', CHECKPOINT_HOOK],
  ['PostToolUse', TOUCHED_HOOK],
  ['PostToolUse', REF_HOOK],
]

function hooksByEvent() {
  const grouped = {}
  for (const [event, hook] of EVENT_HOOKS) {
    grouped[event] ??= []
    grouped[event].push(hook)
  }
  return grouped
}

const path = process.argv[2]

function printManualBlock() {
  console.log('  Add this to your settings.json by hand:')
  console.log(
    JSON.stringify(
      {
        permissions: { allow: ALLOW, ask: ASK },
        hooks: hooksByEvent(),
      },
      null,
      2,
    )
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  )
}

if (!path || !existsSync(path)) {
  printManualBlock()
  process.exit(0)
}

let settings
try {
  settings = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.log(`  ! ${path} is not valid JSON, so it was left alone: ${String(error)}`)
  printManualBlock()
  process.exit(0)
}

copyFileSync(path, `${path}.backup`)

settings.permissions ??= {}
settings.permissions.allow ??= []
settings.permissions.ask ??= []

const addedAllow = ALLOW.filter((rule) => !settings.permissions.allow.includes(rule))
settings.permissions.allow.push(...addedAllow)

const addedAsk = ASK.filter((rule) => !settings.permissions.ask.includes(rule))
settings.permissions.ask.push(...addedAsk)

settings.hooks ??= {}

const addedHooks = []
for (const [event, hook] of EVENT_HOOKS) {
  settings.hooks[event] ??= []
  const command = hook.hooks[0].command
  const present = settings.hooks[event].some((entry) =>
    (entry.hooks ?? []).some((candidate) => candidate.command === command),
  )
  if (!present) {
    settings.hooks[event].push(hook)
    addedHooks.push(command)
  }
}

writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)

console.log(`  backed up to ${path}.backup`)
console.log(`  permissions: ${addedAllow.length} added to allow, ${addedAsk.length} to ask`)
console.log(`  hooks: ${addedHooks.length === 0 ? 'all already there' : `added ${addedHooks.join(', ')}`}`)
