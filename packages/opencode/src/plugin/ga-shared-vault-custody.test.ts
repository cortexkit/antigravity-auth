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
import {
  loadCommonAuthClaustrum,
  VAULT_ACCOUNT_REMEDY,
  type VaultConsumerOptions,
  type VaultScopedClient,
} from '@cortexkit/antigravity-auth-core'
import {
  createVaultHostRelay,
  emptyVaultHostClient,
  withVaultHost,
} from '../../../../test/support/vault-host.ts'

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
const NOW = Date.UTC(2026, 9, 21, 12)
const FETCHED = NOW - 90_000
type InsulaEntry = Parameters<
  NonNullable<VaultConsumerOptions['insula']>['normalize']
>[0]

function insulaEntry(
  name: string,
  overrides: Partial<InsulaEntry> = {},
): InsulaEntry {
  return {
    provider: 'antigravity',
    account: `identity-${name}`,
    source: 'vault',
    fetchedAt: new Date(FETCHED).toISOString(),
    usage: {
      extraRateWindows: [
        {
          id: 'gemini-5h',
          title: 'arbitrary',
          window: {
            usedPercent: 10,
            resetsAt: '2099-01-01T00:00:00Z',
            windowMinutes: 300,
          },
        },
      ],
    },
    ...overrides,
  }
}

/** Use the library's real insula transport over an owned connector, never a daemon. */
async function fakeInsula(result: InsulaEntry[], complete: boolean) {
  const claustrum = await loadCommonAuthClaustrum()
  const counts = { opened: 0, closed: 0, gets: 0, watches: 0, unsubscribed: 0 }
  const live = new Set<number>()
  const listeners = new Set<(body: Uint8Array) => void>()
  const closes: Array<() => void> = []
  const client = await claustrum.connectClaustrumScopedClient({
    connectionFile: join(root, 'vault-connection.json'),
    projectRoot: root,
    storagePath: accountFile(),
    connector: async () => {
      let id: number | undefined
      let end: (() => void) | undefined
      const close = () => {
        end?.()
        if (id !== undefined && live.delete(id)) counts.closed++
      }
      closes.push(close)
      return {
        async routeOpen(target: { module_id: string }) {
          if (target.module_id === 'insula') {
            id = ++counts.opened
            live.add(id)
          }
          return 1
        },
        async request(_route: unknown, request: { method: string }) {
          expect(request.method).toBe('usage.get')
          counts.gets++
          return { result, completeProviders: complete ? ['antigravity'] : [] }
        },
        subscribe(
          _route: unknown,
          request: { method: string },
          onNotice: (body: Uint8Array) => void,
        ) {
          expect(request.method).toBe('usage.watch')
          counts.watches++
          listeners.add(onNotice)
          let resolve!: () => void
          const closed = new Promise<void>((done) => {
            resolve = done
          })
          end = () => {
            listeners.delete(onNotice)
            resolve()
          }
          return {
            closed,
            unsubscribe() {
              counts.unsubscribed++
              end?.()
            },
          }
        },
        close,
      } as never
    },
  })
  const transport = client.insula
  // The scoped bootstrap only obtains the attached transport; quota sockets open later.
  client.close()
  if (!transport) throw new Error('the scoped client has no insula transport')
  cleanups.push(async () => {
    for (const close of closes) close()
  })
  return {
    transport,
    counts,
    live,
    announce() {
      const notice = new TextEncoder().encode(
        JSON.stringify({ kind: 'ready', epoch: 'owned-epoch', seq: 1 }),
      )
      for (const listener of listeners) listener(notice)
    },
  }
}

/**
 * A scoped vault client stand-in serving two accounts. It counts connects
 * and live connections; `hangNext` makes that many next connects wait until
 * the test ends.
 */
