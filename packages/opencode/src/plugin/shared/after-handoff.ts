import { createRequestCancellation } from './request-cancellation.ts'

/** An adapter installs the acknowledgement; only its final publisher calls it. */
export type RegisterResponseHandoff = (acknowledge: () => void) => void

/**
 * Holds a quota refresh until the host publishes its response. Registration adds
 * a completion promise to `work`, so executor shutdown joins the entire refresh.
 */
export function createAfterHandoff(
  work: Set<Promise<void>>,
  signals: readonly AbortSignal[],
  onFailure: () => void,
) {
  const controller = new AbortController()
  const cancellation = createRequestCancellation([
    ...signals,
    controller.signal,
  ])
  let run: ((signal: AbortSignal) => Promise<void>) | undefined
  let acknowledged = false
  let finished = false
  let running = false
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  const finish = () => {
    if (finished) return
    finished = true
    run = undefined
    cancellation.signal.removeEventListener('abort', onAbort)
    cancellation.release()
    work.delete(completion)
    resolveCompletion()
  }
  const onAbort = () => {
    if (!running) finish()
  }
  cancellation.signal.addEventListener('abort', onAbort, { once: true })
  if (cancellation.signal.aborted) onAbort()
  return {
    register(callback: (signal: AbortSignal) => Promise<void>) {
      if (finished || run) return
      run = callback
      work.add(completion)
    },
    acknowledge() {
      if (finished || acknowledged || !run) return
      acknowledged = true
      // Track the completion before invoking even a synchronously throwing callback.
      void Promise.resolve().then(async () => {
        if (finished || cancellation.signal.aborted) return
        running = true
        try {
          await run?.(cancellation.signal)
        } catch {
          try {
            onFailure()
          } catch {
            /* Diagnostics cannot fail a published reply. */
          }
        } finally {
          finish()
        }
      })
    },
    cancel() {
      controller.abort()
      onAbort()
    },
  }
}

/** Fulfil the actual public promise before acknowledging API availability. */
export function publishResponse(
  dispatch: (register: RegisterResponseHandoff) => Promise<Response>,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let acknowledge: (() => void) | undefined
    void Promise.resolve()
      .then(() =>
        dispatch((callback) => {
          acknowledge = callback
        }),
      )
      .then((response) => {
        resolve(response)
        acknowledge?.()
      }, reject)
  })
}
