import { expect, it, spyOn } from 'bun:test'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { setTimeout as delay, setImmediate } from 'node:timers/promises'
import {
  GA_UNCLAIMED_JOB_TTL_MS,
  type GaBridgeJob,
  type GaLoopbackBridge,
  startGaLoopbackBridge,
} from './index.ts'

const firstFrame = 'data: {"text":"first owned frame"}\n\n'
const secondFrame = 'data: {"text":"second owned frame"}\n\n'
const decoder = new TextDecoder()
const released = { unclaimed: 0, claimed: 0, failures: 0, timers: 0 }
const job: GaBridgeJob = {
  sessionID: 'ses_stream_lifetime',
  parentSessionID: null,
  kind: 'primary',
  modelID: 'antigravity-gemini-3.8-flash',
  variant: null,
  url: 'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse',
  body: '{}',
}

async function openStream(holdFailure = false) {
  const accepted = Promise.withResolvers<ServerResponse>()
  const nativeFailure = Promise.withResolvers<unknown>()
  const forwardFailure = Promise.withResolvers<void>()
  const secondBuffered = Promise.withResolvers<void>()
  const nativeFinished = Promise.withResolvers<void>()
  const sockets = new Set<Socket>()
  let cleaned = false
  let loopbackEof = false
  let bridge: GaLoopbackBridge | undefined
  let consumer: ReadableStreamDefaultReader<Uint8Array> | undefined
  const upstream = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(firstFrame)
    accepted.resolve(response)
  })
  upstream.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address() as AddressInfo
  const close = async () => {
    forwardFailure.resolve()
    await consumer?.cancel('fixture cleanup').catch(() => {})
    await bridge?.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
  try {
    bridge = await startGaLoopbackBridge({
      send: async () => {
        throw new Error('Only the owned HTTP upstream may be used')
      },
      execute: async (_job, { signal }) => {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/stream`,
          {
            signal,
          },
        )
        if (!response.body) throw new Error('Missing native upstream body')
        const reader = response.body.getReader()
        const finish = () => {
          reader.releaseLock()
          cleaned = true
          nativeFinished.resolve()
        }
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  const result = await reader.read()
                  if (result.done) {
                    finish()
                    controller.close()
                  } else controller.enqueue(result.value)
                } catch (error) {
                  nativeFailure.resolve(error)
                  if (holdFailure) await forwardFailure.promise
                  finish()
                  controller.error(error)
                }
              },
              async cancel(reason) {
                await reader.cancel(reason)
                finish()
              },
            },
            { highWaterMark: 0 },
          ),
          { status: response.status, headers: response.headers },
        )
      },
    })
    const request = bridge.rewrite(
      new Request(job.url, { method: 'POST', body: job.body }),
      job,
      {},
    )
    const response = await fetch(request)
    expect(response.status).toBe(200)
    if (!response.body) throw new Error('Missing loopback body')
    const network = response.body.getReader()
    const observed = new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const result = await network.read()
              if (result.done) {
                loopbackEof = true
                network.releaseLock()
                controller.close()
              } else {
                controller.enqueue(result.value)
                if (decoder.decode(result.value).includes(secondFrame)) {
                  secondBuffered.resolve()
                }
              }
            } catch (error) {
              network.releaseLock()
              controller.error(error)
            }
          },
          cancel: (reason) => network.cancel(reason),
        },
        { highWaterMark: 0 },
      ),
      { status: response.status, headers: response.headers },
    )
    const adapted = bridge.adaptResponse(request, observed)
    if (!adapted?.body) throw new Error('Missing adapted body')
    consumer = adapted.body.getReader()
    const first = await consumer.read()
    expect(first.done).toBe(false)
    expect(decoder.decode(first.value)).toBe(firstFrame)
    const socketResponse = await accepted.promise
    return {
      bridge,
      consumer,
      nativeFailure: nativeFailure.promise,
      nativeFinished: nativeFinished.promise,
      releaseFailure: () => forwardFailure.resolve(),
      get cleaned() {
        return cleaned
      },
      get loopbackEof() {
        return loopbackEof
      },
      async bufferSecond() {
        socketResponse.write(secondFrame)
        await secondBuffered.promise
        expect(loopbackEof).toBe(false)
      },
      fail: () => socketResponse.destroy(),
      end: () => socketResponse.end(),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

it('delivers the identical native upstream failure after every sent byte', async () => {
  const stream = await openStream()
  try {
    await stream.bufferSecond()
    const second = await stream.consumer.read()
    expect(decoder.decode(second.value)).toBe(secondFrame)
    const terminal = stream.consumer.read().catch((error: unknown) => error)
    stream.fail()
    const failure = await stream.nativeFailure
    expect(failure).toBeInstanceOf(Error)
    expect(await terminal).toBe(failure)
    expect(stream.cleaned).toBe(true)
    expect(stream.bridge.retainedResponses()).toEqual(released)
  } finally {
    await stream.close()
  }
})

it('retains a claimed native failure beyond the former 60-second lease', async () => {
  const stream = await openStream()
  try {
    await stream.bufferSecond()
    stream.fail()
    const failure = await stream.nativeFailure
    expect(failure).toBeInstanceOf(Error)
    const started = performance.now()
    await delay(65_001)
    expect(performance.now() - started).toBeGreaterThanOrEqual(65_001)
    expect(stream.loopbackEof).toBe(false)
    const second = await stream.consumer.read()
    expect(second.done).toBe(false)
    expect(decoder.decode(second.value)).toBe(secondFrame)
    expect(await stream.consumer.read().catch((error: unknown) => error)).toBe(
      failure,
    )
    expect(stream.bridge.retainedResponses()).toEqual(released)
  } finally {
    await stream.close()
  }
}, 80_000)

it('normal disposal leaves no failure retention timer after clean EOF', async () => {
  const timers = spyOn(globalThis, 'setTimeout')
  const stream = await openStream()
  try {
    stream.end()
    expect((await stream.consumer.read()).done).toBe(true)
    await stream.nativeFinished
    const before = timers.mock.calls.length
    await stream.bridge.dispose()
    expect(stream.cleaned).toBe(true)
    expect(stream.bridge.pendingJobs()).toBe(0)
    expect(stream.bridge.retainedResponses()).toEqual(released)
    expect(
      timers.mock.calls
        .slice(before)
        .filter((call) => call[1] === GA_UNCLAIMED_JOB_TTL_MS),
    ).toHaveLength(0)
  } finally {
    await stream.close()
    timers.mockRestore()
  }
})

it('disposal drains a delayed native reader and forbids late failure timers', async () => {
  const timers = spyOn(globalThis, 'setTimeout')
  const stream = await openStream(true)
  let disposal: Promise<void> | undefined
  try {
    await stream.bufferSecond()
    const before = timers.mock.calls.length
    let disposed = false
    disposal = stream.bridge.dispose().then(() => {
      disposed = true
    })
    const failure = await stream.nativeFailure
    expect(failure).toBeInstanceOf(Error)
    await setImmediate()
    const returnedBeforeCleanup = disposed
    stream.releaseFailure()
    await disposal
    await stream.nativeFinished
    await setImmediate()
    expect(returnedBeforeCleanup).toBe(false)
    expect(stream.cleaned).toBe(true)
    expect(stream.bridge.pendingJobs()).toBe(0)
    expect(stream.bridge.retainedResponses()).toEqual(released)
    // This observes real timers without replacing their callbacks or clock.
    expect(
      timers.mock.calls
        .slice(before)
        .filter((call) => call[1] === GA_UNCLAIMED_JOB_TTL_MS),
    ).toHaveLength(0)
    const second = await stream.consumer.read()
    expect(decoder.decode(second.value)).toBe(secondFrame)
    expect(await stream.consumer.read().catch((error: unknown) => error)).toBe(
      failure,
    )
  } finally {
    stream.releaseFailure()
    await disposal
    await stream.close()
    timers.mockRestore()
  }
})

it('cancelling a claimed response cleans up its native reader', async () => {
  const stream = await openStream()
  try {
    await stream.bufferSecond()
    await stream.consumer.cancel('consumer abandoned the response')
    await stream.nativeFailure
    await stream.bridge.dispose()
    expect(stream.cleaned).toBe(true)
    expect(stream.bridge.pendingJobs()).toBe(0)
    expect(stream.bridge.retainedResponses()).toEqual(released)
  } finally {
    await stream.close()
  }
})

it('disposal clears bridge retention for a held claimed failure without a timer', async () => {
  const stream = await openStream()
  try {
    await stream.bufferSecond()
    stream.fail()
    await stream.nativeFailure
    await stream.nativeFinished
    await setImmediate()
    expect(stream.loopbackEof).toBe(false)
    expect(stream.bridge.retainedResponses()).toEqual({
      unclaimed: 0,
      claimed: 1,
      failures: 1,
      timers: 0,
    })
    await stream.bridge.dispose()
    expect(stream.bridge.retainedResponses()).toEqual(released)
  } finally {
    await stream.close()
  }
})

it('does not turn a paused claimed failure into clean EOF on disposal', async () => {
  const stream = await openStream()
  try {
    await stream.bufferSecond()
    stream.fail()
    const failure = await stream.nativeFailure
    await stream.nativeFinished
    await setImmediate()
    expect(stream.loopbackEof).toBe(false)
    expect(stream.bridge.retainedResponses().failures).toBe(1)
    await stream.bridge.dispose()
    expect(stream.bridge.retainedResponses()).toEqual(released)
    const second = await stream.consumer.read()
    expect(second.done).toBe(false)
    expect(decoder.decode(second.value)).toBe(secondFrame)
    const terminal = await stream.consumer
      .read()
      .catch((error: unknown) => error)
    expect(terminal).toBe(failure)
  } finally {
    await stream.close()
  }
})
