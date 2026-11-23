export type NativeGoogleErrorOptions =
  | {
      status: 412
      reason: 'operator_policy' | 'soft_quota' | 'pool_unavailable'
      /** Remaining milliseconds until a known reset; omit unknown resets. Do not substitute a retry sleep or cap this value at the configured maximum wait. */
      resetAfterMs?: number | null
    }
  | {
      status: 412
      reason: 'model_unavailable'
      /** No account has the model, so there is no quota reset to wait for. */
      resetAfterMs?: never
      /**
       * The setting that removed every account from this request, when the
       * refusal comes from configuration rather than upstream evidence.
       */
      setting?: 'account_models'
    }
  | {
      status: 412
      reason: 'routing_refused'
      /**
       * Whole seconds until routing expects an account to be free, sent only
       * as the Retry-After header. Omit when routing gave no timing; the body
       * stays one fixed sentence either way.
       */
      retryAfterSeconds?: bigint
      resetAfterMs?: never
    }
  | { status: 401; reason: 'missing_access_token' }
  | { status: 502; reason: 'empty_response' }

const nativeGoogleErrorMessages = (authCommand: string) =>
  ({
    operator_policy:
      'Antigravity account pool is blocked by the operator quota policy. Adjust the quota floor in /antigravity → Limits or refresh quota.',
    soft_quota:
      'Antigravity account pool is blocked by quota protection. Add accounts, wait for quota reset, or turn off soft quota protection with `"soft_quota_threshold_percent": 100` in antigravity-auth.jsonc.',
    pool_unavailable: `Antigravity account pool has no account available within the configured wait limit. Add accounts with \`${authCommand}\` or wait for quota reset.`,
    model_unavailable:
      'The requested Antigravity model is not available to the configured accounts. Choose another model.',
    routing_refused:
      'Routing has no Antigravity account available for this request right now. Wait before sending another request.',
    missing_access_token: `Missing access token. Run \`${authCommand}\` to reauthenticate.`,
    empty_response:
      'Antigravity returned an empty response after the internal retry attempts.',
  }) satisfies Record<NativeGoogleErrorOptions['reason'], string>

/** One clause naming the setting behind a refusal; free of status digits. */
const NATIVE_GOOGLE_ERROR_SETTING_CLAUSES = {
  account_models:
    'The account_models setting limits which accounts may serve it; change it in /antigravity → Accounts.',
} as const

function formatQuotaResetWait(seconds: bigint): string {
  const hours = seconds / 3600n
  const minutes = (seconds % 3600n) / 60n
  const remainingSeconds = seconds % 60n
  const parts: string[] = []
  if (hours > 0n) parts.push(`${hours}h`)
  if (minutes > 0n) parts.push(`${minutes}m`)
  if (remainingSeconds > 0n || parts.length === 0) {
    parts.push(`${remainingSeconds}s`)
  }
  return parts.join(' ')
}

/**
 * Return errors through the host's native Google failure pipeline, never as
 * assistant content. Local policy blocks use 412 rather than a retryable quota
 * status; fixed messages keep account details and upstream payloads out of the
 * body that hosts also scan when deciding whether to retry.
 */
