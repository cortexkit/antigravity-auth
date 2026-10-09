import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type AccountMetadataV3,
  type AccountRepository,
  type CommonAuthStoreModules,
  createAccountRepositoryFactory,
  loadCommonAuthStoreModules,
  type VaultRouteRef,
  type VaultSendAdmission,
} from '@cortexkit/antigravity-auth-core'

import {
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  readSidebarState,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarStateV1,
  setSidebarMachineState,
  setSidebarMergeHooks,
} from '../sidebar-state'
import {
  createLocalAccountCredentials,
  loadAccountManagerFromRepository,
} from './accounts.ts'
import { registerQuotaManagerProducer } from './index.ts'
import { createPluginLifecycle } from './lifecycle.ts'
import type { Logger } from './logger.ts'
import { commitLogins } from './persist-account-pool.ts'
import {
  classifyQuotaGroup,
  createAuthorizedFetchAccountQuota,
  createLocationQuotaManager,
  createOpenCodeQuotaManager,
  createStoreQuotaService,
  fetchVaultAccountQuota,
  pushSidebarQuotaSnapshot,
  type VaultQuotaSource,
} from './quota.ts'
import { initializeFreshAccountStoreFor, openAccountStore } from './storage.ts'
import type { PluginClient } from './types.ts'

interface QuotaSnapshotAccount {
  index: number
  label?: string
  enabled?: boolean
  coolingDownUntil?: number
  cachedQuota?: AccountMetadataV3['cachedQuota']
}

describe('classifyQuotaGroup', () => {
  it('uses live Antigravity model ids for quota groups', () => {
    expect(
      classifyQuotaGroup('gemini-3-flash-agent', 'Gemini 3.5 Flash (High)'),
    ).toBe('gemini')
    expect(
      classifyQuotaGroup('gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'),
    ).toBe('gemini')
    expect(
      classifyQuotaGroup(
        'gemini-3.6-flash-medium',
        'Gemini 3.6 Flash (Medium)',
      ),
    ).toBe('gemini')
    expect(classifyQuotaGroup('gemini-pro-agent', 'Gemini 3.1 Pro')).toBe(
      'gemini',
    )
    expect(classifyQuotaGroup('claude-sonnet-4-6', 'Claude Sonnet 4.6')).toBe(
      'non-gemini',
    )
  })

  it('classifies gpt-oss models into the non-Gemini pool', () => {
    expect(classifyQuotaGroup('gpt-oss-120b', 'GPT-OSS 120B')).toBe(
      'non-gemini',
    )
    expect(classifyQuotaGroup('gpt-oss-120b-medium', 'GPT-OSS 120B')).toBe(
      'non-gemini',
    )
  })

  it('ignores unsupported non-quota models', () => {
    expect(classifyQuotaGroup('some-unknown-model', 'Unknown Model')).toBeNull()
  })
})

