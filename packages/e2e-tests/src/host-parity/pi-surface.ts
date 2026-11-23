import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgyRequestSessionStore,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import type { ClaustrumScopedClient } from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import {
  type Api,
  type Context,
  isContextOverflow,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  CUSTODY_PROVIDER_KEY_MARKER,
  registerCortexKitPiAntigravity,
} from '../../../pi/src/index.ts'
import {
  PI_ANTIGRAVITY_ENROLLMENT_NAME,
  PiVaultSetup,
} from '../../../pi/src/vault-setup.ts'
import type { Conversation, Custody, Part } from './cases.ts'
import type { Environment } from './environment.ts'
import { credential, epoch } from './fixtures.ts'
import {
  recordFailure,
  recordSignature,
  surface,
  terminal,
} from './native-google.ts'

type Registry = Parameters<typeof registerCortexKitPiAntigravity>[0]
type ProviderConfig = Parameters<Registry['registerProvider']>[1]

function content(part: Part): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, textSignature: part.signature }
    case 'image':
      return { type: 'image', data: part.data, mimeType: part.mediaType }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: part.text,
        thinkingSignature: part.signature,
      }
    case 'call':
      return {
        type: 'toolCall',
        id: part.id,
        name: part.name,
        arguments: part.args,
        thoughtSignature: part.signature,
      }
    case 'result':
      return {
        type: 'toolResult',
        toolCallId: part.id,
        toolName: part.name,
        content: part.content.map(content),
        isError: false,
      }
  }
}

export function piContext(input: Conversation, transcript: boolean): Context {
  const tools = input.tools.map(({ name, description, schema }) => ({
    name,
    description,
    parameters: schema,
  }))
  const messages = input.messages.flatMap(({ role, parts }, offset) => {
    // Equal input timestamps across distinct requests catch fallback session
    // identity that accidentally depends on timestamp rather than ownership.
    const timestamp = offset + 1
    return role === 'tool'
      ? parts.map((part) => ({
          ...content(part),
          role: 'toolResult',
          timestamp,
        }))
      : [
          {
            role,
            content: parts.map(content),
            timestamp,
            ...(role === 'assistant'
              ? {
                  api: 'google-generative-ai',
                  provider: 'google',
                  model: input.model,
                  stopReason: 'stop',
                }
              : {}),
          },
        ]
  })
  return (transcript
    ? {
        messages: [
          {
            role: 'system',
            content: input.prompt,
            toolsAdded: tools,
            timestamp: 0,
          },
          ...messages,
        ],
      }
    : { systemPrompt: input.prompt, messages, tools }) as unknown as Context
}

