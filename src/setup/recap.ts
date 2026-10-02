import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { readVersion } from '../cli/commands/app.ts'
import { downloadAsset, latestRelease, releaseVersion, type Release } from './github-release.ts'
import type { SetupState } from './drawio.ts'

export const RECAP_REPO = 'KikeDeAlba/recap'
export const RECAP_ASSET_SUFFIX = '-macos-arm64.zip'
export const RECAP_PLUGIN_ID = 'recap@recap'
export const RECAP_MARKETPLACE_ARGS = ['plugin', 'marketplace', 'add', RECAP_REPO]
export const RECAP_PLUGIN_ARGS = ['plugin', 'install', RECAP_PLUGIN_ID, '--scope', 'user']
export const RECAP_LOCAL_ZIP_ENV = 'BITA_RECAP_ZIP'
const SETUP_TIMEOUT_MS = 60 * 60 * 1000
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

export type RecapStepName = 'recap-app' | 'recap-cli' | 'recap-plugin' | 'recap-setup'

export interface RecapStep {
  name: RecapStepName
  state: SetupState
  detail: string
}

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface RecapEnvironment {
  platform: string
  arch: string
  home: string
  pathEntries: string[]
  interactive: boolean
  localZip: string | null
  exists: (path: string) => boolean
  writable: (path: string) => boolean
  linkTarget: (path: string) => string | null
  which: (command: string) => Promise<string | null>
  exec: (command: string, args: readonly string[], timeoutMs?: number) => Promise<CommandResult>
  appVersion: (appPath: string) => Promise<string | null>
  latestRelease: () => Promise<Release>
  download: (release: Release, assetName: string, destination: string) => Promise<void>
  tempDir: () => Promise<string>
  remove: (path: string) => Promise<void>
  makeDir: (path: string) => Promise<void>
  link: (target: string, path: string) => Promise<void>
  progress: (message: string) => void
}

function exec(command: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') })
    })
  })
}