describe('pushSidebarQuotaSnapshot', () => {
  let dir: string
  let stateFile: string
  let savedSidebarEnv: string | undefined

  beforeEach(() => {
    // Save preload-pinned value so afterEach can restore it instead of
    // deleting — a delete drops resolution to the operator's real state dir.
    savedSidebarEnv = process.env[SIDEBAR_STATE_ENV]
    dir = mkdtempSync(join(tmpdir(), 'agy-quota-sidebar-'))
    stateFile = join(dir, 'sidebar-state.json')
    process.env[SIDEBAR_STATE_ENV] = stateFile
  })

  afterEach(() => {
    if (savedSidebarEnv !== undefined)
      process.env[SIDEBAR_STATE_ENV] = savedSidebarEnv
    else delete process.env[SIDEBAR_STATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  function read(): SidebarStateV1 {
    return readSidebarState(stateFile)
  }

  it('writes redacted account labels and the just-refreshed quota percentages', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      {
        index: 0,
        label: 'Primary Account',
        enabled: true,
        coolingDownUntil: undefined,
        cachedQuota: {
          'non-gemini': {
            remainingFraction: 0.42,
            resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            modelCount: 1,
          },
          gemini: { remainingFraction: 0.85, modelCount: 1 },
        },
      },
      {
        index: 1,
        label: 'Backup Account',
        enabled: false,
        coolingDownUntil: Date.now() + 5 * 60 * 1000,
        cachedQuota: {
          gemini: { remainingFraction: 0.15, modelCount: 1 },
        },
      },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0)

    const state = read()
    expect(state.version).toBe(SIDEBAR_STATE_VERSION)
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts[0]?.label).toBe('Account 1')
    expect(JSON.stringify(state)).not.toContain('Primary Account')
    expect(JSON.stringify(state)).not.toContain('Backup Account')
    expect(state.accounts[0]?.enabled).toBe(true)
    expect(state.accounts[0]?.quota['non-gemini']?.remainingPercent).toBe(42)
    expect(state.accounts[0]?.quota.gemini?.remainingPercent).toBe(85)
    expect(state.accounts[1]?.enabled).toBe(false)
    expect(state.accounts[1]?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(state.accounts[1]?.quota.gemini?.remainingPercent).toBe(15)
  })

  it('records quotaBackoffUntil when a backoff is active without losing cached quota', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      {
        index: 0,
        label: 'Primary Account',
        enabled: true,
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.6, modelCount: 1 },
        },
      },
    ]

    const backoffUntil = Date.now() + 30_000
    await pushSidebarQuotaSnapshot(getAccounts, backoffUntil)

    const state = read()
    expect(state.quotaBackoffUntil).toBe(backoffUntil)
    // The pre-existing cached quota is preserved — backoff must not erase
    // fresher data per the freshness-merge contract.
    expect(state.accounts[0]?.quota['non-gemini']?.remainingPercent).toBe(60)
  })

  it('is a no-op when getAccounts returns null', async () => {
    await pushSidebarQuotaSnapshot(() => null)

    const state = read()
    expect(state).toEqual({
      ...DEFAULT_SIDEBAR_STATE,
      version: SIDEBAR_STATE_VERSION,
    })
  })

  it('is a no-op when the account list is empty', async () => {
    await pushSidebarQuotaSnapshot(() => [])

    const state = read()
    expect(state.accounts).toEqual([])
  })

  it('runs the windowed summary and gemini-cli quota fetch concurrently', async () => {
    // The summary fetch and the gemini-CLI quota fetch previously
    // ran sequentially — two 10s timeouts back-to-back. Run them
    // concurrently instead. We assert by recording the sequence
    // numbers of each fetch via a gate so the test is
    // deterministic across runtimes.
    const summarySeq: { seq: number } = { seq: 0 }
    const cliSeq: { seq: number } = { seq: 0 }
    let releaseSummary!: () => void
    let releaseCli!: () => void
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve
    })
    const cliGate = new Promise<void>((resolve) => {
      releaseCli = resolve
    })

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: unknown,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url
      if (url.includes('retrieveUserQuotaSummary')) {
        summarySeq.seq += 1
        await summaryGate
        summarySeq.seq += 1
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly',
                    window: 'weekly',
                    resetTime: '2026-01-08T00:00:00Z',
                    remainingFraction: 0.7,
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('retrieveUserQuota')) {
        cliSeq.seq += 1
        await cliGate
        cliSeq.seq += 1
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      }
      // Token refresh and every other request: a successful answer carrying
      // an access token, so token refresh and project lookup succeed and
      // the quota pipeline carries on.
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch)

    const client = {
      auth: { set: mock(async () => {}) },
    } as unknown as PluginClient
    // Use a UNIQUE refresh token per test run so the QuotaManager's
    // singleton cache / backoff state from earlier tests in the
    // same run can't skip the fetch behind our spy.
    const account: AccountMetadataV3 = {
      refreshToken: `concurrent-fetch-${Date.now()}-${Math.random()}`,
      managedProjectId: 'managed-project',
      projectId: 'project-id',
      addedAt: 0,
      lastUsed: 0,
    }
    const manager = createOpenCodeQuotaManager(client, 'google')

    try {
      const refresh = manager.refreshAccounts([account], {
        indexFor: () => 0,
        force: true,
      })
      // Yield until both fetches have started (seq=1).
      const deadline = Date.now() + 5_000
      while ((summarySeq.seq < 1 || cliSeq.seq < 1) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      // Both fetches started before either finished. If they ran
      // sequentially, the cli fetch would not have started yet.
      expect(summarySeq.seq).toBe(1)
      expect(cliSeq.seq).toBe(1)
      releaseSummary()
      releaseCli()
      await refresh

      // Both fetches completed (seq=2).
      expect(summarySeq.seq).toBe(2)
      expect(cliSeq.seq).toBe(2)
    } finally {
      fetchSpy.mockRestore()
      // Yield once more so the spy is fully torn down before the
      // next test's bun event loop watches see the partial state.
      await new Promise((resolve) => setImmediate(resolve))
    }
  })

  it('marks the active claude account as current when getActiveIndexByFamily is passed', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      {
        index: 0,
        label: 'Active',
        enabled: true,
        cachedQuota: {
          'non-gemini': { remainingFraction: 0.8, modelCount: 1 },
        },
      },
      {
        index: 1,
        label: 'Idle',
        enabled: true,
      },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0, () => ({
      claude: 0,
      gemini: 0,
    }))

    const state = read()
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts[0]?.current).toBe(true)
    expect(state.accounts[1]?.current).toBe(false)
  })

  it('marks both accounts current when each family points to a different index', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      { index: 0, label: 'Claude', enabled: true },
      { index: 1, label: 'Middle', enabled: true },
      { index: 2, label: 'Gemini', enabled: true },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0, () => ({
      claude: 0,
      gemini: 2,
    }))

    const state = read()
    expect(state.accounts).toHaveLength(3)
    expect(state.accounts[0]?.current).toBe(true)
    expect(state.accounts[1]?.current).toBe(false)
    expect(state.accounts[2]?.current).toBe(true)
  })

  it('defaults current to false when getActiveIndexByFamily is omitted (backward compat)', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      { index: 0, label: 'Acc', enabled: true },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0)

    const state = read()
    expect(state.accounts[0]?.current).toBe(false)
  })

  it('returns null from getActiveIndexByFamily → all accounts false', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      { index: 0, label: 'A', enabled: true },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0, () => null)

    const state = read()
    expect(state.accounts[0]?.current).toBe(false)
  })

  it('fences the real quota wrapper sidebar enqueue before the lifecycle drain', async () => {
    const events: string[] = []
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetchStartedResolve!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve
    })
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({ access_token: 'access-token', expires_in: 3600 }),
          { status: 200 },
        )) as unknown as typeof fetch,
    )
    const client = {
      auth: { set: mock(async () => {}) },
    } as unknown as PluginClient
    const account: AccountMetadataV3 = {
      refreshToken: 'refresh-token',
      managedProjectId: 'managed-project',
      addedAt: 0,
      lastUsed: 0,
    }
    const manager = createOpenCodeQuotaManager(client, 'google', {
      getAccountsForSidebar: () => [
        {
          index: 0,
          email: 'primary@example.test',
          cachedQuota: {
            'non-gemini': { remainingFraction: 0.42, modelCount: 1 },
          },
        },
      ],
      fetchVia: async () => {
        events.push('fetch:start')
        fetchStartedResolve()
        await fetchGate
        return new Response('unavailable', { status: 503 })
      },
    })
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear: () => {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState: () => {},
      drainSidebarWrites: async () => {
        events.push('lifecycle:drain')
        await drainSidebarWrites()
        events.push(
          readSidebarState(stateFile).accounts.length === 1
            ? 'drain:sees-sidebar-write'
            : 'drain:misses-sidebar-write',
        )
      },
    })
    registerQuotaManagerProducer(lifecycle, manager)
    setSidebarMergeHooks({
      onStep: async (step) => {
        if (step === 'await-lock') events.push('sidebar:write-start')
      },
    })

    const refresh = manager.refreshAccounts([account], {
      indexFor: () => 0,
      force: true,
    })
    await fetchStarted
    const dispose = lifecycle.dispose()
    releaseFetch()

    try {
      await dispose
      await manager.refreshAccounts([account], {
        indexFor: () => 0,
        force: true,
      })
      await drainSidebarWrites()
      expect(events).toEqual([
        'fetch:start',
        'fetch:start',
        'fetch:start',
        'fetch:start',
        // The Gemini CLI quota's two endpoint requests go through the same
        // injected transport (FetchGeminiCliQuotaOptions.fetchVia).
        'fetch:start',
        'fetch:start',
        'sidebar:write-start',
        'lifecycle:drain',
        'drain:sees-sidebar-write',
      ])
    } finally {
      await refresh
      await drainSidebarWrites()
      setSidebarMergeHooks(null)
      fetchSpy.mockRestore()
    }
  })

  it('CLI rejection carries the real error message instead of the generic no-CLI-configured string', async () => {
    // The injected transport (FetchGeminiCliQuotaOptions.fetchVia) carries
    // both Gemini CLI endpoint requests and throws on each. fetchGeminiCliQuota
    // collects those errors and throws when every endpoint fails, and the
    // .catch() in quota.ts records the original transport error on the CLI
    // quota summary instead of the generic "no Gemini CLI quota" text.
    const CLI_THROW_MSG = 'socket hang up'

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: unknown,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url

      if (url.includes('retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly',
                    window: 'weekly',
                    resetTime: '2026-01-08T00:00:00Z',
                    remainingFraction: 0.6,
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('retrieveUserQuota')) {
        // Simulate a transport-level rejection (socket hang up).
        // fetchGeminiCliQuota collects this as an error and re-throws
        // at end-of-loop, triggering the outer .catch() in quota.ts.
        throw new Error(CLI_THROW_MSG)
      }
      return new Response(
        JSON.stringify({ access_token: 'access-token', expires_in: 3600 }),
        { status: 200 },
      )
    }) as unknown as typeof fetch)

    const client = {
      auth: { set: mock(async () => {}) },
    } as unknown as PluginClient
    const account: AccountMetadataV3 = {
      refreshToken: `n2-rejection-${Date.now()}-${Math.random()}`,
      managedProjectId: 'managed-n2',
      projectId: 'project-n2',
      addedAt: 0,
      lastUsed: 0,
    }
    const manager = createOpenCodeQuotaManager(client, 'google')
    let result: import('./quota.ts').AccountQuotaResult | undefined
    try {
      const results = await manager.refreshAccounts([account], {
        indexFor: () => 0,
        force: true,
      })
      result = results[0]
    } finally {
      fetchSpy.mockRestore()
    }

    // Summary succeeded — overall status must stay 'ok'.
    expect(result?.status).toBe('ok')
    if (result?.status !== 'ok') return

    // Summary groups must survive the CLI rejection.
    expect(result.quota?.groups).toBeDefined()

    // The annotation must carry the REAL thrown message, not the generic
    // 'No Gemini CLI quota available' that indicates a permanent absence.
    // Multiple endpoints may each contribute the message (joined by '; ').
    expect(result.geminiCliQuota?.error).toContain(CLI_THROW_MSG)
    expect(result.geminiCliQuota?.error).not.toBe(
      'No Gemini CLI quota available',
    )
  })

  it('HTTP-500 on CLI endpoint does NOT kill the summary (parallel-fetch isolation)', async () => {
    // fetchGeminiCliQuota treats an HTTP 500 from a CLI endpoint as a failed
    // endpoint, so the CLI quota carries an error while the quota summary,
    // fetched in parallel, is still returned.
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: unknown,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url

      if (url.includes('retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly',
                    window: 'weekly',
                    resetTime: '2026-01-08T00:00:00Z',
                    remainingFraction: 0.6,
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('retrieveUserQuota')) {
        return new Response('internal error', { status: 500 })
      }
      return new Response(
        JSON.stringify({ access_token: 'access-token', expires_in: 3600 }),
        { status: 200 },
      )
    }) as unknown as typeof fetch)

    const client = {
      auth: { set: mock(async () => {}) },
    } as unknown as PluginClient
    const account: AccountMetadataV3 = {
      refreshToken: `n2-500-${Date.now()}-${Math.random()}`,
      managedProjectId: 'managed-n2b',
      projectId: 'project-n2b',
      addedAt: 0,
      lastUsed: 0,
    }
    const manager = createOpenCodeQuotaManager(client, 'google')
    let result: import('./quota.ts').AccountQuotaResult | undefined
    try {
      const results = await manager.refreshAccounts([account], {
        indexFor: () => 0,
        force: true,
      })
      result = results[0]
    } finally {
      fetchSpy.mockRestore()
    }

    expect(result?.status).toBe('ok')
    if (result?.status !== 'ok') return
    expect(result.quota?.groups).toBeDefined()
    expect(result.geminiCliQuota?.error).toBeTruthy()
  })
})

