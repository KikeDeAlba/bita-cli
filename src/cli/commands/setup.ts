import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { ensureDrawio, type SetupStep } from '../../setup/drawio.ts'

const run = promisify(execFile)

const OPTIONS = {
  'claude-dir': { type: 'string' as const },
  'no-settings': { type: 'boolean' as const, default: false },
  'no-drawio': { type: 'boolean' as const, default: false },
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  const root = packageRoot()
  const claudeDir =
    readString(args, 'claude-dir') ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')

  const skillSource = join(root, 'skill')
  const commandsSource = join(root, 'commands')

  if (!existsSync(skillSource) || !existsSync(commandsSource)) {
    throw new UsageError(
      `This copy of bita has no skill to install (looked in ${root}). Install it from npm or from a clone of the repository.`,
    )
  }

  const linked: string[] = []

  await mkdir(join(claudeDir, 'skills'), { recursive: true })
  if (await link(skillSource, join(claudeDir, 'skills', 'bita'))) {
    linked.push(join(claudeDir, 'skills', 'bita'))
  }

  await mkdir(join(claudeDir, 'commands'), { recursive: true })
  for (const name of await readdir(commandsSource)) {
    if (!name.endsWith('.md')) continue
    if (await link(join(commandsSource, name), join(claudeDir, 'commands', name))) {
      linked.push(join(claudeDir, 'commands', name))
    }
  }

  let settings: string | null = null
  if (!readBoolean(args, 'no-settings')) {
    const target = join(claudeDir, 'settings.json')
    const merger = join(root, 'scripts', 'merge-settings.mjs')
    if (existsSync(merger)) {
      await run(process.execPath, [merger, target])
      settings = target
    }
  }

  const drawio: SetupStep[] = readBoolean(args, 'no-drawio') ? [] : await ensureDrawio()

  if (json) {
    writeJson(successEnvelope('setup', { root, claudeDir, linked, settings, drawio }))
    return 0
  }

  writeOut(`Skill and commands linked into ${claudeDir}.`)
  writeOut(`They point at ${root}, so updating bita updates them.`)
  if (settings !== null) writeOut(`Permissions and the SessionStart hook merged into ${settings}.`)
  for (const step of drawio) writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.detail}`)
  writeOut('')
  writeOut('Next:')
  writeOut('  bita project add "<name>"     create a project')
  writeOut('  bita scope set . <projectId>  map this repository to it')
  writeOut('  bita app install              install the desktop app')
  return 0
}

async function link(target: string, linkName: string): Promise<boolean> {
  try {
    const existing = await readlink(linkName)
    if (existing === target) return true
    await rm(linkName)
  } catch {
    if (existsSync(linkName)) await rename(linkName, `${linkName}.backup`)
  }

  await symlink(target, linkName)
  return true
}
