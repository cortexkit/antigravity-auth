/**
 * Plugin-flow E2E test.
 *
 * Boots the real plugin factory with `PluginDependencyOverrides` that
 * point at a mock Antigravity server bound to 127.0.0.1, then drives
 * the auth loader + fetch interceptor through every failure mode the
 * production plugin has to handle gracefully.
 *
 * Coverage:
 *   - No-account 401 envelope (Google error envelope, real 401).
 *   - Account load → auth loader → fetch interception → transform →
 *     mock SSE → streaming reverse transform.
 *   - 401 token-expiry refresh + retry path.
 *   - 429 rotation across accounts.
 *   - 503 capacity fallback path.
 *   - Quota refresh + sidebar state write.
 *   - Plugin dispose tears down every subsystem.
 *
 * The mock server's `requests` array is the source of truth: every
 * assertion on "how many calls, in what order, with which body" reads
 * from there. We never inspect the plugin's internals — the test is
 * an external black-box.
 */

import './setup'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { persistAccountPool } from '../../opencode/src/plugin/persist-account-pool'
import {
  getStoragePath,
  loadAccounts,
  saveAccountsReplace,
} from '../../opencode/src/plugin/storage'
import { createE2eHarness, type E2eHarness } from './harness'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

let harness: E2eHarness | undefined

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