export function defaultRecapEnvironment(progress: (message: string) => void = () => undefined): RecapEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    pathEntries: (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    localZip: process.env[RECAP_LOCAL_ZIP_ENV] || null,
    exists: existsSync,
    writable: (path) => {
      try {
        accessSync(path, constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    linkTarget: (path) => {
      try {
        return readlinkSync(path)
      } catch {
        return null
      }
    },
    which: async (command) => {
      const result = await exec('/usr/bin/which', [command])
      const found = result.stdout.trim()
      return result.ok && found.length > 0 ? found : null
    },
    exec,
    appVersion: readVersion,
    latestRelease: () => latestRelease(RECAP_REPO),
    download: async (release, assetName, destination) => {
      const asset = release.assets.find((candidate) => candidate.name === assetName)
      if (!asset) throw new Error(`${assetName} is not in ${release.tag_name}`)
      await downloadAsset(asset, destination)
    },
    tempDir: () => mkdtemp(join(tmpdir(), 'bita-recap-')),
    remove: (path) => rm(path, { recursive: true, force: true }),
    makeDir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    link: async (target, path) => {
      await unlink(path).catch(() => undefined)
      await symlink(target, path)
    },
    progress,
  }
}

export function recapAppPath(env: RecapEnvironment): string {
  return join(env.home, 'Applications', 'Recap.app')
}

export function recapBinary(env: RecapEnvironment): string {
  return join(recapAppPath(env), 'Contents', 'MacOS', 'recap')
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
}

export async function ensureRecapApp(env: RecapEnvironment): Promise<RecapStep> {
  if (env.platform !== 'darwin' || env.arch !== 'arm64') {
    return { name: 'recap-app', state: 'unavailable', detail: 'recap only runs on Apple Silicon Macs.' }
  }
  const appPath = recapAppPath(env)
  const current = await env.appVersion(appPath)

  let zip: string | null = env.localZip
  let wanted: string | null = null
  let release: Release | null = null
  let assetName: string | null = null
  if (zip === null) {
    try {
      release = await env.latestRelease()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return current === null
        ? { name: 'recap-app', state: 'failed', detail: `Could not reach the recap releases: ${reason}` }
        : { name: 'recap-app', state: 'present', detail: `Recap ${current} is installed; could not check for updates.` }
    }
    wanted = releaseVersion(release)
    assetName = release.assets.find((asset) => asset.name.endsWith(RECAP_ASSET_SUFFIX))?.name ?? null
    if (current === wanted) {
      return { name: 'recap-app', state: 'present', detail: `Recap ${current} is installed in ${appPath}.` }
    }
    if (assetName === null) {
      return { name: 'recap-app', state: 'failed', detail: `The ${release.tag_name} release of recap has no ${RECAP_ASSET_SUFFIX} asset.` }
    }
  }

  const work = await env.tempDir()
  try {
    if (zip === null && release !== null && assetName !== null) {
      env.progress(`Downloading ${assetName}…`)
      zip = join(work, assetName)
      await env.download(release, assetName, zip)
    }
    if (zip === null) return { name: 'recap-app', state: 'failed', detail: 'No recap package to install.' }
    const unpacked = join(work, 'unpacked')
    const extracted = await env.exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
    const source = join(unpacked, 'Recap.app')
    if (!extracted.ok || !env.exists(source)) {
      return { name: 'recap-app', state: 'failed', detail: `Could not unpack ${zip}: ${lastLine(extracted.stderr)}` }
    }
    await env.makeDir(join(env.home, 'Applications'))
    await env.remove(appPath)
    const copied = await env.exec('/usr/bin/ditto', [source, appPath])
    if (!copied.ok) return { name: 'recap-app', state: 'failed', detail: `Could not copy Recap.app: ${lastLine(copied.stderr)}` }
    const installed = (await env.appVersion(appPath)) ?? wanted ?? 'local build'
    const detail =
      current === null
        ? `Installed Recap ${installed} in ${appPath}.`
        : current === installed
          ? `Reinstalled Recap ${installed} in ${appPath}.`
          : `Updated Recap from ${current} to ${installed} in ${appPath}.`
    return { name: 'recap-app', state: 'installed', detail }
  } catch (error) {
    return { name: 'recap-app', state: 'failed', detail: `Installing Recap.app failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await env.remove(work).catch(() => undefined)
  }
}

export function chooseLinkDirectory(env: RecapEnvironment): { directory: string; onPath: boolean } {
  const local = join(env.home, '.local', 'bin')
  const candidates = [local, '/opt/homebrew/bin', '/usr/local/bin']
  for (const candidate of candidates) {
    if (!env.pathEntries.includes(candidate)) continue
    if (env.exists(candidate) ? env.writable(candidate) : candidate === local) return { directory: candidate, onPath: true }
  }
  return { directory: local, onPath: false }
}

export async function ensureRecapCli(env: RecapEnvironment): Promise<RecapStep> {
  const binary = recapBinary(env)
  if (!env.exists(binary)) {
    return { name: 'recap-cli', state: 'unavailable', detail: 'Recap.app is not installed, so there is no recap command to link.' }
  }
  const { directory, onPath } = chooseLinkDirectory(env)
  const path = join(directory, 'recap')
  const hint = onPath ? '' : ` Add ${directory} to your PATH, for example in ~/.zshrc: export PATH="${directory}:$PATH"`
  if (env.linkTarget(path) === binary) {
    return { name: 'recap-cli', state: onPath ? 'present' : 'unavailable', detail: `${path} already points at Recap.app.${hint}` }
  }
  try {
    await env.makeDir(directory)
    await env.link(binary, path)
  } catch (error) {
    return { name: 'recap-cli', state: 'failed', detail: `Could not link ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { name: 'recap-cli', state: onPath ? 'installed' : 'unavailable', detail: `Linked ${path}.${hint}` }
}

export function hasRecapPlugin(listJson: string): boolean {
  try {
    const parsed = JSON.parse(listJson) as { id?: unknown }[]
    return Array.isArray(parsed) && parsed.some((plugin) => plugin.id === RECAP_PLUGIN_ID)
  } catch {
    return false
  }
}

export async function ensureRecapPlugin(env: RecapEnvironment): Promise<RecapStep> {
  const manual = `claude ${RECAP_MARKETPLACE_ARGS.join(' ')} && claude ${RECAP_PLUGIN_ARGS.join(' ')}`
  const claude = await env.which('claude')
  if (claude === null) {
    return { name: 'recap-plugin', state: 'unavailable', detail: `Claude Code is not on PATH. Install the plugin by hand: ${manual}` }
  }
  const listed = await env.exec(claude, ['plugin', 'list', '--json'])
  if (listed.ok && hasRecapPlugin(listed.stdout)) {
    return { name: 'recap-plugin', state: 'present', detail: 'The recap plugin is installed in Claude Code.' }
  }
  const marketplaces = await env.exec(claude, ['plugin', 'marketplace', 'list', '--json'])
  if (!(marketplaces.ok && marketplaces.stdout.includes(`"${RECAP_REPO}"`))) {
    const added = await env.exec(claude, RECAP_MARKETPLACE_ARGS)
    if (!added.ok) {
      return { name: 'recap-plugin', state: 'failed', detail: `claude plugin marketplace add failed: ${lastLine(added.stderr)}` }
    }
  }
  const installed = await env.exec(claude, RECAP_PLUGIN_ARGS)
  if (!installed.ok) {
    return { name: 'recap-plugin', state: 'failed', detail: `claude plugin install failed: ${lastLine(installed.stderr)}` }
  }
  return { name: 'recap-plugin', state: 'installed', detail: 'Installed the recap plugin in Claude Code (user scope).' }
}

interface RecapCheck {
  name: string
  ok: boolean
  detail: string
}

interface RecapSetupEnvelope {
  ok?: boolean
  data?: RecapCheck[]
  error?: { message?: string }
}

function parseEnvelope(text: string): RecapSetupEnvelope | null {
  try {
    return JSON.parse(text) as RecapSetupEnvelope
  } catch {
    return null
  }
}

export function summarizeRecapSetup(result: CommandResult): RecapStep {
  const envelope = parseEnvelope(result.stdout)
  if (envelope === null) {
    return { name: 'recap-setup', state: 'failed', detail: `recap setup failed: ${lastLine(result.stderr || result.stdout)}` }
  }
  if (envelope.ok !== true) {
    return { name: 'recap-setup', state: 'failed', detail: `recap setup failed: ${envelope.error?.message ?? 'no reason given'}` }
  }
  const failing = (envelope.data ?? []).filter((check) => !check.ok)
  if (failing.length === 0) {
    return { name: 'recap-setup', state: 'installed', detail: 'recap setup: dependencies, models, bita hook and permissions are ready.' }
  }
  return {
    name: 'recap-setup',
    state: 'failed',
    detail: `recap setup left ${failing.map((check) => `${check.name} (${check.detail})`).join('; ')}`,
  }
}

export async function ensureRecapSetup(env: RecapEnvironment): Promise<RecapStep> {
  const binary = recapBinary(env)
  if (!env.exists(binary)) {
    return { name: 'recap-setup', state: 'unavailable', detail: 'Recap.app is not installed, so recap setup did not run.' }
  }
  const args = ['setup', '--install-deps', '--json', ...(env.interactive ? [] : ['--skip-permissions'])]
  env.progress('Running recap setup (the first time it downloads about 1.6 GB of transcription models)…')
  return summarizeRecapSetup(await env.exec(binary, args, SETUP_TIMEOUT_MS))
}

export async function ensureRecap(env: RecapEnvironment = defaultRecapEnvironment()): Promise<RecapStep[]> {
  const app = await ensureRecapApp(env)
  if (app.state === 'unavailable' || app.state === 'failed') return [app]
  return [app, await ensureRecapCli(env), await ensureRecapPlugin(env), await ensureRecapSetup(env)]
}
