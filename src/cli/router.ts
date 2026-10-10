import { UnknownCommandError, UsageError } from '../errors.ts'
import { runProjects } from './commands/catalog.ts'
import { runProject } from './commands/project.ts'
import { runEntries } from './commands/entries.ts'
import { runRepo } from './commands/repo.ts'
import { runScope } from './commands/scope.ts'
import { runAmend } from './commands/amend.ts'
import { runDelete } from './commands/delete.ts'
import { runHook } from './commands/hook.ts'
import { runHooks } from './commands/hooks.ts'
import { runMerge } from './commands/merge.ts'
import { runCancel, runCurrent, runLog, runStart, runStop } from './commands/timer.ts'
import { writeOut } from './output.ts'

export const VERSION = '1.0.1'

export const MOVED_COMMANDS: Readonly<Record<string, string>> = {
  jira: 'Jira lives in atl now. Use atl jira … (atl jira --help).',
  confluence: 'Confluence lives in atl now (atl confluence …); page sync lives in inkwell (inkwell confluence …).',
  atlassian: 'Atlassian sites live in atl now. Use atl site … (atl site import --from-bita copies the old ones).',
  docs: 'Documents live in inkwell now. Use inkwell … (inkwell page, inkwell note, inkwell search).',
  backlog: 'The backlog lives in inkwell now. Use inkwell backlog ….',
  diagrams: 'Diagrams live in inkwell now. Use inkwell diagrams ….',
  meeting: 'Meetings live in recap now. Use recap … (the minutes PDF: inkwell export meeting …).',
  note: 'Entry notes live in inkwell now. Use inkwell note … (inkwell note save <entryId> --section "…" --md -).',
  notes: 'Entry notes live in inkwell now. Use inkwell note … (inkwell migrate notes --from-bita copies the old ones).',
  summary: 'Grouping the time for Jira lives in tally now. Use tally summary.',
  groups: 'Grouping the time for Jira lives in tally now. Use tally groups.',
  map: 'Jira mappings live in tally now. Use tally map ….',
  link: 'Marking entries as sent to Jira lives in tally now. Use tally link ….',
  config: 'The Jira configuration lives in tally now. Use tally config ….',
  app: 'bita no longer installs the desktop app. Download Den from https://github.com/KikeDeAlba/bita-desktop/releases/latest',
}

const MOVED_TIMER_FLAGS: Readonly<Record<string, string>> = {
  '--did': 'Write what happened in the entry note with inkwell: inkwell note save <entryId> --section "…" --md -',
  '--page': 'Pages live in inkwell now: inkwell page link <pageId> --entry <entryId>',
  '--page-new': 'Pages live in inkwell now: inkwell page new "<title>", then inkwell page link <pageId> --entry <entryId>',
  '--note-md': 'Entry notes live in inkwell now: inkwell note save <entryId> --section "…" --md <file>',
  '--note-json': 'Entry notes live in inkwell now: inkwell note save <entryId> --section "…" --md <file>',
  '--note-file': 'Entry notes live in inkwell now: inkwell note save <entryId> --section "…" --md <file>',
}

const TIMER_COMMANDS = new Set(['start', 'stop', 'log', 'amend', 'cancel', 'discard'])

