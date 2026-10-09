/**
 * OpenCode 2 (2.0.22) server plugin. It sends the host's Google model
 * requests for this plugin's models to Antigravity accounts through a
 * loopback bridge, and serves the `antigravity-auth` v1 RPC with each
 * location's account state and commands. `createGaAntigravityPlugin` is the
 * plugin the host loads; `createGaPluginFromServices` builds one over a
 * given location-services factory. Host SDK imports are type-only.
 */

import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  type AgyTransportOptions,
  type authorizeAntigravity,
  buildAntigravityHarnessUserAgent,
  type ensureProjectContext,
  type exchangeAntigravity,
  type FetchAvailableModelsOptions,
  fetchWithAgyCliTransport,
  getPublicModelDefinitions,
  loadCommonAuthCommands,
  type loadManagedProject,
  type OAuthAuthDetails,
  type OpencodeModelDefinition,
  type refreshAntigravityToken,
} from '@cortexkit/antigravity-auth-core'
import type { Model, Plugin } from '@opencode/plugin'
import type { ProviderEditor } from '@opencode/plugin/promise/provider'
import type { Registration } from '@opencode/plugin/promise/registration'
import type { RpcHandlers, RpcRegistration } from '@opencode/plugin/promise/rpc'
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRequestKind,
  SessionRetry,
} from '@opencode/plugin/promise/session'

import { createGaLocationServices } from '../../plugin/ga-location-services.ts'
import type { persistAccountPool } from '../../plugin/persist-account-pool.ts'
import {
  createLocationRuntime,
  type LocationRuntime,
  type LocationRuntimeOptions,
} from '../../plugin/shared/runtime.ts'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  RpcNotificationPayload,
} from '../../rpc/protocol.ts'
import {
  redactAccountForSidebar,
  type SidebarAccountRedactionInput,
  type SidebarRoutingEntry,
} from '../../sidebar-state.ts'
import {
  assertLoopbackProxyGuard,
  type LoopbackProxyEnv,
} from '../proxy-guard.ts'
import {
  ANTIGRAVITY_MENU_COMMAND_NAME,
  ANTIGRAVITY_RPC_DEFINITION,
  ANTIGRAVITY_RPC_LIMITS,
  ANTIGRAVITY_RPC_VERSION,
  type AntigravityAccountDto,
  type AntigravityAccountsStatus,
  AntigravityApplyInputSchema,
  type AntigravityApplyOutput,
  AntigravityApplyOutputSchema,
  AntigravityApplyResultSchema,
  type AntigravityChangedEvent,
  type AntigravityNotificationDto,
  AntigravityNotificationPayloadSchema,
  type AntigravityRouteDto,
  type AntigravityRpcIssue,
  type AntigravityRpcScope,
  type AntigravitySettingsDto,
  AntigravityStateInputSchema,
  type AntigravityStateOutput,
  AntigravityStateOutputSchema,
  type AntigravityStateReset,
  type AntigravityStatusDto,
} from '../rpc/protocol.ts'

// Overrides

/**
 * The host's request kinds for a model request, declared without the SDK so
 * the override types stay SDK-free. The binding below checks it equals the
 * SDK's `SessionRequestKind`.
 */
export type GaRequestKind = 'primary' | 'compaction' | 'title' | 'generate'

/**
 * Synchronous diagnostic that receives the AbortSignal handed to the
 * production raw sender. Its return type is `undefined`, not `void`, so an
 * async function (`Promise<undefined>`) is not assignable to it.
 */
export type ObserveRawSenderSignal = (signal: AbortSignal) => undefined

/**
 * The fixed fields of one Antigravity request envelope as it goes on the
 * wire. The shared request pipeline builds it; the sender only serializes it.
 */
export interface GaAgyEnvelope {
  readonly project: string
  readonly requestId: string
  readonly request: Readonly<Record<string, unknown>>
  readonly model: string
  readonly userAgent: 'antigravity'
  readonly requestType: 'agent'
}

export interface GaSendInput {
  readonly envelope: GaAgyEnvelope
  readonly auth: OAuthAuthDetails
  /** One of the Antigravity endpoint origins, without a trailing path. */
  readonly endpoint: string
  readonly signal: AbortSignal
  readonly kind: GaRequestKind
}

/** Waits for the OAuth redirect carrying `expectedState`; resolves the code. */
export type GaWaitForOAuthCode = (
  expectedState: string,
  options?: { port?: number; timeoutMs?: number },
) => Promise<string>

/** How the account's provider metadata looked in the read. */
export type HarnessMetadataStatus =
  | 'present'
  | 'absent'
  | 'dropped-uncovered'
  | 'dropped-invalid'

/**
 * The account's access block. `unknown` when the metadata is absent or was
 * dropped, so a block cannot be ruled out; `invalid` when the flags are not
 * booleans or both blocks are set at once.
 */
