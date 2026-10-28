/**
 * Plugin-flow E2E test.
 *
 * Boots the real plugin factory with `PluginDependencyOverrides` that
 * send provider HTTP requests to a mock server bound to 127.0.0.1,
 * then drives the auth loader and fetch interceptor through account,
 * streaming, and upstream-error flows without contacting a live provider.
 *
 * Coverage:
 *   - No-account HTTP 401 with Google's JSON error shape.
 *   - Account load → auth loader → fetch interception → transform →
 *     mock SSE → streaming reverse transform.
 *   - Stored-token expiry refresh followed by an upstream 401 refusal.
 *   - 429 rotation across accounts.
 *   - Same-endpoint 503 capacity retry.
 *   - Quota refresh + sidebar state write.
 *   - Idempotent plugin disposal.
 *
 * The mock server's `requests` array is the source of truth: every
 * assertion on "how many calls, in what order, with which body" reads
 * from there. Poller scheduling and OAuth input are controlled at existing
 * factory seams while the real transport, sidebar and store paths run.
 */

import { prepareVaultFolder } from '../../opencode/src/vault-folder.ts'
import './setup'

import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type AccountRepository,
  createAccountRepositoryFactory,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
  resolveAccountStorePaths,
} from '@cortexkit/antigravity-auth-core'
import { createDefaultAccountStoreOperations } from '../../opencode/src/cli'
import * as oauthMethodsModule from '../../opencode/src/plugin/oauth-methods'
import {
  getStoragePath,
  saveAccountsReplace,
} from '../../opencode/src/plugin/storage'
import type { Provider } from '../../opencode/src/plugin/types'
import type { SidebarStateV1 } from '../../opencode/src/sidebar-state'
import { phase, runDiagnosticCase } from './e2e-phase-diagnostic'
import { runFetchRouter } from './fetch-router'
import { createE2eHarness, type E2eHarness } from './harness'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

let harness: E2eHarness | undefined

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')
const casePaths = new Set<string>()

function emptyProvider(): Provider {
  return {
    id: 'google',
    name: 'Google',
    source: 'custom',
    env: [],
    options: {},
    models: {},
  }
}