export function createNativeGoogleErrorResponse(
  options: NativeGoogleErrorOptions,
  authCommand: string,
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const setting =
    options.reason === 'model_unavailable' && options.setting
      ? NATIVE_GOOGLE_ERROR_SETTING_CLAUSES[options.setting]
      : undefined
  const baseMessage = nativeGoogleErrorMessages(authCommand)[options.reason]
  const message = setting ? `${baseMessage} ${setting}` : baseMessage
  const status =
    options.status === 412
      ? 'FAILED_PRECONDITION'
      : options.status === 401
        ? 'UNAUTHENTICATED'
        : 'UNAVAILABLE'
  let body = JSON.stringify({
    error: { code: options.status, status, message },
  })
  if (
    options.reason === 'routing_refused' &&
    options.retryAfterSeconds !== undefined &&
    options.retryAfterSeconds >= 0n
  ) {
    headers.set('Retry-After', options.retryAfterSeconds.toString())
  }
  if (
    options.status === 412 &&
    typeof options.resetAfterMs === 'number' &&
    Number.isFinite(options.resetAfterMs) &&
    options.resetAfterMs >= 0
  ) {
    // Round milliseconds before integer division: floating seconds division
    // can underflow small positive waits or round large finite delays wrongly.
    // Decimal BigInt rendering also preserves the delay-seconds header grammar.
    const delaySeconds =
      (BigInt(Math.ceil(options.resetAfterMs)) + 999n) / 1000n
    headers.set('Retry-After', delaySeconds.toString())
    const resetBody = JSON.stringify({
      error: {
        code: options.status,
        status,
        message: `${message} Quota resets in ${formatQuotaResetWait(delaySeconds)}.`,
      },
    })
    // OpenCode 1.x's native error classifier searches serialized error text
    // for retryable HTTP-status substrings, even when the response is 412.
    // A duration such as 500h would cause an accidental retry. Omit only the
    // unsafe clause; Retry-After retains the exact delay for quota consumers.
    if (!/429|500|502|503|504|524/.test(resetBody)) body = resetBody
  }
  return new Response(body, {
    status: options.status,
    headers,
  })
}

/**
 * Extracts a non-null, non-array Antigravity error record from an envelope or
 * outer array wrapper. Primitives and arrays are not coerced to writable objects.
 */
export function extractAntigravityError(
  body: unknown,
): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null
  let target: unknown = body
  if (Array.isArray(body)) {
    if (
      body.length === 0 ||
      !body[0] ||
      typeof body[0] !== 'object' ||
      Array.isArray(body[0])
    ) {
      return null
    }
    target = body[0]
  }
  const candidate = (target as Record<string, unknown>).error
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>
  }
  return null
}

export function extractRateLimitErrorInfoReason(details: unknown) {
  if (!Array.isArray(details)) return undefined
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue
    const type = (detail as Record<string, unknown>)['@type']
    const reason = (detail as Record<string, unknown>).reason
    if (
      typeof type === 'string' &&
      type.includes('google.rpc.ErrorInfo') &&
      typeof reason === 'string'
    )
      return reason
  }
}

const MAX_FINITE_WAIT_MS = BigInt(Math.ceil(Number.MAX_VALUE))
const MAX_FINITE_WAIT_SECONDS = (MAX_FINITE_WAIT_MS + 999n) / 1000n
const MAX_FINITE_FORWARDING_MS = MAX_FINITE_WAIT_SECONDS * 1000n
const RFC_HTTP_DATE_REGEX =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

export function validateRetryAfterSecondsBigInt(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') {
    return raw >= 0n && raw <= MAX_FINITE_WAIT_SECONDS ? raw : null
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      return null
    }
    const b = BigInt(raw)
    return b <= MAX_FINITE_WAIT_SECONDS ? b : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  if (/^\d+$/.test(trimmed)) {
    if (trimmed.length > 309) return null
    const val = BigInt(trimmed)
    return val >= 0n && val <= MAX_FINITE_WAIT_SECONDS ? val : null
  }

  if (RFC_HTTP_DATE_REGEX.test(trimmed)) {
    const parsedDate = Date.parse(trimmed)
    if (!Number.isNaN(parsedDate)) {
      const roundtrip = new Date(parsedDate).toUTCString()
      if (roundtrip === trimmed) {
        const diffSec = Math.ceil((parsedDate - Date.now()) / 1000)
        if (diffSec >= 0 && Number.isSafeInteger(diffSec)) {
          return BigInt(diffSec)
        }
      }
    }
  }

  return null
}

export function validateRetryAfterMsBigInt(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') {
    return raw >= 0n && raw <= MAX_FINITE_FORWARDING_MS ? raw : null
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      return null
    }
    const b = BigInt(raw)
    return b <= MAX_FINITE_FORWARDING_MS ? b : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null
  if (trimmed.length > 309) return null
  const val = BigInt(trimmed)
  return val >= 0n && val <= MAX_FINITE_FORWARDING_MS ? val : null
}

