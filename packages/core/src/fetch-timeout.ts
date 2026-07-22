/**
 * Stream-safe active-fetch timeout helper.
 *
 * Bounds the time spent waiting for HTTP response headers while leaving any
 * returned response body fully readable until the caller (or its own signal)
 * chooses to abort it. Naively forwarding `AbortSignal.timeout(...)` into
 * `fetch()` aborts the body at the deadline even when headers arrived
 * promptly — the helper only forwards the timeout into the request signal
 * until the underlying fetch resolves, then drops the timeout listener so
 * the body remains consumable.
 */

export const ACTIVE_FETCH_TIMEOUT_MS = 15_000

export type ActiveFetchOptions = {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Issue an HTTP fetch with a bounded active-fetch (header) wait.
 *
 * The `init.signal` is composed into the request abort signal so caller
 * cancellation still propagates, but the 15s active timeout is only enforced
 * until `fetchImpl` resolves — once headers arrive the timeout listener is
 * removed and the returned Response body can be streamed past the deadline.
 */
export async function fetchWithActiveTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ActiveFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? ACTIVE_FETCH_TIMEOUT_MS

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const activeController = new AbortController()
  const onTimeoutAbort = () => activeController.abort(timeoutSignal.reason)
  if (timeoutSignal.aborted) {
    onTimeoutAbort()
  } else {
    timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true })
  }

  const composedSignal = init.signal
    ? AbortSignal.any([activeController.signal, init.signal])
    : activeController.signal

  try {
    return await fetchImpl(input, { ...init, signal: composedSignal })
  } finally {
    timeoutSignal.removeEventListener('abort', onTimeoutAbort)
  }
}