async function seedAccounts(now: number): Promise<void> {
  await saveAccountsReplace({
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
  fn: (harness: E2eHarness, repository: AccountRepository) => Promise<void>,
  mode: 'accounts' | 'expired-a' | 'empty' | 'legacy' = 'accounts',
): Promise<void> {
  await runDiagnosticCase(() => withHarnessBody(fn, mode))
}

async function withHarnessBody(
  fn: (harness: E2eHarness, repository: AccountRepository) => Promise<void>,
  mode: 'accounts' | 'expired-a' | 'empty' | 'legacy' = 'accounts',
): Promise<void> {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  const configDir = join(root, 'plugin-flow-store')
  const previousFetch = globalThis.fetch
  let repository: AccountRepository | undefined
  process.env.OPENCODE_CONFIG_DIR = configDir
  try {
    mkdirSync(configDir, { recursive: true })
    const path = getStoragePath()
    expect(path).toBe(join(configDir, 'antigravity-accounts.json'))
    expect(casePaths.has(path)).toBe(false)
    casePaths.add(path)
    const operations = createDefaultAccountStoreOperations()
    expect(operations.legacyPath()).toBe(path)
    if (mode === 'empty') {
      phase('store.initialize.start')
      const outcome = await operations.initialize(path)
      phase('store.initialize.end')
      expect(outcome.status).toBe('completed')
    } else {
      phase('store.seed.start')
      await seedAccounts(FIXED_NOW)
      phase('store.seed.end')
      if (mode !== 'legacy') {
        phase('store.migration.start')
        const outcome = await operations.migrate(path)
        phase('store.migration.end')
        expect(outcome.status).toBe('completed')
      }
    }
    // Bind the harness observer after the same startup move the plugin uses;
    // an already-bound repository intentionally never changes generations.
    await prepareVaultFolder({ accountFile: path })
    const servingPath = getStoragePath()
    phase('store.modules.start')
    const modules = await loadCommonAuthStoreModules()
    phase('store.modules.end')
    phase('repository.binding.start')
    const binding = await readAccountStoreBinding(
      servingPath,
      modules,
      Date.now,
    )
    phase('repository.binding.end')
    if (mode !== 'legacy') expect(binding.status).toBe('bound')
    repository = createAccountRepositoryFactory(modules)({
      paths:
        binding.status === 'bound'
          ? binding.paths
          : resolveAccountStorePaths(servingPath),
      now: Date.now,
      // Prepare persistent bearers without using the model-response queue.
      exchange: async ({ refreshToken }) => {
        expect(['refresh-a', 'refresh-b']).toContain(refreshToken)
        return {
          accessToken: refreshToken === 'refresh-a' ? 'access-a' : 'access-b',
          refreshToken,
          expiresAt:
            Date.now() +
            (mode === 'expired-a' && refreshToken === 'refresh-a'
              ? -60_000
              : 3_600_000),
        }
      },
    })
    if (mode !== 'legacy') {
      phase('repository.read.start')
      const state = await repository.read()
      phase('repository.read.end')
      expect(state.status).toBe('ready')
      if (state.status !== 'ready')
        throw new Error('expected initialized store')
      expect(state.rows).toHaveLength(mode === 'empty' ? 0 : 2)
      phase('repository.bearer-preparation.start')
      for (const row of state.rows) {
        expect(row.usable).toBe(true)
        expect(row.stamp).toBe('bound')
        expect((await repository.refresh(row.ref)).status).toBe('rotated')
      }
      phase('repository.bearer-preparation.end')
      const prepared = await repository.read()
      if (prepared.status !== 'ready')
        throw new Error('expected prepared store')
      expect(prepared.rows.map((row) => row.credential?.accessToken)).toEqual(
        mode === 'empty' ? [] : ['access-a', 'access-b'],
      )
      if (mode === 'expired-a')
        expect(prepared.rows[0]?.credential?.expiresAt).toBeLessThan(Date.now())
      if (mode !== 'empty') {
        expect(
          prepared.rows.map((row) => ({
            credential: row.credential?.refreshToken,
            metadata: row.metadata,
          })),
        ).toMatchObject([
          {
            credential: 'refresh-a',
            metadata: {
              status: 'present',
              metadata: {
                email: 'a@example.test',
                projectId: 'project-a',
                managedProjectId: 'managed-a',
                addedAt: FIXED_NOW - 20_000,
                lastUsed: FIXED_NOW - 10_000,
              },
            },
          },
          {
            credential: 'refresh-b',
            metadata: {
              status: 'present',
              metadata: {
                email: 'b@example.test',
                projectId: 'project-b',
                managedProjectId: 'managed-b',
                addedAt: FIXED_NOW - 19_000,
                lastUsed: FIXED_NOW - 9_000,
              },
            },
          },
        ])
      }
    }
    phase('mock-harness.start')
    harness = await createE2eHarness('plugin-flow')
    phase('mock-harness.end')
    expect(harness.server.requests).toHaveLength(0)
    // Repository token exchange and quota use global fetch, whereas model sends
    // use the plugin's injected transport. Only account API calls consult the
    // harness router; updater calls retain the preload's network denial and
    // cannot consume the fixtures queued for token, model, or quota responses.
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        if (url.pathname === '/v1internal:retrieveUserQuotaSummary')
          phase('quota.request.observed')
        const accountApi =
          url.pathname === '/token' || url.pathname.startsWith('/v1internal:')
        return (
          (accountApi ? await runFetchRouter(input, init) : undefined) ??
          previousFetch(input, init)
        )
      },
      previousFetch,
    )
    phase('router.installed')
    phase('test.callback.start')
    await fn(harness, repository)
    phase('test.callback.end')
  } finally {
    try {
      phase('harness.disposal.start')
      await harness?.dispose()
      phase('harness.disposal.end')
    } finally {
      harness = undefined
      try {
        phase('repository.disposal.start')
        await repository?.dispose()
        phase('repository.disposal.end')
      } finally {
        globalThis.fetch = previousFetch
        if (previousConfigDir === undefined)
          delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
        rmSync(configDir, { recursive: true, force: true })
        phase('profile.cleanup.end')
      }
    }
  }
}

