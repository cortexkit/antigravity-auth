/**
 * RPC / TUI flow E2E test.
 *
 * Boots a real plugin over a genuine account store, then drives its RPC
 * server the way the OpenCode 1 TUI does. The plugin writes a
 * `port-<pid>.json` file inside the harness's `ANTIGRAVITY_AUTH_RPC_DIR`;
 * the test reads it via `discoverPortFile` and talks to `/rpc/apply` and
 * `/rpc/pending-notifications`.
 *
 * Accounts are seeded through the pre-store account-file writer and moved
 * into the account store by the genuine offline migration, so the plugin's
 * `/antigravity` menu is built over real store rows.
 *
 * Assertions cover:
 *   - Port file publication under the harness root.
 *   - Bearer-token authorization required for both routes, and the
 *     retired per-command apply shape refused even with the token.
 *   - `/antigravity` queues the Antigravity menu for the requesting session
 *     only, and its payload passes the menu payload contract.
 *   - The Quota section's own check action runs through `apply` and answers
 *     with a contract-valid menu result.
 *   - The Routing section's own set action persists the new settings, and
 *     the refreshed menu shows them.
 *   - Notification drain returns what `pushNotification` queued, scoped by
 *     session and acknowledged by cursor.
 *
 * Payloads and results are checked with the GA protocol's validators for
 * the same `@cortexkit/common-auth/commands` shapes. The TUI render path is
 * NOT exercised: `apply` is the seam the TUI hits over RPC, and running the
 * `solid-js` tree needs a terminal the harness cannot provide.
 */

import './setup'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDefaultAccountStoreOperations } from '../../opencode/src/cli'
import {
  AntigravityApplyResultSchema,
  AntigravityNotificationPayloadSchema,
} from '../../opencode/src/ga/rpc/protocol'
import type { PluginResult } from '../../opencode/src/plugin/index'
import { saveAccountsReplace } from '../../opencode/src/plugin/storage'
import { pushNotification } from '../../opencode/src/rpc/notifications'
import { discoverPortFile } from '../../opencode/src/rpc/port-file'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  RpcNotificationPayload,
} from '../../opencode/src/rpc/protocol'
import { createRpcClient } from '../../opencode/src/rpc/rpc-client'
import { createE2eHarness, type E2eHarness } from './harness'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')
const SESSION = 'ses-rpc-1'
const OTHER_SESSION = 'ses-rpc-2'

let harness: E2eHarness | undefined

/**
 * Seeds one account in the pre-store account file, then moves it into the
 * account store with the genuine offline migration.
 */