function fakeVault(insula?: VaultScopedClient['insula']) {
  const counts = { connects: 0, opened: 0, closed: 0, lists: 0 }
  const live = new Set<number>()
  let hangNext = 0
  const client = (id: number) => ({
    ...(insula ? { insula } : {}),
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
async function approveHost(vaultDir = legacyVaultDir(accountFile())) {
  let approve = false
  const custody = createOpenCodeVaultCustody({
    // No entry point settled a layout here, so the locations read the
    // vault files beside the account file, as this seeding does.
    vaultDir,
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

async function insulaHost(
  entries = ACCOUNTS.map((name) => insulaEntry(name)),
  complete = true,
) {
  await approveHost()
  const insula = await fakeInsula(entries, complete)
  const vault = fakeVault(insula.transport)
  const quota = quotaTransport()
  const producers: BackgroundVaultQuotaRefresh[] = []
  const factory = hostFactory(vault, {
    quota,
    producers,
    now: () => NOW,
    quotaNow: () => NOW,
  })
  return {
    insula,
    vault,
    quota,
    producers,
    factory,
    on: { background_quota_refresh: true },
  }
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

async function quotaAccountRows(serving: Serving) {
  const read = await serving.state.read({
    scope,
    signal: new AbortController().signal,
  })
  if (read.accounts.kind !== 'complete') throw new Error('over limit')
  return read.accounts.rows.map((entry) => entry.row)
}

async function quotaRows(serving: Serving) {
  return (await quotaAccountRows(serving)).map(
    (row) => row.cachedQuota?.gemini?.remainingFraction,
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
  it('waits for the source connect refusal instead of a short roster cutoff', async () => {
    await approveHost()
    const vault = fakeVault()
    vault.hang(1)
    const factory = hostFactory(vault)
    const location = await openLocation(factory, 'refused')
    const started = Date.now()
    // The request now waits for the source's own outcome instead of a fixed 2 s cutoff (issue #61).
    expect(await request(location.serving)).toBe(
      'Claustrum scoped operation unavailable',
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(9_000)
    expect(elapsed).toBeLessThan(15_000)
  }, 20_000)

  it('never recycles a healthy slow read shared by many requests', async () => {
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
    const first = request(locations[0]!.serving)
    await waitUntil(() => vault.counts.connects === 1, 'first connect')
    skew = 25_000
    const concurrent = Array.from({ length: 12 }, (_, index) =>
      request(locations[index % locations.length]!.serving),
    )
    await sleep(100)
    expect(vault.counts.connects).toBe(1)
    for (const release of releases.splice(0)) release()
    for (const outcome of await Promise.all([first, ...concurrent]))
      expect(outcome).toBe('status 200')
    expect(vault.counts.connects).toBe(1)
    expect(vault.counts.closed).toBe(0)
    expect(vault.live.size).toBe(1)
  })

  it('recycles a source whose first connect hangs, so the next request reconnects and succeeds', async () => {
    await approveHost()
    const vault = fakeVault()
    vault.hang(1)
    let skew = 0
    const factory = hostFactory(vault, { now: () => Date.now() + skew })
    const location = await openLocation(factory, 'stuck')
    const first = request(location.serving)
    // The request's roster read has now waited past the stall bound.
    await sleep(200)
    skew = VAULT_REFRESH_STALL_MS
    const recovered = request(location.serving)
    // The request now waits for the source's own outcome instead of a fixed 2 s cutoff (issue #61).
    expect(await first).toBe('Claustrum consumer is closed')
    expect(await recovered).toBe('status 200')
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
    // A new request runs the watchdog while the first requests still wait.
    // Closing their shared stalled source ends those reads with its own error.
    const recovered = request(locations[0]!.serving)
    // The request now waits for the source's own outcome instead of a fixed 2 s cutoff (issue #61).
    for (const outcome of await Promise.all(first))
      expect(outcome).toBe('Claustrum consumer is closed')
    expect(await recovered).toBe('status 200')
    for (const location of locations)
      expect(await request(location.serving)).toBe('status 200')
    expect(vault.counts.connects).toBe(2)
    expect(vault.live.size).toBe(1)
  }, 20_000)
})

describe('the shared custody lease', () => {
  it('[hosted] owns one serving client until the last location releases it and reacquires a fresh client', async () => {
    const relay = createVaultHostRelay(emptyVaultHostClient)
    await withVaultHost('thalamus', relay.accessor, async () => {
      const acquire = () => {
        const lease = acquireGaVaultCustody({
          vaultDir: join(root, 'hosted-vault'),
          accountFile: join(root, 'accounts.json'),
          readHostSlot: async () => {
            throw new Error('Local credentials must stay dormant.')
          },
          create: (input) =>
            createOpenCodeVaultCustody({
              ...input,
              reporterSource: 'direct',
              connectionFile: async () => {
                throw new Error(
                  'A hosted client must not resolve a native connection.',
                )
              },
            }),
        })
        cleanups.push(() => lease.dispose())
        return lease
      }
      const first = acquire()
      const second = acquire()
      const source = await first.custodySource()
      await source.refresh()
      expect(await second.custodySource()).toBe(source)
      expect(relay.calls.map((call) => [call.pluginId, call.closes])).toEqual([
        ['antigravity-auth', 0],
      ])
      await first.dispose()
      await first.dispose()
      await source.refresh()
      expect(relay.calls.map((call) => call.closes)).toEqual([0])
      await second.dispose()
      await second.dispose()
      expect(relay.calls.map((call) => call.closes)).toEqual([1])
      const next = acquire()
      await (await next.custodySource()).refresh()
      expect(relay.calls.map((call) => call.closes)).toEqual([1, 0])
      expect(relay.calls[0]?.client).not.toBe(relay.calls[1]?.client)
      await next.dispose()
      expect(relay.calls.map((call) => call.closes)).toEqual([1, 1])
    })
  })
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
  it('locations resolve the override and share one custody connection', async () => {
    const name = 'OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR'
    env[name] = process.env[name]
    const vaultDir = join(root, 'shared-vault')
    process.env[name] = vaultDir
    cleanups.push(async () => {
      __resetVaultFoldersForTest()
      __resetRuntimeLayoutsForTest()
      __resetRuntimeLayoutRunsForTest()
      __resetProcessHeartbeatForTest()
    })
    await approveHost(vaultDir)
    expect(await prepareVaultFolder({ accountFile: accountFile() })).toEqual({
      accountFile: accountFile(),
      vaultDir,
    })
    const vault = fakeVault()
    const factory = hostFactory(vault)
    const one = await openLocation(factory, 'override-one')
    const two = await openLocation(factory, 'override-two')
    await waitUntil(() => vault.counts.lists >= 1, 'the shared override roster')
    expect(await request(one.serving)).toBe('status 200')
    expect(await request(two.serving)).toBe('status 200')
    expect(vault.counts.opened).toBe(1)
    expect(existsSync(legacyVaultDir(accountFile()))).toBe(false)
    expect(existsSync(join(vaultDir, 'layout.json'))).toBe(false)
  }, 20_000)

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

  it('a local-mode location whose layout.json is malformed is refused with the layout message, not vault advice', async () => {
    const priorStateHome = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = join(root, 'state')
    cleanups.push(async () => {
      if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = priorStateHome
      __resetRuntimeLayoutsForTest()
      __resetRuntimeLayoutRunsForTest()
      __resetVaultFoldersForTest()
      __resetProcessHeartbeatForTest()
    })
    // No vault files anywhere: this host never enrolled.
    const stateDir = runtimeLayoutLocation().stateHomeDir
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const markerPath = join(stateDir, 'layout.json')
    writeFileSync(markerPath, '{ not json', { mode: 0o600 })
    // The activation's settle step, as `setupGaActivation` runs it.
    const folder = await prepareVaultFolder({
      accountFile: accountFile(),
      log: { info() {}, warn() {} },
    })
    expect(folder.refusal?.errorClass).toBe('malformed-marker')

    const vault = fakeVault()
    const location = await openLocation(hostFactory(vault), 'unsettled')
    const refusal = await request(location.serving)
    expect(refusal).toContain(`${markerPath} is malformed`)
    expect(refusal).toContain(
      `If they are, delete ${markerPath}, then restart OpenCode`,
    )
    expect(refusal).not.toContain(VAULT_ACCOUNT_REMEDY)
    expect(refusal).not.toMatch(/enroll/i)
    // Neither source served: the vault was never asked.
    expect(vault.counts.connects).toBe(0)
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
  it('stores the insula vault reading at fetchedAt without calling Google', async () => {
    const f = await insulaHost()
    const location = await openLocation(f.factory, 'insula', f.on, f.quota)
    await waitUntil(() => f.vault.counts.lists >= 2, 'the first source tick')
    await f.producers[0]?.tick()
    expect(f.quota.requests).toEqual([])
    const rows = await quotaAccountRows(location.serving)
    expect(rows.map((row) => row.cachedQuotaUpdatedAt)).toEqual([
      FETCHED,
      FETCHED,
    ])
    expect(rows.map((row) => row.cachedQuota?.gemini)).toEqual(
      ACCOUNTS.map(() => ({
        modelCount: 0,
        remainingFraction: 0.9,
        resetTime: '2099-01-01T00:00:00Z',
        windows: [
          {
            window: '5h',
            remainingFraction: 0.9,
            resetTime: '2099-01-01T00:00:00Z',
          },
        ],
      })),
    )
  }, 20_000)

  it.each([
    1, 3,
  ])('shares one insula poll and watch across %i locations and closes on the last release', async (count) => {
    const f = await insulaHost()
    const locations = []
    for (let index = 0; index < count; index++)
      locations.push(
        await openLocation(f.factory, `insula-${index}`, f.on, f.quota),
      )
    await waitUntil(() => f.vault.counts.lists >= 2, 'the first source tick')
    expect(f.producers).toHaveLength(1)
    await f.producers[0]?.tick()
    expect(f.quota.requests).toEqual([])
    expect(f.vault.counts.opened).toBe(1)
    expect(f.insula.counts).toEqual({
      opened: 2,
      closed: 1,
      gets: 1,
      watches: 1,
      unsubscribed: 0,
    })
    expect(f.insula.live.size).toBe(1)
    for (const location of locations)
      expect(await quotaRows(location.serving)).toEqual([0.9, 0.9])

    // Accepting a watch requests another snapshot, independently of location count.
    f.insula.announce()
    await waitUntil(() => f.insula.counts.closed === 2, 'the watch snapshot')
    expect(f.insula.counts).toEqual({
      opened: 3,
      closed: 2,
      gets: 2,
      watches: 1,
      unsubscribed: 0,
    })
    for (const location of locations.slice(0, -1)) {
      await location.dispose()
      expect(f.insula.live.size).toBe(1)
      expect(f.insula.counts.unsubscribed).toBe(0)
    }
    await locations.at(-1)?.dispose()
    expect(f.insula.live.size).toBe(0)
    expect(f.insula.counts.closed).toBe(f.insula.counts.opened)
    expect(f.insula.counts.unsubscribed).toBe(1)
    expect(f.vault.live.size).toBe(0)
  }, 20_000)

  it.each([
    'cold',
    'upstream-failed',
  ] as const)('%s insula cache skips Google and records no quota', async (miss) => {
    const f = await insulaHost(
      miss === 'cold'
        ? []
        : ACCOUNTS.map((name) =>
            insulaEntry(name, {
              errorClass: 'upstream_failed',
              usage: undefined,
            }),
          ),
      miss !== 'cold',
    )
    const location = await openLocation(f.factory, miss, f.on, f.quota)
    await waitUntil(() => f.vault.counts.lists >= 2, 'the first source tick')
    await f.producers[0]?.tick()
    await f.producers[0]?.tick()
    expect(f.insula.counts.gets).toBe(1)
    expect(f.quota.requests).toEqual([])
    const rows = await quotaAccountRows(location.serving)
    expect(rows.map((row) => row.cachedQuota)).toEqual([undefined, undefined])
    expect(rows.map((row) => row.cachedQuotaUpdatedAt)).toEqual([
      undefined,
      undefined,
    ])
  }, 20_000)

  it.each([
    'oauth echo',
    'absent entry',
  ])('%s falls back to Google once for the missing account', async (miss) => {
    const entries = [insulaEntry('b')]
    if (miss === 'oauth echo')
      entries.push(insulaEntry('a', { source: 'oauth' }))
    const f = await insulaHost(entries)
    const location = await openLocation(f.factory, 'fallback', f.on, f.quota)
    await waitUntil(() => f.vault.counts.lists >= 2, 'the first source tick')
    await f.producers[0]?.tick()
    expect(f.quota.requests).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    ])
    expect(await quotaRows(location.serving)).toEqual([0.33, 0.9])
    await f.producers[0]?.tick()
    expect(f.quota.requests).toHaveLength(1)
  }, 20_000)

  it('Check quota now calls Google directly even with a usable insula vault cache', async () => {
    const f = await insulaHost()
    const location = await openLocation(f.factory, 'manual', f.on, f.quota)
    await waitUntil(() => f.vault.counts.lists >= 2, 'the first source tick')
    await f.producers[0]?.tick()
    expect(f.quota.requests).toEqual([])
    expect(await quotaRows(location.serving)).toEqual([0.9, 0.9])
    const gets = f.insula.counts.gets
    const checked = await checkQuotaNow(location.serving)
    expect(checked.text).toBe('Quota checked for 2 of 2 accounts')
    expect(f.quota.requests).toHaveLength(ACCOUNTS.length)
    expect(await quotaRows(location.serving)).toEqual([0.33, 0.33])
    expect(f.insula.counts.gets).toBe(gets)
  }, 20_000)

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
