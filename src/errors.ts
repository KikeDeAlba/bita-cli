export class MissingTokenError extends Error {
  readonly code = 'MISSING_TOKEN'
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'MissingTokenError'
    this.hint = hint
  }
}

export class KeychainError extends Error {
  readonly code = 'KEYCHAIN_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'KeychainError'
  }
}

export class ConflictError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(message: string, code: string, hint?: string) {
    super(message)
    this.name = 'ConflictError'
    this.code = code
    this.hint = hint
  }
}

export class NotFoundError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(message: string, code: string, hint?: string) {
    super(message)
    this.name = 'NotFoundError'
    this.code = code
    this.hint = hint
  }
}

export class UsageError extends Error {
  readonly code = 'USAGE_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export class PartialWriteError extends Error {
  readonly code = 'PARTIAL_TAG_FAILURE'

  constructor(message: string) {
    super(message)
    this.name = 'PartialWriteError'
  }
}

export class MergeConflictError extends ConflictError {
  readonly paths: string[]

  constructor(message: string, paths: string[], hint?: string) {
    super(message, 'MERGE_CONFLICT', hint)
    this.name = 'MergeConflictError'
    this.paths = paths
  }
}
