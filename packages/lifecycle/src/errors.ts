export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LifecycleError'
  }
}

export class AcknowledgementLostError extends Error {
  readonly code = 'ACKNOWLEDGEMENT_LOST' as const

  constructor(readonly idempotencyKey: string) {
    super('The provider accepted the assignment but its acknowledgement was lost.')
    this.name = 'AcknowledgementLostError'
  }
}

export function isAcknowledgementLostError(error: unknown): error is Error & { code: 'ACKNOWLEDGEMENT_LOST' } {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ACKNOWLEDGEMENT_LOST'
}

export class ConnectorRejectedError extends Error {
  constructor(readonly code: string, message = 'The provider rejected the assignment before accepting it.') {
    super(message)
    this.name = 'ConnectorRejectedError'
  }
}
