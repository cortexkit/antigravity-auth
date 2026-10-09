/** A prepared local request no longer matches the row's current bearer. */
export class LocalGrantSupersededError extends Error {
  constructor() {
    super('The selected local grant has been superseded')
    this.name = 'LocalGrantSupersededError'
  }
}

/** The original selected credential is unavailable for local serving. */
export class StaleLocalGrantError extends Error {
  constructor() {
    super('The selected local grant is unavailable')
    this.name = 'StaleLocalGrantError'
  }
}

/**
 * Capture before asynchronous preparation. A store check verifies that the
 * selected account and stored row still authorize the prepared bearer.
 * Separate resolution may read only the original row ID, credential epoch
 * and authenticated identity; it cannot follow a replacement account ref
 * or change the token of the already-captured request.
 */
export type CapturedLocalGrant =
  | {
      readonly source: 'store'
      check(): void | Promise<void>
      /** Adopt this exact row ref's current credential without an OAuth refresh. */
      resolveCurrent(): Promise<void>
    }
  | {
      readonly source: 'pool-file'
      check(): void | Promise<void>
    }

export function isLocalGrantError(
  error: unknown,
): error is LocalGrantSupersededError | StaleLocalGrantError {
  return (
    error instanceof LocalGrantSupersededError ||
    error instanceof StaleLocalGrantError
  )
}
