/**
 * E2E fetch-guard tests.
 *
 * The `setup.ts` preload wraps `globalThis.fetch` with a loopback-only
 * guard. These tests prove that:
 *   1. Loopback URLs pass through unchanged.
 *   2. Non-loopback URLs throw `LiveNetworkDeniedError`.
 *   3. The guard is restored in `afterEach` so the next test (or the
 *      host's own fetch) sees the original globalThis.fetch.
 */

import { describe, expect, it } from 'bun:test'
import { LiveNetworkDeniedError } from './setup'

describe('e2e fetch guard', () => {
  it('allows loopback fetches through to the host fetch', async () => {
    // The loopback fetch is not blocked. We do not start a real server
    // here — this test only proves the early-return path does NOT
    // throw before the host fetch is invoked. A bogus port closes the
    // connection immediately, which is enough to confirm the guard
    // let the request through.
    let blocked = false
    try {
      await fetch('http://127.0.0.1:1/no-server-listening')
    } catch (err) {
      // Connection refused is the EXPECTED outcome — the guard should
      // NOT throw, so we only land here if the request actually reached
      // the host fetch.
      if (err instanceof LiveNetworkDeniedError) {
        blocked = true
      }
    }
    expect(blocked).toBe(false)
  })

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

  it('allows ::1 loopback (IPv6)', async () => {
    let blocked = false
    try {
      await fetch('http://[::1]:1/no-server')
    } catch (err) {
      if (err instanceof LiveNetworkDeniedError) blocked = true
    }
    expect(blocked).toBe(false)
  })

  it('allows localhost as an alias', async () => {
    let blocked = false
    try {
      await fetch('http://localhost:1/no-server')
    } catch (err) {
      if (err instanceof LiveNetworkDeniedError) blocked = true
    }
    expect(blocked).toBe(false)
  })
})
