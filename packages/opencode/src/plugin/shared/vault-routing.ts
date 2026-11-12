import type {
  QuotaGroup,
  QuotaGroupSummary,
} from '@cortexkit/antigravity-auth-core'
import {
  type RoutingCandidate,
  reportRouting,
} from '../../common-auth-embedded/routing-accessor/index.js'
import { isTerminalSseLine } from '../core/streaming/terminal-event'

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

/**
 * A refusal alone does not establish exhaustion: large requests can fail while
 * quota remains. Each report names its quota pool, so routing blocks only that
 * pool's window on the account, never the account's other models.
 */
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

/**
 * The streaming transformer ends the reply it forwards right after the first
 * terminal event (a finish reason) and then cancels the upstream body, which
 * the server may also keep open. Upstream EOF therefore cannot mark an SSE
 * reply complete: it counts as completed once its terminal event arrives with
 * no failure before it, and a stream that ends without one never completes.
 * Bytes after the terminal event are never forwarded to the caller, so they
 * are not inspected. A non-SSE body completes at a clean EOF.
 */
export function observeVaultUpstream(
  response: Response,
  signal?: AbortSignal | null,
): VaultUpstreamObservation | undefined {
  if (!hasVaultRoutingAccessor() || !response.ok || signal?.aborted)
    return undefined
  let completed = false
  return {
    response: observeBody(
      response,
      () => {
        completed = !signal?.aborted
      },
      isTerminalSseLine,
    ),
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

/**
 * Passes the body through unchanged while watching it for failure events.
 * `complete` runs at a clean EOF, or, for an SSE body when `terminal` is
 * given, as soon as a terminal line arrives with no failure before it.
 */
function observeBody(
  response: Response,
  complete: () => void,
  terminal?: (line: string) => boolean,
): Response {
  if (!response.body) {
    complete()
    return response
  }
  const sse = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
  const awaitsTerminal = sse && terminal !== undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let failed = false
  let terminated = false
  const inspect = (line: string) => {
    if (terminated) return
    if (line.length > 1024 * 1024) {
      failed = true
      return
    }
    if (line.startsWith('event:') && line.slice(6).trim() === 'error')
      failed = true
    if (
      line.startsWith('data:') &&
      /"(?:error|response.failed|failed)"/.test(line)
    ) {
      try {
        failed ||= streamFailure(JSON.parse(line.slice(5)))
      } catch {
        failed = true
      }
    }
    if (awaitsTerminal && !failed && terminal?.(line)) {
      terminated = true
      complete()
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
            if (!failed && !awaitsTerminal) complete()
            controller.close()
            reader.releaseLock()
            return
          }
          if (!failed && !terminated) {
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
