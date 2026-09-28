import type { DatabaseSync } from 'node:sqlite'
import type { ProjectRow } from '../db/rows.ts'
import { findProjectById, findProjectByKey, findProjectByName } from '../db/projects.ts'
import { NotFoundError } from '../errors.ts'

export function resolveProjectArg(db: DatabaseSync, raw: string): ProjectRow {
  const asNumber = Number(raw)
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const byId = findProjectById(db, asNumber)
    if (byId) return byId
    throw new NotFoundError(
      `No project with id ${asNumber}.`,
      'PROJECT_NOT_FOUND',
      'Run "bita projects" to see them.',
    )
  }

  const byName = findProjectByName(db, raw) ?? findProjectByKey(db, raw)
  if (byName) return byName
  throw new NotFoundError(`No project named or keyed "${raw}".`, 'PROJECT_NOT_FOUND', 'Run "bita projects" to see them.')
}
