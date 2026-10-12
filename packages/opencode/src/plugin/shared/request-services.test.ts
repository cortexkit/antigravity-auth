import { afterEach, describe, expect, it, mock } from 'bun:test'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AccountStorageStore,
  type AccountStorageV4,
  type AgyTransportOptions,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  AccountManager as CoreAccountManager,
  type EnrollmentAuthority,
  HealthScoreTracker,
  type ManagedAccount,
  type OAuthAuthDetails,
  SKIP_THOUGHT_SIGNATURE,
  TokenBucketTracker,
} from '@cortexkit/antigravity-auth-core'
import { startGaLoopbackBridge } from '../../ga/server/index'
import { extractAccountAccessErrorDetails } from '../account-access'
import { createAuthLoader } from '../auth-loader'
import { DEFAULT_CONFIG } from '../config'
import { createLocationDebug } from '../debug'
import { createGaJobExecutor } from '../ga-location-services'
import { createGeminiDumpState } from '../gemini-dump'
import { createPluginLifecycle } from '../lifecycle'
import { createLocationLogger } from '../logger'
import { createLocationProactiveRefreshQueue } from '../refresh-queue'
import {
  buildThinkingWarmupBody,
  createRequestWire,
  createRequestWireLocation,
  getImageModelLocalTitle,
  getLastCacheStats,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from '../request'
import { AgySessionRegistry } from '../session-context'
import { createSignatureStore } from '../stores/signature-store'
import type { GetAuth } from '../types'
import {
  createRequestExecutor,
  type LocalRequestCredentials,
  prepareAgyWireRequest,
  type RequestSendAdmission,
  type RequestServicesDeps,
  type RequestWire,
  routeTitleModel,
  TITLE_FALLBACK_MODEL,
} from './request-services'

// =============================================================================
// Shared fixtures
// =============================================================================

const WIRE: RequestWire = {
  prepare: prepareAntigravityRequest,
  transformResponse: transformAntigravityResponse,
  buildThinkingWarmupBody,
  getImageModelLocalTitle,
  getLastCacheStats,
}

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

function testRoot(): string {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  return join(root, 'request-services')
}

function modelUrl(model: string, action = 'streamGenerateContent?alt=sse') {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}`
}

// =============================================================================
// Wire envelope parity
//
// The seven moved OpenCode 2 envelope cases, plus a foreign-call control,
// run through `prepareAgyWireRequest`, the single preparation entry point the
// shared engine uses for every send. The native CLI wire (agy 1.1.6, as the
// Pi adapter's MITM-verified conversion sends it) puts a response to a
// same-target signed call in a model turn and writes only `thoughtSignature`.
// =============================================================================

interface WireEnvelope {
  request: {
    contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>
    generationConfig?: {
      thinkingConfig?: unknown
      maxOutputTokens?: number
      [key: string]: unknown
    }
    toolConfig?: { functionCallingConfig?: { mode?: string } }
    tools?: unknown
    providerOptions?: unknown
  }
}

function prepareEnvelope(
  model: string,
  payload: Record<string, unknown>,
  sessionId = 'session',
): WireEnvelope {
  const sessions = new AgySessionRegistry(testRoot())
  const scope = sessions.beginRequest({ sessionId, parentSessionId: null })
  const prepared = prepareAgyWireRequest(WIRE, {
    input: modelUrl(model),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    accessToken: 'access-token',
    projectId: 'request-test-project',
    endpoint: ANTIGRAVITY_ENDPOINT_FALLBACKS[0],
    headerStyle: 'antigravity',
    options: {
      agySession: scope.session,
      agyRequestTimestamp: scope.timestamp,
    },
  })
  return JSON.parse(String(prepared.init.body)) as WireEnvelope
}

describe('prepareAgyWireRequest envelope parity', () => {
  it('appends a real user turn when the host payload ends with a model turn', () => {
    const envelope = prepareEnvelope('gemini-3.7-flash-medium', {
      contents: [
        { role: 'user', parts: [{ text: 'Start' }] },
        { role: 'model', parts: [{ text: 'Previous answer' }] },
      ],
    })

    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('applies the shared Claude thinking and schema transform', () => {
    const envelope = prepareEnvelope('claude-sonnet-4-6-thinking', {
      contents: [
        {
          role: 'model',
          parts: [
            {
              text: 'foreign thought',
              thought: true,
              thoughtSignature: 'gemini-signature',
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
          ],
        },
      ],
    })

    const generationConfig = envelope.request.generationConfig
    expect(generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    expect(generationConfig?.maxOutputTokens).toBe(64_000)
    expect(
      envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature,
    ).toBeUndefined()
    expect(envelope.request.toolConfig?.functionCallingConfig?.mode).toBe(
      'VALIDATED',
    )
  })

  it('normalizes replay signatures across parallel function calls', () => {
    const validSignature = 's'.repeat(64)
    const envelope = prepareEnvelope('gemini-3.8-flash-medium', {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'first', args: {} },
              thoughtSignature: validSignature,
            },
            {
              functionCall: { name: 'second', args: {} },
              thoughtSignature: 'other'.repeat(20),
            },
          ],
        },
      ],
    })

    expect(envelope.request.contents?.[0]?.parts).toEqual([
      {
        functionCall: { name: 'first', args: {} },
        thoughtSignature: validSignature,
      },
      { functionCall: { name: 'second', args: {} } },
    ])
  })

  it('injects the supported sentinel when Claude replay has no valid signature', () => {
    const envelope = prepareEnvelope('claude-sonnet-4-6-thinking', {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read_file', args: { path: 'a.ts' } },
              thoughtSignature: 'c'.repeat(64),
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
    })

    expect(envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature).toBe(
      SKIP_THOUGHT_SIGNATURE,
    )
  })

  it('uses the native model role for same-target function responses', () => {
    const envelope = prepareEnvelope('gemini-3.8-flash-medium', {
      contents: [
        { role: 'user', parts: [{ text: 'Read the file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read', args: { path: 'README.md' } },
              thoughtSignature: 's'.repeat(64),
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { output: 'contents' },
              },
            },
          ],
        },
      ],
    })

    expect(envelope.request.contents?.at(-2)?.role).toBe('model')
    expect(envelope.request.contents?.at(-2)?.parts?.[0]).toHaveProperty(
      'functionResponse',
    )
    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('keeps responses to an unsigned (foreign) call in a user turn', () => {
    const envelope = prepareEnvelope('gemini-3.8-flash-medium', {
      contents: [
        { role: 'user', parts: [{ text: 'Read the file' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'read', args: { path: 'a.ts' } } }],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'read', response: { output: 'x' } } },
          ],
        },
      ],
    })

    expect(
      envelope.request.contents?.at(-2)?.parts?.[0]?.thoughtSignature,
    ).toBe(SKIP_THOUGHT_SIGNATURE)
    expect(envelope.request.contents?.at(-1)?.role).toBe('user')
    expect(envelope.request.contents?.at(-1)?.parts?.[0]).toHaveProperty(
      'functionResponse',
    )
  })

  it('removes unsupported tools and thinking from image requests', () => {
    const envelope = prepareEnvelope('gemini-3.1-flash-image', {
      contents: [{ role: 'user', parts: [{ text: 'Draw a lighthouse' }] }],
      tools: [{ functionDeclarations: [{ name: 'read' }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    })

    expect(envelope.request.tools).toBeUndefined()
    expect(envelope.request.toolConfig).toBeUndefined()
    expect(envelope.request.generationConfig).toMatchObject({
      imageConfig: { aspectRatio: '1:1' },
      candidateCount: 1,
    })
    expect(envelope.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('sets VALIDATED on tool requests and removes host provider options', () => {
    const envelope = prepareEnvelope('gemini-3.7-flash-medium', {
      contents: [{ role: 'user', parts: [{ text: 'Use a tool' }] }],
      providerOptions: { google: { opaque: true } },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ],
    })

    expect(envelope.request.providerOptions).toBeUndefined()
    expect(envelope.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    })
  })
})

describe('prepareAgyWireRequest against the frozen agy CLI 1.1.24 capture', () => {
  const capture = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '../../../../../test-fixtures/agy-cli-1.1.24-stream-request.json',
      ),
      'utf8',
    ),
  ) as { envelopeKeys: string[]; requestKeys: string[] }

  it('emits the captured envelope and request field order', () => {
    const sessions = new AgySessionRegistry(testRoot())
    const scope = sessions.beginRequest({
      sessionId: 'fixture',
      parentSessionId: null,
    })
    const prepared = prepareAgyWireRequest(WIRE, {
      input: modelUrl('gemini-3.7-flash-medium'),
      init: {
        method: 'POST',
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'system' }] },
          contents: [{ role: 'user', parts: [{ text: 'Use a tool' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'lookup',
                  parameters: {
                    type: 'object',
                    properties: { q: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        }),
      },
      accessToken: 'token',
      projectId: 'project',
      endpoint: ANTIGRAVITY_ENDPOINT_FALLBACKS[0],
      headerStyle: 'antigravity',
      options: {
        agySession: scope.session,
        agyRequestTimestamp: scope.timestamp,
      },
    })
    const envelope = JSON.parse(String(prepared.init.body)) as {
      request: Record<string, unknown>
    }

    expect(Object.keys(envelope)).toEqual(capture.envelopeKeys)
    // The capture had no tool-calling config; the engine's VALIDATED
    // toolConfig sits between tools and labels, as core orders it.
    expect(Object.keys(envelope.request)).toEqual([
      ...capture.requestKeys.slice(0, 3),
      'toolConfig',
      ...capture.requestKeys.slice(3),
    ])
  })
})

// =============================================================================
// Engine bound to explicit location collaborators
//
// These tests build the executor the way a non-OpenCode-1 location does: a
// core account manager on an in-memory store, its own debug/dump/logger,
// its own health and token trackers, injected credentials, and no host
// toast or sidebar callback. Expected values are the OpenCode 1 retry
// contract (endpoint order, capacity retry, refresh cooldown, invalid_grant
// removal, original error identity, last upstream response), not values read
// back from the engine.
// =============================================================================

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

function storedAccounts(count: number): AccountStorageV4 {
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

const managers: CoreAccountManager[] = []

function makePool(
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

afterEach(async () => {
  for (const pool of managers.splice(0)) await pool.dispose()
})

type TransportCall = {
  url: string
  init?: RequestInit
  options?: AgyTransportOptions
}

interface Harness {
  deps: RequestServicesDeps<ManagedAccount>
  pool: CoreAccountManager
  calls: TransportCall[]
  refreshed: string[]
  refreshedAccounts: ManagedAccount[]
  checkedGrants: Array<{ account: ManagedAccount; accessToken: string }>
  clearStoredAuth: ReturnType<typeof mock>
}

function harness(
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
              throw new Error('stale grant')
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
    sessions: new AgySessionRegistry(testRoot()),
    transport: async (url, init, transportOptions) => {
      const call = { url, init, options: transportOptions }
      calls.push(call)
      if (!options.respond) throw new Error('transport not configured')
      return options.respond(call, calls.length - 1)
    },
    fetchImpl: async () => {
      throw new Error('gemini-cli fetch must not be used in these tests')
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

const CHAT_INIT = (signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  }),
  ...(signal ? { signal } : {}),
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

const NON_STREAM_URL = modelUrl('gemini-3-flash', 'generateContent')
const STREAM_URL = modelUrl('gemini-3-flash')
const CLAUDE_URL = modelUrl('claude-sonnet-5-5-low', 'generateContent')

describe('createRequestExecutor retry contract', () => {
  it('tries the Antigravity endpoints in fallback order after a 404', async () => {
    const h = harness({
      respond: async (_call, index) =>
        index === 0 ? new Response('missing', { status: 404 }) : okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(h.calls.map((call) => new URL(call.url).origin)).toEqual([
        ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
      ])
    } finally {
      await executor.dispose()
    }
  })

  it('retries the same endpoint once after a capacity 503', async () => {
    const h = harness({
      respond: async (_call, index) =>
        index === 0
          ? new Response(
              JSON.stringify({
                error: {
                  code: 503,
                  message: 'No capacity available for model',
                  details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
                },
              }),
              { status: 503 },
            )
          : okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(h.calls).toHaveLength(2)
      expect(h.calls[1]?.url).toBe(h.calls[0]?.url as string)
    } finally {
      await executor.dispose()
    }
  })

  // With another account in the pool a failed refresh is retried through
  // selection; the only account's failed refresh is a native 401 instead
  // (see the test below).
  it('retries selection after a failed refresh and sends with the next grant', async () => {
    const h = harness({
      pool: makePool(2),
      refresh: async (auth, attempt) =>
        attempt === 1
          ? undefined
          : { ...auth, access: 'access-second', expires: Date.now() + 3.6e6 },
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(h.refreshed).toHaveLength(2)
      expect(h.calls).toHaveLength(1)
      expect(new Headers(h.calls[0]?.init?.headers).get('authorization')).toBe(
        'Bearer access-second',
      )
    } finally {
      await executor.dispose()
    }
  })

  it('never sends a local grant whose captured check reports it stale', async () => {
    const stale = new Error('row now holds a newer credential')
    const checked: string[] = []
    const h = harness({
      refresh: async (auth) => ({
        ...auth,
        access: 'access-stale',
        expires: Date.now() + 3.6e6,
      }),
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor({
      ...h.deps,
      credentials: {
        ...(h.deps.credentials as LocalRequestCredentials<ManagedAccount>),
        captureGrant: ({ accessToken }) => ({
          source: 'pool-file',
          check() {
            checked.push(accessToken)
            throw stale
          },
        }),
      },
    })
    try {
      await expect(executor.execute(NON_STREAM_URL, CHAT_INIT())).rejects.toBe(
        stale,
      )
      expect(checked).toEqual(
        ANTIGRAVITY_ENDPOINT_FALLBACKS.map(() => 'access-stale'),
      )
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('refuses a send once the row identity captured with the grant changes, even with the same bearer', async () => {
    const pool = makePool(1)
    const h = harness({
      pool,
      refresh: async (auth) => ({
        ...auth,
        access: 'access-kept',
        expires: Date.now() + 3.6e6,
      }),
      respond: async (_call, index) => {
        if (index === 0) {
          // After the grant was resolved and its first send went out, the
          // row now holds another credential; the bearer string is the same.
          const account = pool.getAccounts()[0] as ManagedAccount
          account.parts = { ...account.parts, refreshToken: 'replaced-row' }
          return new Response('missing', { status: 404 })
        }
        return okJson()
      },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      // The second endpoint attempt is refused before transport; the host
      // gets the last upstream answer (the 404) and nothing else is sent.
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(404)
      expect(h.calls).toHaveLength(1)
      expect(h.checkedGrants.map((entry) => entry.accessToken)).toEqual([
        'access-kept',
        'access-kept',
      ])
    } finally {
      await executor.dispose()
    }
  })

  it('keeps the freshly resolved token when project resolution answers from an older cache entry', async () => {
    const h = harness({
      refresh: async (auth) => ({
        ...auth,
        access: 'access-fresh-grant',
        expires: Date.now() + 3.6e6,
      }),
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor({
      ...h.deps,
      credentials: {
        ...(h.deps.credentials as LocalRequestCredentials<ManagedAccount>),
        // Deliberately return an older access token with the same refresh
        // token value and the managed-cached project packed into the record.
        // Project resolution must not replace the freshly resolved access token.
        ensureProject: async (auth) => ({
          auth: {
            ...auth,
            access: 'access-from-older-cache',
            refresh: `${auth.refresh}|managed-cached`,
          },
          effectiveProjectId: 'managed-cached',
        }),
      },
    })
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(new Headers(h.calls[0]?.init?.headers).get('authorization')).toBe(
        'Bearer access-fresh-grant',
      )
      const account = h.pool.getAccounts()[0] as ManagedAccount
      expect(h.pool.toAuthDetails(account).access).toBe('access-fresh-grant')
      expect(h.checkedGrants.map((entry) => entry.accessToken)).toEqual([
        'access-fresh-grant',
      ])
    } finally {
      await executor.dispose()
    }
  })

  it('captures the grant before project resolution, so a row change during it is refused', async () => {
    const pool = makePool(1)
    let release: () => void = () => {}
    let projectStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      projectStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({
      pool,
      refresh: async (auth) => ({
        ...auth,
        access: 'access-original',
        expires: Date.now() + 3.6e6,
      }),
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor({
      ...h.deps,
      credentials: {
        ...(h.deps.credentials as LocalRequestCredentials<ManagedAccount>),
        ensureProject: async (auth) => {
          projectStarted()
          await gate
          return { auth, effectiveProjectId: 'project-effective' }
        },
      },
    })
    try {
      const pending = executor.execute(NON_STREAM_URL, CHAT_INIT())
      await started
      // While project resolution is held, the row now holds another
      // credential; the bearer string is unchanged.
      const account = pool.getAccounts()[0] as ManagedAccount
      account.parts = { ...account.parts, refreshToken: 'replaced-row' }
      release()
      await expect(pending).rejects.toThrow('stale grant')
      expect(h.calls).toHaveLength(0)
    } finally {
      release()
      await executor.dispose()
    }
  })

  it("returns the native 401 when the only account's refresh yields no credential", async () => {
    const h = harness({
      refresh: async () => undefined,
      respond: async () => okJson(),
      config: { max_rate_limit_wait_seconds: 1 },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(401)
      const body = (await response.json()) as {
        error: { status: string; message: string }
      }
      expect(body.error.status).toBe('UNAUTHENTICATED')
      expect(body.error.message).toContain('Missing access token')
      expect(h.refreshed).toHaveLength(1)
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('removes an invalid_grant account and continues on the next one', async () => {
    const pool = makePool(2)
    const h = harness({
      pool,
      refresh: async (auth) => {
        if (auth.refresh.startsWith('refresh-0')) {
          throw new Error('invalid_grant')
        }
        return { ...auth, access: 'access-b', expires: Date.now() + 3.6e6 }
      },
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(pool.getAccountCount()).toBe(1)
      expect(pool.getAccounts()[0]?.parts.refreshToken).toBe('refresh-1')
      expect(h.clearStoredAuth).not.toHaveBeenCalled()
    } finally {
      await executor.dispose()
    }
  })

  it('clears stored auth and returns the no-account 401 when the last grant is revoked', async () => {
    const h = harness({
      refresh: async () => {
        throw new Error('invalid_grant')
      },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(401)
      expect(response.headers.get('x-antigravity-error-type')).toBe(
        'no_accounts',
      )
      expect(h.clearStoredAuth).toHaveBeenCalledTimes(1)
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('rejects with the original transport error object after every endpoint fails', async () => {
    const resetError = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    })
    const h = harness({
      respond: async () => {
        throw resetError
      },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      await expect(executor.execute(STREAM_URL, CHAT_INIT())).rejects.toBe(
        resetError,
      )
      expect(h.calls).toHaveLength(ANTIGRAVITY_ENDPOINT_FALLBACKS.length)
    } finally {
      await executor.dispose()
    }
  })

  it('redacts the actual local project-lookup bearer before cancellation returns its terminal failure', async () => {
    const opaque = 'opaque_project_lookup_748a'
    const failure = Object.assign(new Error(`project lookup echo ${opaque}`), {
      code: 'PROJECT_LOOKUP_FAILED',
    })
    const caller = new AbortController()
    const used: string[] = []
    const h = harness({
      refresh: async (auth) => ({
        ...auth,
        access: opaque,
        expires: Date.now() + 3_600_000,
      }),
      respond: async () => {
        throw new Error('main send must not run')
      },
    })
    const credentials = h.deps
      .credentials as LocalRequestCredentials<ManagedAccount>
    const executor = createRequestExecutor({
      ...h.deps,
      credentials: {
        ...credentials,
        ensureProject: async (auth) => {
          used.push(auth.access ?? '')
          caller.abort(failure)
          throw failure
        },
      },
    })
    try {
      const error = await executor
        .execute(NON_STREAM_URL, CHAT_INIT(caller.signal))
        .catch((error: unknown) => error)
      expect(used).toEqual([opaque])
      expect(h.calls).toHaveLength(0)
      expect(error).toBe(failure)
      expect(failure.code).toBe('PROJECT_LOOKUP_FAILED')
      expect(failure.message).toBe('project lookup echo [credential]')
    } finally {
      await executor.dispose()
    }
  })

  it('vetoes project metadata persistence after public source authority changes during resolution', async () => {
    let local = true
    const h = harness({ respond: async () => okJson() })
    const credentials = h.deps
      .credentials as LocalRequestCredentials<ManagedAccount>
    const update = mock(credentials.updateFromAuth)
    const executor = createRequestExecutor({
      ...h.deps,
      assertAdmission: async () => {
        if (!local) throw new Error('authority changed')
      },
      credentials: {
        ...credentials,
        updateFromAuth: update,
        ensureProject: async (auth) => {
          local = false
          return {
            auth: { ...auth, refresh: 'new-project-metadata' },
            effectiveProjectId: 'new-project',
          }
        },
      },
    })
    try {
      await executor.execute(NON_STREAM_URL, CHAT_INIT()).catch(() => {})
      expect(
        update.mock.calls.filter(
          ([, auth]) => auth.refresh === 'new-project-metadata',
        ),
      ).toHaveLength(0)
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('refuses a physical send after authority changes during the final captured grant await', async () => {
    let local = true
    const h = harness({ respond: async () => okJson() })
    const credentials = h.deps
      .credentials as LocalRequestCredentials<ManagedAccount>
    const executor = createRequestExecutor({
      ...h.deps,
      assertAdmission: async () => {
        if (!local) throw new Error('authority changed')
      },
      credentials: {
        ...credentials,
        captureGrant: () => ({
          source: 'pool-file',
          check: async () => {
            local = false
          },
        }),
      },
    })
    try {
      await executor.execute(NON_STREAM_URL, CHAT_INIT()).catch(() => {})
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  for (const source of ['transport', 'http', 'sse'] as const) {
    it(`redacts selected credential in composed OpenCode ${source} errors`, async () => {
      const detail =
        'echo access-fresh Bearer another-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
      const failure = Object.assign(new Error(detail), {
        code: 'ECONNRESET',
        detail,
        cause: new Error(detail),
      })
      const h = harness({
        respond: async () => {
          if (source === 'transport') throw failure
          return new Response(
            source === 'http'
              ? JSON.stringify({
                  error: {
                    code: 400,
                    status: 'INVALID_ARGUMENT',
                    message: detail,
                  },
                })
              : `data: ${JSON.stringify({ response: { error: { code: 400, message: detail } } })}\n\n`,
            {
              status: source === 'http' ? 400 : 200,
              headers: {
                'content-type':
                  source === 'http' ? 'application/json' : 'text/event-stream',
              },
            },
          )
        },
      })
      const executor = createRequestExecutor(h.deps)
      try {
        if (source === 'transport') {
          const error = await executor
            .execute(STREAM_URL, CHAT_INIT())
            .catch((error: unknown) => error)
          expect(error).toBe(failure)
          expect(failure.code).toBe('ECONNRESET')
          expect(failure.cause).toBeUndefined()
          for (const text of [
            failure.message,
            failure.stack!,
            failure.detail,
          ]) {
            expect(text).not.toContain('access-fresh')
            expect(text).not.toContain('another-token')
            expect(text).not.toContain('eyJ')
          }
        } else {
          const response = await executor.execute(
            source === 'http' ? NON_STREAM_URL : STREAM_URL,
            CHAT_INIT(),
          )
          expect(response.status).toBe(source === 'http' ? 400 : 200)
          const text = await response.text()
          expect(text).not.toContain('access-fresh')
          expect(text).not.toContain('another-token')
          expect(text).not.toContain('eyJ')
          expect(text).toContain('[credential]')
          expect(text).toContain('400')
        }
      } finally {
        await executor.dispose()
      }
    })
  }

  it('redacts immutable terminal transport errors without losing their retry classification', async () => {
    const failure = Object.freeze(
      Object.assign(new Error('echo access-fresh'), {
        code: 'ECONNRESET',
        status: 503,
      }),
    )
    const h = harness({
      respond: async () => {
        throw failure
      },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const error = await executor
        .execute(STREAM_URL, CHAT_INIT())
        .catch((error: unknown) => error)
      expect(error).not.toBe(failure)
      expect(error).toMatchObject({
        message: 'echo [credential]',
        code: 'ECONNRESET',
        status: 503,
      })
      expect(h.calls).toHaveLength(ANTIGRAVITY_ENDPOINT_FALLBACKS.length)
    } finally {
      await executor.dispose()
    }
  })

  for (const host of ['v1', 'ga'] as const) {
    it(`preserves transformed successful ${host} output bytes containing credentials and error-looking text`, async () => {
      const text =
        'access-fresh Bearer another-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature {"error":"access-fresh"}'
      const h = harness({
        respond: async () =>
          new Response(
            `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      })
      let transformed: Response | undefined
      const executor = createRequestExecutor({
        ...h.deps,
        wire: {
          ...WIRE,
          transformResponse: async (...args) => {
            const response = await WIRE.transformResponse(...args)
            transformed = response.clone()
            return response
          },
        },
      })
      const bridge =
        host === 'ga'
          ? await startGaLoopbackBridge({
              execute: createGaJobExecutor(executor),
              send: async () => {
                throw new Error('unused raw sender')
              },
            })
          : undefined
      try {
        const response = bridge
          ? await fetch(
              bridge.rewrite(
                new Request(STREAM_URL, CHAT_INIT()),
                {
                  sessionID: 'success-ga',
                  parentSessionID: null,
                  kind: 'primary',
                  modelID: 'gemini-3-flash',
                  variant: null,
                  url: STREAM_URL,
                  body: String(CHAT_INIT().body),
                },
                {
                  HTTP_PROXY: undefined,
                  HTTPS_PROXY: undefined,
                  ALL_PROXY: undefined,
                },
              ),
            )
          : await executor.execute(STREAM_URL, CHAT_INIT())
        if (!transformed)
          throw new Error('the host response was not transformed')
        const [before, after] = await Promise.all([
          transformed.arrayBuffer(),
          response.arrayBuffer(),
        ])
        expect(new Uint8Array(after)).toEqual(new Uint8Array(before))
        expect(new TextDecoder().decode(after)).toContain(
          text.replaceAll('"', '\\"'),
        )
        expect(response.status).toBe(transformed.status)
        expect(h.calls).toHaveLength(1)
      } finally {
        await bridge?.dispose()
        await executor.dispose()
      }
    })
  }

  for (const source of ['transport', 'http', 'sse'] as const) {
    it(`redacts selected credential through GA host bridge ${source}`, async () => {
      const detail =
        'echo access-fresh Bearer another-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
      const h = harness({
        respond: async () => {
          if (source === 'transport') throw new Error(detail)
          return new Response(
            source === 'http'
              ? JSON.stringify({ error: { code: 400, message: detail } })
              : `data: ${JSON.stringify({ response: { error: { code: 400, message: detail } } })}\n\n`,
            {
              status: source === 'http' ? 400 : 200,
              headers: {
                'content-type':
                  source === 'http' ? 'application/json' : 'text/event-stream',
              },
            },
          )
        },
      })
      const executor = createRequestExecutor(h.deps)
      const bridge = await startGaLoopbackBridge({
        execute: createGaJobExecutor(executor),
        send: async () => {
          throw new Error('unused raw sender')
        },
      })
      try {
        const url = source === 'http' ? NON_STREAM_URL : STREAM_URL
        const request = new Request(url, CHAT_INIT())
        const rewritten = bridge.rewrite(
          request,
          {
            sessionID: 'redaction-ga',
            parentSessionID: null,
            kind: 'primary',
            modelID: 'gemini-3-flash',
            variant: null,
            url,
            body: String(CHAT_INIT().body),
          },
          {
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            ALL_PROXY: undefined,
          },
        )
        const response = await fetch(rewritten)
        expect(response.status).toBe(
          source === 'transport' ? 502 : source === 'http' ? 400 : 200,
        )
        const text = await response.text()
        expect(text).not.toContain('access-fresh')
        expect(text).not.toContain('another-token')
        expect(text).not.toContain('eyJ')
        expect(text).toContain('[credential]')
      } finally {
        await bridge.dispose()
        await executor.dispose()
      }
    })
  }

  it('returns the last upstream response when the only account is ineligible', async () => {
    const pool = makePool(1)
    const h = harness({
      pool,
      respond: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'ACCOUNT_INELIGIBLE',
              details: [{ reason: 'account_ineligible' }],
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(CLAUDE_URL, CHAT_INIT())
      expect(response.status).toBe(403)
      expect(h.calls).toHaveLength(1)
      expect(pool.getAccounts()[0]?.enabled).toBe(false)
    } finally {
      await executor.dispose()
    }
  })
})

