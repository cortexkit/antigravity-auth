import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  AgyRequestSessionStore,
  createAgyRequestSessionContext,
  ensureProjectContext,
  fetchWithAgyCliTransport,
  HostRefusalError,
  type OAuthAuthDetails,
  type PreResponseClock,
  PreResponseDeadline,
  type VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'
import {
  type AntigravityRequestExecutor,
  boundRequestRouting,
  createRequestExecutor,
  createRequestWire,
  createRequestWireLocation,
  extractAccountAccessErrorDetails,
  type RequestCredentials,
  type RequestExecuteOptions,
  type RequestNoticeVariant,
  type RequestRouting,
  type RequestSendAdmission,
  type RequestSessions,
  type RequestTransport,
  type SignedThinking,
} from '@cortexkit/antigravity-auth-core/engine'
import { getPackedRefresh } from './credential-cache.ts'
import { createPiRequestDiagnostics } from './request-diagnostics.ts'
import { createPiRequestPool, type PiRequestRow } from './request-pool.ts'
import {
  defaultPiRequestSettings,
  type PiRequestSettings,
  piEngineConfig,
} from './request-settings.ts'

export class PiReauthorizeError extends HostRefusalError {
  readonly code = 'account_reauthorize'
  constructor() {
    super('Reauthorize Antigravity with /login google.')
  }
}

export interface PiVaultSelection {
  route: VaultRouteRef
  first: RequestSendAdmission
  admit(signal?: AbortSignal): Promise<RequestSendAdmission>
}

type Selection =
  | {
      domain: 'local'
      accessToken: string
      assertAdmission?: () => Promise<void>
    }
  | { domain: 'vault'; select(signal: AbortSignal): Promise<PiVaultSelection> }

export interface PiRequestEngineOptions {
  readonly settings?: () => PiRequestSettings
  readonly ready?: () => Promise<void>
  readonly logDirectory?: string
  readonly routing?: RequestRouting
  readonly notify?: (message: string, variant: RequestNoticeVariant) => unknown
  readonly transport?: RequestTransport
  readonly sessions?: RequestSessions
  readonly preResponseClock?: PreResponseClock
}

const no = () => false
const noop = () => {}
const none = async () => undefined
const noSession = () => ({ sessionId: null, parentSessionId: null })