describe('location-scoped quota', () => {
  let dir: string
  let processFile: string
  let locationFile: string
  let savedSidebarEnv: string | undefined

  beforeEach(() => {
    savedSidebarEnv = process.env[SIDEBAR_STATE_ENV]
    dir = mkdtempSync(join(tmpdir(), 'agy-quota-location-'))
    processFile = join(dir, 'process-sidebar.json')
    locationFile = join(dir, 'location-sidebar.json')
    // SIDEBAR_STATE_ENV names the process-wide sidebar file; snapshots for
    // one location must write their own file, never that one.
    process.env[SIDEBAR_STATE_ENV] = processFile
  })

  afterEach(() => {
    if (savedSidebarEnv !== undefined)
      process.env[SIDEBAR_STATE_ENV] = savedSidebarEnv
    else delete process.env[SIDEBAR_STATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  function recordingLogger(): Logger & { debugMessages: string[] } {
    const debugMessages: string[] = []
    return {
      debugMessages,
      debug: (message) => void debugMessages.push(message),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
  }

  const ACCOUNTS = (): QuotaSnapshotAccount[] => [
    {
      index: 0,
      enabled: true,
      cachedQuota: { gemini: { remainingFraction: 0.5, modelCount: 1 } },
    },
  ]

  it('writes the snapshot to the given file with the given health source and clock', async () => {
    await pushSidebarQuotaSnapshot(ACCOUNTS, 0, undefined, {
      stateFile: locationFile,
      healthScore: (index) => (index === 0 ? 37 : 0),
      now: () => 1_700_000_000_000,
    })
    const state = readSidebarState(locationFile)
    expect(state.checkedAt).toBe(1_700_000_000_000)
    expect(state.accounts[0]?.health).toBe(37)
    expect(readSidebarState(processFile).checkedAt).toBe(0)
  })

  it('writes no health score when the location has no health source', async () => {
    await pushSidebarQuotaSnapshot(ACCOUNTS, 0, undefined, {
      stateFile: locationFile,
      healthScore: null,
    })
    // A missing health score is shown as the redactor's default, 100.
    expect(readSidebarState(locationFile).accounts[0]?.health).toBe(100)
  })

  it('reports a failed write to the location logger', async () => {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'file')
    const logger = recordingLogger()
    await pushSidebarQuotaSnapshot(ACCOUNTS, 0, undefined, {
      stateFile: join(blocker, 'sidebar.json'),
      logger,
      healthScore: null,
    })
    expect(logger.debugMessages).toEqual(['sidebar-quota-write-failed'])
  })

  it('requires a location logger and a quota fetch function', () => {
    expect(() =>
      createLocationQuotaManager({
        logger: undefined as unknown as Logger,
        fetchAccountQuota: async () => ({ index: 0, status: 'disabled' }),
      }),
    ).toThrow('location logger')
    expect(() =>
      createLocationQuotaManager({
        logger: recordingLogger(),
        fetchAccountQuota: undefined as unknown as Parameters<
          typeof createLocationQuotaManager
        >[0]['fetchAccountQuota'],
      }),
    ).toThrow('fetchAccountQuota')
  })

  it('pushes a snapshot after each refresh to its own file only', async () => {
    const manager = createLocationQuotaManager({
      logger: recordingLogger(),
      fetchAccountQuota: async (account) => ({
        index: 0,
        email: account.email,
        status: 'ok',
        disabled: false,
        quota: { groups: {}, modelCount: 0 },
      }),
      sidebar: {
        write: (state) =>
          setSidebarMachineState(state, { stateFile: locationFile }),
        getAccounts: ACCOUNTS,
        healthScore: () => 64,
        now: () => 1_700_000_000_000,
      },
    })
    try {
      await manager.refreshAccounts(
        [{ refreshToken: 'fake-refresh', addedAt: 0, lastUsed: 0 }],
        { indexFor: () => 0, force: true },
      )
    } finally {
      await manager.dispose()
    }
    await drainSidebarWrites()
    expect(readSidebarState(locationFile).accounts[0]?.health).toBe(64)
    expect(readSidebarState(processFile).checkedAt).toBe(0)
  })

  it('keeps backoff per manager, as the OpenCode 1 manager does', async () => {
    const failing = createLocationQuotaManager({
      logger: recordingLogger(),
      fetchAccountQuota: async () => ({
        index: 0,
        status: 'error',
        error: 'fake failure',
        disabled: false,
      }),
    })
    const healthy = createLocationQuotaManager({
      logger: recordingLogger(),
      fetchAccountQuota: async () => ({ index: 0, status: 'disabled' }),
    })
    const account = { refreshToken: 'fake-refresh', addedAt: 0, lastUsed: 0 }
    try {
      await failing.refreshAccount(account, { index: 0 })
      expect(failing.getBackoffUntil(account)).toBeGreaterThan(0)
      expect(healthy.getBackoffUntil(account)).toBe(0)
    } finally {
      await failing.dispose()
      await healthy.dispose()
    }
  })
})

describe('authorized local quota fetcher', () => {
  type Options = Parameters<typeof createAuthorizedFetchAccountQuota>[0]
  type Transport = NonNullable<Options['transport']>
  type Authorization = Awaited<ReturnType<Options['authorize']>>
  type SentRequest = {
    url: string
    authorization: string | null
    body: string
    signal: AbortSignal | null | undefined
  }

  const silent = { debug: () => undefined }
  const ACCOUNT: AccountMetadataV3 = {
    refreshToken: 'fake-refresh-never-sent',
    addedAt: 0,
    lastUsed: 0,
  }

  /** A transport that records every physical request and answers it. */
  function recordingTransport(
    requests: SentRequest[],
    cli: 'ok' | 'fail' = 'ok',
  ): Transport {
    return () => async (url, init, extra) => {
      const headers = new Headers(init.headers)
      requests.push({
        url,
        authorization: headers.get('authorization'),
        body: String(init.body ?? ''),
        signal: extra.signal,
      })
      if (url.includes('retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini',
                buckets: [{ remainingFraction: 0.25, window: 'WEEKLY' }],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (cli === 'fail') throw new Error('fake cli transport failure')
      return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
    }
  }

  function authorized(
    confirmSend: () => Promise<
      { status: 'current' } | { status: 'stale'; reason: string }
    > = async () => ({ status: 'current' }),
  ): Authorization {
    return {
      status: 'authorized',
      domain: 'local',
      accessToken: 'fake-authorized-access',
      projectId: 'fake-authorized-project',
      confirmSend,
    }
  }

  it('authorizes once, synchronously, with the exact account object before any await', async () => {
    const seen: AccountMetadataV3[] = []
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async (account) => {
        seen.push(account)
        return { status: 'refused', reason: 'stale' }
      },
      logger: silent,
    })
    const pending = fetchQuota(ACCOUNT, new AbortController().signal)
    // Called during the synchronous part of the check.
    expect(seen).toEqual([ACCOUNT])
    expect(seen[0]).toBe(ACCOUNT)
    await pending
    expect(seen).toHaveLength(1)
  })

  it('answers a synchronous throw from authorize with an error and sends no request', async () => {
    const requests: SentRequest[] = []
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: () => {
        throw new Error('fake authorize failure')
      },
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, new AbortController().signal)
    expect(result).toEqual({
      index: 0,
      email: undefined,
      status: 'error',
      disabled: false,
      error: 'fake authorize failure',
    })
    expect(requests).toEqual([])
  })

  it('answers a refused authorization with an error and sends no request', async () => {
    const requests: SentRequest[] = []
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () => ({ status: 'refused', reason: 'unattributed' }),
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, new AbortController().signal)
    expect(result).toEqual({
      index: 0,
      email: undefined,
      status: 'error',
      disabled: false,
      error: 'quota check refused (unattributed)',
    })
    expect(requests).toEqual([])
  })

  it('answers a disabled account without authorizing it or sending a request', async () => {
    let calls = 0
    const requests: SentRequest[] = []
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () => {
        calls += 1
        return { status: 'refused', reason: 'unexpected' }
      },
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(
      { ...ACCOUNT, enabled: false },
      new AbortController().signal,
    )
    expect(result.status).toBe('disabled')
    expect(calls).toBe(0)
    expect(requests).toEqual([])
  })

  it('refuses a vault authorization at compile time and at run time, without a request', async () => {
    // Compile time: an authorization naming the vault domain is not a
    // LocalQuotaCheckAuthorization.
    type Assignable<A, B> = [A] extends [B] ? true : false
    const vaultRejected: Assignable<
      {
        status: 'authorized'
        domain: 'vault'
        accessToken: string
        projectId: string
        confirmSend: (signal: AbortSignal) => Promise<{ status: 'current' }>
      },
      Authorization
    > = false
    expect(vaultRejected).toBe(false)

    // Run time: a caller that bypasses the type still gets no request.
    const requests: SentRequest[] = []
    const vault: unknown = { ...authorized(), domain: 'vault' }
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () => vault as Authorization,
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, new AbortController().signal)
    expect(result).toEqual({
      index: 0,
      email: undefined,
      status: 'error',
      disabled: false,
      error: 'quota check refused (unsupported credential domain)',
    })
    expect(requests).toEqual([])
  })

  it('checks the grant before every physical request and sends with the check’s own signal', async () => {
    const requests: SentRequest[] = []
    let checks = 0
    const controller = new AbortController()
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () =>
        authorized(async () => {
          checks += 1
          return { status: 'current' }
        }),
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, controller.signal)
    expect(result.status).toBe('ok')
    expect('updatedAccount' in result).toBe(false)
    expect(requests.length).toBeGreaterThan(0)
    expect(checks).toBe(requests.length)
    for (const request of requests) {
      expect(request.signal).toBe(controller.signal)
      expect(request.authorization).toBe('Bearer fake-authorized-access')
      expect(request.body).not.toContain('fake-refresh-never-sent')
    }
    expect(
      requests.some((request) =>
        request.body.includes('fake-authorized-project'),
      ),
    ).toBe(true)
  })

  it('stops sending once the grant goes stale and does not apply the reading', async () => {
    const requests: SentRequest[] = []
    let checks = 0
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () =>
        authorized(async () => {
          checks += 1
          // Current for the first request only; replaced afterwards.
          return checks === 1
            ? { status: 'current' }
            : { status: 'stale', reason: 'credential replaced' }
        }),
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, new AbortController().signal)
    expect(requests).toHaveLength(1)
    expect(result).toEqual({
      index: 0,
      email: undefined,
      status: 'error',
      disabled: false,
      error: 'quota check refused (stale grant: credential replaced)',
    })
  })

  it('keeps the summary when the Gemini CLI request fails, carrying the real error', async () => {
    const requests: SentRequest[] = []
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () => authorized(),
      logger: silent,
      transport: recordingTransport(requests, 'fail'),
    })
    const result = await fetchQuota(ACCOUNT, new AbortController().signal)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.quota).toBeDefined()
    expect(result.geminiCliQuota?.error).toContain('fake cli transport failure')
  })

  it('stops after authorization when the check was aborted meanwhile', async () => {
    const requests: SentRequest[] = []
    const controller = new AbortController()
    const fetchQuota = createAuthorizedFetchAccountQuota({
      authorize: async () => {
        controller.abort()
        return authorized()
      },
      logger: silent,
      transport: recordingTransport(requests),
    })
    const result = await fetchQuota(ACCOUNT, controller.signal)
    expect(result).toEqual({
      index: 0,
      email: undefined,
      status: 'error',
      disabled: false,
      error: 'aborted',
    })
    expect(requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Account-store quota checks over the genuine published store
//
// Runs against the common-auth store and fs code embedded in the core
// package, loaded with `loadCommonAuthStoreModules`, in a private config
// directory. Before anything runs, every embedded store/fs file is hashed
// and compared with the record (`source-output.json`) of the released 0.11.6
// archive it was copied from; any difference fails the tests.
// ---------------------------------------------------------------------------

const RELEASED_COMMON_AUTH = {
  package: '@cortexkit/common-auth',
  version: '0.11.6',
  tarballSha256:
    '2e1cbbdd2c5e75bbeecada6a64b93c29b64c5d3b41d3742312e1390cfaa6d9df',
} as const

async function embeddedFilesBelow(
  root: string,
  dir: string,
): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await embeddedFilesBelow(root, path)))
    else out.push(path)
  }
  return out
}