/** Vault credentials over the harness pool's rows: only `admit` exists. */
function vaultDeps(
  h: Harness,
  admit: (account: ManagedAccount) => Promise<RequestSendAdmission>,
): RequestServicesDeps<ManagedAccount> {
  return {
    ...h.deps,
    credentials: {
      domain: 'vault',
      admit: async ({ account }) => admit(account),
    },
  }
}

describe('createRequestExecutor vault admissions', () => {
  it('scrubs distinct auxiliary vault bearers before cache-warmup diagnostics reach the sink', async () => {
    const mainToken = 'opaque_primary_vault_24a'
    const auxiliaryToken = 'opaque_auxiliary_vault_95b'
    let admissions = 0
    const diagnostics: string[] = []
    const h = harness({
      pool: makePool(2),
      config: {
        cache_warmup_on_switch: true,
        switch_on_first_rate_limit: true,
        max_rate_limit_wait_seconds: 0,
      },
      respond: async (call, index) => {
        const bearer = new Headers(call.init?.headers).get('authorization')
        if (bearer === `Bearer ${auxiliaryToken}`) {
          call.options?.onDebug?.(`auxiliary-trace echo ${auxiliaryToken}`)
          throw new Error(`echo ${auxiliaryToken}`)
        }
        expect(bearer).toBe(`Bearer ${mainToken}`)
        if (index === 0)
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                status: 'RESOURCE_EXHAUSTED',
                message: 'rate limit exceeded',
              },
            }),
            {
              status: 429,
              headers: {
                'retry-after': '3600',
                'content-type': 'application/json',
              },
            },
          )
        return okJson()
      },
    })
    const dependencies = vaultDeps(h, async (account) => ({
      credentialId: `credential-${account.index}`,
      accountIdentity: `identity-${account.index}`,
      recordVersion: 1,
      accessToken: admissions++ === 2 ? auxiliaryToken : mainToken,
      projectId: 'project-effective',
      report401: async () => {},
    }))
    const executor = createRequestExecutor({
      ...dependencies,
      debug: { ...dependencies.debug, isDebugEnabled: () => true },
      wire: {
        ...WIRE,
        transformResponse: async (...args) => {
          diagnostics.push(...(args[11] ?? []))
          return WIRE.transformResponse(...args)
        },
      },
    })
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
        }),
      )
      expect(admissions).toBe(3)
      expect(h.calls).toHaveLength(3)
      expect(diagnostics.join('\n')).toContain(
        'cache-warmup-probe: failed echo [credential]',
      )
      expect(diagnostics.join('\n')).toContain(
        'auxiliary-trace echo [credential]',
      )
      expect(diagnostics.join('\n')).not.toContain(auxiliaryToken)
      expect(diagnostics.join('\n')).not.toContain(mainToken)
    } finally {
      await executor.dispose()
    }
  })

  it('admits every physical send and sends with that admission only', async () => {
    const admitted: number[] = []
    const h = harness({
      refresh: async () => {
        throw new Error('vault sends must not refresh')
      },
      respond: async (_call, index) =>
        index === 0 ? new Response('missing', { status: 404 }) : okJson(),
    })
    const executor = createRequestExecutor(
      vaultDeps(h, async (account) => {
        const n = admitted.length
        admitted.push(account.index)
        return {
          credentialId: 'credential-a',
          accountIdentity: 'identity-a',
          recordVersion: 1,
          accessToken: `admission-${n}`,
          projectId: `admission-project-${n}`,
          report401: async () => {},
        }
      }),
    )
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(admitted).toEqual([0, 0])
      expect(
        h.calls.map((call) =>
          new Headers(call.init?.headers).get('authorization'),
        ),
      ).toEqual(['Bearer admission-0', 'Bearer admission-1'])
      expect(
        h.calls.map(
          (call) =>
            (JSON.parse(String(call.init?.body)) as { project: string })
              .project,
        ),
      ).toEqual(['admission-project-0', 'admission-project-1'])
      expect(h.refreshed).toEqual([])
      // No admission is written into the pool's stored credential fields.
      expect(h.pool.getAccounts()[0]?.access).toBeUndefined()
      expect(h.pool.getAccounts()[0]?.parts.refreshToken).toBe('refresh-0')
    } finally {
      await executor.dispose()
    }
  })

  it('reports a 401 against its admission and keeps it when the vault serves no newer version', async () => {
    const reports: Array<{ admission: string; status: number }> = []
    let issued = 0
    const h = harness({
      respond: async () =>
        new Response('{"error":{"code":401}}', { status: 401 }),
    })
    const executor = createRequestExecutor(
      vaultDeps(h, async () => {
        const admission = `admission-${issued++}`
        return {
          credentialId: 'credential-a',
          accountIdentity: 'identity-a',
          recordVersion: 1,
          accessToken: admission,
          projectId: 'admission-project',
          report401: async (status) => {
            reports.push({ admission, status })
          },
        }
      }),
    )
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(401)
      await Promise.resolve()
      await Promise.resolve()
      expect(reports).toEqual([{ admission: 'admission-0', status: 401 }])
      expect(h.calls).toHaveLength(1)
      expect(issued).toBe(2)
    } finally {
      await executor.dispose()
    }
  })
})

