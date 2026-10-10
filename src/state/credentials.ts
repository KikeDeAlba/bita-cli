import type { CredentialStore } from '@kikedealba/kit/credentials'
import { KeychainError } from '../errors.ts'

export const KEYCHAIN_SERVICE = 'bita-atlassian'

export type { CredentialStore }

export async function systemCredentialStore(): Promise<CredentialStore> {
  let kit: typeof import('@kikedealba/kit/credentials')
  try {
    kit = await import('@kikedealba/kit/credentials')
  } catch (error) {
    throw new KeychainError(
      `The credential store needs @kikedealba/kit, which this copy of bita cannot load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }
  return kit.credentialStore()
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function storeToken(account: string, token: string, store: CredentialStore): Promise<void> {
  try {
    await store.set(KEYCHAIN_SERVICE, account, token)
  } catch (error) {
    throw new KeychainError(`Could not save the Atlassian token: ${failure(error)}`)
  }
}

export async function readToken(account: string, store: CredentialStore): Promise<string | null> {
  try {
    const token = (await store.get(KEYCHAIN_SERVICE, account))?.trim() ?? ''
    return token.length > 0 ? token : null
  } catch (error) {
    throw new KeychainError(`Could not read the Atlassian token: ${failure(error)}`)
  }
}

export async function deleteToken(account: string, store: CredentialStore): Promise<boolean> {
  try {
    return await store.delete(KEYCHAIN_SERVICE, account)
  } catch (error) {
    throw new KeychainError(`Could not remove the Atlassian token: ${failure(error)}`)
  }
}
