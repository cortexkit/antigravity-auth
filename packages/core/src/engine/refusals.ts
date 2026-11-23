import { HostRefusalError } from '../host-failure.ts'
import { RETIRED_AGY_MODEL_MESSAGE } from '../model-registry.ts'
import { PRE_RESPONSE_TIMEOUT_MESSAGE } from '../pre-response-deadline.ts'

const jsonHeaders = { 'content-type': 'application/json' } as const
const gaHeaders = { ...jsonHeaders, 'x-should-retry': 'false' } as const

function refusal<Id extends string>(
  id: Id,
  text: string,
  status: number,
  options: {
    openCode1Status?: number
    rpcStatus?: string
    late?: boolean
    aborted?: boolean
  } = {},
) {
  return {
    id,
    text,
    openCode1: {
      status: options.openCode1Status ?? status,
      headers: jsonHeaders,
      late: options.late ?? false,
    },
    openCode2: {
      status,
      headers: gaHeaders,
      late: options.late ?? false,
    },
    pi: { event: 'error', stopReason: options.aborted ? 'aborted' : 'error' },
    rpcStatus:
      options.rpcStatus ??
      (status === 400 ? 'INVALID_ARGUMENT' : 'FAILED_PRECONDITION'),
  } as const
}

export const ENGINE_REFUSALS = {
  quota_wait_exhausted: refusal(
    'quota_wait_exhausted',
    'Antigravity refused the request without a stated reason. If this keeps happening, change the agent system prompt or wait before sending another request.',
    412,
  ),
  quota_exhausted: refusal(
    'quota_exhausted',
    'Antigravity quota has been used up.',
    429,
    { rpcStatus: 'RESOURCE_EXHAUSTED' },
  ),
  rate_limit_exceeded: refusal(
    'rate_limit_exceeded',
    'Antigravity asked to slow down. Wait before sending another request.',
    412,
  ),
  capacity_exhausted: refusal(
    'capacity_exhausted',
    'Antigravity could not obtain capacity for this request.',
    412,
  ),
  model_not_found: refusal(
    'model_not_found',
    'The requested Antigravity model was not found for the configured accounts. Choose another model.',
    412,
  ),
  account_reauthorize: refusal(
    'account_reauthorize',
    'Antigravity did not authorize the account. Reauthorize Antigravity before sending another request.',
    401,
    { rpcStatus: 'UNAUTHENTICATED' },
  ),
  signature_recovery_failed: refusal(
    'signature_recovery_failed',
    "Antigravity could not repair the conversation's thinking blocks. Start a new session.",
    400,
  ),
  stopped_by_google: refusal(
    'stopped_by_google',
    'Response stopped by Google',
    400,
    { late: true },
  ),
  incomplete: refusal(
    'incomplete',
    'Antigravity returned an incomplete response.',
    400,
    { late: true },
  ),
  empty: refusal('empty', 'Antigravity returned an empty response.', 400, {
    late: true,
  }),
  embedded_error: refusal(
    'embedded_error',
    'Antigravity returned an embedded error.',
    400,
    { late: true },
  ),
  deadline: refusal('deadline', PRE_RESPONSE_TIMEOUT_MESSAGE, 412),
  transport_error: refusal(
    'transport_error',
    'Antigravity could not communicate with Google. Check the plugin log for details.',
    412,
  ),
  cancelled: refusal('cancelled', 'Antigravity request cancelled.', 412, {
    aborted: true,
  }),
  upstream_http: refusal(
    'upstream_http',
    'Google refused the Antigravity request. Check the plugin log for details.',
    400,
  ),
  retired_model: refusal('retired_model', RETIRED_AGY_MODEL_MESSAGE, 412),
  model_not_allowed: refusal(
    'model_not_allowed',
    'The account_models setting limits which accounts may serve this Antigravity model. Choose another model or change the setting in /antigravity → Accounts.',
    412,
  ),
  busy_store: refusal(
    'busy_store',
    'The Antigravity account store is busy. Try again in a moment.',
    412,
    { openCode1Status: 503 },
  ),
  authority_changed: refusal(
    'authority_changed',
    'Antigravity credential authority changed. No further local account operations were performed.',
    412,
  ),
  context_overflow: refusal(
    'context_overflow',
    'Prompt is too long: context length exceeded.',
    413,
    { rpcStatus: 'INVALID_ARGUMENT' },
  ),
} as const

export type EngineRefusalId = keyof typeof ENGINE_REFUSALS
type HttpHost = 'openCode1' | 'openCode2'

const googleStopCodes = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'OTHER',
  'MALFORMED_FUNCTION_CALL',
])

export function googleStopCode(reason: unknown): string {
  return typeof reason === 'string' && googleStopCodes.has(reason)
    ? reason
    : 'unknown'
}

function quotaMilliseconds(delayMs: number | bigint | undefined) {
  if (typeof delayMs === 'bigint') return delayMs >= 0n ? delayMs : undefined
  if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs >= 0)
    return BigInt(Math.ceil(delayMs))
}

function quotaResetClause(delayMs: number | bigint | undefined): string {
  const milliseconds = quotaMilliseconds(delayMs)
  if (milliseconds === undefined) return ''
  const seconds = (milliseconds + 999n) / 1000n
  const hours = seconds / 3600n
  const minutes = (seconds % 3600n) / 60n
  const remainder = seconds % 60n
  const parts = []
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (remainder || parts.length === 0) parts.push(`${remainder}s`)
  const clause = ` Quota resets in ${parts.join(' ')}.`
  // OpenCode inspects digit runs even inside a duration. Retry headers keep
  // the exact delay regardless of whether its readable form is safe.
  return /429|5\d\d/.test(clause) ? '' : clause
}

type RefusalDetails = { finishReason?: unknown; resetAfterMs?: number | bigint }

export class EngineRefusalError extends HostRefusalError {
  readonly rawStopReason?: string
  constructor(
    readonly id: EngineRefusalId,
    details: RefusalDetails = {},
  ) {
    const { text } = ENGINE_REFUSALS[id]
    super(
      id === 'stopped_by_google'
        ? `${text}: ${googleStopCode(details.finishReason)}.`
        : id === 'quota_exhausted'
          ? text + quotaResetClause(details.resetAfterMs)
          : text,
    )
    if (id === 'stopped_by_google')
      this.rawStopReason = googleStopCode(details.finishReason)
  }
}

const responseRefusals = new WeakMap<Response, EngineRefusalError>()

export function rememberResponseRefusal(
  response: Response,
  error: EngineRefusalError,
) {
  responseRefusals.set(response, error)
  return response
}

export function responseRefusal(
  response: Response,
): EngineRefusalError | undefined {
  return responseRefusals.get(response)
}

export function engineRefusalResponse(
  id: EngineRefusalId,
  details: RefusalDetails = {},
  host: HttpHost = 'openCode1',
): Response {
  const entry = ENGINE_REFUSALS[id]
  const error = new EngineRefusalError(id, details)
  const { status, headers: standardHeaders } = entry[host]
  const headers = new Headers(standardHeaders)
  const milliseconds =
    id === 'quota_exhausted' || id === 'rate_limit_exceeded'
      ? quotaMilliseconds(details.resetAfterMs)
      : undefined
  if (milliseconds !== undefined) {
    headers.set('retry-after', ((milliseconds + 999n) / 1000n).toString())
    headers.set('retry-after-ms', milliseconds.toString())
  }
  return rememberResponseRefusal(
    new Response(
      JSON.stringify({
        error: {
          code: status,
          status: entry.rpcStatus,
          message: error.message,
        },
      }),
      { status, headers },
    ),
    error,
  )
}