describe('createRequestExecutor vault 401 rotation', () => {
  it('retries the same endpoint once with a newer version of the same credential', async () => {
    const reports: Array<{ version: number; status: number }> = []
    const versions = [1, 2]
    const h = harness({
      respond: async (_call, index) =>
        index === 0
          ? new Response('{"error":{"code":401}}', { status: 401 })
          : okJson(),
    })
    const executor = createRequestExecutor(
      vaultDeps(h, async () => {
        const version = versions.shift() ?? 99
        return {
          credentialId: 'credential-a',
          accountIdentity: 'identity-a',
          recordVersion: version,
          accessToken: `token-v${version}`,
          projectId: 'admission-project',
          report401: async (status) => {
            reports.push({ version, status })
          },
        }
      }),
    )
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(reports).toEqual([{ version: 1, status: 401 }])
      expect(
        h.calls.map((call) =>
          new Headers(call.init?.headers).get('authorization'),
        ),
      ).toEqual(['Bearer token-v1', 'Bearer token-v2'])
      expect(h.calls[1]?.url).toBe(h.calls[0]?.url as string)
    } finally {
      await executor.dispose()
    }
  })

  it('does not retry a 401 on a rotated admission for another account', async () => {
    const identities = ['identity-a', 'identity-b']
    let version = 0
    const h = harness({
      respond: async () =>
        new Response('{"error":{"code":401}}', { status: 401 }),
    })
    const executor = createRequestExecutor(
      vaultDeps(h, async () => {
        version += 1
        return {
          credentialId: 'credential-a',
          accountIdentity: identities.shift() ?? 'identity-z',
          recordVersion: version,
          accessToken: `token-v${version}`,
          projectId: 'admission-project',
          report401: async () => {},
        }
      }),
    )
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(401)
      expect(h.calls).toHaveLength(1)
    } finally {
      await executor.dispose()
    }
  })
})

