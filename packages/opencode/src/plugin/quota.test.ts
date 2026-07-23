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
  email?: string
  enabled?: boolean
  coolingDownUntil?: number
  cachedQuota?: AccountMetadataV3['cachedQuota']
}

describe('classifyQuotaGroup', () => {
  it('uses live Antigravity model ids for quota groups', () => {
    expect(
      classifyQuotaGroup('gemini-3-flash-agent', 'Gemini 3.5 Flash (High)'),
    ).toBe('gemini-flash')
    expect(
      classifyQuotaGroup('gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'),
    ).toBe('gemini-flash')
    expect(
      classifyQuotaGroup(
        'gemini-3.6-flash-medium',
        'Gemini 3.6 Flash (Medium)',
      ),
    ).toBe('gemini-flash')
    expect(classifyQuotaGroup('gemini-pro-agent', 'Gemini 3.1 Pro')).toBe(
      'gemini-pro',
    )
    expect(classifyQuotaGroup('claude-sonnet-4-6', 'Claude Sonnet 4.6')).toBe(
      'claude',
    )
  })

  it('classifies gpt-oss models into gpt-oss quota group', () => {
    expect(classifyQuotaGroup('gpt-oss-120b', 'GPT-OSS 120B')).toBe('gpt-oss')
    expect(classifyQuotaGroup('gpt-oss-120b-medium', 'GPT-OSS 120B')).toBe(
      'gpt-oss',
    )
  })

  it('ignores unsupported non-quota models', () => {
    expect(classifyQuotaGroup('some-unknown-model', 'Unknown Model')).toBeNull()
  })
})

describe('pushSidebarQuotaSnapshot', () => {
  let dir: string
  let stateFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-quota-sidebar-'))
    stateFile = join(dir, 'sidebar-state.json')
    process.env[SIDEBAR_STATE_ENV] = stateFile
  })

  afterEach(() => {
    delete process.env[SIDEBAR_STATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  function read(): SidebarStateV1 {
    return readSidebarState(stateFile)
  }

  it('writes redacted account labels and the just-refreshed quota percentages', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      {
        index: 0,
        email: 'primary@example.test',
        enabled: true,
        coolingDownUntil: undefined,
        cachedQuota: {
          claude: {
            remainingFraction: 0.42,
            resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            modelCount: 1,
          },
          'gemini-pro': { remainingFraction: 0.85, modelCount: 1 },
        },
      },
      {
        index: 1,
        email: 'backup@example.test',
        enabled: false,
        coolingDownUntil: Date.now() + 5 * 60 * 1000,
        cachedQuota: {
          'gemini-flash': { remainingFraction: 0.15, modelCount: 1 },
        },
      },
    ]

    await pushSidebarQuotaSnapshot(getAccounts, 0)

    const state = read()
    expect(state.version).toBe(SIDEBAR_STATE_VERSION)
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts[0]?.label).toBe('primary@example.test')
    expect(state.accounts[0]?.enabled).toBe(true)
    expect(state.accounts[0]?.quota.claude?.remainingPercent).toBe(42)
    expect(state.accounts[0]?.quota['gemini-pro']?.remainingPercent).toBe(85)
    expect(state.accounts[1]?.enabled).toBe(false)
    expect(state.accounts[1]?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(state.accounts[1]?.quota['gemini-flash']?.remainingPercent).toBe(15)
  })

  it('records quotaBackoffUntil when a backoff is active without losing cached quota', async () => {
    const getAccounts = (): QuotaSnapshotAccount[] => [
      {
        index: 0,
        email: 'primary@example.test',
        enabled: true,
        cachedQuota: {
          claude: { remainingFraction: 0.6, modelCount: 1 },
        },
      },
    ]

    const backoffUntil = Date.now() + 30_000
    await pushSidebarQuotaSnapshot(getAccounts, backoffUntil)

    const state = read()
    expect(state.quotaBackoffUntil).toBe(backoffUntil)
    // The pre-existing cached quota is preserved — backoff must not erase
    // fresher data per the freshness-merge contract.
    expect(state.accounts[0]?.quota.claude?.remainingPercent).toBe(60)
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
            claude: { remainingFraction: 0.42, modelCount: 1 },
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
})