export function deriveRetryHeaderPairFromMs(ms: bigint): {
  'retry-after': string
  'retry-after-ms': string
} {
  if (typeof ms !== 'bigint' || ms < 0n || ms > MAX_FINITE_FORWARDING_MS) {
    throw new RangeError(
      `deriveRetryHeaderPairFromMs: ms must be a non-negative BigInt <= MAX_FINITE_FORWARDING_MS (got ${String(ms)})`,
    )
  }
  const sec = (ms + 999n) / 1000n
  return {
    'retry-after': sec.toString(),
    'retry-after-ms': ms.toString(),
  }
}

export function deriveRetryHeaderPairFromSeconds(sec: bigint): {
  'retry-after': string
  'retry-after-ms': string
} {
  if (typeof sec !== 'bigint' || sec < 0n || sec > MAX_FINITE_WAIT_SECONDS) {
    throw new RangeError(
      `deriveRetryHeaderPairFromSeconds: sec must be a non-negative BigInt <= MAX_FINITE_WAIT_SECONDS (got ${String(sec)})`,
    )
  }
  const ms = sec * 1000n
  return {
    'retry-after': sec.toString(),
    'retry-after-ms': ms.toString(),
  }
}

/**
 * Validate a Retry-After header value as non-negative integer seconds.
 * Accepts non-negative finite integers, integer numeric strings, and valid RFC HTTP date strings.
 * Rejects NaN, Infinity, negative values (< 0), floats, and out-of-range numbers.
 */
export function validateRetryAfterSeconds(raw: unknown): number | null {
  const val = validateRetryAfterSecondsBigInt(raw)
  if (val === null) return null
  const num = Number(val)
  return Number.isFinite(num) ? num : null
}

/**
 * Validate a retry-after-ms header value as non-negative integer milliseconds.
 * Accepts non-negative finite integers and integer numeric strings.
 * Rejects fractions, negative values (< 0), and out-of-range numbers.
 */
export function validateRetryAfterMs(raw: unknown): number | null {
  const val = validateRetryAfterMsBigInt(raw)
  if (val === null) return null
  const num = Number(val)
  return Number.isFinite(num) ? num : null
}

/**
 * Extract validated retry headers from source headers (Headers instance or plain record).
 * Selects ONE authoritative delay (preferring retry-after-ms for millisecond precision)
 * and derives BOTH 'retry-after' and 'retry-after-ms' from that single value, ensuring
 * conflicting header pairs (e.g. Retry-After: 90 vs retry-after-ms: 60000) can never disagree.
 */
export function collectForwardedHeaders(
  sourceHeaders?: Headers | Record<string, string | number | undefined> | null,
): Record<string, string> {
  if (!sourceHeaders) return {}

  const getHeader = (name: string): unknown => {
    if (typeof (sourceHeaders as Headers).get === 'function') {
      return (sourceHeaders as Headers).get(name)
    }
    const record = sourceHeaders as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === name) return value
    }
    return undefined
  }

  const rawRetryAfterMs = getHeader('retry-after-ms')
  const validMs = validateRetryAfterMsBigInt(rawRetryAfterMs)
  if (validMs !== null) {
    return deriveRetryHeaderPairFromMs(validMs)
  }

  const rawRetryAfter = getHeader('retry-after')
  const validSec = validateRetryAfterSecondsBigInt(rawRetryAfter)
  if (validSec !== null) {
    return deriveRetryHeaderPairFromSeconds(validSec)
  }

  return {}
}

/**
 * Check whether an error response or message represents a quota / rate-limit
 * condition. A message is a quota message only when:
 * - the response status is 429; or
 * - a structured detail names a quota reason (`QuotaFailure`, or an `ErrorInfo`
 *   reason of QUOTA_EXHAUSTED / RATE_LIMIT_EXCEEDED / RESOURCE_EXHAUSTED); or
 * - the message carries a reset clause and a quota word, such as
 *   "Quota exceeded. Resets in 30s.".
 *
 * A 400 whose text merely contains the word "quota", and a bare reset clause
 * such as "Session resets in 5m", are not quota errors: they must never be
 * rewritten with "quota resets in" or have a delay read from their text.
 */