export async function piAdapter(
  environment: Environment,
  custody: Custody,
  transcript: boolean,
  settings: Readonly<Record<string, unknown>> = {},
) {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('Host parity requires the root test preload')
  const dir = await mkdtemp(join(root, 'parity-pi-'))
  const modeFile = join(dir, 'pi-mode.json')
  const settingsFile = join(dir, 'settings.jsonc')
  const nativeAuthPath = join(dir, 'auth.json')
  const native = {
    type: 'oauth' as const,
    access: credential.accessToken,
    refresh: `fixture-refresh|${credential.projectId}|${credential.projectId}`,
    expires: epoch + 86_400_000,
  }
  const connectEnrollment = async () => ({
    enrollPropose: async () => ({ requestId: 'parity-enrollment' }),
    enrollPoll: async () => ({
      status: 'approved' as const,
      name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
      token: 'b'.repeat(64),
      tokenGeneration: 1,
    }),
    close() {},
  })
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({
      view: 'parity-roster',
      rows: [
        {
          id: 'parity-credential',
          accountId: 'parity-identity',
          categories: ['antigravity-native'],
          credentialType: 'oauth',
          serves: [],
          providerIds: [],
          refreshAdapter: 'antigravity',
          state: 'active',
          recordVersion: 1,
          operations: ['read'],
          createdAtMs: null,
        },
      ],
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async () => ({
      material: credential.accessToken,
      projectId: credential.projectId,
      accountId: 'parity-identity',
      credentialId: 'parity-credential',
      recordVersion: 1,
      expiresAtMs: epoch + 86_400_000,
    }),
    reportAuthFailureScoped: async () => {},
    reportCondition: async ({ reason, providerStatus, actionUrl }) => {
      environment.reports.push({
        condition: { reason, providerStatus, ...(actionUrl && { actionUrl }) },
      })
    },
    close() {},
  }
  const hostKey = Symbol.for('cortexkit.vault')
  const priorHost = Reflect.getOwnPropertyDescriptor(globalThis, hostKey)
  if (custody === 'host')
    Reflect.defineProperty(globalThis, hostKey, {
      configurable: true,
      value: () => client,
    })
  let provider: ProviderConfig | undefined
  let stop: (() => Promise<void>) | undefined
  let executionId = 10_001
  const sessionStore = new AgyRequestSessionStore({
    now: () => Date.now(),
    // Generate execution IDs separately so native-slot locking and settings
    // writes do not affect the frozen request metadata.
    createExecutionId: () =>
      `00000000-0000-4000-8000-${(++executionId).toString(16).padStart(12, '0')}`,
  })
  let anonymous = 0
  const initialize = async (keepThinking = false) => {
    await Bun.write(
      settingsFile,
      JSON.stringify({ keep_thinking: keepThinking, ...settings }),
    )
    if (custody === 'local')
      await Bun.write(nativeAuthPath, JSON.stringify({ google: native }))
    if (custody === 'vault') {
      const setup = new PiVaultSetup({
        claustrum: await loadCommonAuthClaustrum(),
        stateDir: dir,
        modeFile,
        readHostSlot: () => undefined,
        connectEnrollment,
      })
      const enrolled = await setup.connectStep()
      if (enrolled.state !== 'approved')
        throw new Error(`Pi parity enrollment: ${enrolled.state}`)
    }
    await registerCortexKitPiAntigravity(
      {
        registerProvider(_name: string, config: ProviderConfig) {
          provider = config
        },
        registerCommand() {},
        on(event: string, handler: () => Promise<void>) {
          if (event === 'session_shutdown') stop = handler
        },
      } as unknown as Registry,
      {
        vaultDir: dir,
        modeFile,
        rosterFile: join(dir, 'roster.json'),
        nativeAuthPath,
        settingsFile,
        readHostSlot: () => (custody === 'local' ? native : undefined),
        connect: async () => client,
        connectEnrollment,
        requestEngine: {
          notify: (message) => environment.notices.push(message),
          sessions: {
            beginRequest: ({ sessionId }) =>
              sessionStore.beginRequest(sessionId ?? `fresh:${++anonymous}`),
          },
        },
      },
    )
  }
  return {
    get nativeAuthPath() {
      return nativeAuthPath
    },
    async activate(keepThinking = false) {
      if (!provider) await initialize(keepThinking)
      if (!provider?.streamSimple)
        throw new Error('Pi did not register its stream')
      return provider
    },
    async run(input: Conversation, session?: string, signal?: AbortSignal) {
      if (!provider) await initialize(input.options.keepThinking)
      if (!provider?.streamSimple)
        throw new Error('Pi did not register its stream')
      const stream = provider.streamSimple
      const output = {
        ...surface(),
        responseId: undefined as string | undefined,
        rawStopReason: undefined as string | undefined,
      }
      const model = {
        id: input.model,
        name: input.model,
        api: 'google-generative-ai',
        provider: 'google',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as Model<Api>
      const { level, budget, temperature, topP, maxTokens } = input.options
      const auth =
        custody === 'local'
          ? (await Bun.file(nativeAuthPath).json()).google
          : null
      const options = {
        apiKey:
          custody === 'local'
            ? provider.oauth?.getApiKey(auth)
            : CUSTODY_PROVIDER_KEY_MARKER,
        sessionId: session,
        signal,
        reasoning: level,
        thinkingBudgets:
          level && budget !== undefined ? { [level]: budget } : undefined,
        temperature,
        topP,
        maxTokens,
        onPayload(payload: unknown) {
          environment.hooks.push({ payload })
          return { ignored: true }
        },
        onResponse(response: unknown) {
          environment.hooks.push({ response })
        },
      } as SimpleStreamOptions
      try {
        for await (const event of stream(
          model,
          piContext(input, transcript),
          options,
        )) {
          switch (event.type) {
            case 'text_delta':
              output.text += event.delta
              break
            case 'thinking_delta':
              output.thinking += event.delta
              break
            case 'toolcall_end': {
              const block = event.toolCall
              output.calls.push({
                name: block.name,
                input: block.arguments,
                signature: block.thoughtSignature,
              })
              break
            }
            case 'done':
            case 'error': {
              const message =
                event.type === 'done' ? event.message : event.error
              output.responseId = message.responseId
              output.rawStopReason = message.rawStopReason
              const { usage } = message
              output.usage = {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                reasoning:
                  (usage as typeof usage & { reasoningTokens?: number })
                    .reasoningTokens ?? 0,
                total: usage.totalTokens,
              }
              for (const block of message.content) {
                if (block.type === 'text')
                  recordSignature(output, 'text', block.textSignature)
                if (block.type === 'thinking')
                  recordSignature(output, 'thinking', block.thinkingSignature)
              }
              if (event.type === 'error') {
                output.compaction ||= isContextOverflow(
                  message,
                  model.contextWindow,
                )
                recordFailure(output, message.errorMessage ?? event.reason)
              } else
                terminal(
                  output,
                  event.reason === 'toolUse' ? 'stop' : event.reason,
                )
              break
            }
          }
        }
      } catch (error) {
        recordFailure(output, error)
      }
      return output
    },
    async dispose() {
      await stop?.()
      if (custody === 'host') {
        if (priorHost) Reflect.defineProperty(globalThis, hostKey, priorHost)
        else Reflect.deleteProperty(globalThis, hostKey)
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}