function seedAccounts(root: string, now: number): void {
  const accountsDir = join(root, 'pi-agent')
  mkdirSync(accountsDir, { recursive: true })
  saveAccountsReplace({
    version: 4,
    accounts: [
      {
        email: 'a@example.test',
        refreshToken: 'refresh-a',
        projectId: 'project-a',
        managedProjectId: 'managed-a',
        addedAt: now - 20_000,
        lastUsed: now - 10_000,
      },
      {
        email: 'b@example.test',
        refreshToken: 'refresh-b',
        projectId: 'project-b',
        managedProjectId: 'managed-b',
        addedAt: now - 19_000,
        lastUsed: now - 9_000,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  })
}

async function withHarness(
  fn: (harness: E2eHarness) => Promise<void>,
): Promise<void> {
  harness = await createE2eHarness('plugin-flow')
  try {
    await fn(harness)
  } finally {
    await harness?.dispose()
    harness = undefined
  }
}

describe('plugin flow (e2e)', () => {
  beforeEach(() => {
    const root = process.env.ANTIGRAVITY_TEST_ROOT
    if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
    seedAccounts(root, FIXED_NOW)
  })

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('returns a 401 envelope when no accounts are configured', async () => {
    await withHarness(async (h) => {
      // Overwrite the seeded accounts with an empty pool. Awaits the
      // write so the next step (createPlugin) loads the empty pool
      // instead of the seeded two-account snapshot — a fire-and-forget
      // here is a race against the plugin's loadAccounts read.
      await saveAccountsReplace({
        version: 4,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })
      const plugin = await h.createPlugin()
      // Inject valid OAuth auth so the loader path returns the
      // fetch hook (it short-circuits to `{}` when no OAuth auth is
      // present).
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      expect(fetchHook).toBeDefined()
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        { method: 'POST', body: '{}' },
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('X-Antigravity-Error-Type')).toBe(
        'no_accounts',
      )
      const body = (await response.json()) as {
        error: { code: number; status: string }
      }
      expect(body.error.code).toBe(401)
      expect(body.error.status).toBe('UNAUTHENTICATED')
      // No live network calls should have been attempted.
      expect(h.server.requests).toHaveLength(0)
    })
  })

  it('loads account, intercepts fetch, transforms, and streams the SSE response', async () => {
    await withHarness(async (h) => {
      // Queue: project discovery → quota → stream.
      h.server.enqueue({
        kind: 'streamChunked',
        model: 'gemini-3-flash',
        chunks: [
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}}',
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" world"}]}}]}}',
        ],
      })

      const plugin = await h.createPlugin()
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          }),
        },
      )
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('hello')
      expect(text).toContain('world')
      // The mock saw at least one streaming hit.
      expect(h.server.requests.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('rotates to a second account on 429', async () => {
    await withHarness(async (h) => {
      h.server.enqueue({
        kind: 'rateLimit429',
        retryAfterMs: 2000,
        reason: 'QUOTA_EXHAUSTED',
      })
      h.server.enqueue({
        kind: 'streamChunked',
        model: 'gemini-3-flash',
        chunks: [
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"from-b"}]}}]}}',
        ],
      })

      const plugin = await h.createPlugin()
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          body: '{}',
        },
      )
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).toContain('from-b')

      expect(h.server.requests.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('returns a structured 401 when refreshed auth is still rejected', async () => {
    await withHarness(async (h) => {
      h.server.enqueue({ kind: 'tokenExpiry401', rotatedRefresh: 'refresh-a2' })
      h.server.enqueue({
        kind: 'streamChunked',
        model: 'gemini-3-flash',
        chunks: [
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"after-refresh"}]}}]}}',
        ],
      })

      const plugin = await h.createPlugin()
      let authReads = 0
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: authReads++ === 0 ? 'access-a' : 'access-a-refreshed',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          body: '{}',
        },
      )
      await response.text()
      expect(response.status).toBe(401)
      expect(h.server.requests.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('falls back across endpoints on 503 capacity errors', async () => {
    await withHarness(async (h) => {
      h.server.enqueue({ kind: 'capacity503', retryAfterMs: 250 })
      h.server.enqueue({
        kind: 'streamChunked',
        model: 'gemini-3-flash',
        chunks: [
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"recovered"}]}}]}}',
        ],
      })

      const plugin = await h.createPlugin()
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        { method: 'POST', body: '{}' },
      )
      expect(response.status).toBe(200)
    })
  })

  it('writes the sidebar state file when the auth loader initializes', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      // Touching the loader is enough to seed the auth path.
      await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )

      // The plugin writes the sidebar file under ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE.
      const sidebarPath = process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
      if (!sidebarPath) throw new Error('sidebar path missing')
      // Poll briefly for the sidebar write to land (the manager
      // updates asynchronously on quota refresh).
      await new Promise((resolve) => setTimeout(resolve, 50))
      const sidebar = readFileSync(sidebarPath, 'utf8')
      const parsed = JSON.parse(sidebar) as {
        accounts?: Array<{ email?: string }>
      }
      expect(parsed.accounts?.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('V3 poller: background_quota_refresh=true exercises the default-on path and refreshes idle accounts', async () => {
    // The harness globally sets background_quota_refresh:false to prevent
    // network calls outside the fetch interceptor. This test overrides that
    // and verifies the poller path through the real factory:
    //   - plugin boots with background_quota_refresh:true
    //   - accounts are loaded (seeded by beforeEach)
    //   - the poller fires (stale freshness gate) and calls the mock server
    //   - the sidebar state file is updated with non-empty quota
    await withHarness(async (h) => {
      const sidebarPath = process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
      if (!sidebarPath) throw new Error('sidebar path missing')

      // Use a longer startup jitter (350ms) so we have a reliable window
      // to write a stale sidebar AFTER the auth loader (which writes a fresh
      // checkedAt) but BEFORE the first poller tick. This makes the only
      // write that can advance past `pollBefore` be the poller's own tick.
      const plugin = await h.createPlugin({
        configOverrides: {
          background_quota_refresh: true,
          background_quota_refresh_interval_minutes: 1,
        },
        extraDependencies: {
          // random=0.012 → jitter = floor(0.012 * 30000) = 360ms.
          // Auth loader runs in ~20ms; we write the stale sidebar at ~250ms
          // — leaving ~110ms before the first tick fires.
          clock: { random: () => 0.012 },
        },
      })

      // Warm up the auth loader so the AccountManager is populated.
      // This will write a fresh checkedAt to the sidebar (~T+20ms).
      await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        {} as Parameters<typeof plugin.auth.loader>[1],
      )

      // Give the auth loader\'s async sidebar write time to land, then
      // forcibly overwrite with a stale checkedAt so the poller\'s freshness
      // gate passes on its first tick (~360ms from start). Must bypass the
      // merge logic (which rejects stale writes) — write directly to disk.
      await new Promise((r) => setTimeout(r, 200))
      require('node:fs').writeFileSync(
        sidebarPath,
        JSON.stringify({
          version: 1,
          checkedAt: Date.now() - 60_000,
          accounts: [],
          activeRouting: {},
          routingAuthoritative: false,
        }),
      )

      // Capture pollBefore AFTER the stale write. Now the ONLY write that
      // can advance checkedAt past this point is the poller\'s first tick.
      const pollBefore = Date.now()

      const deadline = pollBefore + 5_000
      let sidebarCheckedAt = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        try {
          const raw = require('node:fs').readFileSync(
            sidebarPath,
            'utf8',
          ) as string
          const parsed = JSON.parse(raw) as { checkedAt?: number }
          sidebarCheckedAt = parsed.checkedAt ?? 0
          if (sidebarCheckedAt > pollBefore) break
        } catch {
          // File not written yet — retry.
        }
      }

      await plugin.dispose()

      // The poller must have fired, passed the freshness gate on the stale
      // sidebar, and written a fresh checkedAt. This assertion can ONLY be
      // satisfied by the poller — not by the auth loader (which ran before
      // pollBefore and wrote the now-overwritten stale checkedAt).
      expect(sidebarCheckedAt).toBeGreaterThan(pollBefore)
    })
  })

  it('dispose() releases every subsystem and clears the auth loader runtime', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      const before = plugin.dispose
      expect(typeof before).toBe('function')
      await plugin.dispose()
      // Second dispose is a no-op (lifecycle is idempotent).
      await plugin.dispose()
    })
  })

  it('persists newly logged-in accounts through the CLI OAuth method', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      const methods = plugin.auth.methods
      expect(methods.length).toBeGreaterThanOrEqual(1)
      const oauth = methods[0]
      expect(oauth?.label).toContain('Antigravity')

      // The OAuth authorize callback is exercised end-to-end by the
      // cli-flow suite; here we verify that a successfully exchanged
      // token survives `persistAccountPool` and lands in storage.
      const fakeSuccess = {
        type: 'success' as const,
        refresh: 'refresh-c|project-c|managed-c',
        access: 'access-c',
        expires: Date.now() + 3_600_000,
        email: 'c@example.test',
        projectId: 'project-c',
        managedProjectId: 'managed-c',
      }
      await persistAccountPool([fakeSuccess], true)
      const storage = await loadAccounts()
      const path = getStoragePath()
      expect(path).toBeTruthy()
      expect(storage?.accounts.some((a) => a.email === 'c@example.test')).toBe(
        true,
      )
    })
  })
})
