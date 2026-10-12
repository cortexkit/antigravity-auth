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

import { forwardAbort } from './abort-forwarding.ts'

export const ACTIVE_FETCH_TIMEOUT_MS = 15_000

export type ActiveFetchOptions = {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Issue an HTTP fetch with a bounded active-fetch (header) wait.
 *
 * The caller signal (`init.signal`, or the input Request's inherited signal)
 * is forwarded into the request abort signal so cancellation still propagates,
 * but the 15s active timeout is only enforced
 * until `fetchImpl` resolves — once headers arrive the timeout listener is
 * removed and the returned Response body can be streamed past the deadline.
 * Caller forwarding remains until the body reaches EOF, errors, or is canceled.
 */
export async function fetchWithActiveTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ActiveFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? ACTIVE_FETCH_TIMEOUT_MS
  const callerSignal =
    init.signal !== undefined
      ? init.signal
      : input instanceof Request
        ? input.signal
        : undefined

  const activeController = new AbortController()
  const detachCaller = forwardAbort(callerSignal, activeController)
  let detachTimeout = () => {}

  try {
    detachTimeout = forwardAbort(
      AbortSignal.timeout(timeoutMs),
      activeController,
    )
    const response = await fetchImpl(input, {
      ...init,
      signal: activeController.signal,
    })
    if (!callerSignal || !response.body) {
      detachCaller()
      return response
    }
    return withBodyCleanup(response, detachCaller)
  } catch (error) {
    detachCaller()
    throw error
  } finally {
    detachTimeout()
  }
}

function withBodyCleanup(response: Response, cleanup: () => void): Response {
  const reader = response.body!.getReader()
  let finished = false
  let canceled = false
  let pulling = false
  let sourceClosed = false
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
    reader.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        bodyController = controller
      },
      async pull(controller) {
        pulling = true
        try {
          const next = await reader.read()
          if (canceled) return
          if (next.done) {
            finish()
            controller.close()
          } else {
            controller.enqueue(next.value)
            if (sourceClosed) {
              finish()
              controller.close()
            }
          }
        } catch (error) {
          if (canceled) return
          finish()
          controller.error(error)
        } finally {
          pulling = false
        }
      },
      async cancel(reason) {
        canceled = true
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    // Do not read ahead: the caller controls consumption of the network body.
    { highWaterMark: 0 },
  )
  // Observe idle errors/empty EOF without reading ahead or dropping a final chunk.
  void reader.closed.then(
    () => {
      sourceClosed = true
      if (finished || canceled || pulling) return
      finish()
      bodyController.close()
    },
    (error) => {
      if (finished || canceled) return
      finish()
      bodyController.error(error)
    },
  )
  try {
    return preserveResponseMetadata(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      response,
    )
  } catch (error) {
    finish()
    throw error
  }
}

function preserveResponseMetadata(
  wrapped: Response,
  original: Response,
): Response {
  // Response's constructor cannot carry network metadata, including on clones.
  Object.defineProperties(wrapped, {
    url: { value: original.url },
    type: { value: original.type },
    redirected: { value: original.redirected },
    clone: {
      value: () =>
        preserveResponseMetadata(
          Response.prototype.clone.call(wrapped),
          original,
        ),
    },
  })
  return wrapped
}
