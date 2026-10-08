export const DEFAULT_PENDING_LOOKBACK_DAYS = 90

export const MAX_TASK_SECONDS = 8 * 60 * 60
export const ESTIMATE_STEP_SECONDS = 30 * 60
export const MIN_SPLIT_SECONDS = 5 * 60

export const NOTE_BODY_MAX = 16384
export const TITLE_SOFT_MAX = 80
export const TITLE_HARD_MAX = 200

export interface StoryTheme {
  id: string
  name: string
}

export const DEFAULT_STORY_THEMES: readonly StoryTheme[] = [
  { id: 'devops', name: 'DevOps' },
  { id: 'backend', name: 'Backend' },
  { id: 'frontend', name: 'Frontend' },
  { id: 'infra', name: 'Infraestructura' },
  { id: 'analisis', name: 'Análisis y estimación' },
  { id: 'seguridad', name: 'Seguridad' },
  { id: 'soporte', name: 'Soporte' },
  { id: 'sesiones', name: 'Sesiones y reuniones' },
  { id: 'docs', name: 'Documentación' },
]

export const SCHEMA_VERSION = 3
export const NOTE_SCHEMA_VERSION = 1

export const DOC_SCHEMA_VERSION = 1

export const LEGACY_ENTRY_DOC_SECTIONS: readonly string[] = [
  'Contexto',
  'Qué se hizo',
  'Decisiones',
  'Hallazgos',
  'Verificación',
  'Pendiente',
  'Tocado',
]

export const LEGACY_ENTRY_DOC_SECTIONS_REQUIRED: readonly string[] = ['Contexto', 'Qué se hizo', 'Pendiente']

export const DID_MAX = 280

export const PAGE_SPLIT_SECTIONS = 6

export const PAGE_SPLIT_BYTES = 12 * 1024

export const DOC_LOCK_TIMEOUT_MS = 2_000
export const DOC_LOCK_STALE_MS = 30_000

export const DOCS_GIT_LOCK_TIMEOUT_MS = 5_000
export const DOCS_GIT_LOCK_STALE_MS = 60_000

export const CHECKPOINT_STALE_MINUTES = 45
export const CHECKPOINT_TOUCH_THRESHOLD = 3

export const SUMMARY_NOTES_BUDGET_BYTES = 262_144
