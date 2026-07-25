import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AccountMetadataV3 } from '@cortexkit/antigravity-auth-core'

import {
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  readSidebarState,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarStateV1,
  setSidebarMergeHooks,
} from '../sidebar-state'
import { registerQuotaManagerProducer } from './index.ts'
import { createPluginLifecycle } from './lifecycle.ts'
import {
  classifyQuotaGroup,
  createOpenCodeQuotaManager,
  pushSidebarQuotaSnapshot,
} from './quota.ts'
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
      // Token refresh + anything else: return a pliable JSON
      // response so the rest of the quota pipeline can carry on.
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
        // fetchGeminiCliQuota now also uses fetchVia (2 endpoints via the
        // FetchGeminiCliQuotaOptions.fetchVia seam added for N2 testability).
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

  it('N2: CLI rejection carries the real error message instead of the generic no-CLI-configured string', async () => {
    // fetchGeminiCliQuota now propagates transport-level errors (network abort,
    // DNS, socket hang, timeout) by collecting them per-endpoint and throwing
    // when all endpoints fail. That throw reaches the outer .catch() in
    // quota.ts, which sets geminiCliFetchError. Before N2 the catch was
    // present but never fired — fetchGeminiCliQuota silently swallowed errors
    // and returned { buckets: [] }, landing on the generic message.
    //
    // The new FetchGeminiCliQuotaOptions.fetchVia seam lets the test inject
    // a transport that throws, driving the outer .catch() directly.
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

  it('N2: HTTP-500 on CLI endpoint does NOT kill the summary (parallel-fetch isolation)', async () => {
    // Complement: an HTTP 500 is treated as a transport error by the updated
    // fetchGeminiCliQuota (errors[] + re-throw), so the same .catch() path
    // fires and the summary still flows through.
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