export type HarnessAccessBlock =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'verification-required'
      readonly reason: 'validation-required' | 'other' | 'unrecorded'
    }
  | {
      readonly kind: 'ineligible'
      readonly reason: 'account-ineligible' | 'other' | 'unrecorded'
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid' }

/**
 * One account as an out-of-process test harness observes it. It carries no
 * email, label, token, project id, identity, row id or credential epoch.
 */
export interface HarnessAccountObservation {
  readonly selector: string
  readonly position: number
  readonly enabled: boolean
  readonly usable: boolean
  readonly metadataStatus: HarnessMetadataStatus
  readonly accessBlock: HarnessAccessBlock
  /** Routing slots whose stored account reference is exactly this row's. */
  readonly currentFor: readonly ('active' | 'claude' | 'gemini')[]
  readonly cooldownUntil: number | null
}

/**
 * Diagnostic view of one `state` read, built from the same repository read
 * as the answer with the same `readSeq`.
 */
export interface HarnessAccountsObservation {
  readonly generation: string
  readonly readSeq: number
  readonly status:
    | 'ready'
    | 'pending-migration'
    | 'management-pending'
    | 'error'
  readonly accountsStatus: 'complete' | 'over-limit'
  readonly accounts: readonly HarnessAccountObservation[]
  /** Selectors that stopped working at this read. */
  readonly retiredSelectors: readonly string[]
}

/**
 * Synchronous diagnostic receiving each `state` read's observation. Like
 * `ObserveRawSenderSignal`, it returns `undefined` so an async function is
 * not assignable; a throw is ignored.
 */
export type ObserveAccountSnapshot = (
  observation: HarnessAccountsObservation,
) => undefined

/** Dependency overrides for tests; production passes none. */
export interface GaPluginOverrides {
  /**
   * Replaces the production raw sender. When given, the production sender is
   * never called, so `observeRawSenderSignal` is never invoked.
   */
  send?: (input: GaSendInput) => Promise<Response>
  /**
   * Observes the exact AbortSignal on the transport-options object that the
   * production raw sender receives. Called synchronously, never awaited; a
   * throw is ignored and cannot change the dispatch. Only the default sender
   * branch calls it.
   */
  observeRawSenderSignal?: ObserveRawSenderSignal
  /**
   * Receives a redacted observation of each `state` read, for test
   * harnesses that drive a real host. Absent in normal operation; the
   * location's services call it synchronously from the same read.
   */
  observeAccountSnapshot?: ObserveAccountSnapshot
  persistAccountPool?: typeof persistAccountPool
  refreshAccessToken?: typeof refreshAntigravityToken
  ensureProjectContext?: typeof ensureProjectContext
  loadManagedProject?: typeof loadManagedProject
  oauth?: {
    authorize?: typeof authorizeAntigravity
    exchange?: typeof exchangeAntigravity
    waitForCode?: GaWaitForOAuthCode
  }
  /** Transport for quota and model-list fetches. */
  quotaFetch?: NonNullable<FetchAvailableModelsOptions['fetchVia']>
}

// Raw request sender

/**
 * How long a response body may stall with no bytes before the raw sender
 * destroys the socket: five minutes, the value the earlier OpenCode 2 beta
 * adapter (`packages/opencode-v2`) used, kept so both adapters time out
 * alike.
 */
export const GA_RAW_IDLE_TIMEOUT_MS = 300_000

/** The Antigravity streaming endpoint path appended to an endpoint origin. */
export const GA_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse'

export type GaRawSender = (input: GaSendInput) => Promise<Response>

/**
 * Choose the dispatch for one activation. With a `send` override, requests
 * go to it and the observer is never called. Otherwise each request builds
 * one transport-options object, hands its `signal` property to the observer
 * synchronously, and passes that same object to the unchanged production
 * sender. The observer cannot change the dispatch: its result is ignored
 * and a synchronous throw is swallowed.
 */
export function createGaRawSender(
  overrides: Pick<GaPluginOverrides, 'send' | 'observeRawSenderSignal'> = {},
): GaRawSender {
  const send = overrides.send
  if (send) return (input) => send(input)
  const observe = overrides.observeRawSenderSignal
  return (input) => {
    const transportOptions = {
      signal: input.signal,
      idleTimeoutMs: GA_RAW_IDLE_TIMEOUT_MS,
    } satisfies AgyTransportOptions
    if (observe) {
      try {
        observe(transportOptions.signal)
      } catch {
        // A diagnostic failure must not change or delay the dispatch.
      }
    }
    return fetchWithAgyCliTransport(
      `${input.endpoint}${GA_STREAM_PATH}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.auth.access}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip',
          'User-Agent': buildAntigravityHarnessUserAgent(),
        },
        body: JSON.stringify(input.envelope),
      },
      transportOptions,
    )
  }
}

// Loopback bridge

/**
 * Native Google content requests the request hook may rewrite: POST to
 * `…/models/<id>:generateContent` or `…:streamGenerateContent`.
 */
export const GA_GOOGLE_CONTENT_PATH =
  /^\/[^?#]*\/models\/[^/:]+:(generateContent|streamGenerateContent)$/

const BRIDGE_HOST = '127.0.0.1'
/**
 * Job ids are lowercase RFC 4122 UUIDs. End-to-end tests that measure how the
 * host sends the rewritten request match its path against
 * `^/agy/[0-9a-f-]{36}$` (`packages/e2e-tests/docker/ga-loopback-request-contract.ts`),
 * so a different id format would no longer be recognised as a bridge job.
 */
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const JOB_PATH_PATTERN = /^\/agy\/([^/]+)$/
/** A registered job the host never dispatched is dropped after this long. */
export const GA_UNCLAIMED_JOB_TTL_MS = 60_000

export function isGaGoogleContentRequest(request: Request): boolean {
  if (request.method !== 'POST') return false
  try {
    return GA_GOOGLE_CONTENT_PATH.test(new URL(request.url).pathname)
  } catch {
    return false
  }
}

/** What the request hook recorded about one Google request it rewrote. */
export interface GaBridgeJob {
  readonly sessionID: string
  /** Set only when the host supplied a parent session. */
  readonly parentSessionID: string | null
  readonly kind: GaRequestKind
  readonly modelID: string
  /**
   * The selected variant of a registered model, from the host's model
   * reference; `null` for the default variant and for title requests on
   * models this plugin did not register.
   */
  readonly variant: string | null
  /** The host's original request URL. */
  readonly url: string
  /** The host's original JSON body, unmodified. */
  readonly body: string
}

export interface GaJobContext {
  /**
   * Aborts when the host abandons the loopback request or the activation is
   * disposed. The executor passes it to `send`.
   */
  readonly signal: AbortSignal
  readonly send: GaRawSender
}

/**
 * Runs one job: request transformation, account selection, retries and the
 * response adaptation to native Gemini SSE or JSON. The shared request
 * pipeline provides it. A thrown error before a Response exists becomes an
 * HTTP 502 answer; a Response is streamed back unchanged.
 */
export type GaJobExecutor = (
  job: GaBridgeJob,
  context: GaJobContext,
) => Promise<Response>

export interface GaLoopbackBridge {
  readonly port: number
  /** `http://127.0.0.1:<port>` */
  readonly origin: string
  /**
   * Register a job and build its replacement request. The proxy guard runs
   * first, against the actual bridge URL; a refusal throws
   * `LoopbackProxyGuardError` and registers nothing. The replacement copies
   * no original header, has only `content-type: application/json`, body
   * `{}`, and the original request's AbortSignal.
   */
  rewrite(original: Request, job: GaBridgeJob, env: LoopbackProxyEnv): Request
  /**
   * For the host's `http.response` hook. When `request` is one of this
   * bridge's job requests, return a response whose body reads the original
   * bytes and then, if the upstream body failed after headers, fails with
   * the error the bridge captured for that job (the genuine upstream cause)
   * instead of ending. Any other request returns `null` and its response is
   * left alone.
   */
  adaptResponse(request: Request, response: Response): Response | null
  /** Jobs registered or running (diagnostics and tests). */
  pendingJobs(): number
  /**
   * Stop accepting connections, abort every running job, close every
   * socket and wait for the server to close. Idempotent.
   */
  dispose(): Promise<void>
}

export interface GaLoopbackBridgeOptions {
  execute: GaJobExecutor
  send: GaRawSender
  /** Receives bridge failures; never request bodies or credentials. */
  onError?: (message: string) => void
}

/** The HTTP 502 answer for a terminal failure before upstream headers. */
export function gaPreHeaderFailureResponse(error: unknown): Response {
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Antigravity request failed before a response arrived'
  return new Response(
    JSON.stringify({ error: { code: 502, message, status: 'UNAVAILABLE' } }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )
}

export async function startGaLoopbackBridge(
  options: GaLoopbackBridgeOptions,
): Promise<GaLoopbackBridge> {
  const queued = new Map<
    string,
    { job: GaBridgeJob; timer: ReturnType<typeof setTimeout> }
  >()
  const running = new Set<AbortController>()
  const sockets = new Set<Socket>()
  // Post-header failures by job id, held until the job's adapted response
  // reads them or the hold expires.
  const failures = new Map<
    string,
    { error: Error; timer: ReturnType<typeof setTimeout> }
  >()
  const recordFailure = (id: string, error: Error): void => {
    const timer = setTimeout(() => failures.delete(id), GA_UNCLAIMED_JOB_TTL_MS)
    timer.unref?.()
    failures.set(id, { error, timer })
  }
  const takeFailure = (id: string): Error | undefined => {
    const entry = failures.get(id)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    failures.delete(id)
    return entry.error
  }
  let disposal: Promise<void> | null = null
  const report = (message: string): void => {
    try {
      options.onError?.(message)
    } catch {
      // Reporting is best-effort.
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      report(`bridge request failed: ${errorMessage(error)}`)
      if (!response.headersSent) {
        writeResponseHead(response, 500, 'application/json')
        response.end(JSON.stringify({ error: { message: 'bridge failure' } }))
      } else {
        response.destroy()
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const match = JOB_PATH_PATTERN.exec(
      new URL(request.url ?? '/', 'http://bridge').pathname,
    )
    const candidate = match?.[1]
    const id =
      candidate !== undefined && isGaJobId(candidate) ? candidate : null
    const entry = id ? queued.get(id) : undefined
    // The body is always `{}`; read and ignore it so the socket stays usable.
    request.resume()
    if (request.method !== 'POST' || !id || !entry || disposal) {
      writeResponseHead(response, 404, 'application/json')
      response.end(JSON.stringify({ error: { message: 'unknown job' } }))
      return
    }
    // A job runs at most once.
    queued.delete(id)
    clearTimeout(entry.timer)

    const controller = new AbortController()
    running.add(controller)
    response.once('close', () => {
      if (!response.writableFinished) {
        controller.abort(new Error('The host closed the loopback request'))
      }
    })
    try {
      let upstream: Response
      try {
        upstream = await options.execute(entry.job, {
          signal: controller.signal,
          send: options.send,
        })
      } catch (error) {
        upstream = gaPreHeaderFailureResponse(error)
      }
      await pipeResponse(upstream, response, (error) =>
        recordFailure(id, error),
      )
    } finally {
      running.delete(controller)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, BRIDGE_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // The bridge must never be what keeps an idle host process alive.
  server.unref()
  const address = server.address() as AddressInfo
  const origin = `http://${BRIDGE_HOST}:${address.port}`

  return {
    port: address.port,
    origin,
    rewrite(original, job, env) {
      if (disposal) throw new Error('The Antigravity bridge is disposed')
      const id = randomUUID()
      const target = `${origin}/agy/${id}`
      assertLoopbackProxyGuard({ env, target })
      const timer = setTimeout(() => {
        queued.delete(id)
      }, GA_UNCLAIMED_JOB_TTL_MS)
      timer.unref?.()
      queued.set(id, { job, timer })
      return new Request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: original.signal,
      })
    },
    adaptResponse(request, response) {
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return null
      }
      if (url.origin !== origin) return null
      const candidate = JOB_PATH_PATTERN.exec(url.pathname)?.[1]
      if (candidate === undefined || !isGaJobId(candidate)) return null
      const id = candidate
      const source = response.body
      if (!source) return null
      const reader = source.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              // The bridge ends a failed job's loopback body cleanly after
              // its last byte and records the failure first, so the end of
              // the body is where the genuine error is delivered.
              const failure = takeFailure(id)
              if (failure) controller.error(failure)
              else controller.close()
              return
            }
            controller.enqueue(value)
          } catch (error) {
            controller.error(takeFailure(id) ?? error)
          }
        },
        cancel(reason) {
          takeFailure(id)
          return reader.cancel(reason)
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
    pendingJobs: () => queued.size + running.size,
    dispose() {
      if (!disposal) {
        disposal = (async () => {
          for (const { timer } of queued.values()) clearTimeout(timer)
          queued.clear()
          for (const { timer } of failures.values()) clearTimeout(timer)
          failures.clear()
          const closed = new Promise<void>((resolve) => {
            server.close(() => resolve())
          })
          for (const controller of running) {
            controller.abort(
              new Error('The Antigravity activation was disposed'),
            )
          }
          for (const socket of sockets) socket.destroy()
          await closed
        })()
      }
      return disposal
    },
  }
}

/** Accept only job IDs produced by request rewrite. */
export function isGaJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value)
}

function writeResponseHead(
  response: ServerResponse,
  status: number,
  contentType: string,
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-cache',
  })
}