describe('createRequestExecutor local refresh attribution', () => {
  it('refreshes exactly the selected row when two rows share a refresh token, and sends its successor', async () => {
    const pool = new CoreAccountManager(
      undefined,
      {
        ...storedAccounts(2),
        // Two distinct rows with the same refresh token and projects.
        accounts: storedAccounts(2).accounts.map((account) => ({
          ...account,
          refreshToken: 'refresh-duplicated',
          projectId: 'project-shared',
          managedProjectId: 'managed-shared',
        })),
      },
      {
        store: memoryStore(),
        storagePath: join(testRoot(), 'memory-accounts.json'),
      },
    )
    managers.push(pool)
    // Row 0 is ineligible, so selection lands on row 1; a lookup by refresh
    // token would find row 0 instead.
    pool.markAccountIneligible(0, 'test: not selectable')
    const h = harness({
      pool,
      refresh: async (auth) => ({
        ...auth,
        access: 'access-rotated',
        expires: Date.now() + 3.6e6,
      }),
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      const selectedRow = pool.getAccounts()[1]
      expect(h.refreshedAccounts).toHaveLength(1)
      expect(h.refreshedAccounts[0]).toBe(selectedRow as ManagedAccount)
      expect(h.checkedGrants).toEqual([
        {
          account: selectedRow as ManagedAccount,
          accessToken: 'access-rotated',
        },
      ])
      expect(new Headers(h.calls[0]?.init?.headers).get('authorization')).toBe(
        'Bearer access-rotated',
      )
    } finally {
      await executor.dispose()
    }
  })
})

describe('createRequestExecutor request kinds', () => {
  const TITLE_PROMPT_BODY = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Generate a title for this conversation:\n' }],
      },
      { role: 'user', parts: [{ text: 'Generate a red triangle' }] },
    ],
  })

  it('sends a title on an unregistered model to the title fallback model', async () => {
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor(h.deps)
    try {
      await executor.execute(
        modelUrl('some-host-model', 'generateContent'),
        CHAT_INIT(),
        { kind: 'title' },
      )
      expect(h.calls).toHaveLength(1)
      const envelope = JSON.parse(String(h.calls[0]?.init?.body)) as {
        model: string
      }
      expect(envelope.model).toBe(
        prepareAntigravityRequest(
          modelUrl(TITLE_FALLBACK_MODEL, 'generateContent'),
          CHAT_INIT(),
          'token',
          'project',
        ).effectiveModel as string,
      )
    } finally {
      await executor.dispose()
    }
  })

  it('keeps a registered text model for a title request', () => {
    const url = modelUrl('gemini-3.5-flash-low', 'generateContent')
    expect(routeTitleModel(url)).toBe(url)
    expect(routeTitleModel(modelUrl('gemini-3.1-flash-image'))).toBe(
      modelUrl(TITLE_FALLBACK_MODEL),
    )
  })

  it('answers an image-model title locally only for the title kind', async () => {
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor(h.deps)
    const url = modelUrl('antigravity-gemini-3.1-flash-image')
    try {
      const title = await executor.execute(
        url,
        { method: 'POST', body: TITLE_PROMPT_BODY },
        { kind: 'title' },
      )
      expect(title.headers.get('x-antigravity-response-type')).toBe(
        'local_title',
      )
      expect(h.calls).toHaveLength(0)

      const primary = await executor.execute(
        url,
        { method: 'POST', body: TITLE_PROMPT_BODY },
        { kind: 'primary' },
      )
      expect(primary.headers.get('x-antigravity-response-type')).toBeNull()
      expect(h.calls).toHaveLength(1)
    } finally {
      await executor.dispose()
    }
  })

  it('keeps title metadata out of the primary conversation step sequence', async () => {
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor(h.deps)
    const withTitle = { sessionId: 'kind-session-a', parentSessionId: null }
    const control = { sessionId: 'kind-session-b', parentSessionId: null }
    // requestId is agent/<conversation>/<timestamp>/<trajectory>/<step>.
    const requestId = (index: number) =>
      (
        JSON.parse(String(h.calls[index]?.init?.body)) as { requestId: string }
      ).requestId.split('/')
    try {
      const send = (session: typeof withTitle, kind: 'primary' | 'title') =>
        executor.execute(NON_STREAM_URL, CHAT_INIT(), { session, kind })
      await send(withTitle, 'primary')
      await send(withTitle, 'title')
      await send(withTitle, 'primary')
      await send(control, 'primary')
      await send(control, 'primary')
      const [a1, title, a2, b1, b2] = [0, 1, 2, 3, 4].map(requestId)
      expect(a2?.[3]).toBe(a1?.[3] as string)
      expect(title?.[3]).not.toBe(a1?.[3] as string)
      // The primary step advances by the same amount with or without a
      // title request in between.
      expect(Number(a2?.[4]) - Number(a1?.[4])).toBe(
        Number(b2?.[4]) - Number(b1?.[4]),
      )
    } finally {
      await executor.dispose()
    }
  })
})

