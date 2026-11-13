/**
 * Per-account model lists (`account_models`) through the real request
 * engine: which account serves, what is refused and what is never marked.
 * The policy comes from core's `compileModelAccess`, or from the settings
 * runtime reading a real settings file, exactly as the hosts pass it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorageStore,
  type AccountStorageV4,
  AccountManager as CoreAccountManager,
  HealthScoreTracker,
  type ManagedAccount,
  TokenBucketTracker,
} from '@cortexkit/antigravity-auth-core'

import { compileModelAccess } from '../../settings/core-settings'
import { createProtectionStore } from '../../settings/protection'
import {
  type AntigravitySettingsRuntime,
  createSettingsRuntime,
} from '../../settings/runtime'
import { extractAccountAccessErrorDetails } from '../account-access'
import { DEFAULT_CONFIG } from '../config'
import { getProjectConfigPath, loadConfig } from '../config/loader'
import { createLocationDebug } from '../debug'
import { createGeminiDumpState } from '../gemini-dump'
import { createLocationLogger } from '../logger'
import { createOperatorSettingsController } from '../operator-settings'
import {
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from '../request'
import { AgySessionRegistry } from '../session-context'
import {
  createRequestExecutor,
  type RequestSendAdmission,
  type RequestServicesDeps,
  type RequestWire,
  TITLE_FALLBACK_MODEL,
} from './request-services'

const WIRE: RequestWire = {
  prepare: prepareAntigravityRequest,
  transformResponse: transformAntigravityResponse,
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
}

/** The refusal when every account's list forbids the model, word for word. */
const ACCOUNT_MODELS_REFUSAL_BODY = {
  error: {
    code: 412,
    status: 'FAILED_PRECONDITION',
    message:
      'The requested Antigravity model is not available to the configured accounts. Choose another model. The account_models setting limits which accounts may serve it; change it in /antigravity \u2192 Accounts.',
  },
}

function testRoot(): string {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  return join(root, 'model-access-requests')
}

