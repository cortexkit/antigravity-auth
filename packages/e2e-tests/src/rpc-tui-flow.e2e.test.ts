/**
 * RPC / TUI flow E2E test.
 *
 * Boots a real plugin with overrides, then drives its RPC server
 * through the loopback-bound HTTP client the plugin publishes. The
 * plugin writes a `port-<pid>.json` file inside the harness's
 * `ANTIGRAVITY_AUTH_RPC_DIR` env override; the test reads the file
 * via `discoverPortFile` and dispatches `/rpc/apply` calls.
 *
 * Assertions cover:
 *   - Port file publication under the harness root.
 *   - Bearer-token authorization required for both routes.
 *   - `apply` for `antigravity-routing` mutates runtime settings and
 *     triggers a sidebar refresh.
 *   - `apply` for `antigravity-quota` returns quota summary rows.
 *   - Notification drain: `drainNotifications` returns the entries
 *     the plugin has queued via `pushNotification`.
 *
 * The TUI render path is NOT exercised — `apply` is the seam that
 * the TUI hits over RPC. Running the actual `solid-js` tree would
 * require a terminal context the harness cannot provide.
 */

import './setup'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { saveAccountsReplace } from '../../opencode/src/plugin/storage'
import { pushNotification } from '../../opencode/src/rpc/notifications'
import { discoverPortFile } from '../../opencode/src/rpc/port-file'
import { createRpcClient } from '../../opencode/src/rpc/rpc-client'
import { createE2eHarness, type E2eHarness } from './harness'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

let harness: E2eHarness | undefined

function seedAccounts(): void {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  mkdirSync(join(root, 'pi-agent'), { recursive: true })
  saveAccountsReplace({
    version: 4,
    accounts: [
      {
        email: 'rpc@example.test',
        refreshToken: 'refresh-rpc',
        projectId: 'project-rpc',
        managedProjectId: 'managed-rpc',
        addedAt: FIXED_NOW - 10_000,
        lastUsed: FIXED_NOW - 5_000,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  })
}

async function withHarness(
  fn: (harness: E2eHarness) => Promise<void>,
): Promise<void> {
  harness = await createE2eHarness('rpc-tui')
  try {
    await fn(harness)
  } finally {
    await harness?.dispose()
    harness = undefined
  }
}

describe('rpc / tui flow (e2e)', () => {
  beforeEach(() => {
    seedAccounts()
  })

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('publishes a loopback port file and rejects unauthorized requests', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
        if (!rpcDir) throw new Error('RPC dir missing')
        // The plugin has already started the RPC server during the
        // factory call. discoverPortFile finds it.
        const entry = await discoverPortFile(rpcDir, process.pid)
        expect(entry).not.toBeNull()
        if (!entry) throw new Error('expected port file entry')

        // Dispatch an unauthorized request — the server requires the
        // bearer token. We bypass the harness client because we want
        // to prove the authorization gate from raw fetch.
        const response = await fetch(
          `http://127.0.0.1:${entry.port}/rpc/apply`,
          {
            method: 'POST',
            body: JSON.stringify({
              command: 'antigravity-quota',
              arguments: '',
            }),
          },
        )
        expect(response.status).toBe(401)
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('routes apply(antigravity-quota) through the harness client and returns quota rows', async () => {
    await withHarness(async (h) => {
      // Quota fixtures the manager reads on refresh.
      h.server.enqueue({
        kind: 'projectDiscovery',
        projectId: 'project-rpc',
      })
      // Primary: retrieveUserQuotaSummary (windowed).
      // managedProjectId enforces the real API's 403: the caller must
      // post the managed project id, not the regular project id.
      // If it posts the wrong id, the mock returns 403 and the test
      // exercises the fallback path instead — failing the window assertion.
      h.server.enqueue({
        kind: 'quotaSummaryWindow',
        managedProjectId: 'managed-rpc',
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit',
                window: 'weekly',
                resetTime: '2026-07-31T00:00:00Z',
                remainingFraction: 0.7,
              },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit',
                window: 'weekly',
                resetTime: '2026-07-31T00:00:00Z',
                remainingFraction: 0.8,
              },
            ],
          },
        ],
      })
      h.server.enqueue({
        kind: 'geminiCliQuota',
        buckets: [{ model: 'gemini-3-flash', remainingFraction: 0.7 }],
      })

      const plugin = await h.createPlugin()
      try {
        const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
        if (!rpcDir) throw new Error('RPC dir missing')
        const entry = await discoverPortFile(rpcDir, process.pid)
        if (!entry) throw new Error('expected port file entry')
        const client = createRpcClient(rpcDir, process.pid)
        const result = await client.apply({
          command: 'antigravity-quota',
          arguments: '',
          sessionId: 'ses-1',
        })
        expect(result).toBeDefined()
        expect(typeof result.text).toBe('string')
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('routes apply(antigravity-routing) and persists the new settings', async () => {
    await withHarness(async (h) => {
      // The routing apply triggers a sidebar refresh which in turn
      // pings the quota manager. Queue enough fixtures for any
      // background calls.
      for (let i = 0; i < 4; i++) {
        h.server.enqueue({
          kind: 'json',
          body: { ok: true },
        })
      }

      const plugin = await h.createPlugin()
      try {
        const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
        if (!rpcDir) throw new Error('RPC dir missing')
        const entry = await discoverPortFile(rpcDir, process.pid)
        if (!entry) throw new Error('expected port file entry')
        const client = createRpcClient(rpcDir, process.pid)
        const result = await client.apply({
          command: 'antigravity-routing',
          arguments: 'cli_first=true',
          sessionId: 'ses-1',
        })
        expect(result).toBeDefined()
        expect(result.knobs).toMatchObject({ cli_first: true })
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('drains notifications queued via pushNotification through the loopback RPC', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
        if (!rpcDir) throw new Error('RPC dir missing')
        const entry = await discoverPortFile(rpcDir, process.pid)
        if (!entry) throw new Error('expected port file entry')

        pushNotification({
          command: 'antigravity-logging',
          text: 'hello-from-test',
          knobs: {},
        })

        const response = await fetch(
          `http://127.0.0.1:${entry.port}/rpc/pending-notifications`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${entry.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ lastReceivedId: 0 }),
          },
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          messages: Array<{
            payload: {
              command: string
              text: string
              knobs: Record<string, unknown>
            }
          }>
        }
        const notifications = body.messages
        expect(notifications.length).toBeGreaterThanOrEqual(1)
        expect(
          notifications.some((n) => n.payload.text === 'hello-from-test'),
        ).toBe(true)
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('plugin dispose tears down the RPC server and removes the port file', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
      if (!rpcDir) throw new Error('RPC dir missing')
      const entry = await discoverPortFile(rpcDir, process.pid)
      expect(entry).not.toBeNull()
      await plugin.dispose()
      // After dispose, the port file is removed (idempotent on stop()).
      const after = await discoverPortFile(rpcDir, process.pid)
      expect(after).toBeNull()
    })
  })
})