export function isQuotaError(
  status: number | undefined,
  message: string | undefined,
  details?: unknown,
): boolean {
  if (status === 429) return true
  const lower = (message ?? '').toLowerCase()
  if (hasQuotaResetClause(lower)) return true
  return hasStructuredQuotaReason(details)
}

const QUOTA_REASON_CODES = new Set([
  'QUOTA_EXHAUSTED',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
])

/** True when the lowercased message names a quota word and announces a reset. */
function hasQuotaResetClause(lowerMessage: string): boolean {
  if (lowerMessage.length === 0) return false
  if (extractResetDurationFromText(lowerMessage) === null) return false
  return (
    lowerMessage.includes('quota') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('rate_limit') ||
    lowerMessage.includes('resource_exhausted')
  )
}

/** True when a structured detail carries a quota reason code or QuotaFailure. */
function hasStructuredQuotaReason(details: unknown): boolean {
  if (!Array.isArray(details)) return false
  return details.some((detail) => {
    if (!detail || typeof detail !== 'object') return false
    const record = detail as Record<string, unknown>
    const type = record['@type']
    if (typeof type === 'string' && type.includes('google.rpc.QuotaFailure'))
      return true
    const reason = record.reason
    if (typeof reason === 'string' && QUOTA_REASON_CODES.has(reason))
      return true
    // QuotaFailure / ErrorInfo details may be nested inside a wrapped detail.
    const nested = record.details
    return Array.isArray(nested) ? hasStructuredQuotaReason(nested) : false
  })
}

export const RESET_CLAUSE_REGEX =
  /\b(?:quota\s+)?resets?\s+(?:in|after)\s+(?=\d+(?:\.\d+)?[ \t]*(?:ms|[dhms]))((?:(?:\d+(?:\.\d+)?[ \t]*d)[ \t]*)?(?:(?:\d+(?:\.\d+)?[ \t]*h)[ \t]*)?(?:(?:\d+(?:\.\d+)?[ \t]*m(?!s))[ \t]*)?(?:(?:\d+(?:\.\d+)?[ \t]*s)[ \t]*)?(?:(?:\d+(?:\.\d+)?[ \t]*ms))?)(?![a-zA-Z0-9_-])/gi

/**
 * Extract the raw duration string from a reset clause if present, without
 * consuming punctuation, prose, or following credential tokens.
 */
export function extractResetDurationFromText(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const regex = new RegExp(RESET_CLAUSE_REGEX.source, 'i')
  const match = text.match(regex)
  if (!match?.[1]) return null
  const raw = match[1].trim().replace(/[.,;:]+$/, '')
  return raw.length > 0 ? raw : null
}

/**
 * Normalise only captured reset clauses so unrelated credential-like text is
 * unchanged before redaction:
 * - "Resets in 45s before retry." -> "quota resets in 45s before retry."
 * - "Resets in 2h55m14s. 1d2h3m4s5e-synthetic-opaque-credential" -> "quota resets in 2h 55m 14s. 1d2h3m4s5e-synthetic-opaque-credential"
 * - Does not touch tokens or numbers outside the reset clause.
 */
export function normalizeResetDuration(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  return text.replace(RESET_CLAUSE_REGEX, (_match, rawDuration) => {
    if (!rawDuration) return _match
    const duration = String(rawDuration).match(/^(.*?)([ \t]*)$/)
    if (!duration) return _match
    const spaced = (duration[1] ?? '').replace(
      /(\d+(?:\.\d+)?)[ \t]*(ms|[dhms])(?=\d)/gi,
      '$1$2 ',
    )
    return `quota resets in ${spaced}${duration[2] ?? ''}`
  })
}

/**
 * Format a positive millisecond wait as a parser-friendly duration string ("2h 55m 14s").
 * Seconds are rounded up.
 */
