/**
 * Per-test E2E harness.
 *
 * Builds an isolated harness for a single test scenario:
 *   1. Reads the per-test temp root the preload installed.
 *   2. Composes a `PluginDependencyOverrides` bag that points the
 *      production plugin at the mock Antigravity server bound to
 *      `127.0.0.1`.
 *   3. Hands the harness back to the test as a record with helpers for
 *      `createPlugin()`, `runCli()`, and teardown.
 *
 * The harness is the ONLY seam the e2e flows use to talk to the plugin
 * under test. Keeping the seam narrow makes it easy to assert "no live
 * network calls" by relying on the preload's deny-list — any path that
 * tries to reach beyond 127.0.0.1 trips `LiveNetworkDeniedError`.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { PluginDependencyOverrides } from '../../opencode/src/plugin/dependencies'
import {
  createAntigravityPlugin,
  type PluginResult,
} from '../../opencode/src/plugin/index'
import { installFetchRouter } from './fetch-router'
import type { MockServerHandle } from './mock-antigravity-server'
import { startMockAntigravityServer } from './mock-antigravity-server'

export interface E2eHarness {
  /** Per-test temp root. Tests may write fixture files here. */
  testRoot: string
  /** Mock server handle — bound, ready, no fixtures queued. */
  server: MockServerHandle
  /** Base URL the plugin should target for Antigravity requests. */
  antigravityBaseUrl: string
  /** Build a fresh plugin instance scoped to the harness. */
  createPlugin(options?: {
    clientOverrides?: Record<string, unknown>
    extraDependencies?: Partial<PluginDependencyOverrides>
  }): Promise<PluginResult>
  /** Tear down all built plugins + the mock server + temp dirs. */
  dispose(): Promise<void>
}

export interface CreateE2eHarnessOptions {
  /** Optional base name used to namespace the test directory. */
  name?: string
  /** Pre-built mock server (advanced — usually omitted). */
  server?: MockServerHandle
}

const HARNESS_INSTANCES: E2eHarness[] = []

/**
 * Build a harness for one test. The harness owns its mock server and
 * any plugins created through it. Tests must call `dispose()` in a
 * `finally` to release the temp dir even on assertion failure.
 */
export async function createE2eHarness(
  testName: string,
  options: CreateE2eHarnessOptions = {},
): Promise<E2eHarness> {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) {
    throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  }
  const testRoot = join(root, options.name ?? testName)
  mkdirSync(testRoot, { recursive: true })

  const server = options.server ?? (await startMockAntigravityServer())

  // Install a fetch router so any globalThis.fetch call made BEFORE
  // the plugin's fetch-interceptor is wired up (e.g. the
  // `initAntigravityVersion` auto-updater call) is routed through the
  // mock server instead of leaking to the live network. Tests assert
  // on the mock server's `requests` array to confirm.
  //
  // We capture Bun's native fetch here (Bun's `globalThis.fetch` is
  // always the unwrapped host fetch — the e2e preload no longer
  // installs a wrapper). The router calls this captured host fetch
  // directly for rewritten URLs, which is the only way to safely
  // redirect production endpoints without recursing.
  installFetchRouter(createFetchRouter(server.baseUrl), globalThis.fetch)

  const plugins: PluginResult[] = []

  const harness: E2eHarness = {
    testRoot,
    server,
    antigravityBaseUrl: server.baseUrl,
    async createPlugin(pluginOptions = {}) {
      const directory = join(testRoot, `plugin-${plugins.length}`)
      mkdirSync(directory, { recursive: true })
      // Write a project-level config that disables background quota
      // refresh + auto-update so the plugin doesn't fire network calls
      // outside the fetch-interceptor we control.
      await Bun.write(
        `${directory}/.opencode/antigravity.json`,
        JSON.stringify({
          quiet_mode: true,
          session_recovery: false,
          proactive_token_refresh: false,
          cache_warmup_on_switch: false,
          account_selection_strategy: 'sticky',
          scheduling_mode: 'balance',
          switch_on_first_rate_limit: false,
          switch_account_delay_ms: 100,
          max_account_switches: 1,
          soft_quota_threshold_percent: 100,
          quota_refresh_interval_minutes: 0,
          proactive_rotation_threshold_percent: 0,
          auto_update: false,
        }),
      )
      const client = createFakeClient(pluginOptions.clientOverrides)
      const dependencies: PluginDependencyOverrides = {
        // Point the production fetchImpl at the mock server, not at
        // `globalThis.fetch` (which the preload has already wrapped to
        // deny non-loopback). The fetchImpl wrapper inspects the URL
        // host and rewrites Antigravity targets to the mock.
        fetchImpl: createLoopbackFetchImpl(server.baseUrl),
        agyTransport: createAgyTransportMock(server.baseUrl),
        filesystemRoots: {
          projectRoot: directory,
          userConfigRoot: join(testRoot, 'opencode-config'),
          sidebarStateRoot: join(testRoot, 'sidebar'),
          rpcRoot: join(testRoot, 'rpc'),
        },
        ...(pluginOptions.extraDependencies ?? {}),
      }
      const factory = createAntigravityPlugin('google', { dependencies })
      const result = await factory({
        client: client as unknown as Parameters<typeof factory>[0]['client'],
        directory,
      } as Parameters<typeof factory>[0])
      plugins.push(result)
      return result
    },
    async dispose() {
      for (const plugin of plugins) {
        try {
          await plugin.dispose()
        } catch {
          /* plugin already torn down — best-effort */
        }
      }
      plugins.length = 0
      if (!options.server) {
        await server.close()
      }
      try {
        rmSync(testRoot, { recursive: true, force: true })
      } catch {
        /* harness root may have been removed by the preload */
      }
      const idx = HARNESS_INSTANCES.indexOf(harness)
      if (idx >= 0) HARNESS_INSTANCES.splice(idx, 1)
    },
  }

  HARNESS_INSTANCES.push(harness)
  return harness
}

