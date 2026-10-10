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

export class UnknownCommandError extends Error {
  readonly code = 'UNKNOWN_COMMAND'
  readonly hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'UnknownCommandError'
    this.hint = hint
  }
}