export function formatResetDuration(waitMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(waitMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const segments: string[] = []
  if (hours > 0) segments.push(`${hours}h`)
  if (minutes > 0) segments.push(`${minutes}m`)
  segments.push(`${seconds}s`)
  return segments.join(' ')
}

export interface DurationParserOptions {
  /**
   * Accept a duration that totals zero (`0s`, `0m0s`) as `0n` instead of
   * rejecting it. Only the GA bridge sets it, because its pre-header failures
   * can carry a truthful local wait, including `Retry-After: 0`. The executor
   * and the response transformer leave it off so an upstream zero falls through
   * to the configured default retry or the response's own header, as it did
   * before the resolver was shared.
   */
  allowZero?: boolean
  /**
   * Accept a bare number with no unit (`90`) as seconds. Only the executor sets
   * it: Google's RetryInfo sometimes omits the unit, and the executor has always
   * read such a value as 90 seconds.
   */
  allowBareSeconds?: boolean
}

export const DURATION_REGEX =
  /^(?:(\d+(?:\.\d+)?|\.\d+)[ \t]*d)?(?:[ \t]*(\d+(?:\.\d+)?|\.\d+)[ \t]*h)?(?:[ \t]*(\d+(?:\.\d+)?|\.\d+)[ \t]*m(?!s))?(?:[ \t]*(\d+(?:\.\d+)?|\.\d+)[ \t]*s)?(?:[ \t]*(\d+(?:\.\d+)?|\.\d+)[ \t]*ms)?$/i

function parseDecimalComponent(
  str: string,
  multMs: bigint,
): { intPart: bigint; fracStr: string; mult: bigint } | null {
  const parts = str.split('.')
  const intStr = parts[0] ?? ''
  const fracStr = parts[1] ?? ''

  // Lexical bounds: reject if integer part (ignoring leading zeros) > 15 digits
  const effectiveIntStr = intStr.replace(/^0+/, '')
  if (effectiveIntStr.length > 15) return null
  if (str.length > 60) return null

  const intPart = intStr.length > 0 ? BigInt(intStr) : 0n
  return { intPart, fracStr, mult: multMs }
}

/**
 * Strictly ordered whole-string duration grammar:
 * Days -> Hours -> Minutes -> Seconds -> Milliseconds
 * Components can be compact (2h55m14s) or separated by horizontal whitespace (2h 55m 14s).
 * Rejects partial tokens ('1hgarbage', 'x5s'), out-of-order components ('1m2h'),
 * non-positive totals (unless allowZero), non-finite / overflow (400 digits), and unsafe numbers.
 * Zero components in positive Go durations such as "1h0m0s" remain valid.
 */
export function parseDurationToMs(
  duration: string,
  options?: DurationParserOptions,
): number | null {
  const big = parseDurationToMsBigInt(duration, options)
  if (big === null) return null
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(big)
}

export function parseDurationToMsBigInt(
  duration: string,
  options?: DurationParserOptions,
): bigint | null {
  if (typeof duration !== 'string') return null
  const trimmed = duration.trim()
  if (trimmed.length === 0) return null

  let dStr: string | undefined
  let hStr: string | undefined
  let mStr: string | undefined
  let sStr: string | undefined
  let msStr: string | undefined

  const match = trimmed.match(DURATION_REGEX)
  if (match) {
    ;[, dStr, hStr, mStr, sStr, msStr] = match
  }

  // If no unit match and allowBareSeconds is enabled, check for bare decimal number
  if (
    dStr === undefined &&
    hStr === undefined &&
    mStr === undefined &&
    sStr === undefined &&
    msStr === undefined
  ) {
    if (
      options?.allowBareSeconds &&
      /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)
    ) {
      sStr = trimmed
    } else {
      return null
    }
  }

  const rawComponents: Array<{ str: string; mult: bigint }> = []
  if (dStr !== undefined) rawComponents.push({ str: dStr, mult: 86400000n })
  if (hStr !== undefined) rawComponents.push({ str: hStr, mult: 3600000n })
  if (mStr !== undefined) rawComponents.push({ str: mStr, mult: 60000n })
  if (sStr !== undefined) rawComponents.push({ str: sStr, mult: 1000n })
  if (msStr !== undefined) rawComponents.push({ str: msStr, mult: 1n })

  if (rawComponents.length === 0) return null

  let maxFracDigits = 0
  const parsedComponents: Array<{
    intPart: bigint
    fracStr: string
    mult: bigint
  }> = []

  for (const rc of rawComponents) {
    const parsed = parseDecimalComponent(rc.str, rc.mult)
    if (!parsed) return null
    if (parsed.fracStr.length > maxFracDigits) {
      maxFracDigits = parsed.fracStr.length
    }
    parsedComponents.push(parsed)
  }

  const commonDenominator = 10n ** BigInt(maxFracDigits)
  let totalScaledNumerator = 0n

  for (const c of parsedComponents) {
    const fracLen = BigInt(c.fracStr.length)
    const fracVal = c.fracStr.length > 0 ? BigInt(c.fracStr) : 0n
    const scaleFactor = 10n ** (BigInt(maxFracDigits) - fracLen)
    const numerator =
      (c.intPart * commonDenominator + fracVal * scaleFactor) * c.mult
    totalScaledNumerator += numerator
  }

  if (totalScaledNumerator === 0n) {
    return options?.allowZero ? 0n : null
  }

  const quotient = totalScaledNumerator / commonDenominator
  const remainder = totalScaledNumerator % commonDenominator
  let rounded = remainder * 2n >= commonDenominator ? quotient + 1n : quotient
  if (rounded === 0n) {
    // Any positive supported duration below 1 ms rounds to min 1n
    rounded = 1n
  }

  if (rounded > MAX_FINITE_FORWARDING_MS) {
    return null
  }

  return rounded
}