function modelUrl(model: string, action = 'generateContent') {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}`
}

const CHAT_INIT = (): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  }),
})

function okJson(): Response {
  return new Response(
    JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function memoryStore(): AccountStorageStore {
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

const managers: CoreAccountManager[] = []
const roots: string[] = []
const runtimes: AntigravitySettingsRuntime[] = []
const routingSymbol = Symbol.for('cortexkit.routing')

afterEach(async () => {
  for (const pool of managers.splice(0)) await pool.dispose()
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
  Reflect.deleteProperty(globalThis, routingSymbol)
})

/**
 * A pool whose rows carry stable ids: local rows `row-N` (the store row id),
 * vault rows the roster route `route-N` with account identity `identity-N`.
 */
function makePool(
  count: number,
  domain: 'local' | 'vault',
): CoreAccountManager {
  const now = Date.now()
  const pool = new CoreAccountManager(
    undefined,
    {
      version: 4,
      accounts: Array.from({ length: count }, (_, index) => ({
        email: `account-${index}@example.test`,
        refreshToken: `refresh-${index}`,
        projectId: `project-${index}`,
        managedProjectId: `managed-${index}`,
        addedAt: now - 20_000,
        lastUsed: now - 10_000 - index,
      })),
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    },
    { store: memoryStore(), storagePath: join(testRoot(), 'accounts.json') },
  )
  managers.push(pool)
  for (const row of pool.getAccounts()) {
    Object.assign(
      row,
      domain === 'local'
        ? { ref: { id: `row-${row.index}`, credentialEpoch: 1 } }
        : {
            route: {
              routeId: `route-${row.index}`,
              credentialId: `credential-${row.index}`,
              accountIdentity: `identity-${row.index}`,
            },
          },
    )
  }
  return pool
}

interface Harness {
  readonly deps: RequestServicesDeps<ManagedAccount>
  readonly pool: CoreAccountManager
  /** One entry per physical send: the index of the account it was sent for. */
  readonly sentFor: number[]
  readonly bodies: unknown[]
}

function harness(options: {
  readonly count: number
  readonly domain?: 'local' | 'vault'
  readonly config?: Partial<typeof DEFAULT_CONFIG>
  readonly accountModels?: unknown
}): Harness {
  const domain = options.domain ?? 'local'
  const pool = makePool(options.count, domain)
  const sentFor: number[] = []
  const bodies: unknown[] = []
  // The access token names the account it belongs to, so each send shows
  // which account served it.
  const tokenAccount = (token: string | null) =>
    Number(token?.replace(/^Bearer (access|vault-token)-/, '') ?? Number.NaN)
  const config = {
    ...DEFAULT_CONFIG,
    quiet_mode: true,
    account_selection_strategy: 'sticky' as const,
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
  const policy =
    options.accountModels === undefined
      ? undefined
      : compileModelAccess(options.accountModels)
  const deps: RequestServicesDeps<ManagedAccount> = {
    config,
    accounts: pool,
    credentials:
      domain === 'local'
        ? {
            domain: 'local',
            toAuthDetails: (account) => pool.toAuthDetails(account),
            updateFromAuth: (account, auth) =>
              pool.updateFromAuth(account, auth),
            removeAccount: (account) => pool.removeAccount(account),
            saveToDisk: () => pool.saveToDisk(),
            saveToDiskReplace: () => pool.saveToDiskReplace(),
            refresh: async (account) => ({
              ...pool.toAuthDetails(account),
              access: `access-${account.index}`,
              expires: Date.now() + 3.6e6,
            }),
            captureGrant: () => ({ source: 'pool-file', check() {} }),
            ensureProject: async (auth) => ({
              auth,
              effectiveProjectId: 'project-effective',
            }),
            isInvalidGrant: () => false,
            clearStoredAuth: async () => {},
          }
        : {
            domain: 'vault',
            routingCandidate: (account) => ({
              accountId: `identity-${account.index}`,
              credentialId: `credential-${account.index}`,
            }),
            admit: async ({ account }): Promise<RequestSendAdmission> => ({
              accountIdentity: `identity-${account.index}`,
              credentialId: `credential-${account.index}`,
              recordVersion: 1,
              accessToken: `vault-token-${account.index}`,
              projectId: 'vault-project',
              report401: async () => {},
            }),
          },
    sessions: new AgySessionRegistry(),
    transport: async (_url, init) => {
      bodies.push(init?.body)
      sentFor.push(
        tokenAccount(new Headers(init?.headers).get('authorization')),
      )
      return okJson()
    },
    wire: WIRE,
    debug: createLocationDebug({ ...config, debug: false }),
    dump: createGeminiDumpState({ enabled: false }),
    logger: createLocationLogger({ sinkEnabled: () => false }).createLogger(
      'model-access-requests-test',
    ),
    trackers: {
      health: new HealthScoreTracker(),
      token: new TokenBucketTracker(),
    },
    classifyAccessError: extractAccountAccessErrorDetails,
    ...(policy ? { modelAccess: () => policy } : {}),
  }
  return { deps, pool, sentFor, bodies }
}

async function send(
  h: Harness,
  model: string,
  options: Parameters<
    ReturnType<typeof createRequestExecutor>['execute']
  >[2] = {},
  deps: Partial<RequestServicesDeps<ManagedAccount>> = {},
): Promise<{ status: number; body: string }> {
  const executor = createRequestExecutor({ ...h.deps, ...deps })
  try {
    const response = await executor.execute(
      modelUrl(model),
      CHAT_INIT(),
      options,
    )
    return { status: response.status, body: await response.text() }
  } finally {
    await executor.dispose()
  }
}

function account(h: Harness, index: number): ManagedAccount {
  const row = h.pool.getAccounts()[index]
  if (!row) throw new Error(`no account ${index}`)
  return row
}

describe('per-account model lists in the request engine', () => {
  it('skips an account whose list forbids the model and serves from the allowed one', async () => {
    const h = harness({
      count: 2,
      accountModels: { 'row-0': ['claude-sonnet-5-5'] },
    })
    const result = await send(h, 'gemini-4-carbon-high')
    expect(result.status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('marks nothing on a list-excluded account: no rate limit, no cooldown', async () => {
    const h = harness({
      count: 2,
      accountModels: { 'row-0': ['claude-sonnet-5-5'] },
    })
    await send(h, 'gemini-4-carbon')
    expect(h.sentFor).toEqual([1])
    const excluded = account(h, 0)
    expect(h.pool.isRateLimited(excluded, 'gemini', 'gemini-4-carbon')).toBe(
      false,
    )
    expect(h.pool.isAccountCoolingDown(excluded)).toBe(false)
    expect(excluded.rateLimitResetTimes).toEqual({})
    expect(excluded.coolingDownUntil).toBeUndefined()
    expect(excluded.consecutiveFailures ?? 0).toBe(0)
  })

  it('never waits for a list-excluded account when the allowed one is rate limited', async () => {
    const h = harness({
      count: 2,
      config: { max_rate_limit_wait_seconds: 1 },
      accountModels: { 'row-0': ['claude-sonnet-5-5'] },
    })
    h.pool.markRateLimited(account(h, 1), 600_000, 'gemini', 'gemini-4-carbon')
    const result = await send(h, 'gemini-4-carbon')
    expect(result.status).toBe(412)
    expect(JSON.parse(result.body).error.message).toContain(
      'no account available within the configured wait limit',
    )
    expect(h.sentFor).toEqual([])
  })

  it('covers every thinking tier and the antigravity- spelling of a listed model', async () => {
    const h = harness({
      count: 2,
      accountModels: {
        'row-0': ['claude-sonnet-5-5'],
        'row-1': ['gemini-4-carbon-low'],
      },
    })
    for (const model of [
      'gemini-4-carbon-high',
      'antigravity-gemini-4-carbon',
      'gemini-4-carbon',
    ])
      expect((await send(h, model)).status).toBe(200)
    expect(h.sentFor).toEqual([1, 1, 1])
  })

  it('does not let an alias bypass a list', async () => {
    const h = harness({
      count: 2,
      accountModels: { 'row-0': ['gemini-4-carbon'] },
    })
    // `gpt-oss-120b` resolves to `gpt-oss-120b-medium`, which row-0 does not list.
    expect((await send(h, 'gpt-oss-120b')).status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('lets an alias reach the model its list names', async () => {
    const h = harness({
      count: 2,
      accountModels: {
        'row-0': ['gemini-4-carbon'],
        'row-1': ['gpt-oss-120b'],
      },
    })
    // row-1 lists the alias; the request names the model it resolves to.
    expect((await send(h, 'gpt-oss-120b-medium')).status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('ends in the fixed 412 refusal, sending nothing, when every account is forbidden', async () => {
    const h = harness({
      count: 2,
      accountModels: {
        'row-0': ['claude-sonnet-5-5'],
        'row-1': ['gemini-4-argon'],
      },
    })
    const result = await send(h, 'gemini-4-carbon')
    expect(result.status).toBe(412)
    expect(JSON.parse(result.body)).toEqual(ACCOUNT_MODELS_REFUSAL_BODY)
    expect(result.body).not.toMatch(/429|500|502|503|504|524/)
    expect(ACCOUNT_MODELS_REFUSAL_BODY.error.message).not.toMatch(/\d/)
    expect(result.body).not.toContain('example.test')
    expect(result.body).not.toContain('row-')
    expect(h.sentFor).toEqual([])
  })

  it('serves every model from an account with no entry', async () => {
    const h = harness({
      count: 2,
      accountModels: { 'row-9': ['claude-sonnet-5-5'] },
    })
    expect((await send(h, 'gemini-4-carbon')).status).toBe(200)
    expect(h.sentFor).toEqual([0])
  })

  it('refuses a killed permitted account with the operator refusal, not the model one', async () => {
    const h = harness({
      count: 2,
      accountModels: { 'row-1': ['claude-sonnet-5-5'] },
    })
    const permitted = account(h, 0)
    permitted.cachedQuota = {
      gemini: {
        remainingFraction: 0.1,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
        modelCount: 1,
      },
    }
    permitted.cachedQuotaUpdatedAt = Date.now()
    const result = await send(
      h,
      'gemini-4-carbon',
      {},
      {
        operatorSettings: {
          get: () => ({
            killswitch: { enabled: true, minimum_remaining_percent: 50 },
            log_level: 'info' as const,
          }),
        },
      },
    )
    expect(result.status).toBe(412)
    expect(JSON.parse(result.body).error.message).toContain(
      'operator quota policy',
    )
    expect(h.sentFor).toEqual([])
  })

  it('keys vault lists by the roster route id, never the account identity', async () => {
    const h = harness({
      count: 2,
      domain: 'vault',
      accountModels: {
        'route-0': ['claude-sonnet-5-5'],
        // An identity is not a key: this entry restricts nothing.
        'identity-1': ['claude-sonnet-5-5'],
      },
    })
    expect((await send(h, 'gemini-4-carbon')).status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('falls back to its own choice when routing names a forbidden vault account', async () => {
    const asks: unknown[][] = []
    Object.defineProperty(globalThis, routingSymbol, {
      configurable: true,
      value: () => ({
        accountFor: (...args: unknown[]) => {
          asks.push(args)
          return Promise.resolve({
            account_id: 'identity-1',
            credential_id: 'credential-1',
          })
        },
        report: () => {},
      }),
    })
    const h = harness({
      count: 2,
      domain: 'vault',
      accountModels: { 'route-1': ['claude-sonnet-5-5'] },
    })
    const result = await send(h, 'gemini-4-carbon', {
      session: { sessionId: 'routing', parentSessionId: null },
      kind: 'primary',
    })
    expect(result.status).toBe(200)
    expect(h.sentFor).toEqual([0])
  })

  it('sends a thinking warmup only to the allowed account', async () => {
    const h = harness({
      count: 2,
      config: { thinking_warmup: true },
      accountModels: { 'row-0': ['claude-sonnet-5-5'] },
    })
    const result = await send(
      h,
      'gemini-4-carbon',
      {},
      {
        wire: {
          ...WIRE,
          prepare: (...args: Parameters<RequestWire['prepare']>) => ({
            ...WIRE.prepare(...args),
            needsSignedThinkingWarmup: true,
            sessionId: 'warmup-session',
          }),
          buildThinkingWarmupBody: () => 'warmup',
        },
      },
    )
    expect(result.status).toBe(200)
    expect(h.sentFor.length).toBeGreaterThan(1)
    expect(new Set(h.sentFor)).toEqual(new Set([1]))
  })

  it('serves a title request from an account allowed the title model', async () => {
    const h = harness({
      count: 2,
      // row-0 serves only the image model; the title goes to the fallback
      // text model, which row-0 does not list.
      accountModels: { 'row-0': ['gemini-3.1-flash-image'] },
    })
    const result = await send(h, 'gemini-3.1-flash-image', {
      kind: 'title',
      session: { sessionId: 'title', parentSessionId: null },
    })
    // The title went to the fallback text model, not the image model.
    expect(TITLE_FALLBACK_MODEL).toStartWith('gemini-3.8-flash')
    expect(String(h.bodies[0])).not.toContain('flash-image')
    expect(result.status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('serves an image request only from an account whose list names the image model', async () => {
    const h = harness({
      count: 2,
      accountModels: {
        'row-0': ['gemini-4-carbon'],
        'row-1': ['gemini-3.1-flash-image'],
      },
    })
    expect((await send(h, 'gemini-3.1-flash-image')).status).toBe(200)
    expect(h.sentFor).toEqual([1])
  })

  it('never pre-switches a session to a list-excluded account', async () => {
    const h = harness({
      count: 3,
      config: {
        proactive_rotation_threshold_percent: 50,
        soft_quota_cache_ttl_minutes: 10,
      },
      accountModels: { 'row-1': ['claude-sonnet-5-5'] },
    })
    const quota = (index: number, remainingFraction: number) => {
      const row = account(h, index)
      row.cachedQuota = { gemini: { remainingFraction, modelCount: 1 } }
      row.cachedQuotaUpdatedAt = Date.now()
    }
    // The serving account is low; the excluded one has the most quota left.
    quota(0, 0.1)
    quota(1, 0.9)
    quota(2, 0.6)
    const identity = { sessionId: 'rotation', parentSessionId: null }
    expect(
      (await send(h, 'gemini-4-carbon', { session: identity })).status,
    ).toBe(200)
    expect(h.sentFor).toEqual([0])
    expect(
      h.pool.getCurrentAccountForFamily('gemini', { id: 'rotation' })?.index,
    ).toBe(2)
  })
})

describe('per-account model lists read from the settings file', () => {
  it('serves nothing when the list is unusable at start and nothing was saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-access-requests-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await mkdir(join(root, 'cortexkit'), { recursive: true })
    const file = join(root, 'cortexkit', 'antigravity-auth.jsonc')
    // A string where a list belongs makes the whole record unusable.
    await writeFile(
      file,
      '{ "schema_version": 1, "account_models": { "row-0": "gemini-4-carbon" } }\n',
    )
    const runtime = createSettingsRuntime({
      file,
      separateInstall: false,
      legacyUserFile: join(root, 'opencode', 'antigravity.json'),
      log: { warn() {}, info() {} },
      fence: async () => true,
      protection: createProtectionStore(join(root, 'state', 'protection.json')),
      moveReportPath: join(root, 'state', 'move-report.json'),
      retryDelaysMs: [60_000],
    })
    runtimes.push(runtime)
    const settings = await runtime.openProject(project, {
      config: () => loadConfig(project),
      operator: () =>
        createOperatorSettingsController({
          projectConfigPath: getProjectConfigPath(project),
          userConfigPath: join(root, 'opencode', 'antigravity.json'),
        }),
    })
    const h = harness({ count: 2 })
    const result = await send(
      h,
      'gemini-4-carbon',
      {},
      { modelAccess: () => settings.modelAccess() },
    )
    expect(result.status).toBe(412)
    expect(JSON.parse(result.body)).toEqual(ACCOUNT_MODELS_REFUSAL_BODY)
    expect(h.sentFor).toEqual([])
    await settings.release()
  })
})
