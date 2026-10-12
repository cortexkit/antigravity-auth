import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as actualCore from '@cortexkit/antigravity-auth-core'
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  normalizeContext,
  type ThinkingLevel,
  Type,
} from '@earendil-works/pi-ai'
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent'
import opusLow from '../../../test-fixtures/agy-cli-1.3.3/native-opus-low.json'
import sonnetLow from '../../../test-fixtures/agy-cli-1.3.3/native-sonnet-low.json'
import schemaDerived from '../../../test-fixtures/agy-cli-1.3.3/schema-derived-thinking.json'

const ensureProjectContextMock = mock(async () => ({
  auth: {
    type: 'oauth' as const,
    refresh: '',
    access: 'test-token',
    expires: 0,
  },
  effectiveProjectId: 'test-project',
}))
const fetchWithAgyCliTransportMock = mock()

mock.module('@cortexkit/antigravity-auth-core', () => ({
  ...actualCore,
  ensureProjectContext: ensureProjectContextMock,
  fetchWithAgyCliTransport: fetchWithAgyCliTransportMock,
}))

const {
  convertGeminiToolCallPart,
  finalizePiAntigravityRequest,
  parseGeminiSse,
  resolvePiAntigravityModel,
  streamCortexKitAntigravity,
  createCortexKitAntigravityVaultStream,
  updateUsage,
} = await import('./stream.ts')

function fakeModel(id = 'antigravity-gemini-3.5-flash'): Model<Api> {
  return {
    id,
    api: 'google-generative-ai',
    provider: 'google',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<Api>
}

function emptyOutput(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'google-generative-ai',
    provider: 'google',
    model: 'antigravity-gemini-3.5-flash',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
}

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function openSseResponse(frame: string): {
  response: Response
  wasCancelled: () => boolean
} {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    wasCancelled: () => cancelled,
  }
}

function stalledSseResponse(frame: string): {
  response: Response
  abort: () => void
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(new TextEncoder().encode(frame))
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    abort: () => streamController?.error(new Error('aborted')),
  }
}

function userContext(): Context {
  return { messages: [{ role: 'user', content: 'test', timestamp: 1 }] }
}

function observeCallerListeners(signal: AbortSignal) {
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'abort' && listener) listeners.add(listener)
    add(type, listener, options)
  }
  signal.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === 'abort' && listener) listeners.delete(listener)
    remove(type, listener, options)
  }
  return listeners
}

function httpErrorResponse(failure?: Error) {
  const chunks = ['upstream ', 'failure']
  let nextChunk = 0
  let pendingPulls = 0
  let terminal: 'EOF' | 'error' | undefined
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        pendingPulls++
        try {
          await Promise.resolve()
          const chunk = chunks[nextChunk]
          if (chunk !== undefined) {
            nextChunk++
            controller.enqueue(new TextEncoder().encode(chunk))
          } else if (failure) {
            terminal = 'error'
            controller.error(failure)
          } else {
            terminal = 'EOF'
            controller.close()
          }
        } finally {
          pendingPulls--
        }
      },
    },
    { highWaterMark: 0 },
  )
  return {
    response: new Response(body, { status: 503 }),
    state: () => ({ nextChunk, pendingPulls, terminal }),
  }
}

async function runStream(
  model: Model<Api>,
  response: Response,
  sessionId: string,
  onAbort?: () => void,
  reasoning?: ThinkingLevel,
) {
  fetchWithAgyCliTransportMock.mockImplementationOnce(
    async (
      _url: string,
      _init: RequestInit,
      transportOptions?: { signal?: AbortSignal | null },
    ) => {
      if (onAbort)
        transportOptions?.signal?.addEventListener('abort', onAbort, {
          once: true,
        })
      return response
    },
  )
  return collectStream(
    streamCortexKitAntigravity(model, userContext(), {
      apiKey: 'test-token',
      sessionId,
      reasoning,
    }),
  )
}

function terminalTextResponse(): Response {
  return sseResponse([
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
  ])
}