export interface RetryMetadataResult {
  delayMs: bigint
  quotaResetTime?: string
}

export interface ResolveRetryMetadataOptions {
  details?: unknown
  message?: string
  status?: number
  headers?: Headers | Record<string, string | number | undefined> | null
  /**
   * Set only by `gaPreHeaderFailureResponse`, which reads these three fields
   * off an error that failed before upstream headers arrived. Do not fill them
   * from ordinary JSON body fields: the executor's precedence leaves such
   * fields out on purpose.
   */
  retryAfterMs?: unknown
  /** See `retryAfterMs`: thrown pre-header error metadata, not a body field. */
  resetAfterMs?: unknown
  /** See `retryAfterMs`: thrown pre-header error metadata, not a body field. */
  retryAfterSeconds?: unknown
  /**
   * Zero-total durations resolve to `0n` instead of being skipped. The bridge
   * and the response transformer set it so a truthful local `Retry-After: 0`
   * is forwarded; the executor never does (see `DurationParserOptions`). A
   * numeric RetryInfo delay of zero obeys the same flag: with it off the
   * executor skips the zero and uses the response's header instead.
   */
  allowZero?: boolean
  /**
   * Bare numbers in body fields are read as seconds. The executor sets it for
   * unitless RetryInfo delays; the bridge and transformer do not.
   */
  allowBareSeconds?: boolean
}

/**
 * Resolves authoritative retry metadata following unified executor precedence:
 * 1. First VALID RetryInfo scanning all entries (invalid first doesn't hide later)
 * 2. First valid metadata.quotaResetDelay (timestamp retained)
 * 3. Fields only the GA (Gemini API) error envelope carries:
 *    retryAfterMs -> resetAfterMs -> retryAfterSeconds
 * 4. Quota classified original message reset clause
 * 5. HTTP headers: ms before seconds
 */