let genuine: Promise<CommonAuthStoreModules> | undefined

/**
 * The embedded store and fs modules, after each of their files matches the
 * size and SHA-256 recorded for the released 0.11.6 archive.
 */
function genuineModules(): Promise<CommonAuthStoreModules> {
  genuine ??= (async () => {
    const root = dirname(
      dirname(
        Bun.resolveSync(
          '@cortexkit/antigravity-auth-core/common-auth/store',
          import.meta.dir,
        ),
      ),
    )
    const receipt = JSON.parse(
      await readFile(join(root, 'source-output.json'), 'utf8'),
    ) as {
      package?: unknown
      version?: unknown
      artifactStatus?: unknown
      tarballSha256?: unknown
      files?: Array<{ output: string; bytes: number; outputSha256: string }>
    }
    if (
      receipt.package !== RELEASED_COMMON_AUTH.package ||
      receipt.version !== RELEASED_COMMON_AUTH.version ||
      receipt.artifactStatus !== 'released' ||
      receipt.tarballSha256 !== RELEASED_COMMON_AUTH.tarballSha256 ||
      !Array.isArray(receipt.files)
    ) {
      throw new Error(
        `source-output.json does not record the released common-auth ${RELEASED_COMMON_AUTH.version} archive`,
      )
    }
    const recorded = receipt.files.filter((file) =>
      /^(store|fs)\//.test(file.output),
    )
    const present = [
      ...(await embeddedFilesBelow(root, 'store')),
      ...(await embeddedFilesBelow(root, 'fs')),
    ].sort()
    if (
      JSON.stringify(present) !==
      JSON.stringify(recorded.map((file) => file.output).sort())
    ) {
      throw new Error(
        'the embedded store/fs files are not exactly the recorded ones',
      )
    }
    for (const file of recorded) {
      const bytes = await readFile(join(root, file.output))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== file.bytes || sha256 !== file.outputSha256) {
        throw new Error(
          `embedded ${file.output} differs from its recorded size or SHA-256`,
        )
      }
    }
    return loadCommonAuthStoreModules()
  })()
  return genuine
}

