/**
 * OpenCode 2 locations share one vault custody per process and account file
 * (`acquireGaVaultCustody`), with a stall watchdog on its source and one
 * background vault quota producer. Driven through the production host factory
 * (`createGaLocationServicesForHost`) with a stand-in vault client at its
 * `connect` boundary that counts connections, the way `setupGaActivation`
 * opens a location: factory, location runtime, `start`, then the runtime's
 * dispose as the host's cleanup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GaLocationServices, GaRawSender } from '../ga/server/index.ts'
import { __resetProcessHeartbeatForTest } from '../process-heartbeat.ts'
import { __resetRuntimeLayoutRunsForTest } from '../runtime-layout.ts'
import {
  __resetRuntimeLayoutsForTest,
  legacyVaultDir,
  runtimeLayoutLocation,
} from '../runtime-paths.ts'
import {
  __resetVaultFoldersForTest,
  prepareVaultFolder,
} from '../vault-folder.ts'
import type { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh.ts'
import { createGaLocationServicesForHost } from './ga-location-services.ts'
import { acquireGaVaultCustody } from './ga-shared-vault-custody.ts'
import { createOperatorSettingsRegistry } from './operator-settings.ts'
import { createLocationRuntime } from './shared/runtime.ts'
import { VAULT_REFRESH_STALL_MS } from './shared/vault-request-credentials.ts'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
  type OpenCodeVaultCustody,
} from './vault-custody.ts'

const TOKEN = 'ab'.repeat(32)
const ROSTER_UNAVAILABLE = 'The vault roster is not available yet'
let root: string
const env: Record<string, string | undefined> = {}
const cleanups: Array<() => Promise<unknown>> = []
const releases: Array<() => void> = []

beforeEach(() => {
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  root = realpathSync(mkdtempSync(join(temporary, 'ga-shared-vault-')))
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  for (const [key, value] of Object.entries({
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(root, 'state', 'sidebar.json'),
  })) {
    env[key] = process.env[key]
    process.env[key] = value
  }
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {})
  // A connect left pending is released so its client is closed, not leaked.
  for (const release of releases.splice(0)) release()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/** The account file `getStoragePath` resolves under this test's config directory. */
const accountFile = () => join(root, 'config', 'antigravity-accounts.json')

const ACCOUNTS = ['a', 'b'] as const

/**
 * A scoped vault client stand-in serving two accounts. It counts connects
 * and live connections; `hangNext` makes that many next connects wait until
 * the test ends.
 */
function fakeVault() {
  const counts = { connects: 0, opened: 0, closed: 0, lists: 0 }
  const live = new Set<number>()
  let hangNext = 0
  const client = (id: number) => ({
    listScoped: async () => {
      counts.lists++
      return {
        view: 'view-1',
        rows: ACCOUNTS.map((name) => ({
          id: `credential-${name}`,
          accountId: `identity-${name}`,
          credentialType: 'oauth',
          createdAtMs: 1,
          state: 'active',
          recordVersion: 1,
          categories: ['antigravity-native'],
          serves: ['google'],
          providerIds: ['google'],
          operations: ['read'],
          refreshAdapter: 'antigravity',
        })),
        grants: undefined,
        grantTuples: undefined,
      }
    },
    getScoped: async ({ credentialId }: { credentialId: string }) => ({
      material: `bearer-${credentialId}`,
      credentialId,
      accountId: credentialId.replace('credential-', 'identity-'),
      recordVersion: 1,
      projectId: 'vault-project',
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {
      if (live.delete(id)) counts.closed++
    },
  })
  const open = () => {
    const id = ++counts.opened
    live.add(id)
    return client(id)
  }
  return {
    counts,
    live,
    hang(count: number) {
      hangNext = count
    },
    connect: async () => {
      counts.connects++
      if (hangNext > 0) {
        hangNext--
        return new Promise<never>((resolve) => {
          releases.push(() => resolve(open() as never))
        })
      }
      return open() as never
    },
  }
}

/** Approves this host's enrollment, which selects vault mode. */
async function approveHost() {
  let approve = false
  const custody = createOpenCodeVaultCustody({
    // No entry point settled a layout here, so the locations read the
    // vault files beside the account file, as this seeding does.
    vaultDir: legacyVaultDir(accountFile()),
    accountFile: accountFile(),
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
                name: OPENCODE_VAULT_ENROLLMENT_NAME,
                token: TOKEN,
                tokenGeneration: 1,
              }
            : { status: 'pending' as const }
        },
        close() {},
      }) as never,
    connect: async () => {
      throw new Error('enrollment only')
    },
  })
  expect((await custody.requestAccess()).state).toBe('pending')
  approve = true
  expect((await custody.requestAccess()).state).toBe('approved')
  await custody.dispose()
}

