/**
 * One location's runtime: per-location services, phase-ordered disposal,
 * rollback of a failed build, and independence between two locations in one
 * process. Every path is under a disposable test root; user configuration is
 * redirected there through OPENCODE_CONFIG_DIR; quota fetches and token
 * refreshes are fakes, so nothing touches the network or a real store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AccountMetadataV3,
  FetchAccountQuota,
} from '@cortexkit/antigravity-auth-core'

import { AccountManager } from '../accounts.ts'
import {
  createSignatureProcessState,
  type SignatureProcessState,
} from '../cache.ts'
import type { LocationLogRecord } from '../neutral-types.ts'
import {
  createOperatorSettingsRegistry,
  type OperatorSettingsRegistry,
} from '../operator-settings.ts'
import {
  createLocationRuntime,
  createMemoryQuotaSnapshots,
  createRuntimeScope,
  createSidebarFileQuotaSnapshots,
  type LocationAccountView,
  type LocationRuntime,
  type LocationRuntimeOptions,
} from './runtime.ts'

let root: string
let savedConfigDir: string | undefined
let registry: OperatorSettingsRegistry
const runtimes: LocationRuntime[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ga-runtime-'))
  savedConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = join(root, 'user-config')
  mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
  registry = createOperatorSettingsRegistry()
})

afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  )
  if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
})

/** A location directory whose project configuration is `config`. */
function location(name: string, config: Record<string, unknown>): string {
  const directory = join(root, name)
  mkdirSync(join(directory, '.opencode'), { recursive: true })
  writeFileSync(
    join(directory, '.opencode', 'antigravity.json'),
    JSON.stringify({ keep_thinking: false, debug: false, ...config }),
  )
  return directory
}

const okQuota: FetchAccountQuota = async (account) => ({
  index: 0,
  email: account.email,
  status: 'ok',
  disabled: false,
  quota: { groups: {}, modelCount: 0 },
})

function options(
  directory: string,
  overrides: Partial<LocationRuntimeOptions> = {},
): LocationRuntimeOptions {
  return {
    directory,
    quotaSnapshots: createSidebarFileQuotaSnapshots(
      join(directory, 'sidebar-state.json'),
    ),
    fetchAccountQuota: okQuota,
    refreshToken: async () => undefined,
    operatorSettingsRegistry: registry,
    signatureState: createSignatureProcessState(),
    random: () => 0.5,
    ...overrides,
  }
}

async function start(
  runtimeOptions: LocationRuntimeOptions,
): Promise<LocationRuntime> {
  const runtime = await createLocationRuntime(runtimeOptions)
  runtimes.push(runtime)
  return runtime
}

function withoutKey<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value }
  Reflect.deleteProperty(copy, key)
  return copy
}

/** Records every location handle the runtime acquires and releases. */
function recordingSignatureState(): SignatureProcessState & {
  acquired: number
  released: number
} {
  const real = createSignatureProcessState()
  const state = {
    ...real,
    acquired: 0,
    released: 0,
    acquireLocation: (
      signatureOptions: Parameters<SignatureProcessState['acquireLocation']>[0],
    ) => {
      const handle = real.acquireLocation(signatureOptions)
      state.acquired += 1
      return {
        ...handle,
        dispose: async () => {
          state.released += 1
          await handle.dispose()
        },
      }
    },
  }
  return state
}

function fakeAccounts(): LocationAccountView {
  return {
    getAccounts: () => [],
    getAccountsForQuotaCheck: () => [],
    updateQuotaCache: () => undefined,
    applyUpdatedAccount: () => undefined,
    requestSaveToDisk: () => undefined,
    getActiveIndexByFamily: () => ({ claude: 0, gemini: 0 }),
    toAuthDetails: () => ({ type: 'oauth', refresh: 'fake-refresh' }),
    updateFromAuth: () => undefined,
    saveToDisk: async () => undefined,
  }
}

const ACCOUNT: AccountMetadataV3 = {
  refreshToken: 'fake-refresh',
  addedAt: 0,
  lastUsed: 0,
}