describe('selected credential boundary', () => {
  it('refuses local dispatch when enrollment changes during project resolution', async () => {
    let admitted = true
    ensureProjectContextMock.mockImplementationOnce(async () => {
      admitted = false
      return {
        auth: { type: 'oauth', refresh: '', access: 'test-token', expires: 0 },
        effectiveProjectId: 'test-project',
      }
    })
    fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
      terminalTextResponse(),
    )
    const { result } = await collectStream(
      streamCortexKitAntigravity(
        fakeModel(),
        userContext(),
        { apiKey: 'test-token' },
        async () => {
          if (!admitted) throw new Error('local enrollment changed')
        },
      ),
    )
    expect(result.errorMessage).toContain('local enrollment changed')
    expect(fetchWithAgyCliTransportMock).not.toHaveBeenCalled()
  })

  it('production Pi provider refuses enrollment approved during its project await', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'pi-public-authority-')),
    )
    try {
      const { registerCortexKitPiAntigravity } = await import('./index.ts')
      const { PiVaultSetup, PI_ANTIGRAVITY_ENROLLMENT_NAME } = await import(
        './vault-setup.ts'
      )
      const claustrum = await actualCore.loadCommonAuthClaustrum()
      const nativeAuthPath = join(root, 'auth.json')
      const native = {
        type: 'oauth' as const,
        access: 'test-token',
        refresh: 'synthetic-refresh|project',
        expires: Date.now() + 3_600_000,
      }
      await writeFile(nativeAuthPath, JSON.stringify({ google: native }))
      const vaultDir = join(root, 'vault')
      const modeFile = join(vaultDir, 'pi-mode.json')
      const setup = new PiVaultSetup({
        claustrum,
        stateDir: vaultDir,
        modeFile,
        readHostSlot: () => native,
        connectEnrollment: async () => ({
          enrollPropose: async () => ({ requestId: 'synthetic-request' }),
          enrollPoll: async () => ({
            status: 'approved' as const,
            name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
            token: 'b'.repeat(64),
            tokenGeneration: 1,
          }),
          close() {},
        }),
      })
      const registerProvider = mock()
      await registerCortexKitPiAntigravity(
        {
          registerProvider,
          registerCommand: mock(),
        },
        {
          vaultDir,
          modeFile,
          nativeAuthPath,
          nativeStashPath: join(vaultDir, 'stash.json'),
          loadClaustrum: async () => claustrum,
          readHostSlot: () => native,
        },
      )
      const provider = registerProvider.mock.calls[0]?.[1] as
        | ProviderConfig
        | undefined
      const localStream = provider?.streamSimple
      if (!localStream) throw new Error('local Pi provider was not registered')
      ensureProjectContextMock.mockImplementationOnce(async () => {
        expect((await setup.connectStep()).state).toBe('approved')
        expect(
          await actualCore.enrollmentAuthority(
            setup.paths,
            PI_ANTIGRAVITY_ENROLLMENT_NAME,
            claustrum,
          ),
        ).toBe('vault')
        return {
          auth: {
            type: 'oauth',
            refresh: '',
            access: 'test-token',
            expires: 0,
          },
          effectiveProjectId: 'test-project',
        }
      })
      fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
        terminalTextResponse(),
      )
      const { result } = await collectStream(
        localStream(fakeModel(), normalizeContext(userContext()), {
          apiKey: 'test-token',
        }),
      )
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toContain('Vault enrollment excludes local')
      expect(ensureProjectContextMock).toHaveBeenCalledTimes(1)
      expect(fetchWithAgyCliTransportMock).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const source of ['transport', 'http', 'sse'] as const) {
    it(`redacts selected credential in Pi ${source} errors`, async () => {
      const detail =
        'echo test-token Bearer another-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
      fetchWithAgyCliTransportMock.mockImplementationOnce(async () => {
        if (source === 'transport') throw new Error(detail)
        if (source === 'http') return new Response(detail, { status: 403 })
        return sseResponse([
          `data: ${JSON.stringify({ response: { error: { code: 403, status: 'PERMISSION_DENIED', message: detail } } })}\n\n`,
        ])
      })
      const { result } = await collectStream(
        streamCortexKitAntigravity(fakeModel(), userContext(), {
          apiKey: 'test-token',
        }),
      )
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).not.toContain('test-token')
      expect(result.errorMessage).not.toContain('another-token')
      expect(result.errorMessage).not.toContain('eyJ')
      expect(result.errorMessage).toContain('[credential]')
      if (source !== 'transport') expect(result.errorMessage).toContain('403')
    })
  }

  for (const source of ['transport', 'http', 'sse', 'success'] as const) {
    it(`uses the genuinely served opaque vault token at the Pi ${source} boundary`, async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'pi-vault-redaction-')),
      )
      const claustrum = await actualCore.loadCommonAuthClaustrum()
      const fs = await actualCore.loadCommonAuthFs()
      const tokenPath = join(root, 'enrollment-token.json')
      await writeFile(
        tokenPath,
        JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
        { mode: 0o600 },
      )
      const opaque = 'opaque_selected_vault_734a1'
      let admissions = 0
      const vault = actualCore.createAntigravityVaultAccountSource({
        claustrum,
        host: 'pi',
        rosterPath: join(root, 'roster.json'),
        tokenPath,
        isCustodyActive: () => true,
        reporterSource: 'direct',
        state: { path: join(root, 'state.json'), fs },
        logger: { warn() {}, debug() {} },
        connect: async () => ({
          listScoped: async () => ({
            view: 'synthetic-vault-view',
            rows: [
              {
                id: 'cred-1',
                categories: ['antigravity-native'],
                credentialType: 'oauth' as const,
                serves: [],
                providerIds: [],
                refreshAdapter: 'antigravity',
                state: 'active' as const,
                recordVersion: 1,
                operations: ['read'],
                createdAtMs: null,
                accountId: 'account-a',
              },
            ],
          }),
          getScoped: async () => {
            admissions++
            return {
              material: opaque,
              recordVersion: 1,
              expiresAtMs: Date.now() + 3_600_000,
              credentialId: 'cred-1',
              projectId: 'vault-project',
              accountId: 'account-a',
            }
          },
          reportAuthFailureScoped: async () => {},
          close() {},
        }),
      })
      try {
        const { createPiVaultSend } = await import('./vault-source.ts')
        const { CUSTODY_PROVIDER_KEY_MARKER } = await import('./index.ts')
        const send = createPiVaultSend({
          readMode: () => ({
            ok: true,
            record: { version: 1, mode: 'custody' },
          }),
          source: async () => vault,
        })
        fetchWithAgyCliTransportMock.mockImplementationOnce(
          async (_url, init) => {
            expect(new Headers(init.headers).get('authorization')).toBe(
              `Bearer ${opaque}`,
            )
            if (source === 'transport') throw new Error(`echo ${opaque}`)
            if (source === 'http')
              return new Response(`echo ${opaque}`, { status: 403 })
            return sseResponse([
              `data: ${JSON.stringify({ response: source === 'sse' ? { error: { code: 403, message: `echo ${opaque}` } } : { candidates: [{ content: { parts: [{ text: opaque }] }, finishReason: 'STOP' }] } })}\n\n`,
            ])
          },
        )
        const { result } = await collectStream(
          createCortexKitAntigravityVaultStream(
            send,
            CUSTODY_PROVIDER_KEY_MARKER,
          )(fakeModel(), userContext(), {
            apiKey: CUSTODY_PROVIDER_KEY_MARKER,
          }),
        )
        expect(admissions).toBe(1)
        expect(ensureProjectContextMock).not.toHaveBeenCalled()
        if (source === 'success') {
          expect(result.stopReason).toBe('stop')
          expect(result.content).toEqual([{ type: 'text', text: opaque }])
        } else {
          expect(result.stopReason).toBe('error')
          expect(result.errorMessage).not.toContain(opaque)
          expect(result.errorMessage).toContain('[credential]')
          if (source !== 'transport')
            expect(result.errorMessage).toContain('403')
        }
      } finally {
        vault.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('preserves error-looking successful Pi content exactly', async () => {
    const text =
      'test-token Bearer another-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature {"error":"test-token"}'
    const { result, events } = await runStream(
      fakeModel(),
      sseResponse([
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } })}\n\n`,
      ]),
      'redaction-success',
    )
    expect(result.content).toEqual([{ type: 'text', text }])
    expect(events.find((event) => event.type === 'text_delta')).toMatchObject({
      delta: text,
    })
  })
})

async function runContextStream(context: Context, sessionId?: string) {
  fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
    terminalTextResponse(),
  )
  await collectStream(
    streamCortexKitAntigravity(fakeModel(), context, {
      apiKey: 'test-token',
      sessionId,
    }),
  )
  return JSON.parse(
    String(fetchWithAgyCliTransportMock.mock.calls.at(-1)?.[1]?.body),
  )
}

async function collectStream(
  eventStream: ReturnType<typeof streamCortexKitAntigravity>,
) {
  const events = []
  for await (const event of eventStream) {
    events.push(event)
  }
  return { events, result: await eventStream.result() }
}

afterEach(() => {
  fetchWithAgyCliTransportMock.mockReset()
  ensureProjectContextMock.mockClear()
})

describe('resolvePiAntigravityModel', () => {
  it('prepares captured low and schema-derived efforts using genuine Pi registration models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-133-pi-catalog-'))
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(root, 'auth.json'),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      })
      const registry = new ModelRegistry(runtime)
      const { registerCortexKitPiAntigravity } = await import('./index.ts')
      await registerCortexKitPiAntigravity(
        {
          registerProvider: registry.registerProvider.bind(registry),
          registerCommand: mock(),
        },
        {
          vaultDir: join(root, 'vault'),
          modeFile: join(root, 'mode.json'),
          readHostSlot: () => undefined,
        },
      )
      for (const fixture of [opusLow, sonnetLow]) {
        const id = `antigravity-${fixture.model.replace(/-low$/, '')}`
        const model = registry.find('google', id)
        if (!model) throw new Error(`Missing registered model: ${id}`)
        expect(model).toMatchObject({
          reasoning: true,
          contextWindow: 1000000,
          maxTokens: 128000,
        })
        for (const effort of [undefined, 'low', 'medium', 'high'] as const) {
          fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
            sseResponse([
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
            ]),
          )
          const result = await collectStream(
            streamCortexKitAntigravity(model, userContext(), {
              apiKey: 'test-token',
              reasoning: effort,
              sessionId: `registered-${id}-${effort}`,
            }),
          )
          expect(result.result.stopReason).toBe('stop')
          const call = fetchWithAgyCliTransportMock.mock.calls.at(-1)
          const body = JSON.parse(String(call?.[1]?.body))
          const level = effort ?? 'low'
          expect(body.model).toBe(fixture.model.replace(/-low$/, `-${level}`))
          expect(body.request.generationConfig).toEqual(
            level === 'low'
              ? fixture.native_generation_config
              : {
                  maxOutputTokens: 128000,
                  thinkingConfig: schemaDerived[level],
                },
          )
          expect(body.request.labels.model_enum).toBe(
            actualCore.getAgyModelEnum(body.model),
          )
          expect(Object.keys(body)).toEqual(fixture.envelope_keys)
          expect(new Headers(call?.[1]?.headers).get('User-Agent')).toMatch(
            /^antigravity\/cli\/1\.3\.3 .*cl=996823801;/,
          )
        }
        fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
          sseResponse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"capped"}]},"finishReason":"STOP"}]}}\n\n',
          ]),
        )
        const beforeCap = fetchWithAgyCliTransportMock.mock.calls.length
        const capped = await collectStream(
          streamCortexKitAntigravity(model, userContext(), {
            apiKey: 'test-token',
            reasoning: 'low',
            maxTokens: 2048,
          }),
        )
        expect(capped.result.stopReason).toBe('stop')
        expect(fetchWithAgyCliTransportMock.mock.calls.length).toBe(
          beforeCap + 1,
        )
        const body = JSON.parse(
          String(fetchWithAgyCliTransportMock.mock.calls.at(-1)?.[1]?.body),
        )
        expect(body.request.generationConfig).toEqual(
          fixture.as_sent_generation_config,
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
  const gemini36 = {
    ...fakeModel(),
    id: 'antigravity-gemini-3.6-flash',
    reasoning: true,
  }

  it.each([
    ['low', 'gemini-3.6-flash-low', 1000],
    ['medium', 'gemini-3.6-flash-medium', 4000],
    ['high', 'gemini-3.6-flash-high', -1],
  ] as const)('maps Pi %s thinking to the captured AGY route', (reasoning, actualModel, thinkingBudget) => {
    expect(resolvePiAntigravityModel(gemini36, reasoning)).toMatchObject({
      actualModel,
      thinkingBudget,
    })
  })

  const gemini37 = {
    ...fakeModel(),
    id: 'antigravity-gemini-3.7-flash',
    reasoning: true,
  }

  it.each([
    ['low', 'gemini-3.7-flash-low', 1000],
    ['medium', 'gemini-3.7-flash-medium', 4000],
    ['high', 'gemini-3.7-flash-high', -1],
  ] as const)('maps Pi 3.7 %s thinking to the captured AGY route', (reasoning, actualModel, thinkingBudget) => {
    expect(resolvePiAntigravityModel(gemini37, reasoning)).toMatchObject({
      actualModel,
      thinkingBudget,
    })
  })

  const gemini38 = {
    ...fakeModel(),
    id: 'antigravity-gemini-3.8-flash',
    reasoning: true,
  }

  it.each([
    ['low', 'gemini-3.8-flash-low', 1000],
    ['medium', 'gemini-3.8-flash-medium', 4000],
    ['high', 'gemini-3.8-flash-high', -1],
  ] as const)('maps Pi 3.8 %s thinking to the captured AGY route', (reasoning, actualModel, thinkingBudget) => {
    expect(resolvePiAntigravityModel(gemini38, reasoning)).toMatchObject({
      actualModel,
      thinkingBudget,
    })
  })

  it('clamps unsupported edge levels to live AGY tiers', () => {
    expect(resolvePiAntigravityModel(gemini36, 'minimal').actualModel).toBe(
      'gemini-3.6-flash-low',
    )
    expect(resolvePiAntigravityModel(gemini36, 'xhigh').actualModel).toBe(
      'gemini-3.6-flash-high',
    )
  })
})

describe('finalizePiAntigravityRequest', () => {
  it('adds AGY session metadata and VALIDATED tool configuration', () => {
    const request: Record<string, unknown> = {
      generationConfig: { thinkingConfig: { thinkingBudget: 10_000 } },
      tools: [
        {
          functionDeclarations: [
            { name: 'read', parameters: { type: 'OBJECT' } },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: 'system' }] },
      contents: [{ role: 'user', parts: [{ text: 'prompt' }] }],
    }

    const requestId = finalizePiAntigravityRequest(
      request,
      'gemini-3-flash-agent',
      {
        session: {
          conversationId: 'conversation-id',
          trajectoryId: 'trajectory-id',
          numericSessionId: '-3750763034362895579',
        },
        timestamp: 1_784_285_195_116,
      },
    )

    expect(requestId).toBe(
      'agent/conversation-id/1784285195116/trajectory-id/2',
    )
    expect(request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    })
    expect(request.labels).toEqual({
      last_step_index: '1',
      model_enum: 'MODEL_PLACEHOLDER_M84',
      trajectory_id: 'trajectory-id',
      used_claude: 'false',
      used_claude_conservative: 'false',
      used_non_gemini_model: 'false',
    })
    expect(request.sessionId).toBe('-3750763034362895579')
    expect(Object.keys(request)).toEqual([
      'contents',
      'systemInstruction',
      'tools',
      'toolConfig',
      'labels',
      'generationConfig',
      'sessionId',
    ])
  })

  it('matches native first-execution tool continuation step metadata', () => {
    const request: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: 'prompt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read', args: {}, id: 'call-1' },
              thoughtSignature: 'sig',
            },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { output: 'result' },
                id: 'call-1',
              },
            },
          ],
        },
      ],
    }

    const requestId = finalizePiAntigravityRequest(
      request,
      'gemini-3.6-flash-high',
      {
        session: {
          conversationId: 'conversation-id',
          trajectoryId: 'trajectory-id',
          numericSessionId: '-3750763034362895579',
        },
        timestamp: 1_784_285_195_116,
      },
    )

    expect(requestId).toBe(
      'agent/conversation-id/1784285195116/trajectory-id/5',
    )
    expect(request.labels).toMatchObject({
      last_step_index: '4',
      model_enum: 'MODEL_PLACEHOLDER_M71',
    })
  })
})

describe('convertGeminiToolCallPart', () => {
  it('preserves the backend function-call ID', () => {
    const state = {}
    const toolCall = convertGeminiToolCallPart(
      {
        functionCall: {
          name: 'read',
          args: { path: 'a.ts' },
          id: 'toolu_vrtx_123',
        },
      },
      state,
    )

    expect(toolCall).toEqual({
      type: 'toolCall',
      id: 'toolu_vrtx_123',
      name: 'read',
      arguments: { path: 'a.ts' },
    })
  })

  it('generates an ID when the backend omits one', () => {
    const toolCall = convertGeminiToolCallPart(
      { functionCall: { name: 'read', args: {} } },
      {},
    )

    expect(toolCall?.id).toMatch(/^call_[0-9a-f-]{36}$/)
  })

  it('carries a preceding thought signature onto the next function call', () => {
    const state = {}

    expect(
      convertGeminiToolCallPart(
        { text: '', thought: true, thoughtSignature: 'SIG123' },
        state,
      ),
    ).toBeUndefined()

    expect(
      convertGeminiToolCallPart(
        { functionCall: { name: 'read', args: {}, id: 'c1' } },
        state,
      ),
    ).toEqual({
      type: 'toolCall',
      id: 'c1',
      name: 'read',
      arguments: {},
      thoughtSignature: 'SIG123',
    })
    expect(
      convertGeminiToolCallPart(
        { functionCall: { name: 'grep', args: {}, id: 'c2' } },
        state,
      ),
    ).not.toHaveProperty('thoughtSignature')
  })

  it('attaches a parallel batch signature only to the first function call', () => {
    const state = {}

    convertGeminiToolCallPart(
      { thought: true, thoughtSignature: 'SIG1' },
      state,
    )
    const first = convertGeminiToolCallPart(
      { functionCall: { name: 'read', args: {}, id: 'c1' } },
      state,
    )
    const second = convertGeminiToolCallPart(
      { functionCall: { name: 'grep', args: {}, id: 'c2' } },
      state,
    )

    expect(first?.thoughtSignature).toBe('SIG1')
    expect(second).not.toHaveProperty('thoughtSignature')
  })
})

describe('streamCortexKitAntigravity', () => {
  it('works without AbortSignal.any with a caller signal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
    Object.defineProperty(AbortSignal, 'any', {
      ...descriptor,
      value: undefined,
    })
    try {
      expect(AbortSignal.any).toBeUndefined()
      const caller = new AbortController()
      fetchWithAgyCliTransportMock.mockImplementationOnce(async () =>
        terminalTextResponse(),
      )
      const { result } = await collectStream(
        streamCortexKitAntigravity(fakeModel(), userContext(), {
          apiKey: 'test-token',
          sessionId: 'no-any',
          signal: caller.signal,
        }),
      )
      expect(fetchWithAgyCliTransportMock).toHaveBeenCalledTimes(1)
      expect(result.stopReason).toBe('stop')
    } finally {
      Object.defineProperty(AbortSignal, 'any', descriptor)
    }
  })

  it('surfaces an embedded SSE error instead of returning an empty success', async () => {
    const { events, result } = await runStream(
      fakeModel(),
      sseResponse([
        'data: {"error":{"code":429,"message":"Gemini quota exhausted","status":"RESOURCE_EXHAUSTED"}}\n\n',
      ]),
      'embedded-error',
    )

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('RESOURCE_EXHAUSTED')
    expect(result.errorMessage).toContain('Gemini quota exhausted')
  })

  it('surfaces prompt feedback instead of returning an empty success', async () => {
    const { events, result } = await runStream(
      fakeModel(),
      sseResponse([
        'data: {"response":{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"Blocked prompt"}}}\n\n',
      ]),
      'prompt-feedback',
    )

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('SAFETY')
    expect(result.errorMessage).toContain('Blocked prompt')
  })

  it('rejects clean EOF without a terminal candidate', async () => {
    const { events, result } = await runStream(
      fakeModel(),
      new Response(null, { status: 200 }),
      'empty-eof',
    )

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('without a terminal candidate')
  })

  it('rejects a candidate-less terminal response instead of returning an empty success', async () => {
    const { events, result } = await runStream(
      fakeModel(),
      sseResponse([
        'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0}}}\n\n',
      ]),
      'empty-terminal',
    )

    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('empty response')
  })

  it('streams thinking and transfers a pending signature to visible text', async () => {
    const { events, result } = await runStream(
      fakeModel('antigravity-claude-opus-5-5'),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"reasoning","thought":true}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"","thought":true,"thoughtSignature":"SIG123"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3}}}\n\n',
      ]),
      'thinking-text-signature',
    )

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ])
    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer', textSignature: 'SIG123' },
    ])
  })

  it('sends the captured Gemini 3.7 high budget and model enum on the wire', async () => {
    await runStream(
      {
        ...fakeModel('antigravity-gemini-3.7-flash'),
        reasoning: true,
      },
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      'gemini-37-high-wire',
      undefined,
      'high',
    )

    const call = fetchWithAgyCliTransportMock.mock.calls.at(-1)
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.model).toBe('gemini-3.7-flash-high')
    expect(body.request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    })
    expect(body.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M298')
    expect(call?.[1]?.headers?.['User-Agent']).toContain(
      'antigravity/cli/1.3.3',
    )
  })

  it('sends the captured Gemini 3.8 high budget and model enum on the wire', async () => {
    await runStream(
      {
        ...fakeModel('antigravity-gemini-3.8-flash'),
        reasoning: true,
      },
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]}},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      'gemini-38-high-wire',
      undefined,
      'high',
    )

    const call = fetchWithAgyCliTransportMock.mock.calls.at(-1)
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.model).toBe('gemini-3.8-flash-high')
    expect(body.request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    })
    expect(body.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M318')
    expect(call?.[1]?.headers?.['User-Agent']).toContain(
      'antigravity/cli/1.3.3',
    )
  })

  it('sends the transcript system prompt and sanitized tools on the wire', async () => {
    const context = normalizeContext({
      systemPrompt: 'be terse',
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: Type.Object({
            path: Type.String({ minLength: 1 }),
            mode: Type.Optional(
              Type.Union([Type.Literal('a'), Type.Literal('b')]),
            ),
          }),
        },
      ],
      messages: [
        { role: 'user', content: 'hi', timestamp: 11 },
        {
          role: 'system',
          content: 'answer in English',
          toolsAdded: [
            {
              name: 'grep',
              description: 'Search files',
              parameters: Type.Object({ pattern: Type.String() }),
            },
          ],
          timestamp: 12,
        },
      ],
    })

    const body = await runContextStream(context, 'transcript-wire')

    expect(Object.keys(body)).toEqual([
      'project',
      'requestId',
      'request',
      'model',
      'userAgent',
      'requestType',
    ])
    expect(body.request.systemInstruction).toEqual({
      parts: [{ text: 'be terse\n\nanswer in English' }],
    })
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ])
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    })
    const declarations = body.request.tools[0].functionDeclarations
    expect(declarations.map((decl: { name: string }) => decl.name)).toEqual([
      'read',
      'grep',
    ])
    expect(declarations[0]).not.toHaveProperty('parametersJsonSchema')
    expect(declarations[0].parameters.type).toBe('OBJECT')
    expect(declarations[0].parameters.properties.path.type).toBe('STRING')
    expect(declarations[1].parameters).toEqual({
      type: 'OBJECT',
      properties: { pattern: { type: 'STRING' } },
      required: ['pattern'],
    })
    expect(body.request.labels.last_step_index).toBe('1')
  })

  it('keys sessions without a sessionId on the first non-system message', async () => {
    const conversation = (timestamp: number) =>
      normalizeContext({
        systemPrompt: 'be terse',
        messages: [{ role: 'user', content: 'hi', timestamp }],
      })

    const first = await runContextStream(conversation(101))
    const second = await runContextStream(conversation(202))
    const firstAgain = await runContextStream(conversation(101))

    expect(second.request.labels.trajectory_id).not.toBe(
      first.request.labels.trajectory_id,
    )
    expect(firstAgain.request.labels.trajectory_id).toBe(
      first.request.labels.trajectory_id,
    )
  })

  it('adds execution metadata after a completed turn', async () => {
    const terminal = () =>
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ])

    await runStream(fakeModel(), terminal(), 'execution-metadata')
    await runStream(fakeModel(), terminal(), 'execution-metadata')

    const calls = fetchWithAgyCliTransportMock.mock.calls
    const firstBody = JSON.parse(String(calls.at(-2)?.[1]?.body))
    const secondBody = JSON.parse(String(calls.at(-1)?.[1]?.body))
    expect(firstBody.request.labels).not.toHaveProperty('last_execution_id')
    expect(firstBody.request.labels.last_step_index).toBe('1')
    expect(secondBody.request.labels.last_execution_id).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(secondBody.request.labels.last_step_index).toBe('2')
  })

  it('does not rotate execution metadata on a tool-call turn', async () => {
    await runStream(
      fakeModel('antigravity-claude-opus-5-5'),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{},"id":"c1"}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      'tool-execution-metadata',
    )
    await runStream(
      fakeModel('antigravity-claude-opus-5-5'),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
      ]),
      'tool-execution-metadata',
    )

    const secondBody = JSON.parse(
      String(fetchWithAgyCliTransportMock.mock.calls.at(-1)?.[1]?.body),
    )
    expect(secondBody.request.labels).not.toHaveProperty('last_execution_id')
    expect(secondBody.request.labels.last_step_index).toBe('1')
  })

  it('releases and cancels an open response body after STOP', async () => {
    const open = openSseResponse(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}}\n\n',
    )
    const { result } = await runStream(
      fakeModel('antigravity-claude-opus-5-5'),
      open.response,
      'open-response-cleanup',
    )

    expect(result.stopReason).toBe('stop')
    expect(open.wasCancelled()).toBe(true)
  })

  it('consumes GPT usage metadata sent after STOP', async () => {
    const { result } = await runStream(
      fakeModel('antigravity-gpt-oss-120b-medium'),
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
        'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}}\n\n',
      ]),
      'gpt-trailing-usage',
    )

    expect(result.stopReason).toBe('stop')
    expect(result.usage.input).toBe(10)
    expect(result.usage.output).toBe(3)
    expect(result.usage.totalTokens).toBe(13)
  })

  it('finishes a GPT turn when trailing usage never arrives', async () => {
    const stalled = stalledSseResponse(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
    )
    const { result } = await runStream(
      fakeModel('antigravity-gpt-oss-120b-medium'),
      stalled.response,
      'gpt-missing-trailing-usage',
      stalled.abort,
    )

    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('Pi caller cancellation without AbortSignal.any', () => {
  let anyDescriptor: PropertyDescriptor
  beforeEach(() => {
    anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
    Object.defineProperty(AbortSignal, 'any', {
      ...anyDescriptor,
      value: undefined,
    })
    expect(AbortSignal.any).toBeUndefined()
  })
  afterEach(() => Object.defineProperty(AbortSignal, 'any', anyDescriptor))

  function startWithCaller(caller: AbortController) {
    return streamCortexKitAntigravity(fakeModel(), userContext(), {
      apiKey: 'test-token',
      sessionId: 'caller-cancellation',
      signal: caller.signal,
    })
  }

  it('forwards a pre-abort through opening without attaching a caller listener', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    const reason = new Error('pre-aborted Pi request')
    caller.abort(reason)
    fetchWithAgyCliTransportMock.mockImplementationOnce(
      async (_url, _init, options) => {
        expect(options.signal.aborted).toBe(true)
        expect(options.signal.reason).toBe(reason)
        throw options.signal.reason
      },
    )
    const { result } = await collectStream(startWithCaller(caller))
    expect(fetchWithAgyCliTransportMock).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('aborted')
    expect(result.errorMessage).toBe(reason.message)
    expect(listeners.size).toBe(0)
  })

  it('forwards abort while opening and detaches after rejection', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    let opened!: () => void
    const opening = new Promise<void>((resolve) => {
      opened = resolve
    })
    let requestSignal!: AbortSignal
    fetchWithAgyCliTransportMock.mockImplementationOnce(
      async (_url, _init, options) => {
        requestSignal = options.signal
        return new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener(
            'abort',
            () => reject(requestSignal.reason),
            { once: true },
          )
          opened()
        })
      },
    )
    const pending = collectStream(startWithCaller(caller))
    await opening
    expect(listeners.size).toBe(1)
    const reason = new Error('Pi opening canceled')
    caller.abort(reason)
    const { result } = await pending
    expect(requestSignal.reason).toBe(reason)
    expect(result.stopReason).toBe('aborted')
    expect(result.errorMessage).toBe(reason.message)
    expect(listeners.size).toBe(0)
  })

  it('forwards abort during chunk parsing and releases and detaches on cancel', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    let requestSignal!: AbortSignal
    let response!: Response
    fetchWithAgyCliTransportMock.mockImplementationOnce(
      async (_url, _init, options) => {
        requestSignal = options.signal
        response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
                ),
              )
              requestSignal.addEventListener(
                'abort',
                () => controller.error(requestSignal.reason),
                { once: true },
              )
            },
          }),
        )
        return response
      },
    )
    const events = []
    const stream = startWithCaller(caller)
    const reason = new Error('Pi body canceled')
    for await (const event of stream) {
      events.push(event.type)
      if (event.type === 'text_delta') {
        expect(listeners.size).toBe(1)
        caller.abort(reason)
      }
    }
    const result = await stream.result()
    expect(events).toContain('text_delta')
    expect(events.at(-1)).toBe('error')
    expect(requestSignal.reason).toBe(reason)
    expect(result.stopReason).toBe('aborted')
    expect(result.errorMessage).toBe(reason.message)
    expect(response.body!.locked).toBe(false)
    expect(listeners.size).toBe(0)
  })

  it('retains forwarding through successful body cleanup and then detaches', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    let canceled!: () => void
    const cancelStarted = new Promise<void>((resolve) => {
      canceled = resolve
    })
    let finishCancel!: () => void
    const cancelFinished = new Promise<void>((resolve) => {
      finishCancel = resolve
    })
    let requestSignal!: AbortSignal
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}}\n\n',
            ),
          )
        },
        async cancel() {
          canceled()
          await cancelFinished
        },
      }),
    )
    fetchWithAgyCliTransportMock.mockImplementationOnce(
      async (_url, _init, options) => {
        requestSignal = options.signal
        return response
      },
    )
    const pending = collectStream(startWithCaller(caller))
    await cancelStarted
    expect(listeners.size).toBe(1)
    finishCancel()
    const { result } = await pending
    expect(result.stopReason).toBe('stop')
    expect(response.body!.locked).toBe(false)
    expect(listeners.size).toBe(0)
    caller.abort(new Error('after success'))
    expect(requestSignal.aborted).toBe(false)
  })

  it('detaches on opening, HTTP, embedded, and body-read errors', async () => {
    const readFailure = new Error('broken SSE body')
    for (const response of [
      undefined,
      new Response('unavailable', { status: 503 }),
      sseResponse(['data: {"error":{"message":"embedded failure"}}\n\n']),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(readFailure)
          },
        }),
      ),
    ]) {
      const caller = new AbortController()
      const listeners = observeCallerListeners(caller.signal)
      fetchWithAgyCliTransportMock.mockImplementationOnce(async () => {
        expect(listeners.size).toBe(1)
        if (!response) throw new Error('opening failed')
        return response
      })
      const { result } = await collectStream(startWithCaller(caller))
      expect(result.stopReason).toBe('error')
      expect(listeners.size).toBe(0)
      if (response?.ok && response.body)
        expect(response.body.locked).toBe(false)
    }
  })

  it('documents the stock text consumer retaining a completed body lock', async () => {
    const response = new Response('upstream failure', { status: 503 })
    expect(await response.text()).toBe('upstream failure')
    expect(response.bodyUsed).toBe(true)
    // A consumed string-backed body can stay locked despite having no source IO.
    expect(response.body!.locked).toBe(true)
  })

  it('preserves a fully consumed string-backed HTTP error despite its stock body lock', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    const response = new Response('upstream failure', { status: 503 })
    const consume = spyOn(response, 'text')
    fetchWithAgyCliTransportMock.mockImplementationOnce(async () => response)
    const { result } = await collectStream(startWithCaller(caller))
    expect(consume).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe(
      'Antigravity request failed: HTTP 503 upstream failure',
    )
    expect(response.bodyUsed).toBe(true)
    expect(response.body!.locked).toBe(true)
    expect(listeners.size).toBe(0)
    consume.mockRestore()
  })

  it('consumes the HTTP error body and preserves its error without a live parser or caller listener', async () => {
    for (const failure of [undefined, new Error('HTTP body read failure')]) {
      const stock = httpErrorResponse(failure)
      const stockReader = spyOn(stock.response.body!, 'getReader')
      if (failure) await expect(stock.response.text()).rejects.toBe(failure)
      else expect(await stock.response.text()).toBe('upstream failure')
      const caller = new AbortController()
      const listeners = observeCallerListeners(caller.signal)
      const source = httpErrorResponse(failure)
      const parserReader = spyOn(source.response.body!, 'getReader')
      let requestSignal!: AbortSignal
      fetchWithAgyCliTransportMock.mockImplementationOnce(
        async (_url, _init, options) => {
          requestSignal = options.signal
          expect(listeners.size).toBe(1)
          return source.response
        },
      )
      const { events, result } = await collectStream(startWithCaller(caller))
      expect(events.map((event) => event.type)).toEqual(['start', 'error'])
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(
        failure
          ? 'HTTP body read failure'
          : 'Antigravity request failed: HTTP 503 upstream failure',
      )
      expect(source.response.bodyUsed).toBe(true)
      expect(source.response.body!.locked).toBe(stock.response.body!.locked)
      expect(source.state()).toEqual({
        nextChunk: 2,
        pendingPulls: 0,
        terminal: failure ? 'error' : 'EOF',
      })
      // Error bodies must use only Response.text()'s readers, not an extra parseGeminiSse reader.
      expect(parserReader).toHaveBeenCalledTimes(stockReader.mock.calls.length)
      expect(listeners.size).toBe(0)
      expect(requestSignal.aborted).toBe(true)
      const firstReason = requestSignal.reason
      caller.abort(new Error('after HTTP failure'))
      expect(requestSignal.reason).toBe(firstReason)
      expect(listeners.size).toBe(0)
      parserReader.mockRestore()
      stockReader.mockRestore()
    }
  })

  it('forwards caller cancellation into the vault opening path and detaches', async () => {
    const caller = new AbortController()
    const listeners = observeCallerListeners(caller.signal)
    const reason = new Error('vault caller canceled')
    let forwarded!: AbortSignal
    const vaultStream = createCortexKitAntigravityVaultStream(
      async (_dispatch, signal) => {
        forwarded = signal!
        expect(listeners.size).toBe(1)
        caller.abort(reason)
        throw forwarded.reason
      },
      'vault-marker',
    )
    const { result } = await collectStream(
      vaultStream(fakeModel(), userContext(), {
        apiKey: 'vault-marker',
        signal: caller.signal,
      }),
    )
    expect(forwarded.reason).toBe(reason)
    expect(result.stopReason).toBe('aborted')
    expect(listeners.size).toBe(0)
  })
})

describe('parseGeminiSse', () => {
  it('parses and unwraps the Antigravity response envelope into chunks', async () => {
    // Antigravity wraps each chunk under a `response` key (MITM-verified).
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":3}}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
      text: 'hi',
    })
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe('STOP')
    expect(chunks[1]?.usageMetadata?.candidatesTokenCount).toBe(3)
  })

  it('handles frames split across read boundaries', async () => {
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"rol',
      'e":"model","parts":[{"text":"split"}]}}]}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
      text: 'split',
    })
  })

  it('ignores [DONE] sentinels and malformed frames', async () => {
    const response = sseResponse([
      'data: [DONE]\n\n',
      'data: not-json\n\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('parses CRLF-separated frames (Antigravity wire format)', async () => {
    // Antigravity separates frames with \r\n\r\n, which contains no \n\n.
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"crlf"}]}}]}}\r\n\r\n',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\r\n\r\n',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
      text: 'crlf',
    })
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('flushes a trailing frame without a blank-line separator', async () => {
    const response = sseResponse([
      'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"tail"}]}}]}}',
    ])

    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
      text: 'tail',
    })
  })

  it('returns nothing for an empty body', async () => {
    const response = new Response(null, { status: 200 })
    const chunks = []
    for await (const chunk of parseGeminiSse(response)) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(0)
  })
})

describe('updateUsage', () => {
  it('counts thinking tokens as output and splits cached prompt tokens', () => {
    const output = emptyOutput()
    // MITM-observed: total = prompt + candidates + thoughts.
    updateUsage(fakeModel(), output, {
      promptTokenCount: 11597,
      candidatesTokenCount: 16,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 4000,
      totalTokenCount: 11663,
    })
    expect(output.usage.input).toBe(11597 - 4000)
    expect(output.usage.cacheRead).toBe(4000)
    expect(output.usage.output).toBe(16 + 50)
    expect(output.usage.totalTokens).toBe(7597 + 66 + 4000)
  })

  it('treats promptTokenCount as the full prompt when no cache is reported', () => {
    const output = emptyOutput()
    updateUsage(fakeModel(), output, {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
    })
    expect(output.usage.input).toBe(100)
    expect(output.usage.cacheRead).toBe(0)
    expect(output.usage.output).toBe(10)
  })
})

describe('vault native-slot admission', () => {
  it.each([
    undefined,
    'synthetic-local-oauth-access',
    'antigravity-vault-custody-extra',
  ])('rejects a missing or foreign resolved credential before vault dispatch (%s)', async (apiKey) => {
    const send = mock(async () => sseResponse([]))
    const stream = createCortexKitAntigravityVaultStream(
      send,
      'antigravity-vault-custody',
    )
    const result = await stream(
      fakeModel(),
      { messages: [] },
      { ...(apiKey === undefined ? {} : { apiKey }) },
    ).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('credential slot is not synchronized')
    expect(send).not.toHaveBeenCalled()
  })

  it('uses only the served vault credential when Pi resolves the exact placeholder', async () => {
    fetchWithAgyCliTransportMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"vault okay"}]},"finishReason":"STOP"}]}}\n\n',
      ]),
    )
    const send: import('./stream.ts').AntigravityVaultSend = async (
      dispatch,
      signal,
    ) =>
      dispatch(
        {
          accessToken: 'synthetic-served-vault-token',
          projectId: 'synthetic-served-project',
        },
        signal,
      )
    const stream = createCortexKitAntigravityVaultStream(
      send,
      'antigravity-vault-custody',
    )
    const result = await stream(
      fakeModel(),
      { messages: [] },
      { apiKey: 'antigravity-vault-custody' },
    ).result()
    expect(result.stopReason).toBe('stop')
    const init = fetchWithAgyCliTransportMock.mock.calls.at(-1)?.[1] as
      | RequestInit
      | undefined
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer synthetic-served-vault-token',
    )
    expect(String(init?.body)).toContain('synthetic-served-project')
    expect(String(init?.body)).not.toContain('antigravity-vault-custody')
    expect(ensureProjectContextMock).not.toHaveBeenCalled()
  })
})

describe('retired Claude requests', () => {
  it('refuses local requests before project discovery or physical transport', async () => {
    const observed = await collectStream(
      streamCortexKitAntigravity(
        fakeModel('antigravity-claude-opus-4-6-thinking'),
        userContext(),
        { apiKey: 'test-token', sessionId: 'retired-local' },
      ),
    )
    expect(observed.result.stopReason).toBe('error')
    expect(observed.result.errorMessage).toBe(
      'This Antigravity model is no longer offered. Choose another model.',
    )
    expect(ensureProjectContextMock).not.toHaveBeenCalled()
    expect(fetchWithAgyCliTransportMock).not.toHaveBeenCalled()
  })

  it('refuses vault requests before obtaining a credential', async () => {
    const send = mock(async () => {
      throw new Error('Unexpected vault credential acquisition')
    })
    const stream = createCortexKitAntigravityVaultStream(
      send,
      'synthetic-placeholder',
    )
    const observed = await collectStream(
      stream(
        fakeModel('antigravity-claude-sonnet-4-6-thinking'),
        userContext(),
        { apiKey: 'synthetic-placeholder', sessionId: 'retired-vault' },
      ),
    )
    expect(observed.result.stopReason).toBe('error')
    expect(observed.result.errorMessage).toBe(
      'This Antigravity model is no longer offered. Choose another model.',
    )
    expect(send).not.toHaveBeenCalled()
    expect(ensureProjectContextMock).not.toHaveBeenCalled()
    expect(fetchWithAgyCliTransportMock).not.toHaveBeenCalled()
  })
})
