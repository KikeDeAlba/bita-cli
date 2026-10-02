import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ConflictError, NotFoundError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { promptText } from '../prompt.ts'
import { downloadAsset, latestRelease, releaseVersion, type Release } from '../../setup/github-release.ts'

const run = promisify(execFile)

const SUBCOMMANDS = new Set(['install', 'version'])
const REPO = 'KikeDeAlba/bita-desktop'
const TARGET = '/Applications/bita.app'

const OPTIONS = {
  yes: { type: 'boolean' as const, default: false },
  to: { type: 'string' as const },
}

export async function runApp(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'version'
  if (!SUBCOMMANDS.has(first)) {
    throw new UsageError(`Usage: bita app <${[...SUBCOMMANDS].join('|')}>`)
  }

  const args = parseCommandArgs(argv.slice(1), OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  if (first === 'version') return await reportVersion(json)
  return await install(json, readBoolean(args, 'yes'), readString(args, 'to') ?? TARGET)
}

function latest(): Promise<Release> {
  return latestRelease(REPO)
}

export async function readVersion(path: string): Promise<string | null> {
  const plist = join(path, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const { stdout } = await run('defaults', ['read', plist, 'CFBundleShortVersionString'])
    return stdout.trim()
  } catch {
    return null
  }
}

async function reportVersion(json: boolean): Promise<number> {
  const current = await readVersion(TARGET)
  const release = await latest().catch(() => null)
  const data = {
    installed: current,
    latest: release ? releaseVersion(release) : null,
    path: current === null ? null : TARGET,
  }

  if (json) {
    writeJson(successEnvelope('app version', data))
    return 0
  }

  writeOut(current === null ? 'The app is not installed.' : `Installed: ${current}`)
  if (data.latest !== null) writeOut(`Latest   : ${data.latest}`)
  if (current !== null && data.latest !== null && current !== data.latest) {
    writeOut('Run "bita app install" to update it.')
  }
  return 0
}

async function install(json: boolean, assumeYes: boolean, target: string): Promise<number> {
  if (process.platform !== 'darwin') {
    throw new ConflictError('The app only runs on macOS.', 'UNSUPPORTED_PLATFORM')
  }

  const release = await latest()
  const asset = release.assets.find((candidate) => candidate.name.endsWith('.dmg'))
  if (!asset) {
    throw new NotFoundError(
      `The ${release.tag_name} release has no .dmg.`,
      'ASSET_NOT_FOUND',
      'Download it by hand from https://github.com/KikeDeAlba/bita-desktop/releases',
    )
  }

  const current = await readVersion(target)
  const wanted = releaseVersion(release)

  if (current !== null && !assumeYes) {
    const answer = await promptText(
      `${target} is already there, version ${current}. Replace it with ${wanted}? [y/N] `,
    )
    if (!/^(y|s|si|sí|yes)$/i.test(answer.trim())) {
      writeOut('Left alone.')
      return 0
    }
  }

  const work = await mkdtemp(join(tmpdir(), 'bita-app-'))
  const dmg = join(work, asset.name)
  let mounted: string | null = null

  try {
    writeOut(`Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MB)…`)
    await downloadAsset(asset, dmg)

    const { stdout } = await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-quiet', '-mountrandom', work])
    mounted = mountPointOf(stdout) ?? mountPointOf(await plainMount(dmg, work))
    if (mounted === null) {
      throw new ConflictError('Could not mount the .dmg.', 'MOUNT_FAILED')
    }

    const source = join(mounted, 'bita.app')
    if (!existsSync(source)) {
      throw new NotFoundError(`The .dmg does not carry bita.app.`, 'APP_NOT_IN_DMG')
    }

    await rm(target, { recursive: true, force: true })
    await run('cp', ['-R', source, target])
    writeOut(`Installed ${wanted} in ${target}.`)
  } finally {
    if (mounted !== null) await run('hdiutil', ['detach', mounted, '-quiet']).catch(() => undefined)
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  if (json) {
    writeJson(successEnvelope('app install', { version: wanted, path: target }))
  }
  return 0
}

async function plainMount(dmg: string, work: string): Promise<string> {
  const { stdout } = await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountrandom', work])
  return stdout
}

function mountPointOf(output: string): string | null {
  for (const line of output.split('\n')) {
    const at = line.indexOf('/Volumes/')
    if (at !== -1) return line.slice(at).trim()
    const random = line.match(/\s(\/\S*bita-app-\S*)\s*$/)
    if (random?.[1]) return random[1].trim()
  }
  return null
}
