/**
 * Custom error types for opencode-antigravity-auth plugin.
 *
 * Ported from LLM-API-Key-Proxy for robust error handling.
 */

/**
 * Error thrown when Antigravity returns an empty response after retry attempts.
 *
 * Empty responses can occur when:
 * - The model has no candidates/choices
 * - The response body is empty or malformed
 * - A temporary service issue prevents generation
 */
export class EmptyResponseError extends Error {
  readonly provider: string
  readonly model: string
  readonly attempts: number

  constructor(
    provider: string,
    model: string,
    attempts: number,
    message?: string,
  ) {
    super(
      message ??
        `The model returned an empty response after ${attempts} attempts. ` +
          `This may indicate a temporary service issue. Please try again.`,
    )
    this.name = 'EmptyResponseError'
    this.provider = provider
    this.model = model
    this.attempts = attempts
  }
}

/**
 * Error thrown when tool ID matching fails and cannot be recovered.
 */
export class ToolIdMismatchError extends Error {
  readonly expectedIds: string[]
  readonly foundIds: string[]

  constructor(expectedIds: string[], foundIds: string[], message?: string) {
    super(
      message ??
        `Tool ID mismatch: expected [${expectedIds.join(', ')}] but found [${foundIds.join(', ')}]`,
    )
    this.name = 'ToolIdMismatchError'
    this.expectedIds = expectedIds
    this.foundIds = foundIds
  }
}

/**
 * Thrown when the operator killswitch excludes every available account.
 *
 * The killswitch compares each candidate's freshest cached quota
 * remaining-percent against an account-specific override (or the
 * global threshold) and excludes accounts below the floor. When all
 * accounts are excluded, the fetch interceptor throws this error
 * with redacted summaries so the host can surface a useful message
 * without exposing any account identifiers or tokens.
 */
export class AntigravityKillswitchError extends Error {
  readonly family: string
  readonly model: string
  readonly thresholdPercent: number
  readonly summaries: Array<{
    accountKey: string
    remainingPercent: number | null
    thresholdPercent: number
  }>

  constructor(input: {
    family: string
    model: string
    thresholdPercent: number
    summaries: AntigravityKillswitchError['summaries']
    message?: string
  }) {
    super(
      input.message ??
        `Antigravity killswitch: all ${input.summaries.length} account(s) under ${input.thresholdPercent}% quota for ${input.family}. ` +
          `Refresh quota or raise the threshold via /antigravity-killswitch.`,
    )
    this.name = 'AntigravityKillswitchError'
    this.family = input.family
    this.model = input.model
    this.thresholdPercent = input.thresholdPercent
    this.summaries = input.summaries
  }
}