/** Counts physical quota requests; each answers one Gemini 5h reading. */
function quotaTransport() {
  const requests: string[] = []
  const transport = async (url: string | URL | Request) => {
    requests.push(String(url))
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
  }
  return { requests, transport }
}

/** The production host factory with the vault client and clocks replaced. */
function hostFactory(
  vault: ReturnType<typeof fakeVault>,
  options: {
    readonly now?: () => number
    readonly quota?: ReturnType<typeof quotaTransport>
    readonly quotaNow?: () => number
    readonly producers?: BackgroundVaultQuotaRefresh[]
  } = {},
) {
  return createGaLocationServicesForHost({
    readHostSlot: async () => undefined,
    connectionFile: () => join(root, 'vault-connection.json'),
    custody: {
      connect: vault.connect,
      pollIntervalMs: 100,
      ...(options.now ? { now: options.now } : {}),
    },
    quota: {
      ...(options.quota ? { transport: options.quota.transport } : {}),
      ...(options.quotaNow ? { now: options.quotaNow } : {}),
      // The first background tick would come 29.7 s after a producer starts;
      // tests run each tick themselves.
      random: () => 0.99,
      onProducer: (producer) => options.producers?.push(producer),
    },
  })
}

const SSE =
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n'
const send: GaRawSender = async () =>
  new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })

/** One location, opened as `setupGaActivation` does; returns its cleanup. */
async function openLocation(
  factory: ReturnType<typeof hostFactory>,
  name: string,
  settings: {
    readonly background_quota_refresh?: boolean
    readonly background_quota_refresh_interval_minutes?: number
  } = {},
  quota?: ReturnType<typeof quotaTransport>,
) {
  const directory = join(root, 'locations', name)
  mkdirSync(join(directory, '.opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, '.opencode', 'antigravity.json'),
    JSON.stringify({
      background_quota_refresh: false,
      proactive_token_refresh: false,
      auto_update: false,
      ...settings,
    }),
  )
  const services: GaLocationServices = await factory({
    directory,
    overrides: {
      send,
      ...(quota ? { quotaFetch: quota.transport } : {}),
    },
  })
  const runtime = await createLocationRuntime(
    {
      ...services.runtime,
      directory,
      operatorSettingsRegistry: createOperatorSettingsRegistry(),
    },
    services,
  )
  const serving = await services.start({
    runtime,
    generation: `test-${name}`,
    send,
    notify: () => null,
    isConnected: () => true,
  })
  let cleanup: Promise<void> | null = null
  const dispose = () => {
    cleanup ??= runtime.dispose()
    return cleanup
  }
  cleanups.push(dispose)
  return { serving, dispose }
}

type Serving = Awaited<ReturnType<typeof openLocation>>['serving']

const JOB = {
  sessionID: 'test-session',
  parentSessionID: null,
  kind: 'generate' as const,
  modelID: 'gemini-3-flash',
  variant: null,
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  }),
}

/** One request's outcome: its HTTP status, or the message it failed with. */
async function request(serving: Serving): Promise<string> {
  return serving
    .execute(JOB, { signal: new AbortController().signal, send })
    .then(
      async (response) => {
        await response.body?.cancel()
        return `status ${response.status}`
      },
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    )
}

