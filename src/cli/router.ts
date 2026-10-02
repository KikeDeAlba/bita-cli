import { UsageError } from '../errors.ts'
import { runProjects } from './commands/catalog.ts'
import { runProject } from './commands/project.ts'
import { runEntries } from './commands/entries.ts'
import { runSummary } from './commands/summary.ts'
import { runMap } from './commands/map.ts'
import { runConfig } from './commands/config.ts'
import { runRepo } from './commands/repo.ts'
import { runScope } from './commands/scope.ts'
import { runAmend } from './commands/amend.ts'
import { runDelete } from './commands/delete.ts'
import { runDocs } from './commands/docs.ts'
import { runApp } from './commands/app.ts'
import { runSetup } from './commands/setup.ts'
import { runNote } from './commands/note.ts'
import { runNotes } from './commands/notes.ts'
import { runHook } from './commands/hook.ts'
import { runHooks } from './commands/hooks.ts'
import { runLink } from './commands/link.ts'
import { runMerge } from './commands/merge.ts'
import { runBacklog } from './commands/backlog.ts'
import { runConfluence } from './commands/confluence.ts'
import { runCancel, runCurrent, runLog, runStart, runStop } from './commands/timer.ts'
import { writeOut } from './output.ts'

export const VERSION = '0.12.1'