async function seedStore(): Promise<void> {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  mkdirSync(join(root, 'pi-agent'), { recursive: true })
  await saveAccountsReplace({
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
  const operations = createDefaultAccountStoreOperations()
  const outcome = await operations.migrate(operations.legacyPath())
  expect(outcome.status).toBe('completed')
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

async function portEntry() {
  const rpcDir = process.env.ANTIGRAVITY_AUTH_RPC_DIR
  if (!rpcDir) throw new Error('RPC dir missing')
  const entry = await discoverPortFile(rpcDir, process.pid)
  if (!entry) throw new Error('expected port file entry')
  return { rpcDir, entry }
}

/** Runs `/antigravity` in `sessionID`; the hook stops the host with a sentinel. */
async function runMenuCommand(
  plugin: PluginResult,
  sessionID: string,
): Promise<void> {
  const hook = plugin['command.execute.before']
  if (!hook) throw new Error('plugin has no command.execute.before hook')
  await hook(
    { command: 'antigravity', arguments: '', sessionID },
    { parts: [] },
  ).catch(() => undefined)
}

/** Validates one notification payload against the menu payload contract. */
function checkedPayload(payload: object): RpcNotificationPayload {
  const checked = AntigravityNotificationPayloadSchema.parse(payload)
  if (!checked.ok) {
    throw new Error(
      `notification payload failed the contract: ${JSON.stringify(checked.issues)}`,
    )
  }
  return checked.value
}

function checkedResult(result: object | undefined): CommandApplyResult {
  const checked = AntigravityApplyResultSchema.parse(result)
  if (!checked.ok) {
    throw new Error(
      `apply answer failed the contract: ${JSON.stringify(checked.issues)}`,
    )
  }
  return checked.value
}

/** Opens the menu in `SESSION` and returns the payload the TUI receives. */
async function openMenu(plugin: PluginResult): Promise<CommandDialogPayload> {
  const { rpcDir } = await portEntry()
  await runMenuCommand(plugin, SESSION)
  const received = await createRpcClient(
    rpcDir,
    process.pid,
  ).pendingNotifications(0, SESSION)
  const menus = received
    .map((notification) => checkedPayload(notification.payload))
    .filter((payload): payload is CommandDialogPayload => 'menu' in payload)
  const menu = menus.at(-1)
  if (!menu) {
    throw new Error(
      `/antigravity queued no menu for the session: ${JSON.stringify(received)}`,
    )
  }
  return menu
}

/** The request for one action the menu itself emitted. */
function requestFor(
  payload: CommandDialogPayload,
  slot: string,
  actionId: string,
): Omit<CommandApplyRequest, 'values' | 'confirmed'> {
  const section = payload.menu.sections.find((entry) => entry.slot === slot)
  if (!section) throw new Error(`menu has no ${slot} section`)
  const sectionAction = section.actions.find((entry) => entry.id === actionId)
  if (sectionAction) {
    return { command: payload.command, sectionId: section.id, actionId }
  }
  const item = section.items.find((entry) =>
    entry.actions.some((action) => action.id === actionId),
  )
  if (!item) throw new Error(`${slot} section has no ${actionId} action`)
  return {
    command: payload.command,
    sectionId: section.id,
    itemId: item.id,
    actionId,
  }
}

describe('rpc / tui flow (e2e)', () => {
  beforeEach(async () => {
    await seedStore()
  })

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('publishes a loopback port file, rejects unauthorized requests and the retired apply shape', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const { entry } = await portEntry()
        const menuRequest = {
          command: 'antigravity',
          sectionId: 'quota',
          actionId: 'refresh',
        }
        // Without the bearer token both routes refuse.
        for (const path of ['/rpc/apply', '/rpc/pending-notifications']) {
          const response = await fetch(
            `http://127.0.0.1:${entry.port}${path}`,
            {
              method: 'POST',
              body: JSON.stringify(
                path === '/rpc/apply' ? menuRequest : { lastReceivedId: 0 },
              ),
            },
          )
          expect(response.status).toBe(401)
        }
        // With the token, the retired per-command dialog request is refused
        // by the menu's own request parser before any effect.
        const retired = await fetch(
          `http://127.0.0.1:${entry.port}/rpc/apply`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${entry.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              command: 'antigravity-quota',
              arguments: '',
            }),
          },
        )
        expect(retired.status).toBe(400)
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('opens the Antigravity menu for the requesting session only', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const payload = await openMenu(plugin)
        expect(payload.command).toBe('antigravity')
        const slots = payload.menu.sections.map((section) => section.slot)
        expect(slots.slice(0, 4)).toEqual([
          'accounts',
          'quota',
          'routing',
          'limits',
        ])
        // The store row appears as an ordinal account with its own actions,
        // named by the opaque item id the menu issued for its credential.
        const accounts = payload.menu.sections[0]
        expect(accounts?.items.map((item) => item.label)).toEqual(['Account 1'])
        expect(accounts?.items[0]?.actions.map((action) => action.id)).toEqual([
          'disable',
          'select',
          'remove',
          'limit',
        ])
        // The store row's secrets never reach the payload.
        expect(JSON.stringify(payload)).not.toContain('refresh-rpc')
        // Another session receives nothing from this command.
        const { rpcDir } = await portEntry()
        const other = await createRpcClient(
          rpcDir,
          process.pid,
        ).pendingNotifications(0, OTHER_SESSION)
        expect(
          other.filter((notification) => 'menu' in notification.payload),
        ).toEqual([])
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('applies an account action by its menu item id and refuses an id the menu never issued', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const payload = await openMenu(plugin)
        const { rpcDir } = await portEntry()
        const client = createRpcClient(rpcDir, process.pid)
        const disable = requestFor(payload, 'accounts', 'disable')
        const unknown = checkedResult(
          await client.apply({
            ...disable,
            itemId: 'acct-not-issued-by-this-menu',
            sessionId: SESSION,
          }),
        )
        expect(unknown.ok).toBe(false)
        const disabled = checkedResult(
          await client.apply({ ...disable, sessionId: SESSION }),
        )
        expect(disabled.ok).toBe(true)
        // The refreshed menu shows the same account disabled, offering enable.
        const item = disabled.menu.sections
          .find((s) => s.slot === 'accounts')
          ?.items.find((entry) => entry.id === disable.itemId)
        expect(item?.actions.some((action) => action.id === 'enable')).toBe(
          true,
        )
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('runs the Quota section’s own check action through apply', async () => {
    await withHarness(async (h) => {
      // Quota fixtures the store's quota service reads on a check.
      h.server.enqueue({
        kind: 'projectDiscovery',
        projectId: 'project-rpc',
      })
      // Primary: retrieveUserQuotaSummary (windowed). managedProjectId
      // enforces the real API's 403: the caller must post the managed
      // project id, not the regular project id.
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
        const payload = await openMenu(plugin)
        const { rpcDir } = await portEntry()
        const result = checkedResult(
          await createRpcClient(rpcDir, process.pid).apply({
            ...requestFor(payload, 'quota', 'refresh'),
            sessionId: SESSION,
          }),
        )
        expect(result.command).toBe('antigravity')
        expect(typeof result.text).toBe('string')
        expect(result.menu.sections.some((s) => s.slot === 'quota')).toBe(true)
        expect(JSON.stringify(result)).not.toContain('refresh-rpc')
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('runs the Routing section’s own set action and persists the new settings', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const payload = await openMenu(plugin)
        const { rpcDir } = await portEntry()
        const client = createRpcClient(rpcDir, process.pid)
        const request = {
          ...requestFor(payload, 'routing', 'set'),
          sessionId: SESSION,
          values: { cliFirst: true, quotaStyleFallback: false },
        }
        const result = checkedResult(await client.apply(request))
        expect(result.ok).toBe(true)
        // The refreshed menu, and a menu opened afterwards, show the values.
        for (const menu of [result.menu, (await openMenu(plugin)).menu]) {
          const routing = menu.sections.find((s) => s.slot === 'routing')
          const knobs = routing?.actions.find((a) => a.id === 'set')?.knobs
          expect(
            knobs?.map((knob) =>
              knob.kind === 'toggle' ? [knob.id, knob.value] : [knob.id],
            ),
          ).toEqual([
            ['cliFirst', true],
            ['quotaStyleFallback', false],
          ])
        }
      } finally {
        await plugin.dispose()
      }
    })
  })

  it('drains notifications queued via pushNotification, scoped by session and acknowledged by cursor', async () => {
    await withHarness(async (h) => {
      const plugin = await h.createPlugin()
      try {
        const { entry } = await portEntry()
        pushNotification(
          {
            command: 'antigravity',
            notify: { message: 'hello-from-test', kind: 'info' },
          },
          SESSION,
        )

        const drain = async (lastReceivedId: number, sessionId: string) => {
          const response = await fetch(
            `http://127.0.0.1:${entry.port}/rpc/pending-notifications`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${entry.token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ lastReceivedId, sessionId }),
            },
          )
          expect(response.status).toBe(200)
          const body: unknown = await response.json()
          if (
            typeof body !== 'object' ||
            body === null ||
            !('messages' in body) ||
            !Array.isArray(body.messages)
          ) {
            throw new Error('pending-notifications answered no messages')
          }
          return body.messages.map((message: unknown) => {
            if (
              typeof message !== 'object' ||
              message === null ||
              !('id' in message) ||
              typeof message.id !== 'number' ||
              !('payload' in message) ||
              typeof message.payload !== 'object' ||
              message.payload === null
            ) {
              throw new Error('pending-notifications answered a bad message')
            }
            return { id: message.id, payload: checkedPayload(message.payload) }
          })
        }

        const messages = await drain(0, SESSION)
        const hello = messages.find(
          (message) =>
            'notify' in message.payload &&
            message.payload.notify.message === 'hello-from-test',
        )
        expect(hello).toBeDefined()
        // Another session does not receive it.
        const other = await drain(0, OTHER_SESSION)
        expect(
          other.some(
            (message) =>
              'notify' in message.payload &&
              message.payload.notify.message === 'hello-from-test',
          ),
        ).toBe(false)
        // Acknowledged notifications are not delivered again.
        const after = await drain(hello?.id ?? 0, SESSION)
        expect(after.some((message) => message.id === hello?.id)).toBe(false)
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