const REPLAY_SIGNATURE = 'x'.repeat(64)

describe('createRequestWire location state', () => {
  function locationWire(keepThinking: boolean) {
    const location = createRequestWireLocation({
      signatures: {
        keepThinking,
        signatureStore: createSignatureStore(),
        cacheSignature: () => {},
        // Every thought is known to this location's cache under its signature.
        getCachedSignature: () => REPLAY_SIGNATURE,
      },
      debug: createLocationDebug({ ...DEFAULT_CONFIG, debug: false }),
      logger: createLocationLogger({ sinkEnabled: () => false }).createLogger(
        'wire-test',
      ),
    })
    return { location, wire: createRequestWire(location) }
  }

  it('records prompt-cache statistics only in the location that saw them', async () => {
    const a = locationWire(false)
    const b = locationWire(false)
    const openCode1Before = getLastCacheStats()
    const sse = `data: ${JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          totalTokenCount: 120,
        },
      },
    })}\n\n`
    const response = await a.wire.transformResponse(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
      true,
      null,
      'gemini-3-flash',
      'project',
      ANTIGRAVITY_ENDPOINT_FALLBACKS[0],
      'gemini-3-flash',
      'session',
    )
    await response.text()
    expect(a.wire.getLastCacheStats()).toMatchObject({
      model: 'gemini-3-flash',
      read: 40,
      total: 100,
    })
    expect(b.wire.getLastCacheStats()).toBeNull()
    expect(getLastCacheStats()).toBe(openCode1Before)
  })
})

// These policies are Antigravity-owned and deliberately not delegated to the
// common-auth routing admission: its gates refuse a row with no quota reading
// and keep one rate-limit mark per row, where Antigravity selection fails open
// on missing quota and keeps marks per quota key (family, model, header style).
describe('Antigravity-owned selection policy', () => {
  const killswitchOn = {
    get: () => ({
      routing: { cli_first: false, quota_style_fallback: false },
      killswitch: { enabled: true, minimum_remaining_percent: 50 },
      log_level: 'info' as const,
    }),
  }

  it('dispatches on an account with no quota reading while the killswitch is on', async () => {
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor({
      ...h.deps,
      operatorSettings: killswitchOn,
    })
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(200)
      expect(h.calls).toHaveLength(1)
    } finally {
      await executor.dispose()
    }
  })

  it('refuses with a native 412 once a fresh reading is below the floor', async () => {
    const pool = makePool(1)
    const h = harness({ pool, respond: async () => okJson() })
    pool.updateQuotaCache(
      0,
      {
        gemini: {
          remainingFraction: 0.1,
          resetTime: new Date(Date.now() + 3_600_000).toISOString(),
          modelCount: 1,
        },
      },
      pool.getAccounts()[0]?.parts.refreshToken,
    )
    const executor = createRequestExecutor({
      ...h.deps,
      operatorSettings: killswitchOn,
    })
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response.status).toBe(412)
      expect(h.calls).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('keeps a Claude rate-limit mark from blocking a Gemini request on the same account', async () => {
    const pool = makePool(1)
    const h = harness({
      pool,
      respond: async () => okJson(),
      config: { max_rate_limit_wait_seconds: 1 },
    })
    const account = pool.getAccounts()[0] as ManagedAccount
    pool.markRateLimited(
      account,
      600_000,
      'claude',
      'antigravity',
      'claude-sonnet-4-6',
    )
    const executor = createRequestExecutor(h.deps)
    try {
      const gemini = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(gemini.status).toBe(200)
      expect(h.calls).toHaveLength(1)

      const claude = await executor.execute(CLAUDE_URL, CHAT_INIT())
      expect(claude.status).toBe(412)
      expect(h.calls).toHaveLength(1)
    } finally {
      await executor.dispose()
    }
  })
})

describe('createRequestExecutor per-request sender', () => {
  it("sends through the request's own raw sender with request-specific cancellation", async () => {
    const controller = new AbortController()
    const h = harness({
      respond: async () => {
        throw new Error('location transport must not be used')
      },
    })
    const sent: TransportCall[] = []
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(
        NON_STREAM_URL,
        CHAT_INIT(controller.signal),
        {
          session: { sessionId: 'ga-session', parentSessionId: null },
          transport: async (url, init, options) => {
            sent.push({ url, init, options })
            return okJson()
          },
        },
      )
      expect(response.status).toBe(200)
      expect(h.calls).toHaveLength(0)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.options?.signal).toBeInstanceOf(AbortSignal)
      expect(sent[0]?.options?.signal?.aborted).toBe(false)
      await response.text()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(new URL(sent[0]?.url ?? '').origin).toBe(
        ANTIGRAVITY_ENDPOINT_FALLBACKS[0],
      )
    } finally {
      await executor.dispose()
    }
  })
})