describe('account-store quota service', () => {
  let configDir = ''
  let previousConfigDir: string | undefined
  const repositories: AccountRepository[] = []
  const silent: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    configDir = await realpath(
      await mkdtemp(join(tmpdir(), 'agy-quota-store-')),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    for (const repository of repositories.splice(0)) await repository.dispose()
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  const login = (refresh: string, email: string) => ({
    type: 'success' as const,
    refresh,
    access: 'never-stored',
    expires: 1,
    email,
    projectId: '',
  })

  async function storeService(
    onRequest?: (bearer: string | null) => Promise<void> | void,
    options: {
      /** The manager's clock. */
      now?: () => number
      /** Runs before the manager is loaded, with the store's rows. */
      seed?: (repository: AccountRepository) => Promise<void>
      /** Makes every quota write the manager sends fail. */
      failQuotaWrites?: boolean
      /**
       * After real writes finish, the test fixture appends a flush failure
       * without a row ID.
       */
      unscopedFlushFailure?: boolean
    } = {},
  ) {
    const modules = await genuineModules()
    expect((await initializeFreshAccountStoreFor(modules)).status).toBe(
      'completed',
    )
    const exchanged: string[] = []
    const opening = await openAccountStore({
      modules,
      createRepository: createAccountRepositoryFactory(modules),
      exchange: async ({ refreshToken }) => {
        exchanged.push(refreshToken)
        return {
          accessToken: `access-for-${refreshToken}`,
          refreshToken,
          expiresAt: Date.now() + 3_600_000,
        }
      },
    })
    if (opening.status !== 'ready') throw new Error('store is not ready')
    const repository = opening.repository
    repositories.push(repository)
    await commitLogins(repository, [
      login('token-a|project-a', 'a@example.test'),
      login('token-b|project-b', 'b@example.test'),
    ])
    await options.seed?.(repository)
    // The manager writes through this view; with `failQuotaWrites` its
    // quota writes fail while every other operation reaches the store.
    const managerRepository: AccountRepository =
      options.failQuotaWrites || options.unscopedFlushFailure
        ? new Proxy(repository, {
            get(target, key) {
              if (key === 'recordQuota' && options.failQuotaWrites) {
                return async () => {
                  throw new Error('quota write failed')
                }
              }
              if (key === 'flush' && options.unscopedFlushFailure) {
                return async () => {
                  const report = await target.flush()
                  return {
                    completed: report.completed,
                    failures: [
                      ...report.failures,
                      {
                        operation: 'flush',
                        kind: 'unexpected',
                        retryable: false,
                        ambiguous: true,
                        message: 'a write failed for no named row',
                      },
                    ],
                  }
                }
              }
              const value = Reflect.get(target, key)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        : repository
    const manager = await loadAccountManagerFromRepository(managerRepository, {
      onDiagnostic: () => {},
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
    const bearers: Array<string | null> = []
    const service = createStoreQuotaService({
      manager,
      repository,
      logger: silent,
      credentials: createLocalAccountCredentials(manager, {
        repository: managerRepository,
        // A fixed project answer, so the check never makes the live project
        // lookup the local project cache would make.
        ensureProject: async (auth) => ({
          auth,
          effectiveProjectId: 'project-from-cache',
        }),
      }),
      transport: () => async (url, init) => {
        const bearer = new Headers(init.headers).get('authorization')
        bearers.push(bearer)
        await onRequest?.(bearer)
        if (url.includes('retrieveUserQuotaSummary')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini',
                  buckets: [{ remainingFraction: 0.25, window: 'WEEKLY' }],
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      },
    })
    const rows = async () => {
      await repository.flush()
      const read = await repository.read()
      if (read.status !== 'ready') throw new Error('store is not ready')
      return read.rows
    }
    return { repository, manager, service, bearers, exchanged, rows }
  }

  it('checks the selected row with its own repository-refreshed bearer and records the reading on that row only', async () => {
    const store = await storeService()
    const targets = store.manager.getAccountsForQuotaCheck()
    const outcome = await store.service.refreshAccount(targets[1]!, {
      force: true,
    })
    await store.service.dispose()

    expect(outcome.status).toBe('recorded')
    expect(store.exchanged).toEqual(['token-b'])
    expect(new Set(store.bearers)).toEqual(
      new Set(['Bearer access-for-token-b']),
    )
    const [rowA, rowB] = await store.rows()
    expect(rowB?.quota.status).toBe('present')
    expect(rowA?.quota.status).toBe('absent')
  })

  it('never attaches a reading to the credential that replaced the checked one', async () => {
    let replaced = false
    const holder: { repository?: AccountRepository } = {}
    const store = await storeService(async () => {
      if (replaced || holder.repository === undefined) return
      replaced = true
      const read = await holder.repository.read()
      const rowB = read.status === 'ready' ? read.rows[1] : undefined
      if (rowB === undefined) throw new Error('row B is missing')
      await holder.repository.replaceCredential(rowB.ref, {
        refreshToken: 'token-b2',
        disabled: 'keep',
      })
    })
    holder.repository = store.repository
    const targets = store.manager.getAccountsForQuotaCheck()
    await store.service.refreshAccount(targets[1]!, { force: true })
    await store.service.dispose()

    const rowB = (await store.rows())[1]
    expect(rowB?.credential?.refreshToken).toBe('token-b2')
    expect(rowB?.quota.status).toBe('absent')
  })

  it('reports as checked only readings the store holds for exactly the requested credentials', async () => {
    let replaced = false
    const holder: { repository?: AccountRepository } = {}
    const store = await storeService(async (bearer) => {
      // Row A's credential is replaced while its check runs.
      if (replaced || bearer !== 'Bearer access-for-token-a') return
      if (holder.repository === undefined) return
      replaced = true
      const read = await holder.repository.read()
      const rowA = read.status === 'ready' ? read.rows[0] : undefined
      if (rowA === undefined) throw new Error('row A is missing')
      await holder.repository.replaceCredential(rowA.ref, {
        refreshToken: 'token-a2',
        disabled: 'keep',
      })
    })
    holder.repository = store.repository
    const [rowA, rowB] = await store.rows()
    const unknown = { id: 'not-a-row', credentialEpoch: 1 }

    const report = await store.service.checkStoreQuota([
      rowA!.ref,
      rowB!.ref,
      unknown,
    ])
    await store.service.dispose()

    expect(report).toEqual({ checked: 1, notChecked: 2 })
    const [afterA, afterB] = await store.rows()
    expect(afterA?.credential?.refreshToken).toBe('token-a2')
    expect(afterA?.quota.status).toBe('absent')
    expect(afterB?.quota.status).toBe('present')
  })

  it("does not count an older stored reading that shares the new reading's time when the new one was not written", async () => {
    const clock = 1_700_000_000_000
    const store = await storeService(undefined, {
      now: () => clock,
      failQuotaWrites: true,
      seed: async (repository) => {
        const read = await repository.read()
        const rowB = read.status === 'ready' ? read.rows[1] : undefined
        if (rowB === undefined) throw new Error('row B is missing')
        // A reading already stored for row B at the very same time, with
        // a different remaining fraction than the check will fetch.
        await repository.recordQuota(rowB.ref, {
          schemaVersion: 1,
          cachedQuotaAccountId: createHash('sha256')
            .update('token-b')
            .digest('hex')
            .slice(0, 16),
          cachedQuota: {
            gemini: { modelCount: 1, remainingFraction: 0.9 },
          },
          cachedQuotaUpdatedAt: clock,
        })
      },
    })
    const rowB = (await store.rows())[1]

    const report = await store.service.checkStoreQuota([rowB!.ref])
    await store.service.dispose()

    expect(report).toEqual({ checked: 0, notChecked: 1 })
    const after = (await store.rows())[1]
    expect(
      after?.quota.status === 'present'
        ? after.quota.quota.cachedQuota?.gemini?.remainingFraction
        : undefined,
    ).toBe(0.9)
  })

  it('confirms no reading when the drain reports a failure that names no row, even if the stored reading matches', async () => {
    const store = await storeService(undefined, {
      now: () => 1_700_000_000_000,
      unscopedFlushFailure: true,
    })
    const rowB = (await store.rows())[1]

    const report = await store.service.checkStoreQuota([rowB!.ref])
    await store.service.dispose()

    // The new quota reading is stored, but a failure without a row ID
    // prevents reporting the account as checked.
    const after = (await store.rows())[1]
    expect(after?.quota.status).toBe('present')
    expect(report).toEqual({ checked: 0, notChecked: 1 })
  })

  it('confirms no reading when the drain fails with a persist error that lists no failure', async () => {
    const store = await storeService(undefined, {
      now: () => 1_700_000_000_000,
    })
    const rowB = (await store.rows())[1]
    // Let real quota writes finish, then inject a persistence error with no
    // identified failed rows.
    const drain = store.manager.saveToDisk.bind(store.manager)
    store.manager.saveToDisk = async () => {
      await drain()
      throw Object.assign(new Error('persist failed'), {
        name: 'AccountManagerPersistError',
        report: { completed: 0, failures: [] },
      })
    }

    const report = await store.service.checkStoreQuota([rowB!.ref])
    await store.service.dispose()

    expect((await store.rows())[1]?.quota.status).toBe('present')
    expect(report).toEqual({ checked: 0, notChecked: 1 })
  })

  it('refuses a target whose row the manager no longer holds, without refreshing or sending', async () => {
    const store = await storeService()
    const targets = store.manager.getAccountsForQuotaCheck()
    const accountA = store.manager.getAccounts()[0]
    expect(store.manager.removeAccount(accountA!)).toBe(true)

    const outcome = await store.service.refreshAccount(targets[0]!, {
      force: true,
    })
    await store.service.dispose()
    expect(outcome.status).toBe('failed')
    expect(store.exchanged).toEqual([])
    expect(store.bearers).toEqual([])
  })
})

describe('vault quota check', () => {
  type Admission = VaultSendAdmission
  type QuotaFetch = NonNullable<
    Parameters<typeof fetchVaultAccountQuota>[0]['transport']
  >
  const ref: VaultRouteRef = {
    routeId: 'route-1',
    credentialId: 'credential-1',
    accountIdentity: 'account-1',
    label: 'Vault account',
  }
  const silent = { debug: () => {} }

  /**
   * Models vault authorization for quota requests. Each authorization supplies
   * one credential containing a token, project and record version. Each `send`
   * call gets a new authorization. If its first response is 401, the helper
   * records that credential's version and retries once with a new authorization
   * and version. At `refuseFrom` and every later `send` call, it throws before
   * authorizing or dispatching a request.
   */
  function vaultSource(options: { refuseFrom?: number } = {}) {
    const issued: Admission[] = []
    const reported401: number[] = []
    let calls = 0
    const admit = (): Admission => {
      const version = issued.length + 1
      const admission = {
        routeId: ref.routeId,
        credentialId: ref.credentialId,
        accountIdentity: ref.accountIdentity,
        recordVersion: version,
        projectId: `vault-project-${version}`,
        accessToken: `vault-token-${version}`,
        expiresAtMs: null,
      }
      issued.push(admission)
      return admission
    }
    const source: VaultQuotaSource = {
      async send(_ref, dispatch, sendOptions) {
        calls += 1
        if (options.refuseFrom !== undefined && calls >= options.refuseFrom) {
          throw new Error('the vault refused to admit this account')
        }
        let admission = admit()
        let response = await dispatch(admission, sendOptions.signal)
        if (response.status === 401) {
          reported401.push(admission.recordVersion)
          admission = admit()
          response = await dispatch(admission, sendOptions.signal)
        }
        return response
      },
      attribution: (admission) => ({
        routeId: admission.routeId,
        credentialId: admission.credentialId,
        accountIdentity: admission.accountIdentity,
        recordVersion: admission.recordVersion,
      }),
    }
    return { source, issued, reported401 }
  }

  interface Sent {
    url: string
    bearer: string | null
    project: string | undefined
  }

  function recordingTransport(
    sent: Sent[],
    answer: (request: Sent, index: number) => Response,
  ): QuotaFetch {
    return async (url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        project?: string
      }
      const request: Sent = {
        url,
        bearer: new Headers(init.headers).get('authorization'),
        project: body.project,
      }
      sent.push(request)
      return answer(request, sent.length - 1)
    }
  }

  const summaryOk = () =>
    new Response(
      JSON.stringify({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly',
                window: 'weekly',
                remainingFraction: 0.5,
              },
            ],
          },
        ],
      }),
      { status: 200 },
    )

  /** Each HTTP request uses the token and project returned by its own vault authorization. */
  function expectOneAdmissionPerRequest(sent: Sent[], issued: Admission[]) {
    const byToken = new Map(
      issued.map((admission) => [`Bearer ${admission.accessToken}`, admission]),
    )
    const bearers = sent.map((request) => request.bearer)
    expect(new Set(bearers).size).toBe(bearers.length)
    for (const request of sent) {
      const admission = byToken.get(request.bearer ?? '')
      expect(admission).toBeDefined()
      if (request.project !== undefined) {
        expect(String(request.project)).toBe(admission?.projectId ?? '')
      }
    }
  }

  it('builds every physical request from its own new admission, so a failed endpoint is retried with another', async () => {
    const vault = vaultSource()
    const sent: Sent[] = []
    let summaryCalls = 0
    const reading = await fetchVaultAccountQuota({
      source: vault.source,
      ref,
      signal: new AbortController().signal,
      logger: silent,
      transport: recordingTransport(sent, (request) => {
        if (request.url.includes('retrieveUserQuotaSummary')) {
          summaryCalls += 1
          return summaryCalls === 1
            ? new Response('busy', { status: 503 })
            : summaryOk()
        }
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      }),
    })

    const summaryRequests = sent.filter((request) =>
      request.url.includes('retrieveUserQuotaSummary'),
    )
    expect(summaryRequests).toHaveLength(2)
    // The second summary request does not reuse the first one's grant.
    expect(summaryRequests[1]?.bearer).not.toBe(summaryRequests[0]?.bearer)
    expect(summaryRequests[1]?.project).not.toBe(summaryRequests[0]?.project)
    expectOneAdmissionPerRequest(sent, vault.issued)
    expect(vault.issued).toHaveLength(sent.length)

    expect(reading.fellBackToLegacy).toBe(false)
    expect(reading.quota.groups).not.toEqual({})
    // The quota result identifies the credential ID and record version used
    // by the request that returned it.
    const answering = vault.issued.find(
      (admission) =>
        `Bearer ${admission.accessToken}` === summaryRequests[1]?.bearer,
    )
    expect(reading.quotaAttribution?.recordVersion).toBe(
      answering?.recordVersion,
    )
  })

  it('stops at an admission refusal between attempts and sends nothing more', async () => {
    const vault = vaultSource({ refuseFrom: 3 })
    const sent: Sent[] = []
    const reading = await fetchVaultAccountQuota({
      source: vault.source,
      ref,
      signal: new AbortController().signal,
      logger: silent,
      transport: recordingTransport(
        sent,
        () => new Response('busy', { status: 503 }),
      ),
    })

    // The first two authorizations succeed. The third is refused, so no later
    // HTTP request is sent.
    expect(vault.issued).toHaveLength(2)
    expect(sent).toHaveLength(2)
    expectOneAdmissionPerRequest(sent, vault.issued)
    expect(reading.quota.error).toBe('Failed to fetch Antigravity quota')
    expect(reading.quotaAttribution).toBeUndefined()
    expect(reading.geminiCliQuota.error).toBeDefined()
  })

  it('hands a 401 to the source with its own admission and builds the retry from the retry admission', async () => {
    const vault = vaultSource()
    const sent: Sent[] = []
    const reading = await fetchVaultAccountQuota({
      source: vault.source,
      ref,
      signal: new AbortController().signal,
      logger: silent,
      transport: recordingTransport(sent, (request, index) => {
        if (request.url.includes('retrieveUserQuotaSummary')) {
          return index === 0 || request.bearer === 'Bearer vault-token-1'
            ? new Response('unauthorized', { status: 401 })
            : summaryOk()
        }
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      }),
    })

    expect(vault.reported401).toContain(1)
    expectOneAdmissionPerRequest(sent, vault.issued)
    expect(reading.fellBackToLegacy).toBe(false)
    expect(reading.quotaAttribution?.recordVersion).not.toBe(1)
  })

  it('retries the model list without a project under a new admission after a 403', async () => {
    const vault = vaultSource()
    const sent: Sent[] = []
    const reading = await fetchVaultAccountQuota({
      source: vault.source,
      ref,
      signal: new AbortController().signal,
      logger: silent,
      transport: recordingTransport(sent, (request) => {
        if (request.url.includes('retrieveUserQuotaSummary')) {
          return new Response('no', { status: 403 })
        }
        if (request.url.includes('fetchAvailableModels')) {
          return request.project === undefined
            ? new Response(JSON.stringify({ models: {} }), { status: 200 })
            : new Response('no', { status: 403 })
        }
        return new Response(JSON.stringify({ buckets: [] }), { status: 200 })
      }),
    })

    const models = sent.filter((request) =>
      request.url.includes('fetchAvailableModels'),
    )
    expect(models.map((request) => request.project === undefined)).toEqual([
      false,
      true,
    ])
    expect(models[1]?.bearer).not.toBe(models[0]?.bearer)
    expectOneAdmissionPerRequest(sent, vault.issued)
    expect(reading.fellBackToLegacy).toBe(true)
  })

  it('sends nothing for a receipt served after the other half of the check was refused', async () => {
    // Hold the quota-summary authorization and reject the Gemini CLI
    // authorization before releasing it.
    let releaseSummary: () => void = () => {}
    const summaryHeld = new Promise<void>((resolve) => {
      releaseSummary = resolve
    })
    let refusalSeen: () => void = () => {}
    const refused = new Promise<void>((resolve) => {
      refusalSeen = resolve
    })
    let calls = 0
    const issued: Admission[] = []
    const source: VaultQuotaSource = {
      async send(_ref, dispatch, sendOptions) {
        calls += 1
        const call = calls
        if (call === 1) await summaryHeld
        else {
          refusalSeen()
          throw new Error('the vault refused to admit this account')
        }
        const admission = {
          routeId: ref.routeId,
          credentialId: ref.credentialId,
          accountIdentity: ref.accountIdentity,
          recordVersion: call,
          projectId: `vault-project-${call}`,
          accessToken: `vault-token-${call}`,
          expiresAtMs: null,
        }
        issued.push(admission)
        return dispatch(admission, sendOptions.signal)
      },
      attribution: (admission) => ({
        routeId: admission.routeId,
        credentialId: admission.credentialId,
        accountIdentity: admission.accountIdentity,
        recordVersion: admission.recordVersion,
      }),
    }
    const sent: Sent[] = []
    const checking = fetchVaultAccountQuota({
      source,
      ref,
      signal: new AbortController().signal,
      logger: silent,
      transport: recordingTransport(sent, () => summaryOk()),
    })

    await refused
    // Allow the Gemini CLI refusal to stop the quota check before
    // authorizing the held summary request.
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSummary()
    const reading = await checking

    expect(issued).toHaveLength(1)
    expect(sent).toEqual([])
    expect(reading.quotaAttribution).toBeUndefined()
    expect(reading.quota.error).toBe('Failed to fetch Antigravity quota')
  })

  it('never exchanges a refresh token or sends outside the injected transport', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => {
        throw new Error('no global fetch is allowed in a vault quota check')
      }) as unknown as typeof fetch,
    )
    try {
      const vault = vaultSource()
      const sent: Sent[] = []
      await fetchVaultAccountQuota({
        source: vault.source,
        ref,
        signal: new AbortController().signal,
        logger: silent,
        transport: recordingTransport(sent, () => summaryOk()),
      })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(sent.some((request) => request.url.includes('oauth2'))).toBe(false)
      expect(sent.length).toBeGreaterThan(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
