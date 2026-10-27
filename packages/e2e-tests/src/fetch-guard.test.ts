/**
 * E2E fetch-guard tests.
 *
 * The `setup.ts` preload wraps `globalThis.fetch` with a loopback-only
 * guard. These tests prove that:
 *   1. Loopback URLs pass through unchanged.
 *   2. Non-loopback URLs throw `LiveNetworkDeniedError`.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { cleanupE2eRootsForCurrentFile, LiveNetworkDeniedError } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

describe('e2e fetch guard', () => {
  for (const hostname of ['127.0.0.1', '[::1]', 'localhost']) {
    it(`passes ${hostname} requests and init through to the host fetch`, async () => {
      const requests: Array<{ url: string; method: string; body: string }> = []
      const marker = `loopback-${hostname}`
      const server = Bun.serve({
        hostname: hostname === '[::1]' ? '::1' : '127.0.0.1',
        port: 0,
        async fetch(request) {
          requests.push({
            url: request.url,
            method: request.method,
            body: await request.text(),
          })
          return new Response(marker)
        },
      })
      try {
        const url = `http://${hostname}:${server.port}/witness?original=yes`
        const response = await fetch(new Request(url), {
          method: 'POST',
          body: marker,
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe(marker)
        expect(requests).toEqual([{ url, method: 'POST', body: marker }])
      } finally {
        await server.stop(true)
      }
    })
  }

  it('blocks non-loopback URLs with LiveNetworkDeniedError', async () => {
    let thrown: unknown = null
    try {
      await fetch('https://example.com/')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(LiveNetworkDeniedError)
    expect((thrown as LiveNetworkDeniedError).url).toBe('https://example.com/')
  })

  it('blocks raw public IPs the same way', async () => {
    let thrown: unknown = null
    try {
      await fetch('https://1.1.1.1/')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(LiveNetworkDeniedError)
  })

  it('blocks URLs handed in via Request objects', async () => {
    let thrown: unknown = null
    try {
      await fetch(new Request('https://example.com/wat'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(LiveNetworkDeniedError)
  })
})
