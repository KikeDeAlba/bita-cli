import { parseCommandArgs, readBoolean } from '../args.ts'
import { withLocalContext } from '../local-context.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { listProjects } from '../../db/projects.ts'
import { projectView } from './project.ts'

export function runProjects(argv: string[]): number {
  const args = parseCommandArgs(argv, { all: { type: 'boolean', default: false } })

  return withLocalContext(args, (ctx) => {
    const projects = listProjects(ctx.db, readBoolean(args, 'all')).map(projectView)

    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('projects', projects))
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'ID', align: 'right' },
          { header: 'PROJECT' },
          { header: 'CLIENT' },
          { header: 'ACTIVE' },
        ],
        projects.map((project) => [
          String(project.id),
          project.name,
          project.clientName ?? '',
          project.active ? 'yes' : 'no',
        ]),
      ),
    )
    return 0
  })
}