export function resolveRetryMetadata(
  options: ResolveRetryMetadataOptions,
): RetryMetadataResult | null {
  const {
    details,
    message,
    status,
    headers,
    retryAfterMs,
    resetAfterMs,
    retryAfterSeconds,
    allowZero,
    allowBareSeconds,
  } = options
  const bodyParserOptions: DurationParserOptions = {
    allowZero,
    allowBareSeconds,
  }

  // 1. First VALID RetryInfo scanning all entries
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const type = (entry as Record<string, unknown>)['@type']
      if (typeof type === 'string' && type.includes('google.rpc.RetryInfo')) {
        const retryDelay = (entry as Record<string, unknown>).retryDelay
        if (typeof retryDelay === 'string') {
          const ms = parseDurationToMsBigInt(retryDelay, bodyParserOptions)
          if (ms !== null) {
            return { delayMs: ms }
          }
        } else if (typeof retryDelay === 'number') {
          if (Number.isFinite(retryDelay) && retryDelay >= 0) {
            const scaled = retryDelay * 1000
            if (Number.isFinite(scaled)) {
              const rounded = Math.round(scaled)
              if (Number.isSafeInteger(rounded) && rounded >= 0) {
                // Only a true zero is a zero delay. A positive value below
                // 1ms keeps the documented minimum of 1ms, as text does.
                if (retryDelay === 0) {
                  if (allowZero) return { delayMs: 0n }
                } else {
                  return { delayMs: BigInt(Math.max(1, rounded)) }
                }
              }
            }
          }
          // Unsafe or overflow numeric is invalid; continue scanning for later valid RetryInfo/metadata/message/headers
        }
      }
    }

    // 2. First valid metadata.quotaResetDelay (timestamp retained)
    for (const entry of details) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const metadata = (entry as Record<string, unknown>).metadata
      if (
        metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata)
      ) {
        const quotaResetDelay = (metadata as Record<string, unknown>)
          .quotaResetDelay
        if (typeof quotaResetDelay === 'string') {
          const ms = parseDurationToMsBigInt(quotaResetDelay, bodyParserOptions)
          if (ms !== null) {
            const quotaResetTime =
              typeof (metadata as Record<string, unknown>)
                .quotaResetTimeStamp === 'string'
                ? ((metadata as Record<string, unknown>)
                    .quotaResetTimeStamp as string)
                : typeof (metadata as Record<string, unknown>)
                      .quotaResetTime === 'string'
                  ? ((metadata as Record<string, unknown>)
                      .quotaResetTime as string)
                  : undefined
            return {
              delayMs: ms,
              ...(quotaResetTime !== undefined ? { quotaResetTime } : {}),
            }
          }
        }
      }
    }
  }

  // 3. Fields only the GA (Gemini API) error envelope carries:
  //    retryAfterMs -> resetAfterMs -> retryAfterSeconds
  const validGaMs = validateRetryAfterMsBigInt(retryAfterMs)
  if (validGaMs !== null) {
    return { delayMs: validGaMs }
  }
  const validResetMs = validateRetryAfterMsBigInt(resetAfterMs)
  if (validResetMs !== null) {
    return { delayMs: validResetMs }
  }
  const validGaSec = validateRetryAfterSecondsBigInt(retryAfterSeconds)
  if (validGaSec !== null) {
    return { delayMs: validGaSec * 1000n }
  }

  // 4. Quota classified original message reset clause
  if (isQuotaError(status, message, details) && typeof message === 'string') {
    const rawDuration = extractResetDurationFromText(message)
    if (rawDuration !== null) {
      const ms = parseDurationToMsBigInt(rawDuration, bodyParserOptions)
      if (ms !== null) {
        return { delayMs: ms }
      }
    }
  }

  // 5. HTTP headers: ms before seconds
  if (headers) {
    const getHeader = (name: string): unknown => {
      if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name)
      }
      const record = headers as Record<string, unknown>
      for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === name) return value
      }
      return undefined
    }

    const rawMs = getHeader('retry-after-ms')
    const validHeaderMs = validateRetryAfterMsBigInt(rawMs)
    if (validHeaderMs !== null) {
      return { delayMs: validHeaderMs }
    }

    const rawSec = getHeader('retry-after')
    const validHeaderSec = validateRetryAfterSecondsBigInt(rawSec)
    if (validHeaderSec !== null) {
      return { delayMs: validHeaderSec * 1000n }
    }
  }

  return null
}
