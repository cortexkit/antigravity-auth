/**
 * E2E workspace test preload.
 *
 * Per-test isolation + an unconditional non-loopback deny guard on
 * `globalThis.fetch`. The guard is installed in `beforeEach` and
 * restored in `afterEach` so a stray `fetch('https://example.com')`
 * inside the production plugin surfaces as `LiveNetworkDeniedError`
 * instead of silently leaking to the live network.
 *
 * The plugin's `dependencies.agyTransport` and `dependencies.fetchImpl`
 * still own the loopback rewrite to the mock server — the deny guard
 * only blocks non-loopback targets.
 *
 * Responsibilities:
 *   1. Wrap `globalThis.fetch` with a loopback-only guard.
 *   2. Allocate a per-test `mkdtemp` root with HOME / XDG_*
 *      overrides so tests never touch the host filesystem.
 *   3. Tear down the root + restore the original fetch in `afterEach`
 *      so cross-test pollution cannot leak.
 *   4. Defensive final sweep in `afterAll` to reap any temp roots
 *      left behind by crashed tests.
 */

import { afterAll, afterEach, beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Thrown when a request targets anything other than the loopback
 * allowlist. Surfaced as a real exception so the failing test
 * pinpoints the offending call site.
 */
export class LiveNetworkDeniedError extends Error {
  readonly url: string
  constructor(url: string) {
    super(`Live network access denied by e2e harness: ${url}`)
    this.name = 'LiveNetworkDeniedError'
    this.url = url
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * Per-test snapshot of the original `globalThis.fetch` so the guard
 * can be restored in `afterEach`.
 */
let originalFetch: typeof globalThis.fetch | null = null

function installFetchGuard(): void {
  if (originalFetch) return
  originalFetch = globalThis.fetch
  const hostFetch = originalFetch
  globalThis.fetch = async function guardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlString =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    let parsed: URL | null = null
    try {
      parsed = new URL(urlString)
    } catch {
      // Unparseable URL — let the host fetch surface its own error.
      return hostFetch(input as RequestInfo, init)
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new LiveNetworkDeniedError(parsed.href)
    }
    return hostFetch(input as RequestInfo, init)
  } as typeof globalThis.fetch
}

function restoreFetchGuard(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = null
  }
}

beforeEach(() => {
  installFetchGuard()
  // Per-test temp root + env reset. Tests must not touch the host HOME.
  const root = fs.mkdtempSync(join(tmpdir(), 'agy-e2e-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const cache = join(root, 'cache')
  const data = join(root, 'data')
  const state = join(root, 'state')
  const pi = join(root, 'pi-agent')
  for (const path of [home, config, cache, data, state, pi]) {
    fs.mkdirSync(path, { recursive: true })
  }
  process.env.ANTIGRAVITY_TEST_ROOT = root
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = config
  process.env.XDG_CACHE_HOME = cache
  process.env.XDG_DATA_HOME = data
  process.env.XDG_STATE_HOME = state
  process.env.APPDATA = config
  process.env.LOCALAPPDATA = cache
  process.env.OPENCODE_CONFIG_DIR = join(config, 'opencode')
  process.env.PI_AGENT_DIR = pi
  process.env.PI_ANTIGRAVITY_AUTH_FILE = join(pi, 'antigravity-accounts.json')
  process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = join(root, 'gemini-dumps')
  process.env.ANTIGRAVITY_AUTH_RPC_DIR = join(state, 'cortexkit', 'rpc')
  process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE = join(
    state,
    'cortexkit',
    'sidebar.json',
  )
})

afterEach(() => {
  // Restore the unwrapped fetch FIRST so a teardown-step fetch reaching
  // the host (e.g. a tmpdir cleanup that uses a relative path) does not
  // collide with the guard.
  restoreFetchGuard()
  // Tear down the temp root — even on assertion failure. We use the
  // `force` flag because some child files (sockets, fifos) may be
  // unreadable on platforms that hold advisory locks.
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (root) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup; the afterAll pass will retry if anything
      // is left behind.
    }
    delete process.env.ANTIGRAVITY_TEST_ROOT
  }
})

afterAll(() => {
  // Defensive final sweep — the per-test rmSync should have handled
  // everything, but a crashed test may have left a child root alive.
  // We match by prefix to avoid touching the host's tmpdir.
  const entries = fs.readdirSync(tmpdir())
  for (const entry of entries) {
    if (entry.startsWith('agy-e2e-')) {
      try {
        fs.rmSync(join(tmpdir(), entry), { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
  }
})
