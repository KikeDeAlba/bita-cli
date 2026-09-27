export const LOCAL_PROJECT_ID_CEILING = 100_000_000

export interface Migration {
  readonly version: number
  readonly statements: readonly string[]
}

const INITIAL_SCHEMA: readonly string[] = [
  `CREATE TABLE projects (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     client_name TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     external_id INTEGER UNIQUE,
     created_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX projects_name_unique ON projects (name COLLATE NOCASE)`,

  `CREATE TABLE entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL,
     description TEXT NOT NULL,
     started_at TEXT NOT NULL,
     stopped_at TEXT,
     billable INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL,
     external_id INTEGER UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK (stopped_at IS NULL OR stopped_at >= started_at)
   )`,
  `CREATE INDEX entries_started_at ON entries (started_at)`,
  `CREATE INDEX entries_project ON entries (project_id)`,
  `CREATE INDEX entries_running ON entries (started_at) WHERE stopped_at IS NULL`,

  `CREATE TABLE notes (
     entry_id INTEGER PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
     body TEXT NOT NULL,
     files TEXT NOT NULL DEFAULT '[]',
     commands TEXT NOT NULL DEFAULT '[]',
     resources TEXT NOT NULL DEFAULT '[]',
     repo_slug TEXT,
     branch TEXT,
     head_sha TEXT,
     recorded_at TEXT NOT NULL
   )`,

  `CREATE TABLE jira_links (
     entry_id INTEGER PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
     issue_key TEXT,
     worklog_id TEXT,
     linked_at TEXT NOT NULL
   )`,
  `CREATE INDEX jira_links_issue ON jira_links (issue_key)`,

  `CREATE TABLE jira_project_map (
     project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
     jira_key TEXT NOT NULL,
     epic_key TEXT,
     epic_resolved INTEGER NOT NULL DEFAULT 0,
     hierarchy TEXT NOT NULL,
     story_type TEXT,
     work_type TEXT,
     done_transition_id TEXT,
     done_transition_name TEXT,
     timetracking_available INTEGER,
     verified_at TEXT
   )`,

  `CREATE TABLE story_cache (
     project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
     theme_id TEXT NOT NULL,
     issue_key TEXT NOT NULL,
     summary TEXT NOT NULL,
     verified_at TEXT NOT NULL,
     PRIMARY KEY (project_id, theme_id)
   )`,

  `CREATE TABLE repo_map (
     slug TEXT PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
     slug_source TEXT NOT NULL,
     verified_at TEXT
   )`,

  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]

const ENTRY_TOUCHES: readonly string[] = [
  `CREATE TABLE entry_touches (
     entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     PRIMARY KEY (entry_id, path)
   )`,
  `CREATE INDEX entry_touches_entry ON entry_touches (entry_id)`,
]

const ENTRY_DOCS: readonly string[] = [
  `CREATE TABLE entry_docs (
     entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
     rel_path TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'note',
     title TEXT NOT NULL DEFAULT '',
     title_slug TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL,
     section_count INTEGER NOT NULL DEFAULT 0,
     byte_size INTEGER NOT NULL DEFAULT 0,
     checksum TEXT NOT NULL DEFAULT '',
     repo_slug TEXT,
     branch TEXT,
     head_sha TEXT,
     created_at TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     PRIMARY KEY (entry_id, rel_path),
     CHECK (kind IN ('note', 'appendix')),
     CHECK (rel_path <> '' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '%..%')
   )`,
  `CREATE UNIQUE INDEX entry_docs_path ON entry_docs (rel_path)`,
  `CREATE INDEX entry_docs_entry ON entry_docs (entry_id, kind)`,
  `CREATE INDEX entry_docs_recorded ON entry_docs (recorded_at)`,
  `DROP TABLE notes`,
]

const DOC_PAGES: readonly string[] = [
  `CREATE TABLE doc_pages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id INTEGER REFERENCES projects (id) ON DELETE RESTRICT,
     parent_id INTEGER REFERENCES doc_pages (id) ON DELETE RESTRICT,
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     rel_path TEXT NOT NULL,
     depth INTEGER NOT NULL DEFAULT 0,
     position INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active',
     source TEXT NOT NULL,
     section_count INTEGER NOT NULL DEFAULT 0,
     heading_count INTEGER NOT NULL DEFAULT 0,
     byte_size INTEGER NOT NULL DEFAULT 0,
     checksum TEXT NOT NULL DEFAULT '',
     repo_slug TEXT,
     branch TEXT,
     head_sha TEXT,
     created_at TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     CHECK (status IN ('active', 'archived')),
     CHECK (title <> ''),
     CHECK (slug <> '' AND slug NOT LIKE '%/%' AND slug NOT LIKE '%.%'),
     CHECK (rel_path <> '' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '%..%'),
     CHECK (depth >= 0 AND depth <= 4),
     CHECK (parent_id IS NULL OR parent_id <> id)
   )`,
  `CREATE UNIQUE INDEX doc_pages_sibling
     ON doc_pages (IFNULL(project_id, 0), IFNULL(parent_id, 0), slug)`,
  `CREATE UNIQUE INDEX doc_pages_path ON doc_pages (rel_path)`,
  `CREATE INDEX doc_pages_parent ON doc_pages (parent_id, position)`,
  `CREATE INDEX doc_pages_project ON doc_pages (project_id, position)`,

  `CREATE TABLE page_entries (
     page_id INTEGER NOT NULL REFERENCES doc_pages (id) ON DELETE CASCADE,
     entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
     summary TEXT NOT NULL DEFAULT '',
     linked_at TEXT NOT NULL,
     PRIMARY KEY (page_id, entry_id)
   )`,
  `CREATE UNIQUE INDEX page_entries_one_page ON page_entries (entry_id)`,

  `CREATE TABLE page_issues (
     page_id INTEGER NOT NULL REFERENCES doc_pages (id) ON DELETE CASCADE,
     issue_key TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'task',
     summary TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT '',
     status_category TEXT NOT NULL DEFAULT '',
     url TEXT,
     created_at TEXT NOT NULL,
     refreshed_at TEXT,
     PRIMARY KEY (page_id, issue_key),
     CHECK (role IN ('epic', 'story', 'task', 'subtask')),
     CHECK (status_category IN ('', 'new', 'indeterminate', 'done')),
     CHECK (issue_key GLOB '[A-Z]*-[0-9]*')
   )`,
  `CREATE INDEX page_issues_issue ON page_issues (issue_key)`,
]

const MERGED_ENTRIES: readonly string[] = [
  `ALTER TABLE entries ADD COLUMN merged_into INTEGER REFERENCES entries (id) ON DELETE CASCADE`,
  `CREATE INDEX entries_merged_into ON entries (merged_into) WHERE merged_into IS NOT NULL`,
  `DROP INDEX page_entries_one_page`,
  `CREATE INDEX page_entries_entry ON page_entries (entry_id)`,
]

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: INITIAL_SCHEMA },
  { version: 2, statements: ENTRY_TOUCHES },
  { version: 3, statements: ENTRY_DOCS },
  { version: 4, statements: DOC_PAGES },
  { version: 5, statements: MERGED_ENTRIES },
]

export const LATEST_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)
