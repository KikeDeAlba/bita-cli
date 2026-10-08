import { execFile } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRepoIdentity } from '../domain/repo.ts'

export interface RepoRoot {
  path: string
  slug: string
}

export type RootGitRunner = (args: string[], cwd: string) => Promise<string | null>

const GIT_TIMEOUT_MS = 3000

const runGit: RootGitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const value = stdout.trim()
      resolve(value.length > 0 ? value : null)
    })
  })

function nearestDirectory(target: string): string | null {
  let current = path.resolve(target)
  while (true) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? current : path.dirname(current)
      } catch {
        return null
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function canonicalPath(target: string): string {
  const absolute = path.resolve(target)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class RepoRootResolver {
  private readonly byDirectory = new Map<string, string | null>()
  private readonly slugs = new Map<string, string>()
  private readonly run: RootGitRunner
  private readonly home: string

  constructor(run: RootGitRunner = runGit, home: string = os.homedir()) {
    this.run = run
    this.home = home
  }

  async rootOf(target: string): Promise<string | null> {
    const directory = nearestDirectory(target)
    if (directory === null) return null
    if (this.byDirectory.has(directory)) return this.byDirectory.get(directory) ?? null

    const root = await this.lookup(directory)
    this.byDirectory.set(directory, root)
    return root
  }

  async resolve(target: string): Promise<RepoRoot | null> {
    const root = await this.rootOf(target)
    if (root === null) return null
    return { path: root, slug: await this.slugOf(root) }
  }

  async slugOf(root: string): Promise<string> {
    const cached = this.slugs.get(root)
    if (cached !== undefined) return cached

    const remoteUrl = await this.run(['remote', 'get-url', 'origin'], root)
    const identity = resolveRepoIdentity({ cwd: root, toplevel: root, home: this.home, remoteUrl })
    const slug = identity?.slug ?? `local/${path.basename(root)}`
    this.slugs.set(root, slug)
    return slug
  }

  private async lookup(directory: string): Promise<string | null> {
    const output = await this.run(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      directory,
    )
    if (output === null) return null

    const [toplevel, commonDir] = output.split('\n').map((line) => line.trim())
    if (!toplevel) return null
    if (commonDir && path.basename(commonDir) === '.git') {
      const main = path.dirname(commonDir)
      if (main !== toplevel && existsSync(main)) return main
    }
    return toplevel
  }
}