/**
 * Tear down every harness created during the current test run. Used
 * by the preload's afterAll sweep to guarantee no harness leaks.
 */
export async function disposeAllHarnesses(): Promise<void> {
  while (HARNESS_INSTANCES.length > 0) {
    const harness = HARNESS_INSTANCES.pop()
    if (harness) await harness.dispose()
  }
}

/**
 * Dispose only harnesses below one preload-owned root. Multiple e2e files
 * share a Bun process, so disposing all instances can close a sibling's server.
 */
export async function disposeE2eHarnessesInRoot(root: string): Promise<void> {
  for (const harness of [...HARNESS_INSTANCES]) {
    const pathFromRoot = relative(root, harness.testRoot)
    if (
      pathFromRoot.length === 0 ||
      pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      continue
    }
    await harness.dispose()
  }
}

function createFakeClient(overrides: Record<string, unknown> = {}) {
  // Minimal PluginClient shape — the e2e flows override the auth
  // method they exercise. Any field the plugin calls must return a
  // resolved promise; we use `async () => ({})` for all of them.
  const passthrough = async () => ({})
  return {
    app: { log: passthrough },
    auth: {
      set: async (input: unknown) => {
        // Persist the auth payload into the harness root so tests can
        // assert on it after the fact. The shape mirrors what the
        // production plugin hands us.
        const payload = JSON.stringify(input, null, 2)
        try {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(
            join(process.env.ANTIGRAVITY_TEST_ROOT ?? '.', 'auth-set.log'),
            `${payload}\n`,
            { flag: 'a' },
          )
        } catch {
          /* best effort */
        }
      },
    },
    session: {
      messages: passthrough,
      prompt: passthrough,
      updateMessage: passthrough,
    },
    tui: {
      showToast: passthrough,
    },
    ...overrides,
  }
}

/**
 * Hosts the harness rewrites onto the mock server. Keeps the global
 * fetch wrapper's deny-list from tripping on production endpoints the
 * plugin legitimately calls during a session (Antigravity API, OAuth
 * refresh, auto-updater, etc.).
 *
 * Kept in sync with `core/constants.ts` and `core/version.ts`.
 */
const REWRITE_HOSTS = new Set([
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.sandbox.googleapis.com',
  'generativelanguage.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  'antigravity-auto-updater-974169037036.us-central1.run.app',
  'antigravity.google',
])

/**
 * Build the `globalThis.fetch` router the preload installs. The router
 * matches any URL whose host is in the rewrite set and forwards it to
 * the mock server; loopback URLs pass through unchanged so the
 * preload's deny guard handles them.
 */
function createFetchRouter(mockBaseUrl: string) {
  return async function fetchRouter(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    hostFetch: typeof globalThis.fetch,
  ): Promise<Response | undefined> {
    const url = typeof input === 'string' ? input : input.toString()
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (!REWRITE_HOSTS.has(parsed.hostname)) return undefined
    const rewritten = `${mockBaseUrl}${parsed.pathname}${parsed.search}`
    return await hostFetch(rewritten, init)
  }
}

/**
 * Build the `fetchImpl` passed through `PluginDependencyOverrides`.
 * Same rewrite set as the router above, but scoped to the plugin's
 * own fetch calls (the harness-installed router handles every other
 * global fetch). Both layers share `REWRITE_HOSTS` so a regression
 * that adds a new production host without updating the harness
 * surfaces as a denied fetch at teardown.
 */
function createLoopbackFetchImpl(mockBaseUrl: string) {
  return async function fetchImpl(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString()
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    if (parsed && REWRITE_HOSTS.has(parsed.hostname)) {
      const rewritten = `${mockBaseUrl}${parsed.pathname}${parsed.search}`
      return await globalThis.fetch(rewritten, init)
    }
    // For everything else (loopback RPC, OAuth callback, etc.), pass
    // through to the global fetch (which the preload has already
    // wrapped to enforce the loopback allow-list).
    return await globalThis.fetch(input, init)
  }
}

/**
 * Build an `agyTransport` that maps the production HTTPS URLs the
 * interceptor would target onto the mock HTTP server. We drop the
 * transport-only options (idleTimeoutMs, onDebug) — the e2e harness
 * doesn't care about the long-lived socket semantics the production
 * transport implements.
 */
function createAgyTransportMock(mockBaseUrl: string) {
  return async function agyTransport(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const rewritten = rewriteAntigravityUrl(url, mockBaseUrl)
    return await globalThis.fetch(rewritten, init)
  }
}

function rewriteAntigravityUrl(url: string, mockBaseUrl: string): string {
  try {
    const parsed = new URL(url)
    return `${mockBaseUrl}${parsed.pathname}${parsed.search}`
  } catch {
    // Best-effort: if the URL doesn't parse, return it unchanged so
    // the test surfaces the failure rather than masking it.
    return url
  }
}