const HELP = `bita ${VERSION}

bita keeps the time and nothing else. Documents: inkwell. Jira hours: tally.
Jira and Confluence: atl. Meetings: recap.

Usage: bita <command> [options]

Timers:
  start ["<title>"]          Start a timer, blank or titled; several may run at once
  ls                         Show every running timer (also: current, running)
  stop [id]                  Stop one timer (--last, --all, or pick when ambiguous)
  cancel [id]                Discard a running timer without recording it (also: discard)
  log "<title>"              Record a block that already happened
  amend <id|--draft>         Set the title, project or kind of an entry
  delete <ids...>            Remove entries that should never have been recorded (also: rm)
  merge <ids...>             Fold several entries into one, keeping every block

Entries:
  entries [preset]           List time entries (--from, --to, --last-days)
  entries get <id>           One entry with its blocks

Projects:
  projects                   List projects (--all includes archived ones)
  project add "<name>"       Create a project (--client NAME)
  project show <project>     One project
  project rename <id> "<n>"  Rename it
  project archive <id>       Hide it (--activate brings it back)
  project delete <project>   Delete it (--force, --yes, --dry-run)
  project repo ls|add|rm     Local repositories of a project: ls [--project P], add <path>, rm <path>
  project repo suggest <id>  Repositories behind the files an entry touched, and which are mapped
  repo show                  Where am I, and which project resolves here
  repo init [path]           Create a project for a repository and map it (--name, --client, --scope)
  scope list|set|unset|which Map a path prefix to a project; the longest one wins

Integration:
  setup                      Register bita and install the integration for Claude Code, OpenCode, Codex and Gemini CLI
  capabilities               What this bita offers to the other tools (--json)
  doctor                     Which sibling tools (inkwell, tally, atl, recap) kit found
  hooks [list]               Commands run on start, stop, cancel, amend, delete and merge, plus the installed tools subscribed to them
  hooks add --on E -- CMD    Register one (see Hooks options)
  hooks remove N             Remove hook number N
  hook session-start|prompt-submit|checkpoint|touched|codex|gemini
                             Agent lifecycle hooks (installed by setup)

Range presets:
  today, yesterday, week, last-week, month, last-month

Common options:
  --json                     Emit one JSON document on stdout
  --from YYYY-MM-DD          Range start (inclusive)
  --to YYYY-MM-DD            Range end (inclusive)
  --last-days N              Rolling window ending today
  --timezone TZ              Override the timezone
  --db-path FILE             Use this database instead of the default

Timer options:
  --project ID|NAME          Project; otherwise inferred from the repository
  --kind KIND                With start or log, the kind of work (remote-meeting, in-person-meeting, ...)
  --at HH:MM                 Start or stop at this time instead of now
  --all                      stop or cancel every running timer
  --last                     stop or cancel the most recently started one
  --require-running          stop fails when nothing is running
  --file PATH                With stop or log, record a file the work touched (repeatable)

Log options:
  --from HH:MM               When the block started (required)
  --to HH:MM                 When it ended
  --for 1h30m                How long it lasted, instead of --to

Amend options:
  --draft                    Target the single running draft
  --title "..."              Set the title
  --project ID|NAME          Set the project
  --kind KIND|none           Set or clear the kind
                             Any change fires the amend event

Merge options:
  --into ID                  The entry that survives (default: the oldest)
  --title "..."              Title of the merged entry (default: the survivor's)
  --project ID|NAME          Project of the merged entry, required when they differ
  --dry-run                  Show what would be merged, without writing

Delete options:
  --ids A,B,C                Entry ids, as an alternative to positionals
  --dry-run                  Show what would go without deleting anything
  --yes                      Skip the confirmation (required without a terminal)

Hooks options:
  --on EVENTS                With "hooks add", comma list of start, stop, cancel, amend, delete, merge
  --kind KINDS               With "hooks add", only entries of these kinds
  -- COMMAND ARGS            With "hooks add", the command; it gets the event as JSON on stdin

Setup options:
  --target TARGETS           claude, opencode, codex, gemini, all, or a comma list (default: the agents found)
  --agents TARGETS           Alias of --target
  --claude-dir DIR           Claude configuration directory
  --opencode-dir DIR         OpenCode configuration directory
  --codex-home DIR           Codex home directory
  --agents-home DIR          Codex skills directory parent
  --gemini-home DIR          Directory that holds .gemini
  --no-settings              Skip Claude settings changes
  --no-register              Skip registering bita for the other tools
`

function assertNoMovedFlags(command: string, rest: readonly string[]): void {
  if (!TIMER_COMMANDS.has(command)) return
  for (const token of rest) {
    if (token === '--') break
    const flag = token.split('=')[0] ?? token
    const hint = Object.hasOwn(MOVED_TIMER_FLAGS, flag) ? MOVED_TIMER_FLAGS[flag] : undefined
    if (hint) throw new UsageError(`bita ${command} no longer takes ${flag}. ${hint}`)
  }
}

export async function route(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    writeOut(HELP)
    return 0
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    writeOut(VERSION)
    return 0
  }

  const moved = Object.hasOwn(MOVED_COMMANDS, command) ? MOVED_COMMANDS[command] : undefined
  if (moved !== undefined) throw new UnknownCommandError(`"bita ${command}" is no longer part of bita, which only keeps the time.`, moved)

  const ownArgs = command === 'hooks' && rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (ownArgs.includes('--help')) {
    writeOut(HELP)
    return 0
  }

  assertNoMovedFlags(command, rest)

  switch (command) {
    case 'doctor':
      return (await import('./commands/doctor.ts')).runDoctor(rest)
    case 'projects':
      return runProjects(rest)
    case 'project':
      return runProject(rest)
    case 'entries':
      return runEntries(rest)
    case 'repo':
      return runRepo(rest)
    case 'scope':
      return runScope(rest)
    case 'amend':
      return runAmend(rest)
    case 'delete':
    case 'rm':
      return runDelete(rest)
    case 'setup':
      return (await import('./commands/setup.ts')).runSetup(rest)
    case 'capabilities':
      return (await import('./commands/capabilities.ts')).runCapabilities(rest)
    case 'hook':
      return runHook(rest)
    case 'hooks':
      return runHooks(rest)
    case 'merge':
      return runMerge(rest)
    case 'start':
      return runStart(rest)
    case 'stop':
      return runStop(rest)
    case 'log':
      return runLog(rest)
    case 'ls':
    case 'current':
    case 'running':
      return runCurrent(rest)
    case 'cancel':
    case 'discard':
      return runCancel(rest)
    default:
      throw new UnknownCommandError(`Unknown command "${command}".`, 'Run "bita --help" for the list.')
  }
}
