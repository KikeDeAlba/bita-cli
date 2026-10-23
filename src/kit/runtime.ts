import { createRequire } from 'node:module'
import { homedir } from 'node:os'

export type KitPlatform = typeof import('@kikedealba/kit/platform')
export type KitAgents = typeof import('@kikedealba/kit/agents')
export type KitPlatformContext = import('@kikedealba/kit/platform').PlatformContext

const require = createRequire(import.meta.url)

let platformModule: KitPlatform | null | undefined
let agentsModule: KitAgents | null | undefined

function load<T>(specifier: string): T | null {
  try {
    return require(specifier) as T
  } catch {
    return null
  }
}

export function kitPlatform(): KitPlatform | null {
  if (platformModule === undefined) platformModule = load<KitPlatform>('@kikedealba/kit/platform')
  return platformModule
}

export function kitAgents(): KitAgents | null {
  if (agentsModule === undefined) agentsModule = load<KitAgents>('@kikedealba/kit/agents')
  return agentsModule
}

export function setKitModulesForTests(modules: { platform?: KitPlatform | null; agents?: KitAgents | null }): void {
  if ('platform' in modules) platformModule = modules.platform
  if ('agents' in modules) agentsModule = modules.agents
}

export function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = platform === 'win32' ? env['USERPROFILE'] || env['HOME'] : env['HOME']
  return fromEnv || homedir()
}

export function kitContext(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): KitPlatformContext | null {
  const kit = kitPlatform()
  if (!kit) return null
  return kit.platformContext({ platform: kit.currentPlatform(platform), env, home: homeOf(env, platform) })
}
