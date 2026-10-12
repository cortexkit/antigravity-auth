import { describe, expect, it } from 'bun:test'
import { getEventListeners } from 'node:events'
import {
  createRequestCancellation,
  retainResponseLifetime,
} from './request-cancellation'

function sources() {
  const caller = new AbortController()
  const shutdown = new AbortController()
  return {
    caller,
    shutdown,
    cancellation: createRequestCancellation([caller.signal, shutdown.signal]),
  }
}

function expectReleased(caller: AbortController, shutdown: AbortController) {
  expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
  expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0)
}

describe('request cancellation lifetime', () => {
  it('preserves the exact reason when a source is already aborted', () => {
    const caller = new AbortController()
    const shutdown = new AbortController()
    const reason = new Error('already cancelled')
    caller.abort(reason)
    const cancellation = createRequestCancellation([
      caller.signal,
      shutdown.signal,
    ])
    expect(cancellation.signal.reason).toBe(reason)
    expectReleased(caller, shutdown)
  })

  it('releases all source listeners at body EOF, not at headers', async () => {
    const { caller, shutdown, cancellation } = sources()
    const retained = await retainResponseLifetime(
      new Response('complete', { headers: { 'x-test': 'kept' } }),
      cancellation,
    )
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1)
    expect(retained.response.headers.get('x-test')).toBe('kept')
    expect(await retained.response.text()).toBe('complete')
    await retained.settled
    expectReleased(caller, shutdown)
    caller.abort(new Error('after completion'))
    expect(cancellation.signal.aborted).toBe(false)
  })

  it.each([
    'caller',
    'shutdown',
  ] as const)('keeps %s cancellation active after headers and awaits underlying body cleanup', async (source) => {
    const { caller, shutdown, cancellation } = sources()
    const reason = new Error(`${source} aborted after headers`)
    let release: () => void = () => {}
    const heldCleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    let cancelledWith: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel(value) {
        cancelledWith = value
        return heldCleanup
      },
    })
    const retained = await retainResponseLifetime(
      new Response(body),
      cancellation,
    )
    const reader = retained.response.body!.getReader()
    const outcome = reader.read().then(
      (value) => ({ kind: 'read' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    let settled = false
    void retained.settled.then(() => {
      settled = true
    })
    try {
      const controller = source === 'caller' ? caller : shutdown
      controller.abort(reason)
      expect(cancellation.signal.reason).toBe(reason)
      expect(cancelledWith).toBe(reason)
      expect(await outcome).toEqual({ kind: 'error', error: reason })
      expect(settled).toBe(false)
      release()
      await retained.settled
      expectReleased(caller, shutdown)
    } finally {
      release()
      await reader.cancel(new Error('Test fixture cleanup')).catch(() => {})
      await retained.settled
    }
  })

  it('passes consumer cancellation to the underlying body and releases its sources', async () => {
    const { caller, shutdown, cancellation } = sources()
    const reason = new Error('consumer cancelled')
    let cancelledWith: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel(value) {
        cancelledWith = value
      },
    })
    const retained = await retainResponseLifetime(
      new Response(body),
      cancellation,
    )
    await retained.response.body!.cancel(reason)
    await retained.settled
    expect(cancelledWith).toBe(reason)
    expectReleased(caller, shutdown)
  })

  it('preserves the original body failure after actual content and releases listeners', async () => {
    const { caller, shutdown, cancellation } = sources()
    let fail: (error: Error) => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('content before failure'))
        fail = (error) => controller.error(error)
      },
    })
    const retained = await retainResponseLifetime(
      new Response(body),
      cancellation,
    )
    const reader = retained.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'content before failure',
    )
    const original = new Error('body connection lost')
    fail(original)
    await expect(reader.read()).rejects.toBe(original)
    await retained.settled
    expectReleased(caller, shutdown)
  })

  it('releases source listeners when a returned response body is already locked', async () => {
    const { caller, shutdown, cancellation } = sources()
    const response = new Response('already owned')
    const reader = response.body!.getReader()
    try {
      await expect(
        retainResponseLifetime(response, cancellation),
      ).rejects.toBeInstanceOf(TypeError)
      expectReleased(caller, shutdown)
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  })

  it('releases immediately for a response without a body', async () => {
    const { caller, shutdown, cancellation } = sources()
    const retained = await retainResponseLifetime(
      new Response(null, { status: 204 }),
      cancellation,
    )
    expect(retained.response.status).toBe(204)
    await retained.settled
    expectReleased(caller, shutdown)
  })
})
