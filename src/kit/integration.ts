import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentIntegration, HookMap } from '@kikedealba/kit/agents'
import type { ToolManifest } from '@kikedealba/kit/registry'
import { VERSION } from '../cli/router.ts'
import { UsageError } from '../errors.ts'
import {
  CAPABILITIES,
  DESCRIPTION,
  EMITS,
  ENVELOPE_VERSION,
  HOMEPAGE,
  INSTALL_HINT,
  TOOL_NAME,
  binCommand,
} from './manifest.ts'

export const CLAUDE_ALLOW = [
  'Bash(bita projects:*)',
  'Bash(bita project:*)',
  'Bash(bita entries:*)',
  'Bash(bita ls:*)',
  'Bash(bita current:*)',
  'Bash(bita start:*)',
  'Bash(bita stop:*)',
  'Bash(bita log:*)',
  'Bash(bita repo:*)',
  'Bash(bita hook:*)',
  'Bash(bita amend:*)',
  'Bash(bita merge:*)',
  'Bash(bita scope list:*)',
  'Bash(bita scope set:*)',
  'Bash(bita scope unset:*)',
  'Bash(bita scope which:*)',
  'Bash(bita capabilities:*)',
  'Bash(bita doctor:*)',
  'Bash(bita --version)',
]

export const RETIRED_CLAUDE_ALLOW = [
  'Bash(bita summary:*)',
  'Bash(bita link:*)',
  'Bash(bita note:*)',
  'Bash(bita notes:*)',
  'Bash(bita map list:*)',
  'Bash(bita map set:*)',
  'Bash(bita map unset:*)',
  'Bash(bita map story:*)',
  'Bash(bita config get:*)',
  'Bash(bita config set-jira:*)',
  'Bash(bita docs:*)',
  'Bash(bita backlog:*)',
  'Bash(bita confluence status:*)',
  'Bash(bita confluence attach:*)',
  'Bash(bita confluence publish-diagrams:*)',
]

export const RETIRED_COMMANDS = ['bita-check']

export const RETIRED_CLAUDE_HOOKS: HookMap = {
  PostToolUse: [{ matcher: 'mcp__.*Atlassian.*|mcp__.*Google_Drive.*', hooks: [{ type: 'command', command: 'bita hook ref', timeout: 10 }] }],
}

export const CLAUDE_ASK = ['Bash(bita cancel:*)']

export const LEGACY_CLAUDE_HOOKS: HookMap = {
  SessionStart: [
    { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'bita hook session-start', timeout: 5 }] },
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'bita hook prompt-submit', timeout: 5 }] },
    { hooks: [{ type: 'command', command: 'bita hook checkpoint', timeout: 5 }] },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command:
            'jq -r \'.tool_input.file_path // empty\' | { read -r f; [ -n "$f" ] && bita hook touched --file "$f"; } 2>/dev/null || true',
          timeout: 10,
        },
      ],
    },
    ...(RETIRED_CLAUDE_HOOKS['PostToolUse'] ?? []),
  ],
}

export const LEGACY_COMMANDS = ['bita-amend', 'bita-check', 'bita-init', 'bita-log', 'bita-start', 'bita-stop', 'bita-timers']

export const CLAUDE_MARKETPLACE = { marketplace: 'KikeDeAlba/bita-cli', marketplaceName: 'bita' } as const
export const CLAUDE_PLUGIN = 'bita'
export const CLAUDE_MOD_PLUGIN = 'bita-timer'

export const CODEX_EDIT_MATCHER = 'apply_patch|Edit|Write'

export function codexHooks(editMatcher: string = CODEX_EDIT_MATCHER): HookMap {
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bita hook codex', timeout: 5 }] }],
    PostToolUse: [{ matcher: editMatcher, hooks: [{ type: 'command', command: 'bita hook codex', timeout: 10 }] }],
  }
}

export const GEMINI_EDIT_MATCHER = 'write_file|replace'

export function geminiHooks(editMatcher: string = GEMINI_EDIT_MATCHER): HookMap {
  return {
    SessionStart: [{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', name: 'bita-session', command: 'bita hook gemini', timeout: 5000 }] }],
    BeforeAgent: [{ hooks: [{ type: 'command', name: 'bita-prompt', command: 'bita hook gemini', timeout: 5000 }] }],
    AfterTool: [{ matcher: editMatcher, hooks: [{ type: 'command', name: 'bita-tool', command: 'bita hook gemini', timeout: 10000 }] }],
  }
}

export function manifest(root: string, bin: readonly string[] = binCommand(root)): ToolManifest {
  return {
    manifestVersion: 1,
    name: TOOL_NAME,
    version: VERSION,
    description: DESCRIPTION,
    bin: [...bin],
    envelope: ENVELOPE_VERSION,
    capabilities: [...CAPABILITIES],
    emits: [...EMITS],
    subscribes: [],
    homepage: HOMEPAGE,
    install: INSTALL_HINT,
  }
}

export function opencodePluginSource(root: string): string {
  const source = join(root, 'src', 'integrations', 'opencode.ts')
  if (existsSync(source)) return source
  const built = join(root, 'dist', 'integrations', 'opencode.js')
  if (existsSync(built)) return built
  throw new UsageError(`This copy of bita has no OpenCode plugin (looked in ${root}).`)
}

export const USER_SKILLS = ['bita-amend', 'bita-init', 'bita-log', 'bita-start', 'bita-stop', 'bita-timers']

export interface IntegrationOptions {
  codexEditMatcher?: string
  geminiEditMatcher?: string
}

export function integration(root: string, options: IntegrationOptions = {}): AgentIntegration {
  const skillsDir = join(root, 'skills')
  return {
    tool: TOOL_NAME,
    version: VERSION,
    description: DESCRIPTION,
    skills: [{ name: TOOL_NAME, dir: join(skillsDir, TOOL_NAME) }],
    userSkills: USER_SKILLS.map((name) => ({ name, dir: join(skillsDir, name) })),
    opencode: { plugins: [{ name: TOOL_NAME, file: opencodePluginSource(root) }] },
    codex: { hooks: codexHooks(options.codexEditMatcher) },
    gemini: { hooks: geminiHooks(options.geminiEditMatcher) },
  }
}

export function claudePermissions(): AgentIntegration {
  return { tool: TOOL_NAME, version: VERSION, claude: { permissions: { allow: CLAUDE_ALLOW, ask: CLAUDE_ASK } } }
}

export function legacyClaudeIntegration(root: string): AgentIntegration {
  return {
    tool: TOOL_NAME,
    version: VERSION,
    skills: [{ name: TOOL_NAME, dir: join(root, 'skill') }],
    commands: LEGACY_COMMANDS.map((name) => ({ name, file: join(root, 'commands', `${name}.md`) })),
    claude: { permissions: { allow: RETIRED_CLAUDE_ALLOW }, hooks: LEGACY_CLAUDE_HOOKS },
  }
}

export function retiredIntegration(root: string): AgentIntegration {
  return {
    tool: `${TOOL_NAME}-retired`,
    version: VERSION,
    commands: RETIRED_COMMANDS.map((name) => ({ name, file: join(root, 'commands', `${name}.md`) })),
  }
}
