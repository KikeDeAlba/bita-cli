import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { KeychainError } from '../errors.ts'

export const KEYCHAIN_SERVICE = 'bita-atlassian'
const SECURITY = '/usr/bin/security'

export type SecurityRunner = (args: readonly string[]) => Promise<string>

export const securityRunner: SecurityRunner = async (args) => {
  const { stdout } = await promisify(execFile)(SECURITY, [...args], { timeout: 15_000 })
  return stdout
}

function failure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim().split('\n')[0] ?? ''
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 44 || /could not be found/i.test(failure(error))
}

export async function storeToken(account: string, token: string, run: SecurityRunner = securityRunner): Promise<void> {
  try {
    await run(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', token])
  } catch (error) {
    throw new KeychainError(`Could not save the Atlassian token in the Keychain: ${failure(error)}`)
  }
}

export async function readToken(account: string, run: SecurityRunner = securityRunner): Promise<string | null> {
  try {
    const token = (await run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])).trim()
    return token.length > 0 ? token : null
  } catch (error) {
    if (isNotFound(error)) return null
    throw new KeychainError(`Could not read the Atlassian token from the Keychain: ${failure(error)}`)
  }
}

export async function deleteToken(account: string, run: SecurityRunner = securityRunner): Promise<boolean> {
  try {
    await run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw new KeychainError(`Could not remove the Atlassian token from the Keychain: ${failure(error)}`)
  }
}