const scope = { kind: 'sessionless' } as const

async function quotaRows(serving: Serving) {
  const read = await serving.state.read({
    scope,
    signal: new AbortController().signal,
  })
  if (read.accounts.kind !== 'complete') throw new Error('over limit')
  return read.accounts.rows.map(
    (entry) => entry.row.cachedQuota?.gemini?.remainingFraction,
  )
}

async function checkQuotaNow(serving: Serving) {
  return serving.commands.apply({
    request: {
      command: 'antigravity',
      sectionId: 'quota',
      actionId: 'refresh',
    },
    scope,
    signal: new AbortController().signal,
  })
}

async function waitUntil(condition: () => boolean, what: string, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('stall watchdog on the shared vault source', () => {
  it('recycles a source whose first connect hangs, so the next request reconnects and succeeds', async () => {
    await approveHost()
    const vault = fakeVault()
    vault.hang(1)
    let skew = 0
    const factory = hostFactory(vault, { now: () => Date.now() + skew })
    const location = await openLocation(factory, 'stuck')
    const started = Date.now()
    const first = request(location.serving)
    // The request's roster read has now waited past the stall bound.
    await sleep(200)
    skew = VAULT_REFRESH_STALL_MS
    expect(await first).toContain(ROSTER_UNAVAILABLE)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(await request(location.serving)).toBe('status 200')
    // One connect still hangs; the replacement source connected again.
    expect(vault.counts.connects).toBe(2)
    expect(vault.live.size).toBe(1)
  }, 20_000)

  it('recovers every location sharing a stalled consumer after the watchdog', async () => {
    await approveHost()
    const vault = fakeVault()
    vault.hang(1)
    let skew = 0
    const factory = hostFactory(vault, { now: () => Date.now() + skew })
    const locations = [
      await openLocation(factory, 'one'),
      await openLocation(factory, 'two'),
      await openLocation(factory, 'three'),
    ]
    const first = locations.map((location) => request(location.serving))
    await sleep(200)
    skew = VAULT_REFRESH_STALL_MS
    // Each request fails: at its own 2 s bound, or when the first location's
    // watchdog closes the stalled consumer they all wait on.
    for (const outcome of await Promise.all(first))
      expect(outcome).toMatch(
        /The vault roster is not available yet|Claustrum consumer is closed/,
      )
    for (const location of locations)
      expect(await request(location.serving)).toBe('status 200')
    expect(vault.counts.connects).toBe(2)
    expect(vault.live.size).toBe(1)
  }, 20_000)
})

describe('the shared custody lease', () => {
  it('forwards the approved enrollment name, so the request-path refusal names it', async () => {
    // Only the two members this test reaches are real; the rest are unused.
    const custody = {
      grantPrincipal: () => 'antigravity-auth-opencode-2',
      dispose: async () => {},
    } as Partial<OpenCodeVaultCustody> as OpenCodeVaultCustody
    const lease = acquireGaVaultCustody({
      vaultDir: join(root, 'lease-principal-vault'),
      accountFile: join(root, 'lease-principal-accounts.json'),
      readHostSlot: async () => undefined,
      create: () => custody,
    })
    cleanups.push(() => lease.dispose())
    expect(lease.grantPrincipal?.()).toBe('antigravity-auth-opencode-2')
  })

  // The vault files can live in the state home, away from the account file,
  // so the registry is keyed by the vault folder: locations that resolve the
  // same folder share one custody whatever account path they hold, and a
  // custody that refuses an unsettled folder is never shared with one that
  // serves it.
  it('is keyed by the vault folder, not by the account file', async () => {
    const created: string[] = []
    const acquire = (
      vaultDir: string,
      file: string,
      layoutRefusal?: string,
    ) => {
      const lease = acquireGaVaultCustody({
        vaultDir,
        accountFile: file,
        ...(layoutRefusal ? { layoutRefusal } : {}),
        readHostSlot: async () => undefined,
        create: (input) => {
          created.push(
            `${input.vaultDir}|${input.accountFile}|${input.layoutRefusal ?? ''}`,
          )
          return {
            dispose: async () => {},
          } as Partial<OpenCodeVaultCustody> as OpenCodeVaultCustody
        },
      })
      cleanups.push(() => lease.dispose())
      return lease
    }
    const moved = join(root, 'state', 'opencode', 'antigravity-auth-vault')
    acquire(moved, join(root, 'config', 'antigravity-accounts.json'))
    acquire(moved, join(root, 'other-config', 'antigravity-accounts.json'))
    acquire(
      join(root, 'config', 'antigravity-auth-vault'),
      join(root, 'config', 'antigravity-accounts.json'),
    )
    acquire(
      moved,
      join(root, 'config', 'antigravity-accounts.json'),
      'unsettled',
    )
    expect(created).toEqual([
      `${moved}|${join(root, 'config', 'antigravity-accounts.json')}|`,
      `${join(root, 'config', 'antigravity-auth-vault')}|${join(root, 'config', 'antigravity-accounts.json')}|`,
      `${moved}|${join(root, 'config', 'antigravity-accounts.json')}|unsettled`,
    ])
  })
})

describe('one shared custody per process and account file', () => {
  // `setupGaActivation` settles the vault folder before it builds a
  // location's services; the production factory then binds custody to the
  // folder it settled. A custody still reading the config folder would find
  // only the enrollment state the move left there, with no token, and could
  // not serve.
  it('serves a location from the vault files the activation moved, without enrolling again', async () => {
    const priorStateHome = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = join(root, 'state')
    const moved = join(
      runtimeLayoutLocation().stateHomeDir,
      'antigravity-auth-vault',
    )
    cleanups.push(async () => {
      if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = priorStateHome
      __resetRuntimeLayoutsForTest()
      __resetRuntimeLayoutRunsForTest()
      __resetVaultFoldersForTest()
      __resetProcessHeartbeatForTest()
    })
    await approveHost()
    const folder = await prepareVaultFolder({
      accountFile: accountFile(),
      log: { info() {}, warn() {} },
    })
    expect(folder).toEqual({ accountFile: accountFile(), vaultDir: moved })
    expect(existsSync(join(moved, 'opencode-enrollment.json'))).toBe(true)
    expect(
      existsSync(
        join(legacyVaultDir(accountFile()), 'opencode-enrollment.json'),
      ),
    ).toBe(false)
    const vault = fakeVault()
    const location = await openLocation(hostFactory(vault), 'moved')
    await waitUntil(() => vault.counts.lists >= 1, 'the first roster')
    expect(await request(location.serving)).toBe('status 200')
  }, 20_000)

  it('holds one connection for every open location and closes it with the last', async () => {
    await approveHost()
    const vault = fakeVault()
    const factory = hostFactory(vault)
    const locations = [
      await openLocation(factory, 'one'),
      await openLocation(factory, 'two'),
      await openLocation(factory, 'three'),
    ]
    await waitUntil(() => vault.counts.lists >= 1, 'the first roster')
    for (const location of locations)
      expect(await request(location.serving)).toBe('status 200')
    expect(vault.counts.opened).toBe(1)
    expect(vault.live.size).toBe(1)
    await locations[0]?.dispose()
    await locations[1]?.dispose()
    expect(vault.live.size).toBe(1)
    expect(await request(locations[2]?.serving as Serving)).toBe('status 200')
    await locations[2]?.dispose()
    expect(vault.live.size).toBe(0)
    expect(vault.counts.closed).toBe(1)
    await sleep(300)
    expect(vault.counts.opened).toBe(1)
  }, 20_000)
})

describe('background vault quota on OpenCode 2', () => {
  it('records one reading per account per tick for all locations, shown by the next state read', async () => {
    await approveHost()
    const vault = fakeVault()
    const quota = quotaTransport()
    const producers: BackgroundVaultQuotaRefresh[] = []
    const factory = hostFactory(vault, { quota, producers })
    const on = { background_quota_refresh: true }
    const locations = [
      await openLocation(factory, 'one', on, quota),
      await openLocation(factory, 'two', on, quota),
      await openLocation(factory, 'three', on, quota),
    ]
    // Every location lists both accounts before any reading exists.
    for (const location of locations)
      expect(await quotaRows(location.serving)).toEqual([undefined, undefined])
    expect(producers).toHaveLength(1)
    await producers[0]?.tick()
    expect(quota.requests).toHaveLength(ACCOUNTS.length)
    // Rows listed before the reading show it on the next state read.
    for (const location of locations)
      expect(await quotaRows(location.serving)).toEqual([0.33, 0.33])
    // The readings are fresh, so the next tick fetches nothing.
    await producers[0]?.tick()
    expect(quota.requests).toHaveLength(ACCOUNTS.length)
    // The manual check is offered in vault mode and fetches every account.
    const checked = await checkQuotaNow(locations[0]?.serving as Serving)
    expect(checked.text).toBe('Quota checked for 2 of 2 accounts')
    expect(quota.requests).toHaveLength(2 * ACCOUNTS.length)
  }, 20_000)

  it('runs at the shortest enabled interval and stops when no enabled location remains', async () => {
    await approveHost()
    const vault = fakeVault()
    const quota = quotaTransport()
    const producers: BackgroundVaultQuotaRefresh[] = []
    let later = 0
    const factory = hostFactory(vault, {
      quota,
      producers,
      quotaNow: () => Date.now() + later,
    })
    await openLocation(
      factory,
      'off',
      {
        background_quota_refresh: false,
        background_quota_refresh_interval_minutes: 1,
      },
      quota,
    )
    const seven = await openLocation(
      factory,
      'seven',
      {
        background_quota_refresh: true,
        background_quota_refresh_interval_minutes: 7,
      },
      quota,
    )
    expect(producers).toHaveLength(1)
    const producer = producers[0] as BackgroundVaultQuotaRefresh
    expect(producer.interval).toBe(7 * 60_000)
    const three = await openLocation(
      factory,
      'three',
      {
        background_quota_refresh: true,
        background_quota_refresh_interval_minutes: 3,
      },
      quota,
    )
    expect(producer.interval).toBe(3 * 60_000)
    await three.dispose()
    expect(producer.interval).toBe(7 * 60_000)
    expect(producers).toHaveLength(1)
    await producer.tick()
    expect(quota.requests).toHaveLength(ACCOUNTS.length)
    await seven.dispose()
    // The readings are now due again, but the stopped producer fetches nothing.
    later = 60 * 60_000
    await producer.tick()
    expect(quota.requests).toHaveLength(ACCOUNTS.length)
    expect(producers).toHaveLength(1)
  }, 20_000)

  it('starts no producer while every location has background refresh off, and still checks on demand', async () => {
    await approveHost()
    const vault = fakeVault()
    const quota = quotaTransport()
    const producers: BackgroundVaultQuotaRefresh[] = []
    const factory = hostFactory(vault, { quota, producers })
    const off = { background_quota_refresh: false }
    const one = await openLocation(factory, 'one', off, quota)
    await openLocation(factory, 'two', off, quota)
    expect(await quotaRows(one.serving)).toEqual([undefined, undefined])
    expect(producers).toHaveLength(0)
    expect(quota.requests).toHaveLength(0)
    const checked = await checkQuotaNow(one.serving)
    expect(checked.text).toBe('Quota checked for 2 of 2 accounts')
    expect(quota.requests).toHaveLength(ACCOUNTS.length)
    expect(await quotaRows(one.serving)).toEqual([0.33, 0.33])
  }, 20_000)
})