const HELP = `bita ${VERSION}

Usage: bita <command> [options]

Tracking:
  start ["<title>"]          Start a timer, blank or titled; several may run at once
  ls                         Show every running timer
  stop [id]                  Stop one timer (--last, --all, or pick when ambiguous)
  cancel [id]                Discard a running timer without recording it
  log "<title>"              Record a block that already happened
  amend <id|--draft>         Fill in the title, project or document of an entry
  delete <ids...>            Remove entries that should never have been recorded
  merge <ids...>             Fold several pending entries into one, keeping every block
  note path <id> --create    Where the entry's document lives, creating it
  note save <id>             Record the document after editing it
  note get|ls <id>           Read the document, or list the ones an entry has
  notes migrate              Turn the legacy NDJSON notes into documents
  link <ids...> --issue K    Mark entries as registered in a Jira issue

Backlog (pending work and findings, kept out of the pages):
  backlog ls                 Open items across projects (--project, --page, --kind, --status)
  backlog add --kind K       Record a pending item or a finding (--title, --md, --page, --entry)
  backlog resolve|reopen <key> Close an item, like STI-14 (--resolution "..."), or open it again
  backlog edit|rm <key>      Change or remove an item
  backlog extract            Move the pending and findings sections out of the pages (--dry-run)

Confluence (REST API, token in the macOS Keychain):
  confluence login           Save your Atlassian e-mail and API token (run it in a terminal)
  confluence status|logout   Check the login, or forget the token
  confluence attach <id> <files...>   Upload or replace attachments on a Confluence page
  confluence publish-diagrams <pageId> --to <id>   Render a page's diagrams and upload PNG + source

Documents:
  docs tree [--months]       Projects with their document and entry counts
  docs tree --pages          The same, plus the page tree of every space
  docs ls [--project X]      Entries and their documents, newest first
  docs show <id|--path P>    One document: markdown, front matter, sections
  docs search "<text>"       Search every document, with snippets
  docs page ls [--tree]      Pages, flat or as the tree
  docs page show <id>        One page: outline, tasks, work log, subpages
  docs page new "<title>"    A page in a space, or under --parent
  docs page write <id>       Write the body, or one --section, from --md
  docs page rename <id> "<t>"
  docs page move <id> [--parent <id|->] [--position N]
  docs page link <id>        Tie entries or Jira issues to the page
  docs page unlink <id>      Untie them
  docs page ref add <id>     Record a link the page relates to (--url, --title, --kind)
  docs page ref ls|rm <id>   List the page's links, or drop one (--url)
  docs page asset path <id> <file>  Where a page's asset lives (--create makes the folder)
  docs diagrams ls <id>      The page's mermaid and draw.io diagrams, and whether they are rendered
  docs diagrams render <id>  Render them to PNG next to the page (--force redraws all)
  docs page rm <id>          Forget the page; the .md stays on disk
  docs migrate [--yes]       Turn every entry document into a page
  docs migrate --undo        Put the corpus back as it was

  setup                      Install the integration for Claude, OpenCode, or Codex
  app install                Download and install the desktop app
  app version                What is installed, and what the latest release is

Reporting:
  entries [preset]           List time entries
  summary [preset]           Group entries into Jira-ready tasks
  projects                   List projects and their Jira mapping
  project add "<name>"       Create a project (also rename, archive, delete)
  project key <project> <KEY>  Change the short key that prefixes its backlog items

Configuration:
  map list|set|unset|story   Map projects to Jira projects, parents and stories
  repo init [path]           Create a project for a repository and map it
  repo show                  Where am I, and which project resolves here
  scope list|set|unset|which Map a path prefix to a project; the longest one wins
  config get|set-jira        Inspect or set the local configuration
  hook session-start         Emit the Claude Code SessionStart context
  hook codex                 Adapt a Codex lifecycle event from stdin
  hooks [list]               Commands run when a timer starts, stops, is cancelled or changes kind
  hooks add --on E -- CMD    Register one (see Hooks options)
  hooks remove N             Remove hook number N

Range presets:
  today, yesterday, week, last-week, month, last-month

Common options:
  --json                     Emit one JSON document on stdout
  --from YYYY-MM-DD          Range start (inclusive)
  --to YYYY-MM-DD            Range end (inclusive)
  --last-days N              Rolling window ending today
  --pending                  Only entries not yet registered in Jira
  --registered               Only entries already registered in Jira
  --include-running          Count entries whose timer is still running
  --timezone TZ              Override the timezone
  --db-path FILE             Use this database instead of the default
  --docs-dir DIR             Where the documents live (default: beside the database)

Summary options:
  --max-task-hours N         Cap per task before splitting (default 8)
  --estimate-step-minutes N  Round the original estimate up to this step (default 30)
  --case-insensitive         Group descriptions ignoring case and accents
  --no-notes                 Skip the documents altogether
  --notes-mode MODE          inline, path or both (default: both)
  --notes-budget-kb N        Stop inlining documents past this much (default: 256)

Timer options:
  --project ID|NAME          Project; otherwise inferred from the repository
  --kind KIND                With start or log, the kind of work (remote-meeting, in-person-meeting, ...)
  --at HH:MM                 Start or stop at this time instead of now
  --all                      stop or cancel every running timer
  --last                     stop or cancel the most recently started one
  --require-running          stop fails when nothing is running

Log options:
  --from HH:MM               When the block started (required)
  --to HH:MM                 When it ended
  --for 1h30m                How long it lasted, instead of --to

Project options:
  --name NAME                With "repo init", the project name (default: the repo folder)
  --client NAME              Client the project belongs to
  --activate                 With "project archive", bring it back instead
  --all                      With "projects", include archived ones
  --force                    With "project delete", accept leaving its entries orphaned
  --yes / --dry-run          With "project delete", as in delete

Merge options:
  --into ID                  The entry that survives (default: the oldest)
  --title "..."              Title of the merged entry (default: the survivor's)
  --project ID|NAME          Project of the merged entry, required when they differ
  --dry-run                  Show what would be merged, without writing

Amend options:
  --draft                    Target the single running draft
  --title "..."              Set the title
  --project ID|NAME          Set the project
  --kind KIND|none           Set or clear the kind; a change fires the amend hooks
  --note-md FILE             Seed a section of the document from a markdown file

Map options:
  --parent KEY-123           With "map set", send every task under this epic
  --no-epic                  With "map set", point at the board and pick the epic on every run
  --issue-type NAME          With "map set", the issue type of the work
  --epic KEY-123             With "map story", the epic the story sits under
  --no-epic                  With "map story", a story without an epic

Link options:
  --issue KEY                The Jira issue the entries were written to
  --ids A,B,C                Entry ids, as an alternative to positionals
  --unlink                   Undo the link, putting the entries back to pending

Delete options:
  --ids A,B,C                Entry ids, as an alternative to positionals
  --dry-run                  Show what would go without deleting anything
  --yes                      Skip the confirmation (required without a terminal)
  --keep-doc                 Leave the documents on disk
  --force                    Delete even entries already registered in Jira

Note options:
  --create                   With "note path", write the skeleton if there is none
  --raw                      With "note get", print the document and nothing else
  --note-md FILE             Seed a section from a markdown file
  --section "..."            Which section --note-md lands in (default: Qué se hizo)
  --file / --command / --resource   Artifacts touched, repeatable

  Notes migrate options:
  --dry-run                  Show what would be written without writing it
  --limit N                  Only the first N entries

Hooks options:
  --on EVENTS                With "hooks add", comma list of start, stop, cancel, amend
  --kind KINDS               With "hooks add", only entries of these kinds
  -- COMMAND ARGS            With "hooks add", the command; it gets the event as JSON on stdin

Setup options:
  --target TARGET            claude, opencode, codex, or all (default claude)
  --claude-dir DIR           Claude configuration directory
  --opencode-dir DIR         OpenCode configuration directory
  --codex-home DIR           Codex home directory
  --agents-home DIR          Codex skills directory parent
  --no-settings              Skip Claude settings changes
  --no-drawio                Skip draw.io setup
  --no-recap                 Skip installing recap (meeting recorder, app, plugin and models)
`

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

  const ownArgs = command === 'hooks' && rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (ownArgs.includes('--help')) {
    writeOut(HELP)
    return 0
  }

  switch (command) {
    case 'projects':
      return runProjects(rest)
    case 'project':
      return runProject(rest)
    case 'entries':
      return runEntries(rest)
    case 'summary':
    case 'groups':
      return runSummary(rest)
    case 'map':
      return runMap(rest)
    case 'config':
      return runConfig(rest)
    case 'repo':
      return runRepo(rest)
    case 'scope':
      return runScope(rest)
    case 'amend':
      return runAmend(rest)
    case 'delete':
    case 'rm':
      return runDelete(rest)
    case 'docs':
      return runDocs(rest)
    case 'app':
      return runApp(rest)
    case 'setup':
      return runSetup(rest)
    case 'note':
      return runNote(rest)
    case 'notes':
      return runNotes(rest)
    case 'hook':
      return runHook(rest)
    case 'hooks':
      return runHooks(rest)
    case 'link':
      return runLink(rest)
    case 'merge':
      return runMerge(rest)
    case 'backlog':
      return runBacklog(rest)
    case 'confluence':
      return runConfluence(rest)
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
      throw new UsageError(`Unknown command "${command}". Run "bita --help" for the list.`)
  }
}
