/**
 * OpenCode 1 keeps one vault account pool for the life of the plugin. When the
 * vault source's first roster read never settles, the plugin's
 * `currentVaultPool` must replace that source once the read has stalled past
 * `VAULT_REFRESH_STALL_MS`, and rebuild the pool over the new source. Driven
 * through the real plugin and custody, with a stand-in vault client at the
 * custody's `connect` boundary.
 */
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh'
import { createAntigravityPlugin } from './index'
import { VAULT_REFRESH_STALL_MS } from './shared/vault-request-credentials'
import type { PluginClient, PluginInput } from './types'
import * as custodyModule from './vault-custody'

const TOKEN = 'ab'.repeat(32)
let root: string
const env: Record<string, string | undefined> = {}
const cleanups: Array<() => Promise<unknown> | unknown> = []

beforeEach(() => {
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  root = realpathSync(mkdtempSync(join(temporary, 'vault-stall-')))
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  for (const [key, value] of Object.entries({
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(root, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
  })) {
    env[key] = process.env[key]
    process.env[key] = value
  }
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await Promise.resolve()
      .then(cleanup)
      .catch(() => {})
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

it('rebuilds the vault pool over a new source once its first roster read has stalled', async () => {
  const createCustody = custodyModule.createOpenCodeVaultCustody
  const accountFile = join(root, 'config', 'antigravity-accounts.json')
  // Approve this host, which selects vault mode.
  let approve = false
  const enrollment = createCustody({
    accountFile,
    readHostSlot: async () => undefined,
    reporterSource: 'direct',
    connectionFile: () => join(root, 'vault-connection.json'),
    connectEnrollment: async () =>
      ({
        async enrollPropose() {
          return { requestId: 'request-1' }
        },
        async enrollPoll() {
          return approve
            ? {
                status: 'approved' as const,
                name: custodyModule.OPENCODE_VAULT_ENROLLMENT_NAME,
                token: TOKEN,
                tokenGeneration: 1,
              }
            : { status: 'pending' as const }
        },
        close() {},
      }) as never,
  })
  await enrollment.requestAccess()
  approve = true
  expect((await enrollment.requestAccess()).state).toBe('approved')
  await enrollment.dispose()

  // The first connect never settles until the test ends; later ones answer.
  let connects = 0
  const hung: Array<() => void> = []
  cleanups.push(() => {
    for (const release of hung.splice(0)) release()
  })
  const client = {
    listScoped: async () => ({
      view: 'view-1',
      rows: [
        {
          id: 'credential-a',
          accountId: 'identity-a',
          credentialType: 'oauth',
          createdAtMs: 1,
          state: 'active',
          recordVersion: 1,
          categories: ['antigravity-native'],
          serves: ['google'],
          providerIds: ['google'],
          operations: ['read'],
          refreshAdapter: 'antigravity',
        },
      ],
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async () => ({
      material: 'vault-bearer',
      credentialId: 'credential-a',
      accountId: 'identity-a',
      recordVersion: 1,
      projectId: 'vault-project',
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close() {},
  }
  let skew = 0
  const custodySpy = spyOn(
    custodyModule,
    'createOpenCodeVaultCustody',
  ).mockImplementation((options) =>
    createCustody({
      ...options,
      connect: () => {
        connects++
        if (connects === 1)
          return new Promise<never>((resolve) => {
            hung.push(() => resolve(client as never))
          })
        return Promise.resolve(client as never)
      },
      now: () => Date.now() + skew,
    }),
  )
  cleanups.push(() => custodySpy.mockRestore())

  mkdirSync(join(root, '.opencode'))
  writeFileSync(
    join(root, '.opencode', 'antigravity.json'),
    JSON.stringify({
      background_quota_refresh: true,
      proactive_token_refresh: false,
      auto_update: false,
    }),
  )
  let fetched = 0
  const fetchImpl = (async () => {
    fetched++
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.33,
              resetTime: '2099-01-01T00:00:00Z',
            },
          ],
        },
      ],
    })
  }) as unknown as typeof fetch
  const client2 = {
    app: { log: async () => {} },
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
  } as unknown as PluginClient
  let poller: BackgroundVaultQuotaRefresh | undefined
  const plugin = await createAntigravityPlugin('google', {
    // The first background tick would come 29.7 s after start; the test
    // runs each tick itself.
    dependencies: { fetchImpl, clock: { now: Date.now, random: () => 0.99 } },
    _onVaultPollerCreated: (created) => {
      poller = created
    },
  })({ client: client2, directory: root } as PluginInput)
  cleanups.push(() => plugin.dispose?.())
  if (!poller) throw new Error('vault producer not composed')

  // The pool's first roster read waits on the hung connect and gives up.
  await poller.tick()
  expect(connects).toBe(1)
  expect(fetched).toBe(0)

  // Past the stall bound the next tick replaces the source, connects again
  // and records the account's quota.
  skew = VAULT_REFRESH_STALL_MS
  await poller.tick()
  expect(connects).toBe(2)
  expect(fetched).toBe(1)
}, 20_000)
