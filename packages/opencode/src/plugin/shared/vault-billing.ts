import { randomUUID } from 'node:crypto'
import {
  type BillingRequestKind,
  type BillingUsage,
  reportRouting,
} from '../../common-auth-embedded/routing-accessor/index.js'
import type { RequestSendAdmission } from './request-services'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Gemini prompt counts include cache hits; thoughts are separate from candidates. */
export function geminiBillingUsage(value: unknown): BillingUsage | undefined {
  const meta = record(value)
  if (!meta) return undefined
  const usage: BillingUsage = {}
  const prompt = meta.promptTokenCount
  const cached = meta.cachedContentTokenCount
  if (
    count(prompt) &&
    (cached === undefined || (count(cached) && cached <= prompt))
  )
    usage.input = prompt - (count(cached) ? cached : 0)
  if (count(cached)) usage.cacheRead = cached
  if (count(meta.candidatesTokenCount)) usage.output = meta.candidatesTokenCount
  if (count(meta.thoughtsTokenCount)) usage.reasoning = meta.thoughtsTokenCount
  if (Object.keys(usage).length === 0) return undefined
  usage.reasoningIncludedInOutput = false
  return usage
}

/**
 * Billing for one vault-served physical send. The caller checks for the global
 * routing accessor first: standalone hosts have no billing receiver to report to.
 */
export class VaultBillingAttempt {
  private readonly attemptId = randomUUID()
  private reported = false
  private started = false
  private terminal = false
  private failed = false
  private status: number | undefined
  private metadata: Record<string, unknown> | undefined
  private readonly aborted = () => this.end(false)

  constructor(
    private readonly sessionId: string,
    private readonly receipt: Pick<
      RequestSendAdmission,
      'credentialId' | 'accountIdentity'
    >,
    private readonly requestKind: BillingRequestKind,
    private readonly model: string,
    private readonly attempt: number,
    private readonly signal?: AbortSignal | null,
  ) {
    signal?.addEventListener('abort', this.aborted, { once: true })
  }

  private event(value: unknown): void {
    const outer = record(value)
    if (!outer) return
    const response = record(outer.response) ?? outer
    if (outer.error || response.error || outer.type === 'error')
      this.failed = true
    const meta = record(response.usageMetadata)
    if (meta) this.metadata = { ...this.metadata, ...meta }
    if (Array.isArray(response.candidates))
      this.terminal ||= response.candidates.some(
        (candidate) => typeof record(candidate)?.finishReason === 'string',
      )
  }

  /** Tap raw bytes before the wire transformer can inject synthetic zero usage. */
  observe(response: Response): Response {
    this.status = response.status
    if (!response.ok) {
      this.failed = true
      this.end(false)
      return response
    }
    if (!response.body) {
      this.end(true)
      return response
    }
    const sse = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let oversized = false
    const inspect = (line: string) => {
      if (line.length > 1024 * 1024 || this.reported) return
      if (sse && line.startsWith('event:') && line.slice(6).trim() === 'error')
        this.failed = true
      if (sse && !line.startsWith('data:')) return
      try {
        this.event(JSON.parse(sse ? line.slice(5).trim() : line))
      } catch {
        // Missing or unfamiliar usage is not a measured token count.
      }
    }
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              if (!oversized) inspect(pending + decoder.decode())
              this.end(true)
              controller.close()
              reader.releaseLock()
              return
            }
            this.started = true
            if (!oversized) {
              pending += decoder.decode(chunk.value, { stream: true })
              if (sse) {
                let newline = pending.indexOf('\n')
                while (newline >= 0) {
                  inspect(pending.slice(0, newline))
                  pending = pending.slice(newline + 1)
                  newline = pending.indexOf('\n')
                }
              }
              // Accounting must not retain an unbounded non-JSON body or SSE line.
              if (pending.length > 1024 * 1024) {
                oversized = true
                pending = ''
              }
            }
            controller.enqueue(chunk.value)
          } catch (error) {
            this.failed = true
            this.end(false)
            controller.error(error)
            reader.releaseLock()
          }
        },
        cancel: async (reason) => {
          this.end(this.terminal)
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

  end(ended: boolean): void {
    if (this.reported) return
    this.reported = true
    this.signal?.removeEventListener('abort', this.aborted)
    const usage = geminiBillingUsage(this.metadata)
    reportRouting({
      sessionId: this.sessionId,
      kind: 'billing',
      attemptId: this.attemptId,
      requestKind: this.requestKind,
      credentialId: this.receipt.credentialId,
      accountId: this.receipt.accountIdentity,
      provider: 'antigravity',
      model: this.model,
      attempt: this.attempt,
      chargeBasis: 'subscription_included',
      cache: { implicit: true },
      outcome: this.failed
        ? 'failed'
        : ended
          ? 'completed'
          : this.started
            ? 'cut'
            : 'failed',
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(usage ? { usage } : {}),
    })
  }
}
