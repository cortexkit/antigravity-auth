import { mock, spyOn } from 'bun:test'
import { join } from 'node:path'
import {
  type AccountStorageStore,
  type AccountStorageV4,
  type AgyTransportOptions,
  AccountManager as CoreAccountManager,
  HealthScoreTracker,
  type ManagedAccount,
  type OAuthAuthDetails,
  TokenBucketTracker,
} from '@cortexkit/antigravity-auth-core'
import {
  type RequestSendAdmission,
  type RequestWire,
  StaleLocalGrantError,
} from '@cortexkit/antigravity-auth-core/engine'
import { extractAccountAccessErrorDetails } from '../account-access'
import { DEFAULT_CONFIG } from '../config'
import { createLocationDebug } from '../debug'
import { createGeminiDumpState } from '../gemini-dump'
import { createLocationLogger } from '../logger'
import {
  buildThinkingWarmupBody,
  getLastCacheStats,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from '../request'
import { AgySessionRegistry } from '../session-context'
import type { RequestServicesDeps } from './request-executor'

export const WIRE: RequestWire = {
  prepare: prepareAntigravityRequest,
  transformResponse: transformAntigravityResponse,
  buildThinkingWarmupBody,
  getLastCacheStats,
}

export const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

// Retry-metadata fixtures confirm quota exhaustion independently of message wording.
export const QUOTA_ERROR_INFO = {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason: 'QUOTA_EXHAUSTED',
}

export function testRoot(): string {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  return join(root, 'request-services')
}

export function modelUrl(
  model: string,
  action = 'streamGenerateContent?alt=sse',
) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}`
}

export function memoryStore(): AccountStorageStore {
  let current: AccountStorageV4 | null = null
  return {
    load: async () => current,
    saveMerged: async (_path, next) => {
      current = next
      return next
    },
    mutate: async (_path, fn) => {
      const base = current ?? {
        version: 4,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }
      current = (await fn(base)) ?? base
      return current
    },
    clear: async () => {
      current = null
    },
  }
}

export function storedAccounts(count: number): AccountStorageV4 {
  return {
    version: 4,
    accounts: Array.from({ length: count }, (_, index) => ({
      email: `account-${index}@example.test`,
      refreshToken: `refresh-${index}`,
      projectId: `project-${index}`,
      managedProjectId: `managed-${index}`,
      addedAt: FIXED_NOW - 20_000,
      lastUsed: FIXED_NOW - 10_000 - index,
    })),
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  }
}

export const managers: CoreAccountManager[] = []

export function makePool(
  count = 1,
  store: AccountStorageStore = memoryStore(),
): CoreAccountManager {
  const pool = new CoreAccountManager(undefined, storedAccounts(count), {
    store,
    storagePath: join(testRoot(), 'memory-accounts.json'),
  })
  managers.push(pool)
  return pool
}

export type TransportCall = {
  url: string
  init?: RequestInit
  options?: AgyTransportOptions
}

export interface Harness {
  deps: RequestServicesDeps<ManagedAccount>
  pool: CoreAccountManager
  calls: TransportCall[]
  refreshed: string[]
  refreshedAccounts: ManagedAccount[]
  checkedGrants: Array<{ account: ManagedAccount; accessToken: string }>
  clearStoredAuth: ReturnType<typeof mock>
}

export function harness(
  options: {
    pool?: CoreAccountManager
    respond?: (call: TransportCall, index: number) => Promise<Response>
    refresh?: (
      auth: OAuthAuthDetails,
      attempt: number,
    ) => Promise<OAuthAuthDetails | undefined>
    config?: Partial<typeof DEFAULT_CONFIG>
    notify?: RequestServicesDeps<ManagedAccount>['notify']
  } = {},
): Harness {
  const calls: TransportCall[] = []
  const refreshed: string[] = []
  const refreshedAccounts: ManagedAccount[] = []
  const checkedGrants: Array<{ account: ManagedAccount; accessToken: string }> =
    []
  const clearStoredAuth = mock(async () => {})
  const config = {
    ...DEFAULT_CONFIG,
    quiet_mode: true,
    account_selection_strategy: 'sticky' as const,
    scheduling_mode: 'balance' as const,
    switch_on_first_rate_limit: false,
    max_account_switches: 1,
    soft_quota_threshold_percent: 100,
    quota_refresh_interval_minutes: 0,
    proactive_rotation_threshold_percent: 0,
    cache_warmup_on_switch: false,
    thinking_warmup: false,
    request_jitter_max_ms: 0,
    switch_account_delay_ms: 0,
    ...options.config,
  }
  const debug = createLocationDebug({ ...config, debug: false })
  const pool = options.pool ?? makePool()
  const deps: RequestServicesDeps<ManagedAccount> = {
    config,
    accounts: pool,
    credentials: {
      domain: 'local',
      toAuthDetails: (account) => pool.toAuthDetails(account),
      updateFromAuth: (account, auth) => pool.updateFromAuth(account, auth),
      removeAccount: (account) => pool.removeAccount(account),
      saveToDisk: () => pool.saveToDisk(),
      saveToDiskReplace: () => pool.saveToDiskReplace(),
      refresh: async (account) => {
        const auth = pool.toAuthDetails(account)
        refreshed.push(auth.refresh)
        refreshedAccounts.push(account)
        if (options.refresh) {
          return options.refresh(auth, refreshed.length)
        }
        return { ...auth, access: 'access-fresh', expires: Date.now() + 3.6e6 }
      },
      // Use the refresh value captured with the grant as this test's row
      // identity. The later check compares the account's current refresh
      // value with that original value, so account mutation cannot recapture it.
      captureGrant: ({ account, accessToken }) => {
        const identity = pool.toAuthDetails(account).refresh
        return {
          source: 'pool-file',
          check() {
            checkedGrants.push({ account, accessToken })
            if (
              !pool.getAccounts().includes(account) ||
              pool.toAuthDetails(account).access !== accessToken ||
              pool.toAuthDetails(account).refresh !== identity
            ) {
              throw new StaleLocalGrantError()
            }
          },
        }
      },
      ensureProject: async (auth) => ({
        auth,
        effectiveProjectId: 'project-effective',
      }),
      isInvalidGrant: (error) =>
        error instanceof Error && error.message === 'invalid_grant',
      clearStoredAuth,
    },
    sessions: new AgySessionRegistry(),
    transport: async (url, init, transportOptions) => {
      const call = { url, init, options: transportOptions }
      calls.push(call)
      if (!options.respond) throw new Error('transport not configured')
      return options.respond(call, calls.length - 1)
    },
    wire: WIRE,
    debug,
    dump: createGeminiDumpState({ enabled: false }),
    logger: createLocationLogger({ sinkEnabled: () => false }).createLogger(
      'request-services-test',
    ),
    trackers: {
      health: new HealthScoreTracker(),
      token: new TokenBucketTracker(),
    },
    classifyAccessError: extractAccountAccessErrorDetails,
    ...(options.notify ? { notify: options.notify } : {}),
  }
  return {
    deps,
    pool,
    calls,
    refreshed,
    refreshedAccounts,
    checkedGrants,
    clearStoredAuth,
  }
}

export const CHAT_INIT = (signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  }),
  ...(signal ? { signal } : {}),
})

export function okJson(): Response {
  return new Response(
    JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

export const NON_STREAM_URL = modelUrl('gemini-3-flash', 'generateContent')
export const STREAM_URL = modelUrl('gemini-3-flash')
export const CLAUDE_URL = modelUrl('claude-sonnet-5-5-low', 'generateContent')

/** Vault credentials over the harness pool's rows: only `admit` exists. */
export function vaultDeps(
  h: Harness,
  admit: (account: ManagedAccount) => Promise<RequestSendAdmission>,
): RequestServicesDeps<ManagedAccount> {
  return {
    ...h.deps,
    credentials: {
      domain: 'vault',
      routingCandidate: (account) => ({
        accountId: `identity-${account.index}`,
        credentialId: `credential-${account.index}`,
      }),
      admit: async ({ account }) => admit(account),
    },
  }
}

export const routingSession = (
  id: string,
  kind: 'primary' | 'generate' | 'compaction' | 'title' = 'primary',
) => ({
  session: { sessionId: id, parentSessionId: null },
  kind,
})
export const routingAdmission = (
  account: ManagedAccount,
): RequestSendAdmission => ({
  accountIdentity: `identity-${account.index}`,
  credentialId: `credential-${account.index}`,
  recordVersion: 1,
  accessToken: `vault-token-${account.index}`,
  projectId: 'vault-project',
  report401: async () => {},
})

export const wireBearers = (h: Harness) =>
  h.calls.map((call) => new Headers(call.init?.headers).get('authorization'))

export const placementHarness = (options: Parameters<typeof harness>[0] = {}) =>
  harness({
    pool: options.pool ?? makePool(2),
    refresh: async (auth) => ({
      ...auth,
      access: `access-${auth.refresh.split('|')[0]}`,
      expires: Date.now() + 3.6e6,
    }),
    respond: async () => okJson(),
    ...options,
  })

export function quotaRefusal() {
  return new Response(
    JSON.stringify({
      error: { status: 'RESOURCE_EXHAUSTED', details: [QUOTA_ERROR_INFO] },
    }),
    { status: 429, headers: { 'Retry-After': '8' } },
  )
}

export function quotaReading(pool: CoreAccountManager, index = 0) {
  const reset = FIXED_NOW + 3_600_000
  const observedAt = FIXED_NOW - 1_000
  const row = pool.getAccounts()[index]!
  row.cachedQuotaUpdatedAt = observedAt
  row.cachedQuota = {
    gemini: {
      modelCount: 1,
      remainingFraction: 0,
      windows: [
        {
          window: '5h',
          remainingFraction: 0,
          resetTime: new Date(reset).toISOString(),
        },
      ],
    },
  }
  return { observedAt, reset }
}

export function routedTime(...sleepDelays: number[]) {
  let now = FIXED_NOW
  const delays: number[] = []
  const date = spyOn(Date, 'now').mockImplementation(() => now)
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    delay: number,
  ) =>
    sleepDelays.includes(delay)
      ? realTimeout(() => {
          delays.push(delay)
          now += delay
          fn()
        }, 0)
      : realTimeout(fn, delay)) as typeof setTimeout)
  return {
    delays,
    restore: () => {
      timer.mockRestore()
      date.mockRestore()
    },
  }
}

export async function disposePools() {
  for (const pool of managers.splice(0)) await pool.dispose()
}
