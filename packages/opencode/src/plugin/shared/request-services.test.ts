import { afterEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AccountStorageStore,
  type AccountStorageV4,
  type AgyTransportOptions,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  AccountManager as CoreAccountManager,
  HealthScoreTracker,
  type ManagedAccount,
  type OAuthAuthDetails,
  SKIP_THOUGHT_SIGNATURE,
  TokenBucketTracker,
} from '@cortexkit/antigravity-auth-core'
import { extractAccountAccessErrorDetails } from '../account-access'
import { DEFAULT_CONFIG } from '../config'
import { createLocationDebug } from '../debug'
import { createGeminiDumpState } from '../gemini-dump'
import { createLocationLogger } from '../logger'
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

function makePool(count = 1): CoreAccountManager {
  const pool = new CoreAccountManager(undefined, storedAccounts(count), {
    store: memoryStore(),
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
      assertGrantCurrent: ({ account, accessToken }) => {
        checkedGrants.push({ account, accessToken })
        if (
          !pool.getAccounts().includes(account) ||
          pool.toAuthDetails(account).access !== accessToken
        ) {
          throw new Error('stale grant')
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
const CLAUDE_URL = modelUrl('claude-sonnet-4-6', 'generateContent')

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
      executor.dispose()
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
      executor.dispose()
    }
  })

  it('retries selection after a failed refresh and sends with the next grant', async () => {
    const h = harness({
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
      executor.dispose()
    }
  })

  it('never sends a local grant that assertGrantCurrent reports stale', async () => {
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
        assertGrantCurrent: ({ accessToken }) => {
          checked.push(accessToken)
          throw stale
        },
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
    }
  })

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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
    }
  })
})

describe('createRequestExecutor per-request sender', () => {
  it("sends through the request's own raw sender with the caller signal", async () => {
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
      expect(sent[0]?.options?.signal).toBe(controller.signal)
      expect(new URL(sent[0]?.url ?? '').origin).toBe(
        ANTIGRAVITY_ENDPOINT_FALLBACKS[0],
      )
    } finally {
      executor.dispose()
    }
  })
})

describe('createRequestExecutor cancellation and overflow', () => {
  it('hands the caller AbortSignal object to the raw transport unchanged', async () => {
    const controller = new AbortController()
    const h = harness({ respond: async () => okJson() })
    const executor = createRequestExecutor(h.deps)
    try {
      await executor.execute(NON_STREAM_URL, CHAT_INIT(controller.signal))
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]?.options?.signal).toBe(controller.signal)
    } finally {
      executor.dispose()
    }
  })

  // An abort during the capacity wait ends that endpoint's attempt; the loop
  // then moves to the next endpoint, whose send receives the already-aborted
  // signal (the raw transport rejects such a send without network I/O), and
  // the request rejects with the caller's reason.
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
      executor.dispose()
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
      executor.dispose()
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
      executor.dispose()
    }
  })
})