describe('createRequestExecutor cancellation and overflow', () => {
  it('propagates the caller exact abort reason to an admitted physical send', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled the physical send')
    let start: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let physicalReason: unknown
    const h = harness({
      respond: async (call) => {
        const signal = call.options?.signal
        if (!signal) throw new Error('Physical send requires a signal')
        start()
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              physicalReason = signal.reason
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    })
    const executor = createRequestExecutor(h.deps)
    const outcome = executor
      .execute(NON_STREAM_URL, CHAT_INIT(controller.signal))
      .then(
        (value) => ({ kind: 'response' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
    try {
      await started
      controller.abort(reason)
      expect(physicalReason).toBe(reason)
      expect(await outcome).toEqual({ kind: 'error', error: reason })
      expect(h.calls).toHaveLength(1)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      await executor.dispose()
      await outcome
    }
  })

  it('final shutdown aborts physical I/O and waits for its cleanup', async () => {
    const controller = new AbortController()
    let start: () => void = () => {}
    let release: () => void = () => {}
    let aborted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const heldCleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const shutdownObserved = new Promise<void>((resolve) => {
      aborted = resolve
    })
    let physicalReason: unknown
    let cleaned = false
    const h = harness({
      respond: async (call) => {
        const signal = call.options?.signal
        if (!signal) throw new Error('Physical send requires a signal')
        start()
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              physicalReason = signal.reason
              aborted()
              void heldCleanup.then(() => {
                cleaned = true
                reject(signal.reason)
              })
            },
            { once: true },
          )
        })
      },
    })
    const executor = createRequestExecutor(h.deps)
    const outcome = executor
      .execute(NON_STREAM_URL, CHAT_INIT(controller.signal))
      .then(
        (value) => ({ kind: 'response' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
    try {
      await started
      let closed = false
      const disposal = executor.dispose()
      void disposal.then(() => {
        closed = true
      })
      expect(physicalReason).toBeInstanceOf(Error)
      await shutdownObserved
      expect(physicalReason).toMatchObject({
        message: 'The Antigravity request executor is disposed',
      })
      expect(controller.signal.aborted).toBe(false)
      expect(cleaned).toBe(false)
      expect(closed).toBe(false)
      release()
      await disposal
      expect(cleaned).toBe(true)
      expect(await outcome).toEqual({ kind: 'error', error: physicalReason })
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      release()
      controller.abort(new Error('Test fixture cleanup'))
      await executor.dispose()
      await outcome
    }
  })

  it('retirement keeps an admitted send and its body, refuses new requests, and resolves after both finish', async () => {
    let start: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let respond: () => void = () => {}
    const responded = new Promise<void>((resolve) => {
      respond = resolve
    })
    const held = heldSse('retired-first', 'retired-last')
    let physicalAborted = false
    const h = harness({
      respond: async (call) => {
        call.options?.signal?.addEventListener('abort', () => {
          physicalAborted = true
        })
        start()
        await responded
        return held.response
      },
    })
    const executor = createRequestExecutor(h.deps)
    const outcome = executor.execute(STREAM_URL, CHAT_INIT()).then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    try {
      await started
      let retired = false
      const retirement = executor.retire()
      void retirement.then(() => {
        retired = true
      })
      // Observed rather than awaited: a request the retired executor wrongly
      // admitted would wait on the held send below.
      const refused = executor.execute(STREAM_URL, CHAT_INIT()).then(
        () => 'sent',
        (error: unknown) => (error instanceof Error ? error.message : error),
      )

      respond()
      expect(await refused).toBe('The Antigravity request executor is retired')
      const result = await outcome
      if (result.kind !== 'response') throw result.error
      expect(h.calls).toHaveLength(1)
      const reader = result.response.body?.getReader()
      if (!reader) throw new Error('The stream has no body')
      expect(await readFirstEvent(reader)).toContain('retired-first')
      expect(retired).toBe(false)
      held.finish()
      expect(await readRest(reader)).toContain('retired-last')
      await retirement
      expect(retired).toBe(true)
      expect(physicalAborted).toBe(false)
      expect(held.cancelled()).toBe(false)
    } finally {
      respond()
      held.finish()
      await executor.dispose()
      await outcome
    }
  })

  it('disposal after retirement aborts the retired body and ends the retirement', async () => {
    const held = heldSse('retired-first', 'never-sent')
    const h = harness({ respond: async () => held.response })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(STREAM_URL, CHAT_INIT())
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The stream has no body')
      expect(await readFirstEvent(reader)).toContain('retired-first')
      const nextRead = observeRead(reader)
      let retired = false
      const retirement = executor.retire()
      void retirement.then(() => {
        retired = true
      })
      await Promise.resolve()
      expect(retired).toBe(false)

      await executor.dispose()
      expect(await nextRead).toMatchObject({
        kind: 'error',
        error: { message: 'The Antigravity request executor is disposed' },
      })
      await retirement
      expect(retired).toBe(true)
      expect(held.cancelled()).toBe(true)
    } finally {
      held.finish()
      await executor.dispose()
    }
  })

  it('an authority transition preserves admitted physical work and refuses the next local request', async () => {
    const controller = new AbortController()
    let authority: 'local' | 'vault' = 'local'
    let start: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const heldSend = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({
      respond: async () => {
        start()
        await heldSend
        return okJson()
      },
    })
    const executor = createRequestExecutor({
      ...h.deps,
      assertAdmission: async () => {
        if (authority !== 'local')
          throw new Error('Local execution refused under vault custody')
      },
    })
    const pending = executor.execute(
      NON_STREAM_URL,
      CHAT_INIT(controller.signal),
    )
    const outcome = pending.then(
      (value) => ({ kind: 'response' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    try {
      await started
      authority = 'vault'
      expect(h.calls[0]?.options?.signal?.aborted).toBe(false)
      release()
      const response = await pending
      expect(response.status).toBe(200)
      await response.text()
      await expect(
        executor.execute(NON_STREAM_URL, CHAT_INIT(controller.signal)),
      ).rejects.toThrow('Local execution refused under vault custody')
      expect(h.calls).toHaveLength(1)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      release()
      await executor.dispose()
      await outcome
    }
  })

  // Cancellation during backoff must preserve the caller's reason and
  // prevent a later endpoint attempt from doing network I/O.
  it('rejects with the abort reason when cancelled during a retry wait', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const h = harness({
      respond: async (call) => {
        if (call.options?.signal?.aborted) throw call.options.signal.reason
        // Abort while the engine sleeps before the capacity retry.
        setTimeout(() => controller.abort(reason), 10)
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: 'No capacity available for model',
              details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
            },
          }),
          { status: 503 },
        )
      },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      await expect(
        executor.execute(NON_STREAM_URL, CHAT_INIT(controller.signal)),
      ).rejects.toBe(reason)
      expect(h.calls.length).toBeGreaterThanOrEqual(1)
      expect(h.calls.length).toBeLessThanOrEqual(
        ANTIGRAVITY_ENDPOINT_FALLBACKS.length,
      )
    } finally {
      await executor.dispose()
    }
  })

  it('returns the original context-overflow response unread, without rotating', async () => {
    const pool = makePool(2)
    const payload =
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Prompt is too long"}}'
    const original = new Response(payload, {
      status: 400,
      headers: { 'content-type': 'application/json', 'x-overflow': 'kept' },
    })
    const notices: string[] = []
    const h = harness({
      pool,
      respond: async () => original,
      notify: (message) => {
        notices.push(message)
        return undefined
      },
      config: { quiet_mode: false },
    })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
      expect(response).toBe(original)
      expect(response.bodyUsed).toBe(false)
      expect(await response.text()).toBe(payload)
      expect(h.calls).toHaveLength(1)
      expect(notices).toEqual([
        'Using account-0@example.test (1/2)',
        'Context too long - use /compact to reduce size',
      ])
      expect(pool.getAccounts().map((account) => account.enabled)).toEqual([
        true,
        true,
      ])
    } finally {
      await executor.dispose()
    }
  })

  it('serves local image-model titles without selecting an account', async () => {
    const h = harness()
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(
        modelUrl('antigravity-gemini-3.1-flash-image', 'streamGenerateContent'),
        {
          method: 'POST',
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: 'Generate a title for this conversation:\n' }],
              },
              { role: 'user', parts: [{ text: 'Generate a red triangle' }] },
            ],
          }),
        },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('x-antigravity-response-type')).toBe(
        'local_title',
      )
      const text = await response.text()
      expect(JSON.parse(text.slice('data: '.length).trim())).toMatchObject({
        candidates: [
          { content: { parts: [{ text: 'Generate a red triangle' }] } },
        ],
      })
      expect(h.calls).toHaveLength(0)
      expect(h.refreshed).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })
})