/**
 * Stream a Response to the loopback client. Bytes pass through unchanged,
 * except that an event stream ending without its final blank line gets one,
 * so the host's SSE reader sees the last frame.
 *
 * When the upstream body fails, the failure is handed to `onFailure` first,
 * and then the loopback response is ended normally: the status, the headers
 * and every byte already written still reach the host. The job's
 * `http.response` adapter turns that end into the genuine error, so the host
 * receives the real content followed by the original failure, and never a
 * fabricated success. Setup registers that adapter before the request hook,
 * so every rewritten job has it.
 *
 * The response is not destroyed on failure. Bun's `ServerResponse` calls a
 * write's callback while the bytes are still in the response's own buffer
 * (its `writableLength` has not dropped yet), and destroying it then
 * discards those bytes and the unsent headers. The host's fetch would then
 * fail with a connection reset before any response exists, and its
 * `http.response` hook would never run.
 */
async function pipeResponse(
  upstream: Response,
  response: ServerResponse,
  onFailure: (error: Error) => void,
): Promise<void> {
  const contentType =
    upstream.headers.get('content-type') ?? 'application/octet-stream'
  writeResponseHead(response, upstream.status, contentType)
  if (!upstream.body) {
    response.end()
    return
  }
  const eventStream = contentType.startsWith('text/event-stream')
  const reader = upstream.body.getReader()
  let tail = ''
  let wroteAny = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      wroteAny = true
      if (eventStream) {
        tail = (tail + Buffer.from(value).toString('latin1')).slice(-2)
      }
      if (!response.write(value)) {
        await new Promise<void>((resolve) => {
          response.once('drain', resolve)
          response.once('close', resolve)
        })
      }
      if (response.destroyed) {
        await reader.cancel().catch(() => {})
        return
      }
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    // The captured upstream body error is recorded before the loopback body
    // ends, so the job's `http.response` hook adapter (`adaptResponse`) finds
    // it when the host reads the end of the body and fails the read with it.
    onFailure(error)
    response.end()
    return
  }
  if (eventStream && wroteAny && tail !== '\n\n') {
    response.write(tail.endsWith('\n') ? '\n' : '\n\n')
  }
  response.end()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Setup context check