describe('runtime scope', () => {
  it('stops producers, then drains, then closes consumers, newest first in each phase', async () => {
    const scope = createRuntimeScope()
    const order: string[] = []
    scope.add({ dispose: () => void order.push('consumer-1') }, 'consumer')
    scope.add({ dispose: () => void order.push('producer-1') }, 'producer')
    scope.addDrain(async () => void order.push('drain'))
    scope.add({ dispose: () => void order.push('consumer-2') }, 'consumer')
    scope.add({ dispose: () => void order.push('producer-2') }, 'producer')
    await scope.dispose()
    expect(order).toEqual([
      'producer-2',
      'producer-1',
      'drain',
      'consumer-2',
      'consumer-1',
    ])
  })

  it('awaits each producer before the next step', async () => {
    const scope = createRuntimeScope()
    const order: string[] = []
    scope.add(
      {
        dispose: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          order.push('slow producer stopped')
        },
      },
      'producer',
    )
    scope.addDrain(async () => void order.push('drain'))
    await scope.dispose()
    expect(order).toEqual(['slow producer stopped', 'drain'])
  })

  it('is idempotent and returns the same promise', async () => {
    const scope = createRuntimeScope()
    let count = 0
    scope.add(
      {
        dispose: () => {
          count += 1
        },
      },
      'consumer',
    )
    const first = scope.dispose()
    expect(scope.dispose()).toBe(first)
    await first
    await scope.dispose()
    expect(count).toBe(1)
    expect(scope.disposed).toBe(true)
  })

  it('runs every step after a failure and reports all failures together', async () => {
    const scope = createRuntimeScope()
    const order: string[] = []
    scope.add(
      {
        dispose: () => {
          throw new Error('consumer failed')
        },
      },
      'consumer',
    )
    scope.add(
      {
        dispose: () => {
          throw new Error('producer failed')
        },
      },
      'producer',
    )
    scope.addDrain(async () => void order.push('drain'))
    const error = await scope.dispose().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect(
      (error as AggregateError).errors.map((e) => (e as Error).message),
    ).toEqual(['producer failed', 'consumer failed'])
    expect(order).toEqual(['drain'])
  })

  it('disposes a resource added after disposal started instead of keeping it', async () => {
    const scope = createRuntimeScope()
    await scope.dispose()
    let disposed = false
    scope.add(
      {
        dispose: () => {
          disposed = true
        },
      },
      'producer',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(true)
  })
})

