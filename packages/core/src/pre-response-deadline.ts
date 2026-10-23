// Measured through the native Antigravity CLI (agy 1.4.5 for the long Gemini
// runs): Claude Opus 5.5 high sends response headers in 1.4-3.1 s, and Gemini
// 3.8 Flash high sends them in about 3.7 s even when it then thinks for 23-30k
// tokens over 50-66 s. Both stream their thinking after the headers. Ten
// minutes leaves wide headroom; it is a backstop for an endpoint that never
// answers, not a thinking limit.
export const PRE_RESPONSE_DEADLINE_MS = 600_000

// Fixed text avoids status-code and quota phrases scanned by host retry policies.
export const PRE_RESPONSE_TIMEOUT_MESSAGE =
  'Antigravity did not begin a response within the pre-response time limit. Check your connection and try again later.'

export class PreResponseTimeoutError extends Error {
  readonly code = 412
  readonly status = 'FAILED_PRECONDITION'
  readonly reason = 'PRE_RESPONSE_TIMEOUT'

  constructor() {
    super(PRE_RESPONSE_TIMEOUT_MESSAGE)
    this.name = 'PreResponseTimeoutError'
  }
}

export function preResponseTimeoutResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 412,
        status: 'FAILED_PRECONDITION',
        message: PRE_RESPONSE_TIMEOUT_MESSAGE,
      },
    }),
    { status: 412, headers: { 'Content-Type': 'application/json' } },
  )
}

/** Monotonic time and cancellable scheduling, independent of quota wall time. */
export interface PreResponseClock {
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
}

const clock: PreResponseClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/** One absolute deadline, paused only while consuming an accepted response. */
export class PreResponseDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private active = true
  private cancelTimer: (() => void) | undefined
  private readonly detachCaller: () => void
  private readonly detachSignals: Array<() => void> = []

  constructor(
    private readonly caller?: AbortSignal | null,
    private readonly time: PreResponseClock = clock,
  ) {
    this.expiresAt = time.now() + PRE_RESPONSE_DEADLINE_MS
    this.signal = this.controller.signal
    const abort = () => {
      this.cancelTimer?.()
      this.controller.abort(caller?.reason)
    }
    this.detachCaller = () => caller?.removeEventListener('abort', abort)
    if (caller?.aborted) abort()
    else caller?.addEventListener('abort', abort, { once: true })
    this.arm()
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - this.time.now())
  }

  follow(signal: AbortSignal | undefined): void {
    if (!signal || signal === this.signal) return
    const abort = () => this.controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    this.detachSignals.push(() => signal.removeEventListener('abort', abort))
    this.check()
  }

  private arm(): void {
    if (this.signal.aborted) return
    this.cancelTimer = this.time.schedule(() => {
      if (this.remainingMs() > 0) this.arm()
      else this.expire()
    }, this.remainingMs())
  }

  private expire(): void {
    this.cancelTimer?.()
    this.controller.abort(new PreResponseTimeoutError())
  }

  check(): void {
    // Caller cancellation wins even when both signals become ready together.
    this.caller?.throwIfAborted()
    if (this.active && this.remainingMs() <= 0 && !this.signal.aborted)
      this.expire()
    this.signal.throwIfAborted()
  }

  acceptHeaders(): void {
    this.check()
    this.acceptTerminalResponse()
  }

  acceptTerminalResponse(): void {
    this.active = false
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  resume(): void {
    this.active = true
    this.check()
    this.arm()
  }

  /** Cancel a response that arrives after its sender lost the abort race. */
  open(work: () => Promise<Response>): Promise<Response> {
    return this.wait(() => {
      const pending = work()
      void pending.then(
        (response) => {
          if (this.signal.aborted) void response.body?.cancel().catch(() => {})
        },
        () => {},
      )
      return pending
    })
  }

  /** Interrupt even prerequisites that cannot themselves accept an AbortSignal. */
  async wait<T>(work: () => T | PromiseLike<T>): Promise<T> {
    this.check()
    let abort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(this.caller?.aborted ? this.caller.reason : this.signal.reason)
      this.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.check()
          return work()
        }),
        cancelled,
      ])
      this.check()
      return result
    } finally {
      this.signal.removeEventListener('abort', abort)
    }
  }

  dispose(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.detachCaller()
    for (const detach of this.detachSignals) detach()
    this.detachSignals.length = 0
  }
}