/** Context capabilities setup requires, by property path. */
export const GA_REQUIRED_CONTEXT_CAPABILITIES = [
  'location.directory',
  'session.hook',
  'rpc.register',
  'provider.transform',
] as const

export class GaSetupContextError extends Error {
  override readonly name = 'GaSetupContextError'
  constructor(readonly missing: readonly string[]) {
    super(
      `OpenCode GA plugin context is missing: ${missing.join(', ')}. ` +
        'The Antigravity GA plugin cannot start in this host.',
    )
  }
}

/**
 * Validate host setup capabilities before allocating resources. Only
 * `session` and `location` are read before deciding:
 * - neither present: `'legacy'`, an OpenCode 1 core loader; setup returns
 *   `undefined` with no side effect;
 * - exactly one present, or both with a required capability missing: throws
 *   `GaSetupContextError` naming what is missing;
 * - otherwise `'ga'`.
 */
export function classifyGaSetupContext(context: object): 'legacy' | 'ga' {
  const record = context as Record<string, unknown>
  const session = record.session
  const location = record.location
  if (session === undefined && location === undefined) return 'legacy'
  const missing: string[] = []
  if (!isObject(location) || typeof location.directory !== 'string') {
    missing.push('location.directory')
  }
  if (!isObject(session) || typeof session.hook !== 'function') {
    missing.push('session.hook')
  }
  if (session !== undefined && location !== undefined && missing.length === 0) {
    const rpc = record.rpc
    if (!isObject(rpc) || typeof rpc.register !== 'function') {
      missing.push('rpc.register')
    }
    const provider = record.provider
    if (!isObject(provider) || typeof provider.transform !== 'function') {
      missing.push('provider.transform')
    }
  }
  if (missing.length > 0) throw new GaSetupContextError(missing)
  return 'ga'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// RPC store per activation

/**
 * A new opaque generation token. Each activation gets its own, so a client
 * still holding an older activation's token is detected and reset.
 */
export function createGaGeneration(): string {
  return `g-${randomUUID()}`
}

/**
 * Read side of one location's state, supplied by the location's services.
 * Rows are the sidebar projection's input; the activation redacts them with
 * `redactAccountForSidebar`, so raw account records never reach a client.
 */
export interface GaStateSource {
  /**
   * One snapshot for one `state` call, from a single repository read. The
   * source serializes its reads per activation, so `readSeq` increases in
   * the order the answers are built. `signal` aborts when the activation is
   * disposed or the client gives up; an aborted read must not change the
   * source's selector registry.
   */
  read(input: {
    readonly scope: AntigravityRpcScope
    readonly signal: AbortSignal
  }): Promise<GaStateRead>
}

/** The accounts of one read: the whole roster, or only its size. */
export type GaAccountsRead =
  | {
      readonly kind: 'complete'
      /** At most `ANTIGRAVITY_RPC_LIMITS.accounts` rows, in roster order. */
      readonly rows: readonly {
        readonly selector: string
        readonly row: SidebarAccountRedactionInput
      }[]
    }
  /** The roster is larger than the limit; no selectors were issued. */
  | { readonly kind: 'over-limit'; readonly count: number }

export interface GaStateRead {
  /** Strictly increasing per activation; sent to the client unchanged. */
  readonly readSeq: number
  readonly accounts: GaAccountsRead
  /** The requesting session's route; `null` for the sessionless scope. */
  readonly route: SidebarRoutingEntry | null
  readonly status: AntigravityStatusDto
  /** Read from the same location's runtime after the repository read. */
  readonly settings: AntigravitySettingsDto
}

/**
 * One Antigravity menu action for this location's command service.
 * `request` has passed the `parseApplyRequest` of the same
 * `@cortexkit/common-auth/commands` module the location's menu was built
 * with; for a session scope its `sessionId` was set from the GA apply
 * input's scope.
 */
export interface GaApplyRequest {
  readonly request: CommandApplyRequest
  readonly scope: AntigravityRpcScope
  /**
   * Aborts when the activation is disposed. The service must not start new
   * effects once it aborts.
   */
  readonly signal: AbortSignal
}

/**
 * The per-location command service: it runs one action through this
 * location's Antigravity menu and returns the menu's answer. The activation
 * that owns this location's generation validates the answer before it
 * reaches a client.
 */
export interface GaCommandService {
  apply(request: GaApplyRequest): Promise<CommandApplyResult>
}

export interface GaRpcActivationOptions {
  state: GaStateSource
  commands: GaCommandService
  /**
   * `parseApplyRequest` of the `@cortexkit/common-auth/commands` module
   * the location's Antigravity menu was built with. Every GA apply request
   * passes it after the wire schema, so the menu receives only what that
   * module itself accepts.
   */
  parseApplyRequest: (value: unknown) => CommandApplyRequest | undefined
  /** Defaults to `createGaGeneration()`. */
  generation?: string
  /** Called after a notification is queued, e.g. to emit `changed`. */
  onChanged?: (event: AntigravityChangedEvent) => void
  now?: () => number
  /** Notifications retained per scope before the oldest are evicted. */
  notificationsPerScope?: number
  /** Scopes retained before the least recently used is forgotten. */
  maxScopes?: number
}

/** Raised for input that fails the portable schema; carries no input value. */
export class GaRpcInputError extends Error {
  override readonly name = 'GaRpcInputError'
  constructor(readonly issues: readonly AntigravityRpcIssue[]) {
    super(
      `Invalid Antigravity RPC input: ${issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    )
  }
}

/** Raised when a collaborator produced a value that fails the contract. */
export class GaRpcContractError extends Error {
  override readonly name = 'GaRpcContractError'
}

/** Account state and RPC handlers belong to this location activation. */
export interface GaRpcActivation {
  readonly generation: string
  /**
   * The two RPC handlers, taking raw (unvalidated) input and the host call's
   * abort signal.
   */
  readonly handlers: {
    state(input: unknown, signal?: AbortSignal): Promise<AntigravityStateOutput>
    apply(input: unknown, signal?: AbortSignal): Promise<AntigravityApplyOutput>
  }
  /**
   * Queue a notification (the Antigravity menu payload, or a toast) in one
   * scope and return its cursor. A payload that fails the wire contract is
   * refused with `GaRpcContractError`. After disposal it does nothing and
   * returns `null`.
   */
  notify(
    scope: AntigravityRpcScope,
    payload: RpcNotificationPayload,
  ): number | null
  /** Whether a client pulled this scope's state within the last 3 s. */
  isConnected(scope: AntigravityRpcScope): boolean
  readonly disposed: boolean
  /**
   * Stop serving: later calls answer `disposed`, running state reads and
   * applies are aborted and awaited, and queued notifications are
   * discarded. Idempotent.
   */
  dispose(): Promise<void>
}

const CONNECTION_TTL_MS = 3_000
const DEFAULT_NOTIFICATIONS_PER_SCOPE = 100
const DEFAULT_MAX_SCOPES = 256

interface ScopeQueue {
  /** Last cursor issued in this scope; 0 before the first. */
  lastIssued: number
  /** Highest cursor evicted unacknowledged; 0 when none. */
  evictedThrough: number
  notifications: AntigravityNotificationDto[]
  lastPullAt: number
}

function scopeKey(scope: AntigravityRpcScope): string {
  return scope.kind === 'session' ? `session:${scope.sessionID}` : 'sessionless'
}

function routeDto(
  entry: SidebarRoutingEntry | null,
): AntigravityRouteDto | null {
  if (!entry) return null
  return {
    accountId: entry.accountId,
    modelFamily: entry.modelFamily,
    headerStyle: entry.headerStyle,
    strategy: entry.strategy ?? null,
    updatedAt: entry.updatedAt,
  }
}

export function createGaRpcActivation(
  options: GaRpcActivationOptions,
): GaRpcActivation {
  const generation = options.generation ?? createGaGeneration()
  const now = options.now ?? Date.now
  const perScope =
    options.notificationsPerScope ?? DEFAULT_NOTIFICATIONS_PER_SCOPE
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES
  const scopes = new Map<string, ScopeQueue>()
  const running = new Set<{
    controller: AbortController
    done: Promise<unknown>
  }>()
  let lastReadSeq = 0
  let disposed = false
  let disposal: Promise<void> | null = null

  const disposedOutput = () =>
    ({
      version: ANTIGRAVITY_RPC_VERSION,
      kind: 'disposed',
      generation,
    }) as const

  const queueFor = (scope: AntigravityRpcScope): ScopeQueue => {
    const key = scopeKey(scope)
    let queue = scopes.get(key)
    if (queue) {
      // Refresh recency so the least recently used scope is evicted first.
      scopes.delete(key)
    } else {
      queue = {
        lastIssued: 0,
        evictedThrough: 0,
        notifications: [],
        lastPullAt: 0,
      }
    }
    scopes.set(key, queue)
    while (scopes.size > maxScopes) {
      const oldest = scopes.keys().next().value
      if (oldest === undefined) break
      scopes.delete(oldest)
    }
    return queue
  }

  /**
   * Run one collaborator call that disposal aborts and waits for. The host
   * call's own signal is forwarded, so a client that leaves aborts it too.
   */
  const track = async <T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    if (signal?.aborted) forward()
    else signal?.addEventListener('abort', forward, { once: true })
    const done = run(controller.signal)
    const entry = { controller, done }
    running.add(entry)
    try {
      return await done
    } finally {
      running.delete(entry)
      signal?.removeEventListener('abort', forward)
    }
  }

  const accountsDto = (
    accounts: GaAccountsRead,
  ): {
    accountsStatus: AntigravityAccountsStatus
    accounts: AntigravityAccountDto[]
  } => {
    if (accounts.kind === 'over-limit') {
      return {
        accountsStatus: {
          kind: 'over-limit',
          count: accounts.count,
          limit: ANTIGRAVITY_RPC_LIMITS.accounts,
        },
        accounts: [],
      }
    }
    // A complete read longer than the wire limit would have to be shortened;
    // the source must report it as over the limit instead.
    if (accounts.rows.length > ANTIGRAVITY_RPC_LIMITS.accounts) {
      throw new GaRpcContractError(
        'State source returned more accounts than the limit',
      )
    }
    return {
      accountsStatus: { kind: 'complete' },
      accounts: accounts.rows.map(({ selector, row }) => ({
        selector,
        ...redactAccountForSidebar(row),
      })),
    }
  }

  const state = async (
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AntigravityStateOutput> => {
    const parsed = AntigravityStateInputSchema.parse(input)
    if (!parsed.ok) throw new GaRpcInputError(parsed.issues)
    if (disposed) return disposedOutput()
    const request = parsed.value
    const read = await track(signal, (readSignal) =>
      options.state.read({ scope: request.scope, signal: readSignal }),
    )
    // A read that finishes after disposal is not reported.
    if (disposed) return disposedOutput()
    if (!Number.isSafeInteger(read.readSeq) || read.readSeq <= lastReadSeq) {
      throw new GaRpcContractError('State source returned a stale readSeq')
    }
    lastReadSeq = read.readSeq
    const queue = queueFor(request.scope)
    queue.lastPullAt = now()

    let reset: AntigravityStateReset | null = null
    if (request.generation === null) reset = 'initial'
    else if (request.generation !== generation) reset = 'generation-changed'
    else if (request.cursor > queue.lastIssued) reset = 'cursor-ahead'
    const acknowledged = reset === null ? request.cursor : 0

    // Acknowledged notifications are no longer retained.
    queue.notifications = queue.notifications.filter(
      (notification) => notification.cursor > acknowledged,
    )
    const delivered = queue.notifications.slice(
      0,
      ANTIGRAVITY_RPC_LIMITS.notificationsPerState,
    )
    const last = delivered.at(-1)
    const cursor = last
      ? last.cursor
      : Math.max(acknowledged, queue.evictedThrough)
    const output: AntigravityStateOutput = {
      version: ANTIGRAVITY_RPC_VERSION,
      kind: 'snapshot',
      generation,
      scope: request.scope,
      reset,
      cursor,
      dropped: Math.max(0, queue.evictedThrough - acknowledged),
      more: queue.notifications.length > delivered.length,
      notifications: delivered,
      readSeq: read.readSeq,
      ...accountsDto(read.accounts),
      route: request.scope.kind === 'session' ? routeDto(read.route) : null,
      status: read.status,
      settings: read.settings,
    }
    const checked = AntigravityStateOutputSchema.parse(output)
    if (!checked.ok) {
      throw new GaRpcContractError('State source produced an invalid snapshot')
    }
    return output
  }

  const apply = async (
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AntigravityApplyOutput> => {
    const parsed = AntigravityApplyInputSchema.parse(input)
    if (!parsed.ok) throw new GaRpcInputError(parsed.issues)
    if (disposed) return disposedOutput()
    const request = parsed.value
    if (request.generation !== generation) {
      return {
        version: ANTIGRAVITY_RPC_VERSION,
        kind: 'stale-generation',
        generation,
      }
    }
    const menuRequest = options.parseApplyRequest({
      ...request.request,
      ...(request.scope.kind === 'session'
        ? { sessionId: request.scope.sessionID }
        : {}),
    })
    if (!menuRequest) {
      throw new GaRpcInputError([
        { path: ['request'], message: 'not a menu action the menu accepts' },
      ])
    }
    const result: CommandApplyResult = await track(signal, (applySignal) =>
      options.commands.apply({
        request: menuRequest,
        scope: request.scope,
        signal: applySignal,
      }),
    )
    // A completion that arrives after disposal is not reported as applied.
    if (disposed) return disposedOutput()
    const checked = AntigravityApplyResultSchema.parse(result)
    if (!checked.ok || result.command !== ANTIGRAVITY_MENU_COMMAND_NAME) {
      throw new GaRpcContractError(
        'Command service produced a result that is not a menu answer',
      )
    }
    const output: AntigravityApplyOutput = {
      version: ANTIGRAVITY_RPC_VERSION,
      kind: 'applied',
      generation,
      scope: request.scope,
      result,
    }
    if (!AntigravityApplyOutputSchema.parse(output).ok) {
      throw new GaRpcContractError('Apply output failed the contract')
    }
    return output
  }

  return {
    generation,
    handlers: { state, apply },
    notify(scope, payload) {
      if (disposed) return null
      if (!AntigravityNotificationPayloadSchema.parse(payload).ok) {
        throw new GaRpcContractError('Notification payload failed the contract')
      }
      const queue = queueFor(scope)
      queue.lastIssued += 1
      const cursor = queue.lastIssued
      queue.notifications.push({ cursor, payload })
      while (queue.notifications.length > perScope) {
        const evicted = queue.notifications.shift()
        if (evicted) queue.evictedThrough = evicted.cursor
      }
      try {
        options.onChanged?.({ version: ANTIGRAVITY_RPC_VERSION, generation })
      } catch {
        // The event is a wake-up hint; clients still pull on their timer.
      }
      return cursor
    },
    isConnected(scope) {
      if (disposed) return false
      const queue = scopes.get(scopeKey(scope))
      return (
        queue !== undefined &&
        queue.lastPullAt > 0 &&
        now() - queue.lastPullAt < CONNECTION_TTL_MS
      )
    },
    get disposed() {
      return disposed
    },
    dispose() {
      if (!disposal) {
        disposed = true
        disposal = (async () => {
          scopes.clear()
          const pending = [...running]
          for (const entry of pending) {
            entry.controller.abort(
              new Error('The Antigravity activation was disposed'),
            )
          }
          await Promise.allSettled(pending.map((entry) => entry.done))
        })()
      }
      return disposal
    },
  }
}

// Host binding

/** The plugin id this adapter registers with the host. */
export const GA_PLUGIN_ID = 'cortexkit.antigravity-auth'

/** The host provider whose requests the hooks handle. */
export const GA_PROVIDER_ID = 'google'

// Compile-time guard: the SDK-free kind union must equal the host's.
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const REQUEST_KIND_MATCHES_HOST: SameType<GaRequestKind, SessionRequestKind> =
  true
void REQUEST_KIND_MATCHES_HOST

/** Session headers the host sets on a model request. */
const PARENT_SESSION_HEADERS = [
  'x-opencode-parent-session-id',
  'x-parent-session-id',
] as const

/**
 * What the location runtime needs from the account service: the quota
 * snapshot store (in memory for an OpenCode 2 location) and the functions
 * that use credentials to fetch quota, look up the plan tier and refresh
 * tokens.
 */
export type GaRuntimeCollaborators = Omit<
  LocationRuntimeOptions,
  'directory' | 'logSink'
>

/** What a location's services serve once the runtime is built. */
export interface GaServingServices {
  /** Runs one bridged request: transformation, account rotation, retries. */
  readonly execute: GaJobExecutor
  /** Accounts, routes and status for the RPC `state` method. */
  readonly state: GaStateSource
  /** Applies Antigravity menu actions for the RPC `apply` method. */
  readonly commands: GaCommandService
}

/**
 * One activation's request, account and command services. The shared
 * request pipeline, account integration and command modules implement it;
 * `setupGaActivation` decides when they start and stop.
 */
export interface GaLocationServices {
  readonly runtime: GaRuntimeCollaborators
  /**
   * Start serving on the built runtime. `notify` and `isConnected` belong to
   * this activation's RPC store, for opening the Antigravity menu and toasts.
   */
  start(input: {
    readonly runtime: LocationRuntime
    /** This activation's generation, for diagnostics the services emit. */
    readonly generation: string
    readonly send: GaRawSender
    readonly notify: GaRpcActivation['notify']
    readonly isConnected: GaRpcActivation['isConnected']
  }): Promise<GaServingServices>
  /** Release the services' own resources. Called after hooks and RPC stop. */
  dispose(): Promise<void>
}

/** Builds one activation's services for a host-owned location directory. */
export type GaLocationServicesFactory = (input: {
  readonly directory: string
  readonly overrides: GaPluginOverrides
}) => Promise<GaLocationServices>

/**
 * The fields the request hook reads and writes. The host's
 * `SessionHttpRequest` is passed in directly; `request` is the one field the
 * hook may replace.
 */
export interface GaHttpRequestEvent {
  readonly sessionID: string
  readonly kind: GaRequestKind
  readonly model: {
    readonly id: string
    readonly providerID: string
    readonly variant?: string | undefined
  }
  request: Request
}

/** The fields the response hook reads and writes (`SessionHttpResponse`). */
export interface GaHttpResponseEvent {
  readonly request: Request
  response: Response
}

/** The fields the retry hook reads and writes. */
export interface GaRetryEvent {
  readonly model: { readonly id: string; readonly providerID: string }
  decision: { retry: false } | { retry: true; delay: number }
}

/**
 * Whether the plugin owns a Google request: every title request (the host
 * may pick an off-catalog title model) and any request for a model this
 * plugin registered. Everything else passes through untouched.
 */
export function isGaOwnedRequest(
  event: Pick<GaHttpRequestEvent, 'kind' | 'model'>,
  isRegisteredModel: (modelID: string) => boolean,
): boolean {
  // The hooks are registered for the Google provider only; the provider
  // check repeats that scope so a host that widened it still passes other
  // providers through untouched.
  if (event.model.providerID !== GA_PROVIDER_ID) return false
  return event.kind === 'title' || isRegisteredModel(event.model.id)
}

/**
 * Request hook body: record an owned Google content request as a bridge job
 * and replace it with the bridge request. The original body is read from a
 * clone, so the host's request is never consumed when the rewrite is
 * refused. A proxy-guard refusal throws before any replacement; the host
 * then records it as the request's error and dispatches nothing.
 */
export async function rewriteGaHttpRequest(
  event: GaHttpRequestEvent,
  input: {
    readonly bridge: Pick<GaLoopbackBridge, 'rewrite'>
    readonly isRegisteredModel: (modelID: string) => boolean
    readonly env: LoopbackProxyEnv
  },
): Promise<void> {
  if (!isGaOwnedRequest(event, input.isRegisteredModel)) return
  const original = event.request
  if (!isGaGoogleContentRequest(original)) return
  const job: GaBridgeJob = {
    sessionID: event.sessionID,
    parentSessionID: headerValue(original, PARENT_SESSION_HEADERS),
    kind: event.kind,
    modelID: event.model.id,
    variant: event.model.variant ?? null,
    url: original.url,
    body: await original.clone().text(),
  }
  event.request = input.bridge.rewrite(original, job, input.env)
}

/** Adapt only responses whose request belongs to a recognized bridge job. */
export function adaptGaHttpResponse(
  event: GaHttpResponseEvent,
  bridge: Pick<GaLoopbackBridge, 'adaptResponse'>,
): void {
  const adapted = bridge.adaptResponse(event.request, event.response)
  if (adapted) event.response = adapted
}

/**
 * Retry hook body. The bridge's job runner rotates accounts and retries
 * endpoints itself; a host retry on top would repeat that whole sequence.
 * Only this plugin's registered models are affected.
 */
export function decideGaRetry(
  event: GaRetryEvent,
  isRegisteredModel: (modelID: string) => boolean,
): void {
  if (
    event.model.providerID === GA_PROVIDER_ID &&
    isRegisteredModel(event.model.id)
  ) {
    event.decision = { retry: false }
  }
}

/**
 * The parts of the host context setup uses, taken from the published
 * `Plugin.Context` type. Tests pass an object of this type; the host passes
 * its full context.
 */
export interface GaHostContext {
  readonly location: Pick<Plugin.Context['location'], 'directory'>
  readonly session: Pick<Plugin.Context['session'], 'hook'>
  readonly rpc: Pick<Plugin.Context['rpc'], 'register'>
  readonly provider: Pick<Plugin.Context['provider'], 'transform' | 'reload'>
}

// Model registration

/**
 * Convert one shared public catalog entry to the host's model record for the
 * Google provider. Only enabled variants are offered; a variant carries only
 * its id, which reaches the request hook as the model reference's `variant`
 * and is resolved by the request pipeline, the same way the OpenCode 1
 * adapter resolves variant suffixes. Title wire aliases are not catalog
 * entries and are never registered.
 *
 * The host's branded id types are plain strings at runtime. This module
 * loads no host schema code, so the brands are applied by type assertion on
 * values taken from the shared catalog.
 */
export function toGaModelInfo(
  id: string,
  definition: OpencodeModelDefinition,
): Model.Info {
  const variants = Object.entries(definition.variants ?? {})
    .filter(([, variant]) => variant.disabled !== true)
    .map(([variantID]) => ({ id: variantID as Model.VariantID }))
  const released = Date.parse(definition.release_date)
  return {
    id: id as Model.ID,
    modelID: id as Model.ID,
    providerID: GA_PROVIDER_ID as Model.Info['providerID'],
    name: definition.name,
    capabilities: {
      tools: definition.tool_call,
      input: [...definition.modalities.input],
      output: [...definition.modalities.output],
    },
    variants,
    time: { released: Number.isFinite(released) ? released : 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: {
      context: definition.limit.context,
      output: definition.limit.output,
    },
  }
}

/** The host records for every public catalog model, keyed by model id. */
export function gaCatalogModels(): ReadonlyMap<string, Model.Info> {
  return new Map(
    Object.entries(getPublicModelDefinitions()).map(([id, definition]) => [
      id,
      toGaModelInfo(id, definition),
    ]),
  )
}

/**
 * Provider transform body: add the catalog models to the Google provider,
 * keeping every model the provider already has under another id. When the
 * host has no Google provider record, nothing is registered.
 */
export function registerGaModels(
  editor: {
    get(
      providerID: string,
    ): { readonly models: ReadonlyMap<string, Model.Info> } | undefined
    readonly models: Pick<ProviderEditor['models'], 'set'>
  },
  catalog: ReadonlyMap<string, Model.Info>,
): void {
  const record = editor.get(GA_PROVIDER_ID)
  if (!record) return
  const kept = [...record.models.values()].filter(
    (model) => !catalog.has(model.id),
  )
  editor.models.set(GA_PROVIDER_ID, [...kept, ...catalog.values()])
}

/**
 * Writes a location's log records to stderr: the OpenCode 2 plugin context
 * offers plugins no log sink.
 */
function stderrLogSink(record: {
  service: string
  level: string
  message: string
}): void {
  try {
    process.stderr.write(
      `[antigravity] ${record.level} ${record.service}: ${record.message}\n`,
    )
  } catch {
    // Logging must never break a request.
  }
}

function headerValue(
  request: Request,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = request.headers.get(name)
    if (value) return value
  }
  return null
}

/**
 * Set up one activation. Returns `undefined` with no side effect for a
 * legacy context without `session` and `location`, and throws
 * `GaSetupContextError` for a partial one. Otherwise it builds the services,
 * the location runtime, the RPC activation and the loopback bridge for the
 * host-owned location directory; registers the `antigravity-auth` RPC, the
 * public catalog models on the Google provider, the `http.request` rewrite,
 * the `http.response` post-header error adapter and the registered-model
 * retry policy (all scoped to the Google provider);
 * and returns a Cleanup that removes only this activation's hooks and RPC
 * and stops everything else: producers are stopped and awaited, queued
 * quota snapshot writes drain, and then the remaining handles close.
 *
 * Any failure before the Cleanup is returned releases everything acquired
 * so far before the error propagates, so a failed setup leaves no hook,
 * port, timer or file handle behind.
 */
export async function setupGaActivation(
  context: GaHostContext,
  factory: GaLocationServicesFactory,
  overrides: GaPluginOverrides = {},
): Promise<Plugin.Cleanup | undefined> {
  if (classifyGaSetupContext(context) === 'legacy') return undefined
  const directory = context.location.directory
  const send = createGaRawSender(overrides)

  const services = await factory({ directory, overrides })
  let runtime: LocationRuntime
  try {
    runtime = await createLocationRuntime({
      ...services.runtime,
      directory,
      logSink: stderrLogSink,
    })
  } catch (error) {
    await services.dispose().catch(() => {
      // The runtime error is the one the host needs to see.
    })
    throw error
  }

  // Everything below is registered on the runtime scope as a producer. The
  // scope stops producers newest first, so teardown runs: request, retry
  // and response hooks, model registration, RPC, activation, bridge,
  // services, then the runtime's own producers; after that queued snapshot
  // writes drain and the runtime's files and handles close.
  try {
    runtime.scope.add(services, 'producer')

    let serving: GaServingServices | null = null
    const requireServing = (): GaServingServices => {
      if (!serving) throw new Error('Antigravity services are not started')
      return serving
    }
    let rpcRegistration: RpcRegistration<
      typeof ANTIGRAVITY_RPC_DEFINITION
    > | null = null
    const commandsModule = await loadCommonAuthCommands()
    const activation = createGaRpcActivation({
      state: {
        read: (input) => requireServing().state.read(input),
      },
      commands: {
        apply: (request) => requireServing().commands.apply(request),
      },
      parseApplyRequest: commandsModule.parseApplyRequest,
      onChanged: (event) => {
        void rpcRegistration?.events.emit('changed', event).catch(() => {
          // A missed changed notification delays the client's next state request.
        })
      },
    })

    serving = await services.start({
      runtime,
      generation: activation.generation,
      send,
      notify: activation.notify,
      isConnected: activation.isConnected,
    })
    const started = serving
    const catalog = gaCatalogModels()
    const isRegisteredModel = (modelID: string) => catalog.has(modelID)

    const bridge = await startGaLoopbackBridge({
      execute: started.execute,
      send,
      onError: (message) => runtime.logger.createLogger('bridge').warn(message),
    })
    runtime.scope.add(bridge, 'producer')
    runtime.scope.add(activation, 'producer')

    const handlers: RpcHandlers<typeof ANTIGRAVITY_RPC_DEFINITION> = {
      state: (input, call) => activation.handlers.state(input, call.signal),
      apply: (input, call) => activation.handlers.apply(input, call.signal),
    }
    rpcRegistration = await context.rpc.register(
      ANTIGRAVITY_RPC_DEFINITION,
      handlers,
    )
    runtime.scope.add(rpcRegistration, 'producer')

    const modelRegistration: Registration = await context.provider.transform(
      (editor) => registerGaModels(editor, catalog),
    )
    runtime.scope.add(modelRegistration, 'producer')
    await context.provider.reload()

    const responseHook: Registration = await context.session.hook(
      'http.response',
      (event: SessionHttpResponse) => adaptGaHttpResponse(event, bridge),
      { providerID: GA_PROVIDER_ID },
    )
    runtime.scope.add(responseHook, 'producer')

    const retryHook: Registration = await context.session.hook(
      'retry',
      (event: SessionRetry) => decideGaRetry(event, isRegisteredModel),
      { providerID: GA_PROVIDER_ID },
    )
    runtime.scope.add(retryHook, 'producer')

    // The `http.request` hook, which rewrites requests to the bridge, is
    // installed last, so every request it rewrites already has the
    // `http.response` adapter and the retry policy in place. Teardown removes
    // producers newest first, so this hook is removed first.
    const requestHook: Registration = await context.session.hook(
      'http.request',
      (event: SessionHttpRequest) =>
        rewriteGaHttpRequest(event, {
          bridge,
          isRegisteredModel,
          env: process.env,
        }),
      { providerID: GA_PROVIDER_ID },
    )
    runtime.scope.add(requestHook, 'producer')
  } catch (error) {
    await runtime.dispose().catch(() => {
      // Preserve the initialization error if disposal also throws.
    })
    throw error
  }

  let cleanup: Promise<void> | null = null
  return () => {
    cleanup ??= runtime.dispose()
    return cleanup
  }
}

/** Build the OpenCode 2 plugin over the given services factory. */
export function createGaPluginFromServices(
  factory: GaLocationServicesFactory,
  overrides: GaPluginOverrides = {},
): Plugin.Plugin {
  return {
    id: GA_PLUGIN_ID,
    setup: (context: Plugin.Context) =>
      setupGaActivation(context, factory, overrides),
  }
}

/**
 * The plugin the OpenCode 2 host loads: setup over the production location
 * services (`createGaLocationServices`), which open the location's account
 * store, keep its quota snapshots in memory and run the shared request
 * pipeline. `overrides` exist for tests; the host passes none.
 */
export function createGaAntigravityPlugin(
  overrides: GaPluginOverrides = {},
): Plugin.Plugin {
  return createGaPluginFromServices(createGaLocationServices, overrides)
}
