import type {
  QuotaGroup,
  QuotaGroupSummary,
} from '@cortexkit/antigravity-auth-core'
import {
  type RoutingCandidate,
  reportRouting,
} from '../../common-auth-embedded/routing-accessor/index.js'

// The external routing relay (THALAMUS) must forward the quota-group pool field
// before scoped exhaustion is enabled; losing it would block the whole account.
export const ROUTING_GROUP_SCOPED_EXHAUSTION = false

/** The bridge may arrive or disappear after plugin load; never cache its presence. */
export function hasVaultRoutingAccessor(): boolean {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

export interface RoutingIdentity extends RoutingCandidate {
  sessionId: string
}

export function routingQuotaScope(
  group: QuotaGroup,
  window: string,
):
  | {
      pool: 'gemini' | '3p' | 'gemini-argon'
      limitWindow: 'five_hour' | 'seven_day'
    }
  | undefined {
  const limitWindow =
    window === '5h'
      ? 'five_hour'
      : window === 'weekly'
        ? 'seven_day'
        : undefined
  return limitWindow
    ? { pool: group === 'non-gemini' ? '3p' : group, limitWindow }
    : undefined
}

/** common-auth 0.33.0 carries pool separately from the window length; its routing relay translates 5h/7d. */
export function routingExhaustionFields(
  scope: NonNullable<ReturnType<typeof routingQuotaScope>>,
): {
  pool: string
  window: '5h' | '7d'
} {
  return {
    pool: scope.pool,
    window: scope.limitWindow === 'five_hour' ? '5h' : '7d',
  }
}

/** A refusal alone does not establish exhaustion: large requests can fail while quota remains. */
export function reportVaultExhaustion(
  input: {
    identity: RoutingIdentity
    status: number
    reason: string
    group: QuotaGroup
    quota?: QuotaGroupSummary
    observedAt?: number
    signal?: AbortSignal | null
  },
  groupScopedExhaustion = ROUTING_GROUP_SCOPED_EXHAUSTION,
  report: typeof reportRouting = reportRouting,
): void {
  if (
    !hasVaultRoutingAccessor() ||
    input.signal?.aborted ||
    input.status !== 429 ||
    input.reason !== 'QUOTA_EXHAUSTED' ||
    !Number.isFinite(input.observedAt) ||
    (input.observedAt ?? 0) <= 0 ||
    (input.observedAt ?? Infinity) > Date.now()
  )
    return
  for (const window of input.quota?.windows ?? []) {
    if (window.remainingFraction !== 0) continue
    const scope = routingQuotaScope(input.group, window.window)
    const resetsAt = Date.parse(window.resetTime)
    if (!scope || !Number.isFinite(resetsAt) || resetsAt <= Date.now()) continue
    if (groupScopedExhaustion)
      report({
        ...input.identity,
        outcome: 'exhausted',
        ...routingExhaustionFields(scope),
        resetsAt,
      })
  }
}

const RATE_LIMIT_HEADERS = [
  'retry-after',
  'retry-after-ms',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
] as const

function streamFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(streamFailure)
  const event = value as Record<string, unknown>
  return (
    event.error != null ||
    event.type === 'error' ||
    event.type === 'response.failed' ||
    event.status === 'failed' ||
    streamFailure(event.response)
  )
}

export interface VaultUpstreamObservation {
  response: Response
  completedSuccessfully(): boolean
}

/** transformAntigravityResponse can stop at a finish reason before upstream EOF, hiding a later error. */
export function observeVaultUpstream(
  response: Response,
  signal?: AbortSignal | null,
): VaultUpstreamObservation | undefined {
  if (!hasVaultRoutingAccessor() || !response.ok || signal?.aborted)
    return undefined
  let completed = false
  return {
    response: observeBody(response, () => {
      completed = !signal?.aborted
    }),
    completedSuccessfully: () => completed,
  }
}

/** Observe only the body the caller consumes; cancellation and failed reads never count as served. */
export function observeVaultServed(
  identity: RoutingIdentity,
  response: Response,
  signal?: AbortSignal | null,
  upstream?: VaultUpstreamObservation,
): Response {
  if (!hasVaultRoutingAccessor() || !response.ok || signal?.aborted)
    return response
  const report = () => {
    if (
      signal?.aborted ||
      (upstream && !upstream.completedSuccessfully()) ||
      !hasVaultRoutingAccessor()
    )
      return
    const headers: Record<string, string> = {}
    for (const name of RATE_LIMIT_HEADERS) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    reportRouting({ ...identity, outcome: 'served', headers })
  }
  return observeBody(response, report)
}

function observeBody(response: Response, complete: () => void): Response {
  if (!response.body) {
    complete()
    return response
  }
  const sse = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let failed = false
  const inspect = (line: string) => {
    if (line.length > 1024 * 1024) {
      failed = true
      return
    }
    if (line.startsWith('event:') && line.slice(6).trim() === 'error')
      failed = true
    if (
      !line.startsWith('data:') ||
      !/"(?:error|response.failed|failed)"/.test(line)
    )
      return
    try {
      failed ||= streamFailure(JSON.parse(line.slice(5)))
    } catch {
      failed = true
    }
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            if (sse) inspect(pending + decoder.decode())
            else if (/"(?:error|response.failed|failed)"/.test(pending)) {
              try {
                failed ||= streamFailure(JSON.parse(pending + decoder.decode()))
              } catch {
                failed = true
              }
            }
            if (!failed) complete()
            controller.close()
            reader.releaseLock()
            return
          }
          if (!failed) {
            pending += decoder.decode(chunk.value, { stream: true })
            if (sse) {
              let newline = pending.indexOf('\n')
              while (newline >= 0) {
                inspect(pending.slice(0, newline))
                pending = pending.slice(newline + 1)
                newline = pending.indexOf('\n')
              }
            }
            // A malformed, unbounded event cannot establish successful completion.
            if (pending.length > 1024 * 1024) {
              failed = true
              pending = ''
            }
          }
          controller.enqueue(chunk.value)
        } catch (error) {
          failed = true
          controller.error(error)
          reader.releaseLock()
        }
      },
      async cancel(reason) {
        failed = true
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(observed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  })
  return observed
}
