export interface RequestCancellation {
  readonly signal: AbortSignal
  release(): void
}

/** Keep caller and final-shutdown cancellation independent without requiring AbortSignal.any. */
export function createRequestCancellation(
  signals: readonly AbortSignal[],
): RequestCancellation {
  const controller = new AbortController()
  const remove: (() => void)[] = []
  const release = () => {
    for (const detach of remove.splice(0)) detach()
  }
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason)
      release()
      break
    }
    const forward = () => {
      controller.abort(source.reason)
      release()
    }
    remove.push(() => source.removeEventListener('abort', forward))
    source.addEventListener('abort', forward, { once: true })
    if (source.aborted) forward()
    if (controller.signal.aborted) break
  }
  return { signal: controller.signal, release }
}

/** Headers do not end a request: keep cancellation alive until its body ends or is cancelled. */
export async function retainResponseLifetime(
  response: Response,
  cancellation: RequestCancellation,
): Promise<{
  response: Response
  settled: Promise<void>
}> {
  if (!response.body) {
    cancellation.release()
    return { response, settled: Promise.resolve() }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = response.body.getReader()
  } catch (error) {
    cancellation.release()
    throw error
  }
  let resolve: () => void = () => {}
  const settled = new Promise<void>((done) => {
    resolve = done
  })
  let stopping = false
  let finished = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = () => {
    if (finished) return
    finished = true
    cancellation.signal.removeEventListener('abort', abort)
    cancellation.release()
    resolve()
  }
  const abort = () => {
    if (finished || stopping) return
    stopping = true
    const reason = cancellation.signal.reason
    controller.error(reason)
    void reader.cancel(reason).then(finish, finish)
  }
  const body = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output
      cancellation.signal.addEventListener('abort', abort, { once: true })
      if (cancellation.signal.aborted) abort()
    },
    async pull(output) {
      try {
        const next = await reader.read()
        if (stopping) return
        if (next.done) {
          output.close()
          finish()
        } else {
          output.enqueue(next.value)
        }
      } catch (error) {
        if (stopping) return
        output.error(error)
        finish()
      }
    },
    async cancel(reason) {
      stopping = true
      try {
        await reader.cancel(reason)
      } finally {
        finish()
      }
    },
  })
  try {
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      settled,
    }
  } catch (error) {
    stopping = true
    await reader.cancel(error).then(finish, finish)
    throw error
  }
}