// =============================================================================
// OpenCode 1 runtime replacement
//
// The auth loader replaces its local request runtime after an account is added,
// on the first local requests after vault custody ends, and when the host runs
// the loader again. These cases compose the real loader with the real request
// executor over an owned account pool, so any abort they observe comes from the
// executor's own cancellation, not from a fixture.
// =============================================================================

type ReadOutcome =
  | { kind: 'chunk'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown }

const sseDecoder = new TextDecoder()

function sseEvent(text: string): string {
  return `data: ${JSON.stringify({
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    },
  })}\n\n`
}

/** An upstream SSE body that sends its first event and holds until `finish`. */
function heldSse(firstText: string, lastText: string) {
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      controller.enqueue(new TextEncoder().encode(sseEvent(firstText)))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
    /** Whether the reader of this upstream body cancelled it. */
    cancelled: () => cancelled,
    finish() {
      // A body the executor already cancelled refuses further events; the
      // test then reports what the reader observed instead.
      try {
        output?.enqueue(new TextEncoder().encode(sseEvent(lastText)))
        output?.close()
      } catch {}
    },
  }
}

function completeSse(text: string): Response {
  return new Response(sseEvent(text), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function observeRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadOutcome> {
  return reader.read().then(
    (next): ReadOutcome =>
      next.done
        ? { kind: 'done' }
        : { kind: 'chunk', text: sseDecoder.decode(next.value) },
    (error: unknown): ReadOutcome => ({ kind: 'error', error }),
  )
}

/**
 * Reads the transformed stream through the end of its first SSE event, so
 * the next read waits on the held upstream body.
 */
async function readFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  let text = ''
  while (!text.endsWith('\n\n')) {
    const next = await reader.read()
    if (next.done) throw new Error(`The stream ended early after: ${text}`)
    text += sseDecoder.decode(next.value)
  }
  return text
}

async function readRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  let text = ''
  for (;;) {
    const next = await reader.read()
    if (next.done) return text
    text += sseDecoder.decode(next.value)
  }
}

function chatInit(text: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
  }
}

