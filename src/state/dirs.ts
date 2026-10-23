import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { kitPlatform } from '../kit/runtime.ts'

export interface DirsOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  exists?: (file: string) => boolean
}

export interface BitaDirs {
  config: string
  data: string
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

export function toolDirsFor(tool: string, options: DirsOptions = {}): BitaDirs {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const kit = kitPlatform()
  if (kit) {
    const dirs = kit.toolDirs(tool, kit.platformContext({ platform: kit.currentPlatform(platform), env, home }))
    return { config: dirs.config, data: dirs.data }
  }
  const p = pathApi(platform)
  if (platform === 'win32') {
    return {
      config: p.join(env['APPDATA'] ?? p.join(home, 'AppData', 'Roaming'), tool),
      data: p.join(env['LOCALAPPDATA'] ?? p.join(home, 'AppData', 'Local'), tool),
    }
  }
  return {
    config: p.join(env['XDG_CONFIG_HOME'] ?? p.join(home, '.config'), tool),
    data: p.join(env['XDG_DATA_HOME'] ?? p.join(home, '.local', 'share'), tool),
  }
}

export function legacyDirs(options: DirsOptions = {}): BitaDirs {
  const env = options.env ?? process.env
  const p = pathApi(options.platform ?? process.platform)
  const home = options.home ?? homedir()
  return {
    config: p.join(home, '.config', 'bita'),
    data: p.join(env['XDG_DATA_HOME'] ?? p.join(home, '.local', 'share'), 'bita'),
  }
}

export function bitaDirs(options: DirsOptions = {}): BitaDirs {
  const exists = options.exists ?? existsSync
  const next = toolDirsFor('bita', options)
  const legacy = legacyDirs(options)
  return {
    config: legacy.config !== next.config && exists(legacy.config) ? legacy.config : next.config,
    data: legacy.data !== next.data && exists(legacy.data) ? legacy.data : next.data,
  }
}
