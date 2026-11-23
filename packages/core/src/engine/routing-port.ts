/** The engine works with admitted routing identities, never the adapter's routing client. */
export interface RoutingCandidate {
  accountId: string
  credentialId: string
}

export type RoutingExhaustion = RoutingCandidate & {
  observedAtMs: number
} & (
    | {
        limitWindow: 'five_hour' | 'seven_day'
        pool?: string
        resetsAtMs?: number
        retryAfterS?: number
      }
    | {
        limitWindow: 'signed_out'
        pool?: never
        resetsAtMs?: never
        retryAfterS?: never
      }
  )

interface RoutingQuestion<C extends RoutingCandidate> {
  sessionId: string
  provider: 'antigravity'
  modelId: string
  candidates: readonly C[]
  deadlineMs: number
  refusals: true
}

interface ContinueRoutingQuestion<C extends RoutingCandidate>
  extends RoutingQuestion<C> {
  mode: 'continue'
  requestId: string
  exhausted: RoutingExhaustion
  holdWaitMaxS: number
}

export interface RoutingRefusal {
  refused: {
    code:
      | 'account_limit_exhausted'
      | 'account_selection_refused'
      | 'account_selection_final'
      | 'concurrency_full'
    routingCode?: string
    reason?: string
    retryAfterSecs?: number
    resetsAtMs?: number
  }
}

type RoutingAnswer<C extends RoutingCandidate> =
  | { candidate: C; hold?: { retry_after_ms: number } }
  | RoutingRefusal
  | undefined

export interface RoutingIdentity extends RoutingCandidate {
  sessionId: string
}

export type BillingRequestKind =
  | 'primary'
  | 'title'
  | 'compaction'
  | 'generate'
  | 'keep_warm'
  | 'prime'

export interface BillingUsage {
  input?: number
  output?: number
  cacheRead?: number
  reasoning?: number
  reasoningIncludedInOutput?: boolean
}

export type RequestWaitReason =
  | 'account_limit'
  | 'account_free'
  | 'rate_limited'
  | 'server_busy'
  | 'quota_reading'
  | 'routing_hold'

export type RequestRoutingReport =
  | (RoutingIdentity &
      (
        | { outcome: 'served'; headers: Readonly<Record<string, string>> }
        | {
            outcome: 'exhausted'
            window: '5h' | '7d'
            pool: string
            resetsAt: number
          }
        | { kind: 'transient_backoff'; retryAtMs: number }
      ))
  | {
      sessionId: string
      kind: 'wait'
      phase: 'start' | 'end'
      waitId: string
      reason: RequestWaitReason
      nextMs?: number
      attempt?: number
      message?: string
      outcome?: 'resumed' | 'cancelled' | 'abandoned'
    }
  | {
      sessionId: string
      kind: 'billing'
      attemptId: string
      requestKind: BillingRequestKind
      credentialId: string
      accountId: string
      provider: 'antigravity'
      model: string
      attempt: number
      chargeBasis: 'subscription_included'
      cache: { implicit: true }
      outcome: 'completed' | 'cut' | 'failed'
      status?: number
      usage?: BillingUsage
    }

/** Availability is checked live because the host can attach or remove its routing accessor. */
export interface RequestRouting {
  hasAccessor(): boolean
  hasVaultHost(): boolean
  ask<C extends RoutingCandidate>(
    input: ContinueRoutingQuestion<C>,
  ): Promise<RoutingAnswer<C>>
  askUntilCapacity<C extends RoutingCandidate>(
    input: RoutingQuestion<C>,
    options: { signal: AbortSignal },
  ): Promise<RoutingAnswer<C>>
  report(input: RequestRoutingReport): void
}