/** One activation's wire state and current account. An in-flight attempt owns its original row. */
export function createPiRequestEngine(options: PiRequestEngineOptions = {}) {
  const settings = options.settings ?? (() => defaultPiRequestSettings)
  const diagnostics = createPiRequestDiagnostics(settings, options.logDirectory)
  const config = piEngineConfig(settings)
  const requestSessions = new AgyRequestSessionStore({ now: () => Date.now() })
  let anonymous = 0
  const sessions: RequestSessions = options.sessions ?? {
    beginRequest: ({ sessionId }) =>
      requestSessions.beginRequest(
        sessionId ? `session:${sessionId}` : `anonymous:${++anonymous}`,
      ),
  }
  // A cache hit is scoped to this activation and the engine's own conversation key.
  const signatures = new Map<
    string,
    { value: SignedThinking; expires: number }
  >()
  const findSignature = (key: string) => {
    const entry = signatures.get(key)
    if (entry && entry.expires <= Date.now()) signatures.delete(key)
    return settings().signature_cache.enabled &&
      entry &&
      entry.expires > Date.now()
      ? entry.value
      : undefined
  }
  const wireLocation = createRequestWireLocation({
    signatures: {
      get keepThinking() {
        return settings().keep_thinking
      },
      signatureStore: {
        get: findSignature,
        set(key, value) {
          if (!settings().signature_cache.enabled) return
          signatures.delete(key)
          signatures.set(key, {
            value,
            expires:
              Date.now() + settings().signature_cache.memory_ttl_seconds * 1000,
          })
          if (signatures.size > 256)
            signatures.delete(signatures.keys().next().value!)
        },
        has: (key) => findSignature(key) !== undefined,
        delete: (key) => {
          signatures.delete(key)
        },
      },
      cacheSignature: noop,
      getCachedSignature(key, text) {
        const signed = findSignature(key)
        return signed?.text === text ? signed.signature : undefined
      },
    },
    debug: { ...diagnostics.debug, isDebugTuiEnabled: no, logCacheStats: noop },
    logger: diagnostics.logger,
  })
  const pluginSessionId = randomUUID()
  const defaultSession = createAgyRequestSessionContext({
    conversationId: pluginSessionId,
    trajectoryId: pluginSessionId,
  })
  const wire = createRequestWire(wireLocation, {
    pluginSessionId,
    defaultSession,
    debugMessagePrefix: 'Antigravity diagnostics:',
    helperLog: diagnostics.logger,
    dump: diagnostics.dump,
  })
  // Only the selected receipt for this request can be consumed by its first
  // send. Concurrent requests on the same row must not borrow that receipt.
  const current = new AsyncLocalStorage<{
    assertAdmission?: () => Promise<void>
    first?: RequestSendAdmission
    admit?: PiVaultSelection['admit']
  }>()
  let bound: { key: string; executor: AntigravityRequestExecutor } | undefined
  const retired = new Set<AntigravityRequestExecutor>()
  const resetAccount = () => {
    if (!bound) return
    const executor = bound.executor
    bound = undefined
    retired.add(executor)
    void executor.retire().then(() => retired.delete(executor))
  }

  function bind(
    key: string,
    row: PiRequestRow,
    credentials: RequestCredentials<PiRequestRow>,
  ) {
    if (bound?.key !== key) {
      resetAccount()
      bound = {
        key,
        executor: createRequestExecutor({
          preResponseClock: options.preResponseClock,
          config,
          accounts: createPiRequestPool(row),
          credentials,
          sessions,
          scopeDisplayedThinking: true,
          assertAdmission: async (signal) => {
            signal.throwIfAborted()
            await current.getStore()?.assertAdmission?.()
          },
          readSession: noSession,
          isTitleRoutingRequest: no,
          routing:
            credentials.domain === 'vault'
              ? (options.routing ?? boundRequestRouting)
              : {
                  ...boundRequestRouting,
                  hasAccessor: no,
                  hasVaultHost: no,
                },
          authCommand: '/login google',
          reauthorize: () => new PiReauthorizeError(),
          wire,
          ...diagnostics,
          transport: options.transport ?? fetchWithAgyCliTransport,
          trackers: {
            health: {
              recordFailure: noop,
              recordRateLimit: noop,
              recordSuccess: noop,
            },
            token: { consume: no, refund: noop },
          },
          classifyAccessError: extractAccountAccessErrorDetails,
          notify: options.notify,
        }),
      }
    }
    return bound.executor
  }

  return {
    logger: diagnostics.logger,
    resetAccount,
    async dispose() {
      const executor = bound?.executor
      bound = undefined
      await Promise.all([
        executor?.dispose(),
        ...[...retired].map((item) => item.dispose()),
      ])
      requestSessions.clear()
      signatures.clear()
    },
    async execute(
      selection: Selection,
      url: string,
      init: RequestInit,
      request: RequestExecuteOptions,
    ) {
      const opening = new PreResponseDeadline(
        init.signal,
        options.preResponseClock,
      )
      let selected: PiVaultSelection | undefined
      try {
        if (selection.domain === 'local')
          await opening.wait(() => selection.assertAdmission?.())
        await opening.wait(() => options.ready?.())
        if (selection.domain === 'vault')
          selected = await opening.wait(() => selection.select(opening.signal))
      } finally {
        opening.dispose()
      }
      if (selection.domain === 'vault') {
        const { route, first, admit } = selected!
        const key = JSON.stringify([
          'vault',
          route.routeId,
          first.recordVersion,
        ])
        const executor = bind(
          key,
          { index: 0, route, rateLimitResetTimes: {} },
          {
            domain: 'vault',
            boundRoute: true,
            async admit({ signal }) {
              const scope = current.getStore()!
              const receipt = scope.first
              scope.first = undefined
              return receipt ?? scope.admit!(signal)
            },
          },
        )
        return current.run({ first, admit }, () =>
          executor.execute(url, init, request),
        )
      }

      const { accessToken, assertAdmission } = selection
      if (!accessToken)
        throw new HostRefusalError('Missing Antigravity OAuth access token')
      const refresh = getPackedRefresh(accessToken) ?? ''
      const key = createHash('sha256')
        .update(JSON.stringify(['local', refresh, accessToken]))
        .digest('hex')
      const auth: OAuthAuthDetails = {
        type: 'oauth',
        refresh,
        access: accessToken,
        expires: Number.MAX_SAFE_INTEGER,
      }
      const executor = bind(
        key,
        { index: 0, rateLimitResetTimes: {} },
        {
          domain: 'local',
          toAuthDetails: () => auth,
          ensureProject: ensureProjectContext,
          refresh: none,
          updateFromAuth: noop,
          removeAccount: no,
          saveToDisk: none,
          saveToDiskReplace: none,
          isInvalidGrant: no,
          clearStoredAuth: none,
          captureGrant: () => ({
            source: 'pool-file',
            check() {
              if (bound?.key !== key) throw new PiReauthorizeError()
            },
          }),
        },
      )
      return current.run({ assertAdmission }, () =>
        executor.execute(url, init, request),
      )
    },
  }
}

export type PiRequestEngine = ReturnType<typeof createPiRequestEngine>