describe('OpenCode 1 runtime replacement with admitted streams', () => {
  const provider = {
    id: 'google',
    name: 'Google',
    source: 'custom',
    env: [],
    options: {},
    models: {},
  } as never
  const getAuth = (async () => ({
    type: 'oauth' as const,
    refresh: 'refresh-0|project-0|managed-0',
    access: 'access',
    expires: 100,
  })) as unknown as GetAuth

  type LoadedFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>

  function runtimeLoader(options: {
    respond: (call: TransportCall) => Promise<Response>
    refresh?: (
      auth: OAuthAuthDetails,
      attempt: number,
    ) => Promise<OAuthAuthDetails | undefined>
    readAuthority?: () => Promise<EnrollmentAuthority>
    beforeLoad?: (loadNumber: number) => Promise<void>
  }) {
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState() {},
    })
    // Every loaded manager writes to one store, as the pool file is shared
    // by every manager loaded from it; each save is recorded in order.
    const store = memoryStore()
    const saves: Array<{ load: number; refreshTokens: string[] }> = []
    const events: string[] = []
    // Settles when the manager of each load (1-based) has been disposed.
    const disposed = new Map<number, Promise<void>>()
    let loadNumber = 0
    const loadAccountManager = mock(async () => {
      loadNumber += 1
      const load = loadNumber
      await options.beforeLoad?.(load)
      const pool = makePool(1, {
        ...store,
        saveMerged: async (path, next) => {
          saves.push({
            load,
            refreshTokens: next.accounts.map((entry) => entry.refreshToken),
          })
          return store.saveMerged(path, next)
        },
      })
      const dispose = pool.dispose.bind(pool)
      let markDisposed: () => void = () => {}
      disposed.set(
        load,
        new Promise<void>((resolve) => {
          markDisposed = resolve
        }),
      )
      pool.dispose = async () => {
        await dispose()
        events.push(`manager ${load} disposed`)
        markDisposed()
      }
      return pool as never
    })
    const runtimes: CoreAccountManager[] = []
    const loader = createAuthLoader({
      publishSidebar: async () => {},
      client: {
        auth: { set: mock(async () => {}) },
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: { ...DEFAULT_CONFIG, proactive_token_refresh: false },
      lifecycle,
      ...(options.readAuthority && {
        readAuthority: options.readAuthority,
        createVaultFetch: async () => ({
          fetch: async () => new Response('vault-response'),
          dispose() {},
        }),
      }),
      createFetch: ({ accountManager }) => {
        runtimes.push(accountManager)
        const executor = createRequestExecutor(
          harness({
            pool: accountManager,
            respond: options.respond,
            ...(options.refresh && { refresh: options.refresh }),
          }).deps,
        )
        return {
          fetch: (input, init) => executor.execute(input, init),
          retire: () => executor.retire(),
          dispose: () => executor.dispose(),
        }
      },
      dependencies: {
        openAccountStore: async () =>
          ({ status: 'initialization-required' }) as const,
        loadAccounts: async () => null,
        clearAccounts: async () => {},
        loadAccountManager,
      },
    })
    const load = async (): Promise<LoadedFetch> => {
      const loaded = await loader(getAuth, provider)
      if (!('fetch' in loaded) || typeof loaded.fetch !== 'function')
        throw new Error('The loader returned no fetch')
      return loaded.fetch as LoadedFetch
    }
    return {
      lifecycle,
      loader,
      load,
      loadAccountManager,
      runtimes,
      saves,
      events,
      disposed,
    }
  }

  it('a reload keeps a stream admitted by the replaced runtime alive', async () => {
    const held = heldSse('first-part', 'last-part')
    let sends = 0
    const { lifecycle, loader, load, runtimes, events, disposed } =
      runtimeLoader({
        respond: async () =>
          sends++ === 0 ? held.response : completeSse('after-reload'),
      })
    try {
      const fetch = await load()
      const response = await fetch(STREAM_URL, chatInit('streaming'))
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The stream has no body')
      expect(await readFirstEvent(reader)).toContain('first-part')
      let pendingRead: ReadOutcome | undefined
      const nextRead = observeRead(reader)
      void nextRead.then((outcome) => {
        pendingRead = outcome
      })

      // What the OAuth add flow does once the new account is persisted.
      await loader.reload(getAuth)
      expect(runtimes).toHaveLength(2)
      const fresh = await fetch(STREAM_URL, chatInit('after reload'))
      expect(await fresh.text()).toContain('after-reload')
      expect(sends).toBe(2)

      // The replaced manager stays open while its admitted stream is held.
      expect(pendingRead).toBeUndefined()
      expect(events).toEqual([])
      held.finish()
      expect(await nextRead).toMatchObject({
        kind: 'chunk',
        text: expect.stringContaining('last-part'),
      })
      // The stream then ends normally; the engine closes it with a usage
      // summary rather than an error.
      const rest = await readRest(reader)
      expect(rest).not.toContain('error')
      expect(held.cancelled()).toBe(false)

      // Only once that stream has finished is the replaced manager disposed;
      // the live one is not.
      await disposed.get(1)
      expect(events).toEqual(['manager 1 disposed'])
    } finally {
      held.finish()
      await lifecycle.dispose()
    }
    expect(events).toEqual(['manager 1 disposed', 'manager 2 disposed'])
  })

  it('a reload keeps a request admitted during its token refresh, then saves and sends the successor token', async () => {
    let releaseRefresh: () => void = () => {}
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let markRefreshStarted: () => void = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const sent: Array<{ prompt: string; authorization: string | null }> = []
    const { lifecycle, loader, load, saves, events, disposed } = runtimeLoader({
      refresh: async (auth, attempt) => {
        if (attempt > 1)
          return { ...auth, access: 'access-fresh', expires: FIXED_NOW * 2 }
        markRefreshStarted()
        await refreshHeld
        return {
          ...auth,
          refresh: 'refresh-0-successor|project-0|managed-0',
          access: 'access-successor',
          expires: FIXED_NOW * 2,
        }
      },
      respond: async (call) => {
        sent.push({
          prompt: String(call.init?.body).includes('during refresh')
            ? 'during refresh'
            : 'other',
          authorization: new Headers(call.init?.headers).get('authorization'),
        })
        return completeSse('refreshed-answer')
      },
    })
    try {
      const fetch = await load()
      const outcome = fetch(STREAM_URL, chatInit('during refresh')).then(
        async (response) => ({
          kind: 'response' as const,
          text: await response.text(),
        }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
      await refreshStarted
      await loader.reload(getAuth)
      expect(events).toEqual([])

      releaseRefresh()
      expect(await outcome).toMatchObject({
        kind: 'response',
        text: expect.stringContaining('refreshed-answer'),
      })
      expect(sent).toEqual([
        { prompt: 'during refresh', authorization: 'Bearer access-successor' },
      ])
      await disposed.get(1)
      // The replaced manager saved the successor token of its admitted
      // request before it was disposed.
      expect(
        saves.some(
          (save) =>
            save.load === 1 &&
            save.refreshTokens.includes('refresh-0-successor'),
        ),
      ).toBe(true)
      expect(events).toEqual(['manager 1 disposed'])
    } finally {
      releaseRefresh()
      await lifecycle.dispose()
    }
  })

  it('two concurrent first local requests after vault custody reload the local runtime once', async () => {
    let authority: EnrollmentAuthority = 'vault'
    const held = heldSse('first-request-part', 'first-request-last')
    let releaseSecondLoad: () => void = () => {}
    const secondLoad = new Promise<void>((resolve) => {
      releaseSecondLoad = resolve
    })
    const { lifecycle, load, loadAccountManager, runtimes } = runtimeLoader({
      readAuthority: async () => authority,
      // A second load, if one happens, waits until the first request is
      // streaming, so the run shows what a second install does to it.
      beforeLoad: async (loadNumber) => {
        if (loadNumber > 1) await secondLoad
      },
      respond: async (call) =>
        String(call.init?.body).includes('first request')
          ? held.response
          : completeSse('second-request-answer'),
    })
    try {
      const fetch = await load()
      expect(
        await (await fetch(STREAM_URL, chatInit('under vault'))).text(),
      ).toBe('vault-response')

      authority = 'local'
      const first = fetch(STREAM_URL, chatInit('first request'))
      const second = fetch(STREAM_URL, chatInit('second request')).then(
        async (response) => ({
          kind: 'response' as const,
          text: await response.text(),
        }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
      const response = await first
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The stream has no body')
      expect(await readFirstEvent(reader)).toContain('first-request-part')
      let pendingRead: ReadOutcome | undefined
      const nextRead = observeRead(reader)
      void nextRead.then((outcome) => {
        pendingRead = outcome
      })

      releaseSecondLoad()
      expect(await second).toMatchObject({
        kind: 'response',
        text: expect.stringContaining('second-request-answer'),
      })
      const observed = {
        loads: loadAccountManager.mock.calls.length,
        runtimes: runtimes.length,
        firstStream: pendingRead,
      }
      expect(observed).toEqual({
        loads: 1,
        runtimes: 1,
        firstStream: undefined,
      })
      held.finish()
      expect(await nextRead).toMatchObject({
        kind: 'chunk',
        text: expect.stringContaining('first-request-last'),
      })
    } finally {
      releaseSecondLoad()
      held.finish()
      await lifecycle.dispose()
    }
  })

  it('final shutdown aborts a stream still held by a replaced runtime and waits for it', async () => {
    const held = heldSse('first-part', 'never-sent')
    let sends = 0
    const { lifecycle, loader, load, events } = runtimeLoader({
      respond: async () =>
        sends++ === 0 ? held.response : completeSse('after-reload'),
    })
    try {
      const fetch = await load()
      const response = await fetch(STREAM_URL, chatInit('streaming'))
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The stream has no body')
      expect(await readFirstEvent(reader)).toContain('first-part')
      let pendingRead: ReadOutcome | undefined
      const nextRead = observeRead(reader)
      void nextRead.then((outcome) => {
        pendingRead = outcome
        events.push('stream settled')
      })
      await loader.reload(getAuth)
      expect(pendingRead).toBeUndefined()
      expect(held.cancelled()).toBe(false)

      await lifecycle.dispose()
      expect(pendingRead).toMatchObject({
        kind: 'error',
        error: { message: 'The Antigravity request executor is disposed' },
      })
      // Shutdown cancelled the physical upstream body and waited for the
      // stream before disposing the manager it used, then the live one.
      expect(held.cancelled()).toBe(true)
      expect(events).toEqual([
        'stream settled',
        'manager 1 disposed',
        'manager 2 disposed',
      ])
      await expect(
        fetch(STREAM_URL, chatInit('after shutdown')),
      ).rejects.toThrow('The account loader is disposed')
      expect(sends).toBe(1)
    } finally {
      held.finish()
      await lifecycle.dispose()
    }
  })

  it('a replaced manager stays open until its refresh queue has finished an admitted proactive refresh', async () => {
    const lifecycle = createPluginLifecycle({
      sessionRegistry: { clear() {} },
      shutdownDiskSignatureCache: async () => {},
      clearFetchState() {},
    })
    const events: string[] = []
    const store = memoryStore()
    // A manager whose saves and disposal are recorded in `events`.
    const recordedPool = (name: string) => {
      const pool = makePool(1, {
        ...store,
        saveMerged: async (path, next) => {
          events.push(
            `${name} saved ${next.accounts.map((entry) => entry.refreshToken).join(',')}`,
          )
          return store.saveMerged(path, next)
        },
      })
      const dispose = pool.dispose.bind(pool)
      let markDisposed: () => void = () => {}
      const disposed = new Promise<void>((resolve) => {
        markDisposed = resolve
      })
      pool.dispose = async () => {
        await dispose()
        events.push(`${name} disposed`)
        markDisposed()
      }
      return { pool, disposed }
    }
    const first = recordedPool('manager 1')
    const second = recordedPool('manager 2')
    // The account's token expires within the queue's refresh window.
    const account = first.pool.getAccounts()[0]
    if (!account) throw new Error('The pool has no account')
    first.pool.updateFromAuth(account, {
      ...first.pool.toAuthDetails(account),
      access: 'access-expiring',
      expires: Date.now() + 60_000,
    })
    let releaseRefresh: () => void = () => {}
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let markRefreshStarted: () => void = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const queue = createLocationProactiveRefreshQueue(
      {
        logger: createLocationLogger({
          sinkEnabled: () => false,
        }).createLogger('proactive-refresh-test'),
        refreshToken: async (auth) => {
          markRefreshStarted()
          await refreshHeld
          return {
            ...auth,
            refresh: 'refresh-0-proactive|project-0|managed-0',
            access: 'access-proactive',
            expires: Date.now() + 3_600_000,
          }
        },
      },
      { enabled: true, bufferSeconds: 3600, checkIntervalSeconds: 0.001 },
    )
    queue.setAccountManager(first.pool)
    const firstExecutor = createRequestExecutor(
      harness({ pool: first.pool }).deps,
    )
    const secondExecutor = createRequestExecutor(
      harness({ pool: second.pool }).deps,
    )
    let firstRetirement: Promise<void> | undefined
    try {
      expect(
        await lifecycle.replaceAccountRuntime(first.pool as never, queue, {
          retire: () => {
            firstRetirement = firstExecutor.retire()
            return firstRetirement
          },
          dispose: () => firstExecutor.dispose(),
        }),
      ).toBe(true)
      queue.start()
      await refreshStarted

      // The replacement retires the first runtime, which has no admitted
      // request, while its queue is still inside the proactive refresh.
      const replaced = lifecycle.replaceAccountRuntime(
        second.pool as never,
        null,
        {
          retire: () => secondExecutor.retire(),
          dispose: () => secondExecutor.dispose(),
        },
      )
      await firstRetirement
      // Let a manager disposal that followed the request retirement alone
      // run before the refresh is released.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const beforeRelease = [...events]

      releaseRefresh()
      expect(await replaced).toBe(true)
      await first.disposed
      expect({ beforeRelease, events }).toEqual({
        beforeRelease: [],
        events: ['manager 1 saved refresh-0-proactive', 'manager 1 disposed'],
      })
    } finally {
      releaseRefresh()
      await queue.dispose()
      await lifecycle.dispose()
    }
  })
})

describe('retired Claude admission', () => {
  it('refuses user selections before selection, refresh, warmup or physical send', async () => {
    const h = harness({
      config: { thinking_warmup: true, cache_warmup_on_switch: true },
      respond: async () => okJson(),
    })
    const executor = createRequestExecutor(h.deps)
    try {
      for (const model of [
        'claude-sonnet-4-6',
        'antigravity-claude-opus-4-6-thinking-high',
        'gemini-claude-sonnet-4-6-thinking',
      ]) {
        const response = await executor.execute(modelUrl(model), CHAT_INIT(), {
          kind: 'primary',
        })
        expect(response.status).toBe(412)
        const body = await response.text()
        expect(JSON.parse(body)).toEqual({
          error: {
            code: 412,
            status: 'FAILED_PRECONDITION',
            message:
              'This Antigravity model is no longer offered. Choose another model.',
          },
        })
        expect(body).not.toMatch(/429|500|502|503|504|524/)
      }
      expect(h.calls).toHaveLength(0)
      expect(h.refreshed).toHaveLength(0)
      expect(h.checkedGrants).toHaveLength(0)
    } finally {
      await executor.dispose()
    }
  })

  it('routes title work from a retired selection to a current server-offered route', async () => {
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor(h.deps)
    try {
      const response = await executor.execute(
        modelUrl('antigravity-claude-opus-4-6-thinking'),
        CHAT_INIT(),
        { kind: 'title' },
      )
      expect(response.status).toBe(200)
      await response.text()
      expect(h.calls).toHaveLength(1)
      const call = h.calls[0]
      if (!call?.init) throw new Error('Missing title dispatch')
      const body = JSON.parse(String(call.init.body))
      expect(body.model).toBe('gemini-3.5-flash-extra-low')
      expect(body.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M187')
    } finally {
      await executor.dispose()
    }
  })
})