function modelRequests(h: E2eHarness) {
  return h.server.requests.filter((request) =>
    /\/v1internal:(?:streamGenerateContent|generateContent)/.test(request.path),
  )
}

function readSidebar(): SidebarStateV1 {
  const path = process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
  if (!path) throw new Error('sidebar path missing')
  return JSON.parse(readFileSync(path, 'utf8')) as SidebarStateV1
}

function enqueueQuota(h: E2eHarness): void {
  for (const [project, bearer, remainingFraction] of [
    ['managed-a', 'Bearer access-a', 0.7],
    ['managed-b', 'Bearer access-b', 0.8],
  ] as const) {
    h.server.enqueue({
      kind: 'quotaSummaryWindow',
      match: {
        method: 'POST',
        endpoint: '/v1internal:retrieveUserQuotaSummary',
        bearer,
      },
      managedProjectId: project,
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Gemini',
              window: 'weekly',
              resetTime: new Date(Date.now() + 3_600_000).toISOString(),
              remainingFraction,
            },
          ],
        },
      ],
    })
  }
}

describe('plugin flow (e2e)', () => {
  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('returns a 401 envelope when no accounts are configured', async () => {
    await withHarness(async (h) => {
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
        emptyProvider(),
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
    }, 'empty')
  })

  it('refuses an unmigrated legacy pool with 412, unchanged bytes, and zero network', async () => {
    await withHarness(async (h, repository) => {
      const path = getStoragePath()
      const original = readFileSync(path)
      expect((await repository.read()).status).toBe('pending-migration')
      const plugin = await h.createPlugin()
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        emptyProvider(),
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected refusal fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        { method: 'POST', body: '{}' },
      )
      expect(response.status).toBe(412)
      const body = (await response.json()) as {
        error: { code: number; status: string }
      }
      expect(body.error.code).toBe(412)
      expect(body.error.status).toBe('FAILED_PRECONDITION')
      await plugin.dispose()
      expect(readFileSync(path)).toEqual(original)
      expect(h.server.requests).toHaveLength(0)
    }, 'legacy')
  })

  it('loads account, intercepts fetch, transforms, and streams the SSE response', async () => {
    await withHarness(async (h) => {
      // Stored project IDs and access tokens avoid discovery or OAuth requests,
      // so the queued response belongs to the model request below.
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
        emptyProvider(),
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
      expect(modelRequests(h)).toHaveLength(1)
      expect(modelRequests(h)[0]?.headers.authorization).toBe('Bearer access-a')
      expect(JSON.parse(modelRequests(h)[0]?.body ?? '{}').project).toBe(
        'managed-a',
      )
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

      // Enable rate-limit switching so recovery must use another account,
      // rather than succeeding through the harness's same-account retry.
      const plugin = await h.createPlugin({
        configOverrides: { switch_on_first_rate_limit: true },
      })
      const loader = await plugin.auth.loader(
        async () => ({
          type: 'oauth' as const,
          refresh: 'refresh-a|project-a|managed-a',
          access: 'access-a',
          expires: Date.now() + 3_600_000,
        }),
        emptyProvider(),
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
      const attempts = modelRequests(h)
      expect(attempts).toHaveLength(2)
      expect(attempts.map((request) => request.headers.authorization)).toEqual([
        'Bearer access-a',
        'Bearer access-b',
      ])
      expect(
        attempts.map((request) => JSON.parse(request.body).project),
      ).toEqual(['managed-a', 'managed-b'])
    })
  })

  it('returns a structured 401 when refreshed auth is still rejected', async () => {
    await withHarness(async (h, repository) => {
      h.server.enqueue({
        kind: 'json',
        body: {
          access_token: 'access-a-refreshed',
          refresh_token: 'refresh-a2',
          expires_in: 3600,
        },
      })
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
        emptyProvider(),
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
      const body = (await response.json()) as {
        error: { code: number; status: string }
      }
      expect(
        h.server.requests.map((request) => ({
          path: request.path,
          bearer: request.headers.authorization,
        })),
      ).toEqual([
        { path: '/token', bearer: undefined },
        {
          path: '/v1internal:streamGenerateContent?alt=sse',
          bearer: 'Bearer access-a-refreshed',
        },
      ])
      expect(response.status).toBe(401)
      expect(h.server.requests.length).toBeGreaterThanOrEqual(1)
      expect(body.error.code).toBe(401)
      expect(body.error.status).toBe('UNAUTHENTICATED')
      expect(response.headers.get('X-Antigravity-Error-Type')).toBeNull()
      const refreshRequests = h.server.requests.filter(
        (request) => request.path === '/token',
      )
      expect(refreshRequests).toHaveLength(1)
      expect(refreshRequests[0]?.method).toBe('POST')
      const form = new URLSearchParams(refreshRequests[0]?.body)
      expect(form.get('grant_type')).toBe('refresh_token')
      expect(form.get('refresh_token')).toBe('refresh-a')
      expect(modelRequests(h)).toHaveLength(1)
      expect(modelRequests(h)[0]?.headers.authorization).toBe(
        'Bearer access-a-refreshed',
      )
      expect(JSON.parse(modelRequests(h)[0]?.body ?? '{}').project).toBe(
        'managed-a',
      )
      const persisted = await repository.read()
      if (persisted.status !== 'ready')
        throw new Error('expected refreshed store')
      expect(persisted.rows[0]?.credential).toMatchObject({
        refreshToken: 'refresh-a2',
        accessToken: 'access-a-refreshed',
      })
      expect(persisted.rows[1]?.credential?.refreshToken).toBe('refresh-b')
    }, 'expired-a')
  })

  it('retries the same endpoint on a 503 capacity error', async () => {
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
        emptyProvider(),
      )
      const fetchHook = (loader as { fetch?: typeof fetch }).fetch
      if (!fetchHook) throw new Error('expected fetch hook')
      const response = await fetchHook(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
        { method: 'POST', body: '{}' },
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('recovered')
      expect(modelRequests(h)).toHaveLength(2)
      expect(h.transportRequests).toEqual([
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      ])
      expect(
        modelRequests(h).map((request) => request.headers.authorization),
      ).toEqual(['Bearer access-a', 'Bearer access-a'])
      expect(
        modelRequests(h).map((request) => JSON.parse(request.body).project),
      ).toEqual(['managed-a', 'managed-a'])
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
        emptyProvider(),
      )

      // The loader awaits sidebar publication before returning.
      const parsed = readSidebar()
      phase('sidebar.observable.read')
      expect(parsed.accounts?.length).toBeGreaterThanOrEqual(1)
      expect(parsed.accounts.map(({ id, label }) => ({ id, label }))).toEqual([
        { id: 'acct-0', label: 'Account 1' },
        { id: 'acct-1', label: 'Account 2' },
      ])
      expect(h.server.requests).toHaveLength(0)
    })
  })

  it('V3 poller: background_quota_refresh=true exercises the default-on path and refreshes idle accounts', async () => {
    // Background quota refresh is enabled by default in production, but the
    // harness disables it to keep other cases free of unsolicited requests.
    // Re-enable it here to exercise the poller through the real factory:
    //   - plugin boots with background_quota_refresh:true
    //   - accounts are loaded from this case's migrated store
    //   - the poller fires (stale freshness gate) and calls the mock server
    //   - the sidebar state file is updated with non-empty quota
    await withHarness(async (h, repository) => {
      const sidebarPath = process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
      if (!sidebarPath) throw new Error('sidebar path missing')

      let release!: () => void
      const ready = new Promise<void>((resolve) => {
        release = resolve
      })
      let finished!: () => void
      let failed!: (error: unknown) => void
      const tick = new Promise<void>((resolve, reject) => {
        finished = resolve
        failed = reject
      })
      // Hold the first tick before it reads freshness. The loader, stale
      // snapshot and response queue must all be ready before quota work starts.
      const plugin = await h.createPlugin({
        configOverrides: {
          background_quota_refresh: true,
          background_quota_refresh_interval_minutes: 1,
        },
        extraDependencies: {
          clock: { random: () => 0 },
        },
        onPollerCreated(poller) {
          const instance = poller as unknown as { runTick(): Promise<void> }
          const run = instance.runTick.bind(poller)
          let first = true
          instance.runTick = async () => {
            if (!first) return run()
            first = false
            await ready
            try {
              await run()
              finished()
            } catch (error) {
              failed(error)
              throw error
            }
          }
        },
      })

      let pollBefore = 0
      try {
        // Warm up the auth loader so the AccountManager is populated.
        // The loader also writes a fresh checkedAt to the sidebar.
        await plugin.auth.loader(
          async () => ({
            type: 'oauth' as const,
            refresh: 'refresh-a|project-a|managed-a',
            access: 'access-a',
            expires: Date.now() + 3_600_000,
          }),
          emptyProvider(),
        )

        // Loader publication is complete. Overwrite its freshness to let the
        // held first tick refresh immediately. Bypass the normal sidebar
        // merge logic (which rejects stale writes) — write directly to disk.
        writeFileSync(
          sidebarPath,
          JSON.stringify({
            version: 1,
            checkedAt: Date.now() - 60_000,
            accounts: [],
            activeRouting: {},
            routingAuthoritative: false,
          }),
        )
        enqueueQuota(h)
        phase('quota.queue.ready')

        // Capture pollBefore AFTER the stale write. Now the ONLY write that
        // can advance checkedAt past this point is the poller's first tick.
        pollBefore = Date.now()
      } finally {
        release()
      }
      phase('quota.observable.await')
      await tick
      const sidebarCheckedAt = readSidebar().checkedAt ?? 0
      phase('quota.observable.ready')

      await plugin.dispose()

      // The poller must have fired, passed the freshness gate on the stale
      // sidebar, and written a fresh checkedAt. This assertion can ONLY be
      // satisfied by the poller — not by the auth loader (which ran before
      // pollBefore and wrote the now-overwritten stale checkedAt).
      expect(sidebarCheckedAt).toBeGreaterThanOrEqual(pollBefore)
      expect(modelRequests(h)).toHaveLength(0)
      expect(
        h.server.requests
          .map((request) => ({
            method: request.method,
            path: request.path,
            bearer: request.headers.authorization,
            project: JSON.parse(request.body).project,
          }))
          .sort((a, b) =>
            `${a.bearer}:${a.path}`.localeCompare(`${b.bearer}:${b.path}`),
          ),
      ).toEqual([
        {
          method: 'POST',
          path: '/v1internal:retrieveUserQuotaSummary',
          bearer: 'Bearer access-a',
          project: 'managed-a',
        },
        {
          method: 'POST',
          path: '/v1internal:retrieveUserQuotaSummary',
          bearer: 'Bearer access-b',
          project: 'managed-b',
        },
      ])
      const quotaRequests = h.server.requests.filter((request) =>
        request.path.includes('/v1internal:retrieveUserQuotaSummary'),
      )
      expect(quotaRequests).toHaveLength(2)
      expect(
        quotaRequests
          .map((request) => ({
            bearer: request.headers.authorization,
            project: JSON.parse(request.body).project,
          }))
          .sort((a, b) => (a.bearer ?? '').localeCompare(b.bearer ?? '')),
      ).toEqual([
        { bearer: 'Bearer access-a', project: 'managed-a' },
        { bearer: 'Bearer access-b', project: 'managed-b' },
      ])
      const sidebar = readSidebar()

      expect(
        sidebar.accounts.map((account) => ({
          id: account.id,
          remaining: account.quota.gemini?.remainingPercent,
        })),
      ).toEqual([
        { id: 'acct-0', remaining: 70 },
        { id: 'acct-1', remaining: 80 },
      ])
      const persisted = await repository.read()
      if (persisted.status !== 'ready') throw new Error('expected quota store')
      expect(persisted.rows.map((row) => row.quota.status)).toEqual([
        'present',
        'present',
      ])
      expect(
        persisted.rows.map((row) =>
          row.quota.status === 'present'
            ? row.quota.quota.cachedQuota?.gemini?.remainingFraction
            : undefined,
        ),
      ).toEqual([0.7, 0.8])
      for (const row of persisted.rows) {
        if (row.quota.status !== 'present')
          throw new Error('expected persisted quota')
        expect(row.quota.quota.cachedQuotaUpdatedAt).toBeGreaterThanOrEqual(
          pollBefore,
        )
      }
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
    await withHarness(async (h, repository) => {
      const fakeSuccess = {
        type: 'success' as const,
        refresh: 'refresh-c|project-c|managed-c',
        access: 'access-c',
        expires: Date.now() + 3_600_000,
        email: 'c@example.test',
        projectId: 'project-c',
        managedProjectId: 'managed-c',
      }
      const state = 'owned-cli-state'
      const authorize = mock(async () => ({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        verifier: 'verifier',
        projectId: 'project-c',
      }))
      const exchange = mock(async () => fakeSuccess)
      const startListener = mock(async () => {
        throw new Error('headless CLI must not open a listener')
      })
      const promptAddAnotherAccount = mock(async () => false)
      const realCreate = oauthMethodsModule.createOAuthMethods
      // Preserve the real factory and persistence adapter; only OAuth/UI inputs
      // are replaced because the plugin's dependency bag does not forward them.
      const bridge = spyOn(
        oauthMethodsModule,
        'createOAuthMethods',
      ).mockImplementation((options) =>
        realCreate({
          ...options,
          dependencies: {
            ...options.dependencies,
            authorize,
            exchange,
            startListener,
            promptLoginMode: async () => ({ mode: 'fresh' }),
            promptProjectId: async () => 'project-c',
            promptCallback: async () =>
              `http://localhost/oauth-callback?code=code-c&state=${state}`,
            promptAddAnotherAccount,
            openBrowser: async () => false,
            shouldSkipLocalServer: () => true,
            isHeadless: () => true,
          },
        }),
      )
      const plugin = await h.createPlugin().finally(() => bridge.mockRestore())
      const methods = plugin.auth.methods
      expect(methods.length).toBeGreaterThanOrEqual(1)
      const oauth = methods[0]
      expect(oauth?.label).toContain('Antigravity')
      if (oauth?.type !== 'oauth') throw new Error('expected OAuth method')
      const authorization = await oauth.authorize({ noBrowser: 'true' })
      expect(authorization.method).toBe('auto')
      if (authorization.method !== 'auto')
        throw new Error('expected CLI result')
      expect(authorization.instructions).toBe(
        'Multi-account setup complete (1 account(s)).',
      )
      expect(await authorization.callback()).toEqual(fakeSuccess)
      expect(authorize).toHaveBeenCalledWith('project-c')
      expect(exchange).toHaveBeenCalledTimes(1)
      expect(exchange).toHaveBeenCalledWith('code-c', state)
      expect(promptAddAnotherAccount).toHaveBeenCalledWith(1)
      expect(startListener).not.toHaveBeenCalled()
      expect(h.server.requests).toHaveLength(0)
      const storage = await repository.read()
      const path = getStoragePath()
      expect(path).toBeTruthy()
      expect(storage.status).toBe('ready')
      if (storage.status !== 'ready') throw new Error('expected login storage')
      expect(
        storage.rows.some(
          (row) =>
            row.metadata.status === 'present' &&
            row.metadata.metadata.email === 'c@example.test',
        ),
      ).toBe(true)
      expect(storage.rows).toHaveLength(1)
      expect(storage.rows[0]?.credential?.refreshToken).toBe('refresh-c')
      expect(storage.rows[0]?.metadata).toMatchObject({
        status: 'present',
        metadata: { projectId: 'project-c', managedProjectId: 'managed-c' },
      })
    })
  })
})
