import { parseCommandArgs, readBoolean } from '../args.ts'
import { createLocalContext } from '../local-context.ts'
import { renderTable } from '../table.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { listProjects } from '../../db/projects.ts'
import { readConfig } from '../../state/config.ts'

export async function runProjects(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, { all: { type: 'boolean', default: false } })
  const ctx = createLocalContext(args)

  try {
    const config = await readConfig()
    const projects = listProjects(ctx.db, readBoolean(args, 'all')).map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      active: project.active,
      clientName: project.clientName,
      jiraProjectKey: config.projectMapping[String(project.id)]?.jiraProjectKey ?? null,
    }))

    if (readBoolean(args, 'json')) {
      writeJson(successEnvelope('projects', projects))
      return 0
    }

    writeOut(
      renderTable(
        [
          { header: 'ID', align: 'right' },
          { header: 'KEY' },
          { header: 'PROJECT' },
          { header: 'CLIENT' },
          { header: 'ACTIVE' },
          { header: 'JIRA' },
        ],
        projects.map((project) => [
          String(project.id),
          project.key ?? '',
          project.name,
          project.clientName ?? '',
          project.active ? 'yes' : 'no',
          project.jiraProjectKey ?? '',
        ]),
      ),
    )
    return 0
  } finally {
    ctx.db.close()
  }
}