describe('location runtime', () => {
  it('builds each location from its own configuration and fresh defaults', async () => {
    const a = await start(
      options(location('a', { background_quota_refresh: true })),
    )
    const b = await start(
      options(location('b', { background_quota_refresh: false })),
    )
    expect(a.config.config.background_quota_refresh).toBe(true)
    expect(b.config.config.background_quota_refresh).toBe(false)
    expect(a.backgroundQuotaRefresh).not.toBeNull()
    expect(b.backgroundQuotaRefresh).toBeNull()
    expect(a.config.config).not.toBe(b.config.config)
    expect(a.config.config.signature_cache).not.toBe(
      b.config.config.signature_cache,
    )
    expect(a.quotaManager).not.toBe(b.quotaManager)
    expect(a.dump).not.toBe(b.dump)
    a.dump.setEnabled(true)
    expect(b.dump.isEnabled()).toBe(false)
  })

  it('sends each location’s log records only to its own sink', async () => {
    const sinkA: LocationLogRecord[] = []
    const sinkB: LocationLogRecord[] = []
    const a = await start(
      options(location('a', { debug_tui: true }), {
        logSink: (record) => void sinkA.push(record),
      }),
    )
    await start(
      options(location('b', { debug_tui: true }), {
        logSink: (record) => void sinkB.push(record),
      }),
    )
    a.logger.createLogger('probe').warn('only for a')
    expect(sinkA.map((record) => record.message)).toContain('only for a')
    expect(sinkB.map((record) => record.message)).not.toContain('only for a')
  })

  it('keeps its quota backoff to itself', async () => {
    const failing: FetchAccountQuota = async () => ({
      index: 0,
      status: 'error',
      error: 'fake upstream failure',
      disabled: false,
    })
    const a = await start(
      options(location('a', {}), { fetchAccountQuota: failing }),
    )
    const b = await start(options(location('b', {})))
    await a.quotaManager.refreshAccount(ACCOUNT, { index: 0 })
    expect(a.quotaManager.getBackoffUntil(ACCOUNT)).toBeGreaterThan(0)
    expect(b.quotaManager.getBackoffUntil(ACCOUNT)).toBe(0)
  })

  it('disposing one location leaves the other serving', async () => {
    const a = await start(options(location('a', {})))
    const b = await start(options(location('b', {})))
    await a.dispose()
    expect(registry.livePaths()).toHaveLength(2)
    await expect(
      b.operatorSettings.update((draft) => {
        draft.log_level = 'debug'
      }),
    ).resolves.toBeUndefined()
    const results = await b.quotaManager.refreshAccounts([ACCOUNT], {
      indexFor: () => 0,
      force: true,
    })
    expect(results[0]?.status).toBe('ok')
    await expect(
      a.operatorSettings.update((draft) => {
        draft.log_level = 'debug'
      }),
    ).rejects.toThrow('disposed')
  })

  it('stops producers while consumers are still open, and releases them last', async () => {
    const runtime = await start(options(location('a', {})))
    const order: string[] = []
    runtime.scope.add(
      {
        dispose: () => {
          order.push(`producer, live settings ${registry.livePaths().length}`)
        },
      },
      'producer',
    )
    runtime.scope.addDrain(async () => void order.push('drain'))
    await runtime.dispose()
    expect(order).toEqual(['producer, live settings 2', 'drain'])
    expect(registry.livePaths()).toEqual([])
  })

  it('rolls back everything already acquired when a later step fails', async () => {
    const signatureState = recordingSignatureState()
    const error = await createLocationRuntime(
      withoutKey(
        options(location('a', {}), { signatureState }),
        'fetchAccountQuota',
      ),
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toContain('fetchAccountQuota')
    expect(signatureState.acquired).toBe(1)
    expect(signatureState.released).toBe(1)
    expect(registry.livePaths()).toEqual([])
  })

  it('refuses a missing token refresher before acquiring anything', async () => {
    const signatureState = recordingSignatureState()
    await expect(
      createLocationRuntime(
        withoutKey(
          options(location('a', {}), { signatureState }),
          'refreshToken',
        ),
      ),
    ).rejects.toThrow('refreshToken')
    expect(signatureState.acquired).toBe(0)
    expect(registry.livePaths()).toEqual([])
  })

  it('binds the refresh queue to the account view and stops it on replacement and disposal', async () => {
    const runtime = await start(
      options(location('a', { proactive_token_refresh: true })),
    )
    expect(runtime.refreshQueue()).toBeNull()
    const view = fakeAccounts()
    await runtime.replaceAccounts(view)
    const first = runtime.refreshQueue()
    expect(runtime.accounts()).toBe(view)
    expect(first?.isRunning()).toBe(true)
    await runtime.replaceAccounts(fakeAccounts())
    expect(first?.isRunning()).toBe(false)
    const second = runtime.refreshQueue()
    expect(second?.isRunning()).toBe(true)
    await runtime.dispose()
    expect(second?.isRunning()).toBe(false)
    expect(runtime.refreshQueue()).toBeNull()
    await runtime.replaceAccounts(fakeAccounts())
    expect(runtime.refreshQueue()).toBeNull()
    expect(runtime.accounts()).toBeNull()
  })

  it('starts no refresh queue when proactive refresh is off', async () => {
    const runtime = await start(
      options(location('a', { proactive_token_refresh: false })),
    )
    await runtime.replaceAccounts(fakeAccounts())
    expect(runtime.refreshQueue()).toBeNull()
  })
})

describe('OpenCode 2 location without a sidebar file', () => {
  function listFiles(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
  }

  it('keeps quota snapshots in memory and writes no sidebar file', async () => {
    const snapshots = createMemoryQuotaSnapshots()
    const directory = location('ga', { background_quota_refresh: false })
    const runtime = await start(
      options(directory, {
        quotaSnapshots: snapshots,
        now: () => 1_700_000_000_000,
      }),
    )
    // A real account manager over an in-memory pool; nothing is read from
    // or written to disk.
    await runtime.replaceAccounts(
      new AccountManager(undefined, {
        version: 4,
        accounts: [
          {
            refreshToken: 'fake-refresh',
            addedAt: 0,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      }),
    )
    await runtime.quotaManager.refreshAccounts([ACCOUNT], {
      indexFor: () => 0,
      force: true,
    })
    const latest = snapshots.latest()
    expect(latest?.checkedAt).toBe(1_700_000_000_000)
    expect(latest?.accounts.map((account) => account.id)).toEqual(['acct-0'])
    expect(snapshots.lastCheckedAt()).toBe(1_700_000_000_000)
    expect(snapshots.pollLockPath).toBeNull()
    // Nothing but the project configuration exists under the location, and
    // the process-wide sidebar file named by ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
    // was not created.
    expect(listFiles(directory)).toEqual([
      join(directory, '.opencode', 'antigravity.json'),
    ])
    const processSidebar = process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE
    if (processSidebar) expect(existsSync(processSidebar)).toBe(false)
  })

  it('polls without a cross-process lock when the store has no lock path', async () => {
    let lockCalls = 0
    const runtime = await start(
      options(location('ga', { background_quota_refresh: true }), {
        quotaSnapshots: createMemoryQuotaSnapshots(),
        random: () => 0,
        acquireLock: async () => {
          lockCalls += 1
          return null
        },
      }),
    )
    await runtime.replaceAccounts(fakeAccounts())
    const poller = runtime.backgroundQuotaRefresh
    expect(poller).not.toBeNull()
    await (poller as unknown as { runTick(): Promise<void> }).runTick()
    expect(lockCalls).toBe(0)
  })
})
