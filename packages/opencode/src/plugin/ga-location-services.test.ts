/**
 * GA location services. Account state and dialog commands run against a
 * small in-memory repository that keeps exact row refs (id, credential
 * epoch, identity) the way the real one does; the credential refresh runs
 * against a genuine repository on the public store in a disposable
 * directory, with a deterministic token exchange. No network or host.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AccountManager,
  AccountRepositoryError,
  type AccountRepositoryRead,
  type AccountRow,
  createAccountRepositoryFactory,
  createQuotaManager,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  type RowRef,
  readAccountStoreAdmission,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'

import { placeholderSecret } from '../common-auth-embedded/opencode2/index.js'
import type {
  GaBridgeJob,
  GaHttpRequestEvent,
  GaLocationServices,
  GaPluginOverrides,
  GaSendInput,
  HarnessAccountsObservation,
} from '../ga/server/index.ts'
import {
  GaRequestOwnership,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from '../ga/server/index.ts'
import { createLocalAccountCredentials } from './accounts.ts'
import { BackgroundQuotaRefresh } from './background-quota-refresh.ts'
import type { LocationDebug } from './debug.ts'
import {
  createOperatorSettingsRegistry,
  emptyOperatorSettings,
  type OperatorSettings,
} from './operator-settings.ts'
import { createStoreQuotaService } from './quota.ts'
import { AgySessionRegistry } from './session-context.ts'
import {
  createLocationRuntime,
  createMemoryQuotaSnapshots,
  type LocationRuntime,
} from './shared/runtime.ts'

const activeCases = new Set<GaTestCase>()

/** Bun timeouts leave test promises running; afterEach drains owned work before releasing global paths. */
class GaTestCase {
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cleanup: (() => Promise<void>)[] = []
  private readonly cancelled = new DOMException(
    'GA test case closed',
    'AbortError',
  )
  private closing = false
  private closed?: Promise<void>

  defer(cleanup: () => Promise<void>) {
    this.check()
    this.cleanup.push(cleanup)
  }

  controller() {
    this.check()
    const controller = new AbortController()
    this.controllers.add(controller)
    return controller
  }

  check() {
    if (this.closing) throw this.cancelled
  }

  track<T>(work: () => Promise<T>): Promise<T> {
    this.check()
    const pending = Promise.resolve().then(() => {
      this.check()
      return work()
    })
    this.pending.add(pending)
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    )
    return pending
  }

  async step<T>(work: () => Promise<T>): Promise<T> {
    const result = await this.track(work)
    this.check()
    return result
  }

  async wait<T>(pending: Promise<T>): Promise<T> {
    const controller = this.controller()
    const cancelled = Promise.withResolvers<never>()
    const abort = () => cancelled.reject(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([pending, cancelled.promise])
    } finally {
      controller.signal.removeEventListener('abort', abort)
    }
  }

  close(): Promise<void> {
    if (this.closed) return this.closed
    this.closing = true
    for (const controller of this.controllers) controller.abort(this.cancelled)
    this.closed = (async () => {
      const errors: unknown[] = []
      while (this.pending.size > 0) {
        const results = await Promise.allSettled([...this.pending])
        for (const result of results) {
          // A timeout is already red; cancellation merely stops its continuation.
          if (result.status === 'rejected' && result.reason !== this.cancelled)
            errors.push(result.reason)
        }
      }
      for (const cleanup of this.cleanup.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'GA test case cleanup failed')
    })()
    return this.closed
  }
}

function ownedIt(
  name: string,
  work: (scope: GaTestCase) => Promise<void>,
  timeout?: number,
) {
  it(
    name,
    () => {
      const scope = new GaTestCase()
      activeCases.add(scope)
      return scope.track(() => work(scope))
    },
    timeout,
  )
}

afterEach(async () => {
  for (const scope of activeCases) {
    try {
      await scope.close()
    } finally {
      activeCases.delete(scope)
    }
  }
})

let environmentOwner: GaTestCase | undefined

function caseEnvironment(
  scope: GaTestCase,
  prefix: string,
  dispose: () => Promise<void>,
) {
  let root: string | undefined
  let previous:
    | { OPENCODE_CONFIG_DIR?: string; XDG_CONFIG_HOME?: string }
    | undefined
  // Register before creating files, changing globals, or starting asynchronous setup.
  scope.defer(async () => {
    try {
      await dispose()
    } finally {
      if (environmentOwner === scope && previous) {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        environmentOwner = undefined
      }
      if (root) rmSync(root, { recursive: true, force: true })
    }
  })
  if (environmentOwner)
    throw new Error(
      'A previous GA test case still owns the configuration paths',
    )
  root = mkdtempSync(join(tmpdir(), prefix))
  root = realpathSync(root)
  previous = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  environmentOwner = scope
  process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  return root
}

const realCore = await import('@cortexkit/antigravity-auth-core')
const lifetimeControl = process.env.ANTIGRAVITY_GA_TEST_LIFETIME
let failedSetupRoot: string | undefined
const initializeStore = realCore.initializeFreshAccountStore
const networkCalls: {
  url: string
  init?: RequestInit
  options?: import('@cortexkit/antigravity-auth-core').AgyTransportOptions
}[] = []
function terminalResponse() {
  return new Response(
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"transport reached"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
mock.module('@cortexkit/antigravity-auth-core', () => ({
  ...realCore,
  ...(lifetimeControl === 'setup'
    ? {
        initializeFreshAccountStore: async (
          ...args: Parameters<typeof initializeStore>
        ) => {
          const result = await initializeStore(...args)
          if (!failedSetupRoot) {
            failedSetupRoot = dirname(dirname(args[1].legacyPath))
            throw new Error('injected setup failure')
          }
          return result
        },
      }
    : {}),
  fetchWithAgyCliTransport: (
    url: string,
    init?: RequestInit,
    options?: import('@cortexkit/antigravity-auth-core').AgyTransportOptions,
  ) => {
    networkCalls.push({ url, init, options })
    return Promise.resolve(terminalResponse())
  },
}))

const {
  accessBlockOf,
  authorizeGaQuotaCheck,
  createGaAccountStateSource,
  createGaFetchAccountQuota,
  createGaHostSlotReader,
  createGaJobExecutor,
  createGaLocalCredentials,
  createGaLocationServices,
  createGaLocationServicesFactory,
  createGaMenuCommandService,
  createGaReauthorize,
  createGaRouteBook,
  createGaRuntimeCollaborators,
  createGaSelectorRegistry,
  GA_ACCOUNTS_FILE,
  gaSettingsOf,
} = await import('./ga-location-services.ts')

function row(ref: RowRef, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    ref,
    index: 0,
    enabled: true,
    usable: true,
    stamp: 'bound',
    metadata: { status: 'present', metadata: { addedAt: 1, lastUsed: 1 } },
    quota: { status: 'absent' },
    ...overrides,
  }
}

class MemoryRepository {
  rows: AccountRow[]
  routing: Extract<AccountRepositoryRead, { status: 'ready' }>['routing']
  status: AccountRepositoryRead['status'] = 'ready'
  writes: string[] = []
  reads = 0
  readGate: Promise<void> | null = null

  constructor(rows: AccountRow[]) {
    this.rows = rows
  }

  async read(): Promise<AccountRepositoryRead> {
    this.reads += 1
    if (this.readGate) await this.readGate
    if (this.status === 'pending-migration')
      return { status: 'pending-migration' }
    return {
      status: 'ready',
      rows: this.rows.map((entry, index) => ({ ...entry, index })),
      ...(this.routing ? { routing: this.routing } : {}),
    }
  }

  private holding(ref: RowRef): AccountRow {
    const found = this.rows.find((entry) => sameRowRef(entry.ref, ref))
    if (!found)
      throw new AccountRepositoryError({
        operation: 'setEnabled',
        kind: 'attribution',
        retryable: false,
        ambiguous: false,
        message: 'changed',
      })
    return found
  }

  async setEnabled(ref: RowRef, input: { enabled: boolean }) {
    const target = this.holding(ref)
    target.enabled = input.enabled
    this.writes.push(`${input.enabled ? 'enable' : 'disable'}:${ref.id}`)
    return { ref }
  }

  async remove(ref: RowRef) {
    this.holding(ref)
    this.rows = this.rows.filter((entry) => !sameRowRef(entry.ref, ref))
    this.writes.push(`remove:${ref.id}`)
  }

  async selectAccount(target: string, ref: RowRef | null) {
    if (ref) this.holding(ref)
    this.writes.push(`select:${target}:${ref?.id ?? 'none'}`)
  }
}

const A: RowRef = { id: 'row-a', credentialEpoch: 1, identity: 'a@example' }
const B: RowRef = { id: 'row-b', credentialEpoch: 1 }

const settingsDto = () =>
  gaSettingsOf(emptyOperatorSettings(), dumpOff, 'hybrid')
const dumpOff = { isEnabled: () => false }
const status = () => ({
  checkedAt: null,
  quotaBackoffUntil: null,
  routingAuthoritative: true,
})

function stateSource(
  repository: MemoryRepository,
  registry = createGaSelectorRegistry(),
  observed: HarnessAccountsObservation[] = [],
) {
  return createGaAccountStateSource({
    repository,
    registry,
    generation: 'g-test',
    settings: settingsDto,
    status,
    route: () => null,
    observe: (observation) => {
      observed.push(observation)
      return undefined
    },
  })
}

const sessionless = { kind: 'sessionless' } as const

async function selectorsOf(
  source: ReturnType<typeof stateSource>,
): Promise<[string, string, ...string[]]> {
  const read = await source.read({
    scope: sessionless,
    signal: new AbortController().signal,
  })
  if (read.accounts.kind !== 'complete') throw new Error('over limit')
  const selectors = read.accounts.rows.map((entry) => entry.selector)
  // Callers destructure the first two; a shorter roster pads with ''.
  return [selectors[0] ?? '', selectors[1] ?? '', ...selectors.slice(2)]
}

describe('GA account state', () => {
  it('keeps a selector for the same credential and retires it when the epoch changes', async () => {
    const repository = new MemoryRepository([row(A), row(B)])
    const observed: HarnessAccountsObservation[] = []
    const source = stateSource(repository, undefined, observed)
    const [a1, b1] = await selectorsOf(source)
    const [a2, b2] = await selectorsOf(source)
    expect(a2).toBe(a1)
    expect(b2).toBe(b1)

    const replaced = { ...A, credentialEpoch: 2 }
    repository.rows = [row(replaced), row(B)]
    const [a3, b3] = await selectorsOf(source)
    expect(a3).not.toBe(a1)
    expect(b3).toBe(b1)
    expect(observed.at(-1)?.retiredSelectors).toEqual([a1])
    expect(observed.map((entry) => entry.readSeq)).toEqual([1, 2, 3])
  })

  it('keeps selectors across a reorder and never exposes row data', async () => {
    const repository = new MemoryRepository([row(A), row(B)])
    const source = stateSource(repository)
    const [a1, b1] = await selectorsOf(source)
    repository.rows = [row(B), row(A)]
    const read = await source.read({
      scope: sessionless,
      signal: new AbortController().signal,
    })
    if (read.accounts.kind !== 'complete') throw new Error('over limit')
    expect(read.accounts.rows.map((entry) => entry.selector)).toEqual([b1, a1])
    // The RPC contract's selector shape.
    for (const selector of [a1, b1]) expect(selector).toMatch(/^sel-[\w-]{32}$/)
    const text = JSON.stringify(read)
    expect(text).not.toContain('row-a')
    expect(text).not.toContain('a@example')
  })

  it('leaves the registry unchanged when a read is aborted', async () => {
    const repository = new MemoryRepository([row(A)])
    const registry = createGaSelectorRegistry()
    const observed: HarnessAccountsObservation[] = []
    const source = stateSource(repository, registry, observed)
    let release: () => void = () => undefined
    repository.readGate = new Promise((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const pending = source.read({
      scope: sessionless,
      signal: controller.signal,
    })
    controller.abort(new Error('client gave up'))
    release()
    await expect(pending).rejects.toThrow('client gave up')
    repository.readGate = null
    const [selector] = await selectorsOf(source)
    expect(selector).not.toBe('')
    expect(registry.resolve(selector).kind).toBe('live')
    // The aborted read built no answer: the first answer is readSeq 1.
    expect(observed.map((entry) => entry.readSeq)).toEqual([1])
  })

  it('reports an over-limit roster without issuing selectors', async () => {
    const rows = Array.from({ length: 65 }, (_, index) =>
      row({ id: `row-${index}`, credentialEpoch: 1 }),
    )
    const source = stateSource(new MemoryRepository(rows))
    const read = await source.read({
      scope: sessionless,
      signal: new AbortController().signal,
    })
    expect(read.accounts).toEqual({ kind: 'over-limit', count: 65 })
  })

  it('reads settings fresh for every answer', async () => {
    let settings: OperatorSettings = emptyOperatorSettings()
    const source = createGaAccountStateSource({
      repository: new MemoryRepository([]),
      registry: createGaSelectorRegistry(),
      generation: 'g-test',
      settings: () => gaSettingsOf(settings, dumpOff, 'hybrid'),
      status,
      route: () => null,
    })
    const signal = new AbortController().signal
    const first = await source.read({ scope: sessionless, signal })
    settings = { ...settings, log_level: 'debug' }
    const second = await source.read({ scope: sessionless, signal })
    expect(first.settings.logLevel).toBe('info')
    expect(second.settings.logLevel).toBe('debug')
  })

  it('reports an unknown access block when metadata was dropped', () => {
    expect(
      accessBlockOf(
        row(A, { metadata: { status: 'dropped', reason: 'invalid' } }),
      ),
    ).toEqual({ kind: 'unknown' })
    expect(accessBlockOf(row(A))).toEqual({ kind: 'none' })
  })
})

describe('GA menu command service', () => {
  it('runs each request through the menu with an invocation for its scope', async () => {
    const calls: unknown[] = []
    const notices: unknown[] = []
    const service = createGaMenuCommandService({
      menu: {
        command: 'antigravity',
        open: async () => {
          throw new Error('not used')
        },
        apply: async (request, invocation) => {
          calls.push({ request, sessionId: invocation.sessionId })
          invocation.notify('Routing updated')
          return {
            command: 'antigravity',
            ok: true,
            text: 'done',
            menu: {
              command: 'antigravity',
              title: 'Antigravity',
              sections: [],
            },
          }
        },
      },
      notify: (scope, payload) => {
        notices.push({ scope, payload })
        return 1
      },
    })
    const request = {
      command: 'antigravity',
      sectionId: 'limits',
      actionId: 'set',
    }
    const scope = { kind: 'session', sessionID: 'ses-1' } as const
    const result = await service.apply({
      request,
      scope,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ request, sessionId: 'ses-1' }])
    expect(notices).toEqual([
      {
        scope,
        payload: {
          command: 'antigravity',
          notify: { message: 'Routing updated', kind: 'info' },
        },
      },
    ])

    const aborted = new AbortController()
    aborted.abort(new Error('disposed'))
    await expect(
      service.apply({ request, scope, signal: aborted.signal }),
    ).rejects.toThrow('disposed')
    expect(calls).toHaveLength(1)
  })

  it('opens the menu by queuing its payload in the invoking scope', async () => {
    const payload = {
      command: 'antigravity',
      menu: { command: 'antigravity', title: 'Antigravity', sections: [] },
    }
    const queued: unknown[] = []
    const service = createGaMenuCommandService({
      menu: {
        command: 'antigravity',
        open: async (invocation) => {
          expect(invocation.sessionId).toBe('ses-2')
          return payload
        },
        apply: async () => {
          throw new Error('not used')
        },
      },
      notify: (scope, entry) => {
        queued.push({ scope, entry })
        return 1
      },
    })
    const scope = { kind: 'session', sessionID: 'ses-2' } as const
    await service.open({ scope, signal: new AbortController().signal })
    expect(queued).toEqual([{ scope, entry: payload }])
  })
})

describe('GA request pipeline pieces', () => {
  it('keeps each session route in memory and shows it only to that session', () => {
    const routes = createGaRouteBook()
    routes.record('session-a', {
      accountId: 'acct-0',
      modelFamily: 'claude',
      headerStyle: 'antigravity',
      updatedAt: 7,
    })
    expect(routes.route({ kind: 'session', sessionID: 'session-a' })).toEqual({
      accountId: 'acct-0',
      modelFamily: 'claude',
      headerStyle: 'antigravity',
      updatedAt: 7,
    })
    expect(routes.route({ kind: 'session', sessionID: 'session-b' })).toBeNull()
    expect(routes.route({ kind: 'sessionless' })).toBeNull()
  })

  it('hands a bridged job to the engine with its body, signal, session and context', async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const execute = createGaJobExecutor({
      execute: async (input, init, options) => {
        calls.push({ input, init, options })
        return new Response('ok')
      },
    })
    await execute(
      {
        sessionID: 'session-a',
        parentSessionID: null,
        kind: 'primary',
        modelID: 'gemini-3-pro',
        variant: null,
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent',
        body: '{"contents":[]}',
      },
      { signal: controller.signal, send: async () => new Response('unused') },
    )
    expect(calls).toEqual([
      {
        input:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"contents":[]}',
          signal: controller.signal,
        },
        options: {
          kind: 'primary',
          variant: undefined,
          session: { sessionId: 'session-a', parentSessionId: null },
        },
      },
    ])
  })

  it('adds only a per-request transport when the send override exists', async () => {
    const calls: unknown[] = []
    const executor = {
      execute: async (_input: unknown, _init: unknown, options: unknown) => {
        calls.push(options)
        return new Response('ok')
      },
    }
    const context = {
      signal: new AbortController().signal,
      send: async () => terminalResponse(),
    }
    await createGaJobExecutor(executor)(transportJob, context)
    await createGaJobExecutor(executor, {
      send: async () => terminalResponse(),
    })(transportJob, context)
    expect(calls).toEqual([
      {
        kind: transportJob.kind,
        variant: undefined,
        session: { sessionId: transportJob.sessionID, parentSessionId: null },
      },
      {
        kind: transportJob.kind,
        variant: undefined,
        session: { sessionId: transportJob.sessionID, parentSessionId: null },
        transport: expect.any(Function),
      },
    ])
  })

  ownedIt(
    'refreshes through the genuine repository and stores the successor there',
    async (scope) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-credentials-')))
      scope.defer(async () => rmSync(root, { recursive: true, force: true }))
      const legacyPath = join(root, 'antigravity-accounts.json')
      const modules = await scope.step(() => loadCommonAuthStoreModules())
      await scope.step(() =>
        initializeFreshAccountStore(modules, { legacyPath, now: Date.now }),
      )
      const admission = await scope.step(() =>
        readAccountStoreAdmission(legacyPath, modules, Date.now),
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const exchanged: string[] = []
      const repository = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async ({ refreshToken }) => {
          exchanged.push(refreshToken)
          return {
            accessToken: 'access-new',
            refreshToken: 'refresh-successor',
            expiresAt: Date.now() + 3_600_000,
          }
        },
      })
      scope.defer(async () => {
        await repository.dispose()
      })
      await scope.step(() =>
        repository.login({
          id: crypto.randomUUID(),
          refreshToken: 'refresh-original',
          metadata: { addedAt: 1, lastUsed: 1, projectId: 'project-1' },
        }),
      )
      await scope.step(() =>
        repository.login({
          id: crypto.randomUUID(),
          refreshToken: 'refresh-other',
          metadata: { addedAt: 2, lastUsed: 2, projectId: 'project-2' },
        }),
      )
      const manager = AccountManager.fromRepository(
        await scope.step(() => repository.read()),
        { repository },
      )
      scope.defer(() => manager.dispose())
      const credentials = createGaLocalCredentials(manager, {
        repository,
        overrides: {},
      })
      const [first, second] = manager.getAccounts()
      if (!first || !second) throw new Error('missing accounts')
      const refreshed = await scope.step(() => credentials.refresh(second))
      // The selected account itself is refreshed; no row is looked up again by token.
      expect(exchanged).toEqual(['refresh-other'])
      expect(refreshed?.access).toBe('access-new')
      expect(refreshed?.refresh).toBe('refresh-successor|project-2')
      const read = await scope.step(() => repository.read())
      if (read.status !== 'ready') throw new Error(read.status)
      expect(read.rows.map((row) => row.credential?.refreshToken)).toEqual([
        'refresh-original',
        'refresh-successor',
      ])
      expect(first.parts.refreshToken).toBe('refresh-original')
    },
  )
})

async function freshRepository(options: { expiresAt?: () => number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-quota-')))
  const legacyPath = join(root, 'antigravity-accounts.json')
  const modules = await loadCommonAuthStoreModules()
  await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
  const admission = await readAccountStoreAdmission(
    legacyPath,
    modules,
    Date.now,
  )
  if (admission.status !== 'active') throw new Error(admission.status)
  const exchanged: string[] = []
  const repository = createAccountRepositoryFactory(modules)({
    paths: admission.paths,
    now: Date.now,
    exchange: async ({ refreshToken }) => {
      exchanged.push(refreshToken)
      return {
        accessToken: 'access-fresh',
        refreshToken,
        expiresAt: options.expiresAt?.() ?? Date.now() + 3_600_000,
      }
    },
  })
  const { ref } = await repository.login({
    id: crypto.randomUUID(),
    refreshToken: 'refresh-quota',
    metadata: { addedAt: 1, lastUsed: 1, projectId: 'project-q' },
  })
  return {
    repository,
    ref,
    exchanged,
    cleanup: async () => {
      await repository.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const transportJob: GaBridgeJob = {
  sessionID: 'transport-session',
  parentSessionID: null,
  kind: 'generate',
  modelID: 'antigravity-gemini-3.5-flash',
  variant: null,
  url: 'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse',
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Exact transport bytes: é' }] }],
  }),
}

/** Uses the location factory and shared request engine, with disposable local logins or a stand-in vault source. */
async function transportLocation(
  scope: GaTestCase,
  domain: 'local' | 'vault',
  overrides: GaPluginOverrides,
  accountCount = 1,
  /** The vault location's source in place of the stand-in. */
  vaultSource?: import('./ga-location-services.ts').GaVaultCustodySource,
) {
  let services: GaLocationServices | undefined
  let runtime: LocationRuntime | undefined
  let seed:
    | ReturnType<ReturnType<typeof createAccountRepositoryFactory>>
    | undefined
  let restorePrepared: (() => void) | undefined
  let disposal: Promise<void> | undefined
  const dispose = () => {
    disposal ??= (async () => {
      const errors: unknown[] = []
      for (const cleanup of [
        () => restorePrepared?.(),
        () => seed?.dispose(),
        () => {
          const manager = runtime?.accounts()
          return manager instanceof AccountManager
            ? manager.flushSaveToDisk()
            : undefined
        },
        () => services?.dispose(),
        () => runtime?.dispose(),
      ]) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'GA transport fixture disposal failed')
    })()
    return disposal
  }
  const root = caseEnvironment(scope, 'ga-transport-', dispose)
  const directory = join(root, 'location')
  mkdirSync(join(directory, '.opencode'), { recursive: true })
  await scope.step(() =>
    writeFile(
      join(directory, '.opencode', 'antigravity.json'),
      JSON.stringify({
        background_quota_refresh: false,
        proactive_token_refresh: false,
        request_jitter_max_ms: 0,
        ...(accountCount > 1
          ? { switch_on_first_rate_limit: true, switch_account_delay_ms: 0 }
          : {}),
      }),
    ),
  )
  const admitted: { signal?: AbortSignal; credentialId: string }[] = []
  if (domain === 'local') {
    const legacyPath = join(root, 'config', GA_ACCOUNTS_FILE)
    const modules = await scope.step(() => loadCommonAuthStoreModules())
    await scope.step(() =>
      initializeFreshAccountStore(modules, { legacyPath, now: Date.now }),
    )
    const admission = await scope.step(() =>
      readAccountStoreAdmission(legacyPath, modules, Date.now),
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    seed = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('seed must not refresh')
      },
    })
    const repository = seed
    for (let i = 0; i < accountCount; i++) {
      await scope.step(() =>
        repository.login({
          id: crypto.randomUUID(),
          refreshToken: `refresh-${i}`,
          metadata: {
            addedAt: i + 1,
            lastUsed: i + 1,
            managedProjectId: `project-${i}`,
          },
        }),
      )
    }
    await scope.step(() => repository.dispose())
    seed = undefined
  }
  const route = {
    routeId: 'route-0',
    credentialId: 'credential-0',
    accountIdentity: 'identity-0',
    label: 'Vault account',
  }
  const source = {
    refresh: async () => undefined,
    routes: () => [route],
    admit: async (ref: typeof route, signal?: AbortSignal) => {
      admitted.push({ signal, credentialId: ref.credentialId })
      return {
        ...ref,
        recordVersion: 1,
        accessToken: 'vault-access',
        projectId: 'vault-project',
        expiresAtMs: null,
      }
    },
    reportServedStatus: async () => false,
    send: async () => {
      throw new Error('vault source must use the composed transport')
    },
    attribution: () => ({ ...route, recordVersion: 1 }),
    commitState: async () => ({ status: 'unchanged' as const }),
  }
  const factory =
    domain === 'local'
      ? createGaLocationServices
      : createGaLocationServicesFactory({
          loadStoreModules: async () => {
            throw new Error('vault must not open a local store')
          },
          resolveAccountFile: () => join(root, 'config', GA_ACCOUNTS_FILE),
          now: Date.now,
          runtime: (input) =>
            createGaRuntimeCollaborators({
              ...input,
              accounts: { current: null, quotaLogger: null },
              now: Date.now,
            }),
          createPipeline: async () => {
            throw new Error('vault must not construct a local pipeline')
          },
          custody: () => ({
            readMode: async () => ({
              ok: true,
              record: { version: 1, mode: 'custody' },
            }),
            custodySource: async () => vaultSource ?? source,
            readState: async () => ({ schemaVersion: 1, accounts: {} }),
            menuSection: () => ({
              id: 'vault',
              title: 'Vault',
              build: () => ({ lines: [], actions: [] }),
            }),
            dispose: async () => {},
          }),
        })
  const configured = await scope.step(async () => {
    const configured = await factory({
      directory,
      overrides: {
        refreshAccessToken: async (refresh) => ({
          access: `access-${refresh}`,
          refresh,
          expires: Date.now() + 3_600_000,
        }),
        ...overrides,
      },
    })
    services = configured
    return configured
  })
  const locationRuntime = await scope.step(async () => {
    const created = await createLocationRuntime({
      ...configured.runtime,
      directory,
      operatorSettingsRegistry: createOperatorSettingsRegistry(),
    })
    runtime = created
    return created
  })
  // This debug method receives the prepared body and headers before the engine sends them.
  const prepared = spyOn(locationRuntime.debug, 'startAntigravityDebugRequest')
  restorePrepared = () => prepared.mockRestore()
  const serving = await scope.step(() =>
    configured.start({
      runtime: locationRuntime,
      generation: 'transport-generation',
      send: async () => {
        throw new Error('legacy send plumbing must stay unused')
      },
      notify: () => null,
      isConnected: () => false,
    }),
  )
  networkCalls.length = 0
  return {
    serving,
    services: configured,
    runtime: locationRuntime,
    admitted,
    prepared,
    dispose,
  }
}

describe('GA pool login request visibility', () => {
  ownedIt(
    'refreshes an already started empty pipeline so the next physical request uses the committed account',
    async (scope) => {
      const sent: GaSendInput[] = []
      const location = await transportLocation(
        scope,
        'local',
        {
          send: async (input) => {
            sent.push(input)
            return terminalResponse()
          },
          ensureProjectContext: async (auth) => ({
            auth,
            effectiveProjectId: 'pool-project',
          }),
        },
        0,
      )
      const before = await scope.step(() =>
        location.serving.state.read({
          scope: { kind: 'sessionless' },
          signal: scope.controller().signal,
        }),
      )
      expect(before.accounts).toMatchObject({ kind: 'complete', rows: [] })
      const login = location.services.localLogin
      if (!login) throw new Error('Local pool login missing')
      await scope.step(() =>
        login.persist(
          {
            type: 'success',
            refresh: 'new-refresh|pool-project',
            access: 'new-access',
            expires: Date.now() + 3_600_000,
            email: 'new@example.test',
            projectId: 'pool-project',
          },
          login.assertAdmission,
        ),
      )
      const response = await scope.step(() =>
        location.serving.execute(transportJob, {
          signal: scope.controller().signal,
          send: async () => {
            throw new Error('Legacy send must stay unused')
          },
        }),
      )
      expect(await response.text()).toContain('transport reached')
      expect(sent).toHaveLength(1)
      expect(sent[0]?.auth.access).toBe('access-new-refresh')
      expect(sent[0]?.envelope.project).toBe('pool-project')
      expect(networkCalls).toHaveLength(0)
    },
  )
})

function expectFinalizedSend(
  sent: GaSendInput,
  prepared: Parameters<LocationDebug['startAntigravityDebugRequest']>[0],
) {
  expect(prepared.body).toBe(JSON.stringify(sent.envelope))
  expect(new Headers(prepared.headers).get('authorization')).toBe(
    `Bearer ${sent.auth.access}`,
  )
  expect(sent.endpoint).toBe(new URL(prepared.resolvedUrl).origin)
  expect(sent.kind).toBe(transportJob.kind)
}

ownedIt('starts GA quota only after bridge head flush', async (scope) => {
  const ready = Promise.withResolvers<void>()
  const publish = Promise.withResolvers<void>()
  const quota = Promise.withResolvers<void>()
  const events: string[] = []
  const flush = ServerResponse.prototype.flushHeaders
  const flushed = spyOn(
    ServerResponse.prototype,
    'flushHeaders',
  ).mockImplementation(function (this: ServerResponse) {
    flush.call(this)
    events.push('flush')
  })
  scope.defer(async () => flushed.mockRestore())
  const location = await transportLocation(scope, 'local', {
    send: async () => terminalResponse(),
    quotaFetch: async () => {
      events.push('quota')
      quota.resolve()
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const bridge = await startGaLoopbackBridge({
    send: async () => {
      throw new Error('unused send')
    },
    execute: async (job, context) => {
      const response = await location.serving.execute(job, {
        ...context,
        onResponseHandoff: (acknowledge) =>
          context.onResponseHandoff?.(() => {
            events.push('ack')
            acknowledge()
          }),
      })
      ready.resolve()
      await publish.promise
      return response
    },
  })
  scope.defer(() => bridge.dispose())
  const request = bridge.rewrite(
    new Request(transportJob.url, {
      method: 'POST',
      body: transportJob.body,
    }),
    transportJob,
    {},
  )
  const reply = fetch(request, { signal: AbortSignal.timeout(3000) })
  try {
    await ready.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual([])
    publish.resolve()
    const response = await reply
    await quota.promise
    expect(events).toEqual(['flush', 'ack', 'quota'])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('transport reached')
  } finally {
    publish.resolve()
    await reply.then(
      (response) => (response.bodyUsed ? undefined : response.body?.cancel()),
      () => {},
    )
  }
})

ownedIt(
  'GA flush makes headers available before gated upstream body',
  async (scope) => {
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const location = await transportLocation(scope, 'local', {
      send: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      quotaFetch: async () => new Response('{}'),
    })
    const bridge = await startGaLoopbackBridge({
      execute: location.serving.execute,
      send: async () => {
        throw new Error('unused send')
      },
    })
    scope.defer(() => bridge.dispose())
    const request = bridge.rewrite(
      new Request(transportJob.url, {
        method: 'POST',
        body: transportJob.body,
      }),
      transportJob,
      {},
    )
    try {
      const response = await fetch(request, {
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      body?.enqueue(
        new TextEncoder().encode(
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"gated reply"}]},"finishReason":"STOP"}]}}\n\n',
        ),
      )
      body?.close()
      expect(await response.text()).toContain('gated reply')
    } finally {
      try {
        body?.close()
      } catch {}
    }
  },
)

ownedIt(
  'GA quota rejection after handoff preserves status body and terminal frame',
  async (scope) => {
    const errors: unknown[] = []
    const onUnhandled = (error: unknown) => {
      errors.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    scope.defer(async () => {
      process.off('unhandledRejection', onUnhandled)
    })
    const entered = Promise.withResolvers<void>()
    const fail = Promise.withResolvers<void>()
    scope.defer(async () => fail.resolve())
    const location = await transportLocation(scope, 'local', {
      send: async () => terminalResponse(),
      quotaFetch: async () => {
        entered.resolve()
        await fail.promise
        throw new Error('private quota transport failure')
      },
    })
    const bridge = await startGaLoopbackBridge({
      execute: location.serving.execute,
      send: async () => terminalResponse(),
    })
    scope.defer(() => bridge.dispose())
    const request = bridge.rewrite(
      new Request(transportJob.url, {
        method: 'POST',
        body: transportJob.body,
      }),
      transportJob,
      {},
    )
    try {
      const response = await fetch(request, {
        signal: AbortSignal.timeout(3000),
      })
      await entered.promise
      expect(response.status).toBe(200)
      fail.resolve()
      const text = await response.text()
      expect(text).toContain('transport reached')
      expect(text).toContain('"finishReason":"STOP"')
      expect(text.endsWith('\n\n')).toBe(true)
      expect(text).not.toContain('private quota transport failure')
      await location.dispose()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(errors).toEqual([])
    } finally {
      fail.resolve()
    }
  },
)

for (const after of [false, true]) {
  ownedIt(
    `GA host close ${after ? 'after' : 'before'} head ${after ? 'aborts' : 'drops'} quota`,
    async (scope) => {
      const ready = Promise.withResolvers<void>()
      const publish = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const quotaAborted = Promise.withResolvers<void>()
      const jobAborted = Promise.withResolvers<void>()
      let entries = 0
      const location = await transportLocation(scope, 'local', {
        send: async () =>
          new Response(new ReadableStream({ start() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        quotaFetch: async (_url, _init, options) => {
          entries++
          entered.resolve()
          options.signal?.addEventListener(
            'abort',
            () => quotaAborted.resolve(),
            { once: true },
          )
          await quotaAborted.promise
          return new Response('{}')
        },
      })
      const bridge = await startGaLoopbackBridge({
        send: async () => terminalResponse(),
        execute: async (job, context) => {
          context.signal.addEventListener('abort', () => jobAborted.resolve(), {
            once: true,
          })
          const response = await location.serving.execute(job, context)
          ready.resolve()
          await publish.promise
          return response
        },
      })
      scope.defer(() => bridge.dispose())
      const controller = new AbortController()
      const request = bridge.rewrite(
        new Request(transportJob.url, {
          method: 'POST',
          body: transportJob.body,
        }),
        transportJob,
        {},
      )
      const reply = fetch(request, { signal: controller.signal }).then(
        (response) => response,
        () => undefined,
      )
      try {
        await ready.promise
        if (after) {
          publish.resolve()
          const response = await reply
          expect(response?.status).toBe(200)
          await entered.promise
        }
        controller.abort()
        await jobAborted.promise
        publish.resolve()
        await reply
        if (after) await quotaAborted.promise
        await bridge.dispose()
        await location.dispose()
        expect(entries).toBe(after ? 1 : 0)
      } finally {
        controller.abort()
        publish.resolve()
      }
    },
  )
}

if (lifetimeControl) {
  const baseline = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  const events: string[] = []
  let firstRoot: string | undefined
  describe('GA case lifetime child', () => {
    ownedIt(
      'first case fails without abandoning its admitted work',
      async (scope) => {
        if (lifetimeControl === 'timeout') {
          firstRoot = caseEnvironment(scope, 'ga-held-case-', async () => {
            events.push('cleanup')
          })
          await scope.step(
            () =>
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  events.push('drained')
                  resolve()
                }, 100)
              }),
          )
          events.push('late continuation')
        } else {
          const location = await transportLocation(scope, 'local', {})
          firstRoot = dirname(process.env.OPENCODE_CONFIG_DIR ?? '')
          const dispose = location.runtime.dispose.bind(location.runtime)
          spyOn(location.runtime, 'dispose').mockImplementation(async () => {
            await dispose()
            throw new Error('injected disposal failure')
          })
          await location.dispose()
        }
      },
      lifetimeControl === 'timeout' ? 25 : undefined,
    )

    ownedIt(
      'following fixture keeps its own environment and initialized store',
      async (scope) => {
        expect({
          OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        }).toEqual(baseline)
        expect(existsSync(firstRoot ?? failedSetupRoot ?? '')).toBe(false)
        if (lifetimeControl === 'timeout')
          expect(events).toEqual(['drained', 'cleanup'])
        const location = await transportLocation(scope, 'local', {})
        try {
          const response = await location.serving.execute(transportJob, {
            signal: scope.controller().signal,
            send: async () => terminalResponse(),
          })
          expect(await response.text()).toContain('transport reached')
          expect(networkCalls).toHaveLength(1)
        } finally {
          await location.dispose()
        }
        process.stdout.write(
          `GA_LIFETIME_CONTROL ${JSON.stringify({ mode: lifetimeControl, events, restored: true })}\n`,
        )
      },
    )
  })
} else {
  describe('GA test case lifetime', () => {
    for (const mode of ['timeout', 'setup', 'disposal']) {
      ownedIt(
        `contains ${mode} failure before the following fixture starts`,
        async (scope) => {
          let child: ReturnType<typeof Bun.spawn> | undefined
          scope.defer(async () => {
            if (!child) return
            if (child.exitCode === null) child.kill()
            await child.exited
          })
          const process = Bun.spawn(
            [
              Bun.which('bun') ?? 'bun',
              'test',
              '--isolate',
              import.meta.path,
              '-t',
              '^GA case lifetime child',
            ],
            {
              env: {
                ...globalThis.process.env,
                ANTIGRAVITY_GA_TEST_LIFETIME: mode,
              },
              stdout: 'pipe',
              stderr: 'pipe',
              signal: scope.controller().signal,
            },
          )
          child = process
          const [stdout, stderr, code] = await scope.step(() =>
            Promise.all([
              new Response(process.stdout).text(),
              new Response(process.stderr).text(),
              process.exited,
            ]),
          )
          expect(code).toBe(1)
          expect(stderr).toContain(
            '(fail) GA case lifetime child > first case fails without abandoning its admitted work',
          )
          expect(stderr).toContain(
            '(pass) GA case lifetime child > following fixture keeps its own environment and initialized store',
          )
          expect(stdout).toContain(`"mode":"${mode}"`)
          expect(stdout).toContain('"restored":true')
          expect(stderr).toContain(
            mode === 'timeout'
              ? 'timed out after 25ms'
              : `injected ${mode} failure`,
          )
        },
      )
    }
  })
}

describe('GA composed transport', () => {
  ownedIt(
    'sends the switched-account warmup probe and main request through the override',
    async (scope) => {
      const sends: GaSendInput[] = []
      let probeCancelled = 0
      let observations = 0
      const location = await transportLocation(
        scope,
        'local',
        {
          send: async (input) => {
            sends.push(input)
            if (sends.length === 1)
              return new Response(
                '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"rate limit exceeded"}}',
                {
                  status: 429,
                  headers: {
                    'retry-after': '3600',
                    'content-type': 'application/json',
                  },
                },
              )
            if (sends.length !== 2) return terminalResponse()
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('data: {}\n\n'))
                },
                cancel() {
                  probeCancelled++
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            )
          },
          observeRawSenderSignal: () => {
            observations++
            return undefined
          },
        },
        2,
      )
      try {
        expect(location.runtime.config.config.cache_warmup_on_switch).toBe(true)
        const context = {
          signal: scope.controller().signal,
          send: async () => terminalResponse(),
        }
        expect(
          await (await location.serving.execute(transportJob, context)).text(),
        ).toContain('transport reached')
        expect(sends).toHaveLength(3)
        const probe = sends[1]
        const main = sends[2]
        const prepared = location.prepared.mock.calls[1]?.[0]
        if (!probe || !main || !prepared)
          throw new Error('missing switched sends')
        expectFinalizedSend(probe, prepared)
        expectFinalizedSend(main, prepared)
        expect(probe.auth.access).not.toBe(sends[0]?.auth.access)
        expect(probe.auth.access).toBe(main.auth.access)
        expect(probe.envelope.project).not.toBe(sends[0]?.envelope.project)
        expect(probe.envelope.project).toBe(main.envelope.project)
        expect(probe.signal).toBe(main.signal)
        expect(probeCancelled).toBe(1)
        expect(networkCalls).toHaveLength(0)
        expect(observations).toBe(0)
      } finally {
        await location.dispose()
      }
    },
  )

  ownedIt(
    'preserves finalized bytes, signal and idle timeout without an override',
    async (scope) => {
      const observed: AbortSignal[] = []
      const location = await transportLocation(scope, 'local', {
        observeRawSenderSignal: (signal) => {
          expect(networkCalls).toHaveLength(0)
          observed.push(signal)
          return undefined
        },
      })
      try {
        const controller = scope.controller()
        const response = await location.serving.execute(transportJob, {
          signal: controller.signal,
          send: async () => {
            throw new Error('unused')
          },
        })
        expect(await response.text()).toContain('transport reached')
        expect(networkCalls).toHaveLength(1)
        const call = networkCalls[0]
        const prepared = location.prepared.mock.calls[0]?.[0]
        if (!call || !prepared) throw new Error('missing physical send')
        expect(call.url).toBe(prepared.resolvedUrl)
        expect(call.url).toBe(
          'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        )
        expect(call.init?.body).toBe(prepared.body)
        expect([...new Headers(call.init?.headers)]).toEqual([
          ...new Headers(prepared.headers),
        ])
        expect(new Headers(call.init?.headers).get('authorization')).toBe(
          'Bearer access-refresh-0',
        )
        expect(JSON.parse(String(call.init?.body)).project).toBe('project-0')
        expect(call.options?.signal).toBe(call.init?.signal)
        expect(observed).toHaveLength(1)
        expect(call.options?.signal).toBe(observed[0])
        expect(call.options?.idleTimeoutMs).toBe(300_000)
      } finally {
        await location.dispose()
      }
    },
  )

  for (const domain of ['local', 'vault'] as const) {
    ownedIt(
      `reaches the ${domain} send override with the finalized physical attempt`,
      async (scope) => {
        const sends: GaSendInput[] = []
        const observed: AbortSignal[] = []
        const location = await transportLocation(scope, domain, {
          send: async (input) => {
            sends.push(input)
            return terminalResponse()
          },
          observeRawSenderSignal: (signal) => {
            observed.push(signal)
            return undefined
          },
        })
        try {
          const response = await location.serving.execute(transportJob, {
            signal: scope.controller().signal,
            send: async () => {
              throw new Error('unused')
            },
          })
          expect(await response.text()).toContain('transport reached')
          expect(sends).toHaveLength(1)
          const sent = sends[0]
          const prepared = location.prepared.mock.calls[0]?.[0]
          if (!sent || !prepared) throw new Error('missing override send')
          expectFinalizedSend(sent, prepared)
          expect(sent.auth.access).toBe(
            domain === 'local' ? 'access-refresh-0' : 'vault-access',
          )
          expect(sent.envelope.project).toBe(
            domain === 'local' ? 'project-0' : 'vault-project',
          )
          expect(Object.keys(sent.auth)).toEqual(['access'])
          expect(networkCalls).toHaveLength(0)
          expect(observed).toHaveLength(0)
          if (domain === 'vault') {
            expect(location.admitted).toEqual([
              { signal: sent.signal, credentialId: 'credential-0' },
            ])
          }
        } finally {
          await location.dispose()
        }
      },
    )

    ownedIt(
      `cancels an in-flight ${domain} override through the real request signal`,
      async (scope) => {
        const reached = Promise.withResolvers<AbortSignal>()
        const observed: AbortSignal[] = []
        const location = await transportLocation(scope, domain, {
          send: ({ signal }) =>
            new Promise<Response>((_resolve, reject) => {
              reached.resolve(signal)
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              })
            }),
          observeRawSenderSignal: (signal) => {
            observed.push(signal)
            return undefined
          },
        })
        try {
          const controller = scope.controller()
          const pending = location.serving.execute(transportJob, {
            signal: controller.signal,
            send: async () => {
              throw new Error('unused')
            },
          })
          const failure = pending.catch((error: unknown) => error)
          const physical = await scope.wait(reached.promise)
          const reason = new DOMException(
            'host cancelled transport',
            'AbortError',
          )
          controller.abort(reason)
          expect(physical.aborted).toBe(true)
          expect(physical.reason).toBe(reason)
          expect(await failure).toBe(reason)
          expect(networkCalls).toHaveLength(0)
          expect(observed).toHaveLength(0)
        } finally {
          await location.dispose()
        }
      },
    )
  }
})

describe('GA vault request when the approved vault serves no accounts', () => {
  const GRANT =
    'ck auth grant --principal enrolled:antigravity-auth-opencode --selector-kind category --selector antigravity-native --operation read'
  const CATEGORY_GRANT = [
    {
      selectorKind: 'category',
      selector: 'antigravity-native',
      operation: 'read',
    },
  ]

  /**
   * Runs one job through a GA vault location whose source is the real vault
   * account source and consumer, over a vault whose listing names no account
   * for this host and reports `grants` and `grantTuples` as given
   * (undefined: a vault too old to report them).
   */
  async function requestOnEmptyVault(
    scope: GaTestCase,
    grants: number | undefined,
    grantTuples: typeof CATEGORY_GRANT | undefined,
  ) {
    const vaultRoot = realpathSync(
      mkdtempSync(
        join(
          process.platform === 'win32' ? tmpdir() : '/tmp',
          'ga-empty-vault-',
        ),
      ),
    )
    scope.defer(async () => rmSync(vaultRoot, { recursive: true, force: true }))
    const tokenPath = join(vaultRoot, 'enrollment-token.json')
    await scope.step(() =>
      writeFile(
        tokenPath,
        JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
        { mode: 0o600 },
      ),
    )
    const source = realCore.createAntigravityVaultAccountSource({
      claustrum: await scope.step(() => realCore.loadCommonAuthClaustrum()),
      host: 'opencode',
      rosterPath: join(vaultRoot, 'roster.json'),
      tokenPath,
      isCustodyActive: () => true,
      reporterSource: 'direct',
      logger: { warn() {}, debug() {} },
      connect: async () => ({
        listScoped: async () => ({
          view: 'empty-view',
          rows: [],
          grants,
          grantTuples,
        }),
        getScoped: async () => {
          throw new Error('an empty roster admits no send')
        },
        reportAuthFailureScoped: async () => {},
        close() {},
      }),
    })
    scope.defer(async () => source.close())
    const location = await transportLocation(scope, 'vault', {}, 1, source)
    try {
      const response = await location.serving.execute(transportJob, {
        signal: scope.controller().signal,
        send: async () => {
          throw new Error('unused')
        },
      })
      expect(networkCalls).toHaveLength(0)
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      }
    } finally {
      await location.dispose()
    }
  }

  /** The no-account 401 every case keeps; only the message differs. */
  const noAccountRefusal = (message: string) => ({
    status: 401,
    headers: {
      'content-type': 'application/json',
      'x-antigravity-error-type': 'no_accounts',
      'x-antigravity-requested-model': 'antigravity-gemini-3.5-flash',
    },
    body: { error: { code: 401, message, status: 'UNAUTHENTICATED' } },
  })

  ownedIt(
    'says no grant exists and gives the grant command when the vault reports zero grants',
    async (scope) => {
      expect(await requestOnEmptyVault(scope, 0, [])).toEqual(
        noAccountRefusal(
          [
            'Vault access is approved. The vault has not granted antigravity-auth-opencode read access.',
            `The vault operator grants it with: ${GRANT}`,
          ].join('\n'),
        ),
      )
    },
  )

  ownedIt(
    'says the grant reaches no login and gives the reclassify and status commands when a grant exists',
    async (scope) => {
      expect(await requestOnEmptyVault(scope, 1, CATEGORY_GRANT)).toEqual(
        noAccountRefusal(
          [
            'Vault access is approved. antigravity-auth-opencode has read access, but it reaches no Antigravity login in the vault.',
            "The vault operator updates the vault's logins with: ck auth reclassify --from-registry",
            'Then they check them with: ck auth status',
          ].join('\n'),
        ),
      )
    },
  )

  ownedIt(
    'keeps the general vault remedy when the vault does not report grants',
    async (scope) => {
      expect(await requestOnEmptyVault(scope, undefined, undefined)).toEqual(
        noAccountRefusal(realCore.VAULT_ACCOUNT_REMEDY),
      )
    },
  )
})

describe('GA composed request context', () => {
  function job(
    kind: GaBridgeJob['kind'],
    modelID: string,
    variant: string | null = null,
    body = transportJob.body,
    sessionID = 'context-session',
  ): GaBridgeJob {
    return {
      ...transportJob,
      sessionID,
      kind,
      modelID,
      variant,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`,
      body,
    }
  }

  function physicalBody(index: number) {
    const call = networkCalls[index]
    if (!call) throw new Error(`Missing physical request ${index}`)
    return JSON.parse(String(call.init?.body))
  }

  function execute(
    location: Awaited<ReturnType<typeof transportLocation>>,
    scope: GaTestCase,
    request: GaBridgeJob,
  ) {
    return scope.step(async () => {
      const response = await location.serving.execute(request, {
        signal: scope.controller().signal,
        send: async () => {
          throw new Error('legacy sender must not be used')
        },
      })
      const text = await response.text()
      return { response, text }
    })
  }

  ownedIt('routes title work before primary model refusal', async (scope) => {
    const location = await transportLocation(scope, 'local', {})
    try {
      for (const model of [
        'host-off-catalog-title',
        'antigravity-gemini-3.1-pro',
        'antigravity-gemini-3.1-flash-image',
      ]) {
        const { response, text } = await execute(
          location,
          scope,
          job('title', model, 'unavailable-on-original-model'),
        )
        expect(response.status).toBe(200)
        expect(text).toContain('transport reached')
        expect(physicalBody(networkCalls.length - 1).model).toBe(
          'gemini-3.5-flash-extra-low',
        )
      }
      expect(networkCalls).toHaveLength(3)
    } finally {
      await location.dispose()
    }
  })

  ownedIt(
    'applies the selected registered variant to the wire model and thinking',
    async (scope) => {
      const location = await transportLocation(scope, 'local', {})
      const incidentalDefault = JSON.stringify({
        ...JSON.parse(transportJob.body),
        providerOptions: { google: { thinkingLevel: 'high' } },
        generationConfig: {
          thinkingConfig: { includeThoughts: false, thinkingLevel: 'high' },
        },
      })
      try {
        const { response } = await execute(
          location,
          scope,
          job(
            'primary',
            'antigravity-gemini-3.8-flash',
            'low',
            incidentalDefault,
          ),
        )
        expect(response.status).toBe(200)
        expect(networkCalls).toHaveLength(1)
        const body = physicalBody(0)
        expect(body.model).toBe('gemini-3.8-flash-low')
        expect(body.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 1000,
        })
        expect(body.request).not.toHaveProperty('providerOptions')
      } finally {
        await location.dispose()
      }
    },
  )

  ownedIt(
    'native default variant reaches the base model transport instead of returning 412',
    async (scope) => {
      const sends: GaSendInput[] = []
      const location = await transportLocation(scope, 'local', {
        send: async (input) => {
          sends.push(input)
          return terminalResponse()
        },
      })
      const modelID = 'antigravity-gemini-3.8-flash'
      const ownership = new GaRequestOwnership()
      let capturedJob: GaBridgeJob | undefined
      const event: GaHttpRequestEvent = {
        sessionID: 'native-default-session',
        kind: 'primary',
        model: { id: modelID, providerID: 'google', variant: 'default' },
        request: new Request(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: { 'x-goog-api-key': placeholderSecret('google') },
            body: transportJob.body,
          },
        ),
      }
      try {
        await rewriteGaHttpRequest(event, {
          bridge: {
            rewrite: (original, job) => {
              capturedJob = job
              return original
            },
          },
          isRegisteredModel: (id) => id === modelID,
          env: {},
          ownership,
        })
        if (!capturedJob) throw new Error('the request hook created no GA job')
        const response = await location.serving.execute(capturedJob, {
          signal: scope.controller().signal,
          send: async () => {
            throw new Error('legacy sender must not be used')
          },
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('transport reached')
        expect(sends).toHaveLength(1)
        expect(sends.map((send) => send.kind)).toEqual(['primary'])
        expect(sends[0]?.envelope.model).toBe('gemini-3.8-flash-medium')
      } finally {
        await location.dispose()
        ownership.clear()
      }
    },
  )

  ownedIt(
    'owned seeded default request reaches the composed sender with pool bearer and prepared envelope',
    async (scope) => {
      const { prepareGaRoot, seedGaHost } = await import(
        '../../../e2e-tests/src/opencode-ga-harness.ts'
      )
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'ga-seeded-default-'))
      scope.defer(async () =>
        rmSync(fixtureRoot, { recursive: true, force: true }),
      )
      const paths = prepareGaRoot(fixtureRoot)
      seedGaHost(
        paths,
        '/owned/wrapper',
        'http://127.0.0.1:1234',
        0,
        false,
        'ga-ownership-pool-login',
      )
      const config = JSON.parse(
        readFileSync(join(paths.opencodeConfig, 'opencode.json'), 'utf8'),
      )
      const sends: GaSendInput[] = []
      const reached = Promise.withResolvers<GaSendInput>()
      const location = await transportLocation(scope, 'local', {
        send: (input) => {
          sends.push(input)
          reached.resolve(input)
          return new Promise<Response>((_resolve, reject) => {
            input.signal.addEventListener(
              'abort',
              () => reject(input.signal.reason),
              { once: true },
            )
          })
        },
      })
      const modelID = 'antigravity-gemini-3.8-flash'
      const ownership = new GaRequestOwnership()
      let capturedJob: GaBridgeJob | undefined
      const event: GaHttpRequestEvent = {
        sessionID: 'seeded-default-session',
        kind: 'primary',
        model: { id: modelID, providerID: 'google', variant: 'default' },
        request: new Request(
          `${config.providers.google.settings.baseURL}/models/${modelID}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: { 'x-goog-api-key': placeholderSecret('google') },
            body: transportJob.body,
          },
        ),
      }
      try {
        await rewriteGaHttpRequest(event, {
          bridge: {
            rewrite: (original, job) => {
              capturedJob = job
              return original
            },
          },
          isRegisteredModel: (id) => id === modelID,
          env: {},
          ownership,
        })
        if (!capturedJob) throw new Error('the request hook created no GA job')
        expect(capturedJob.variant).toBeNull()
        const controller = scope.controller()
        const signal = controller.signal
        const pending = location.serving.execute(capturedJob, {
          signal,
          send: async () => {
            throw new Error('legacy sender must not be used')
          },
        })
        const failure = pending.catch((error: unknown) => error)
        await scope.wait(Promise.race([reached.promise, pending]))
        expect(sends).toHaveLength(1)
        expect(sends.map((send) => send.kind)).toEqual(['primary'])
        expect(sends[0]?.auth).toEqual({ access: 'access-refresh-0' })
        expect(sends[0]?.envelope.project).toBe('project-0')
        expect(sends[0]?.envelope.model).toBe('gemini-3.8-flash-medium')
        const sent = sends[0]
        const prepared = location.prepared.mock.calls[0]?.[0]
        if (!sent || !prepared) throw new Error('missing prepared primary send')
        expect(prepared.body).toBe(JSON.stringify(sent.envelope))
        expect(new Headers(prepared.headers).get('authorization')).toBe(
          'Bearer access-refresh-0',
        )
        expect(sent.signal.aborted).toBe(false)
        expect(signal.aborted).toBe(false)
        const reason = new DOMException('job cancelled', 'AbortError')
        controller.abort(reason)
        expect(sent.signal.aborted).toBe(true)
        expect(sent.signal.reason).toBe(reason)
        expect(await failure).toBe(reason)
        expect(networkCalls).toHaveLength(0)
      } finally {
        await location.dispose()
        ownership.clear()
      }
    },
  )

  ownedIt(
    'keeps a registered title target and its selected variant',
    async (scope) => {
      const location = await transportLocation(scope, 'local', {})
      try {
        const { response } = await execute(
          location,
          scope,
          job(
            'title',
            'antigravity-gemini-3.8-flash',
            'medium',
            JSON.stringify({
              ...JSON.parse(transportJob.body),
              generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
            }),
          ),
        )
        expect(response.status).toBe(200)
        expect(networkCalls).toHaveLength(1)
        const body = physicalBody(0)
        expect(body.model).toBe('gemini-3.8-flash-medium')
        expect(body.request.generationConfig.thinkingConfig).toEqual({
          includeThoughts: true,
          thinkingBudget: 4000,
        })
      } finally {
        await location.dispose()
      }
    },
  )

  ownedIt(
    'refuses unavailable and disabled variants without a physical send',
    async (scope) => {
      const location = await transportLocation(scope, 'local', {})
      const variants =
        realCore.getPublicModelDefinitions()['antigravity-gemini-3.8-flash']!
          .variants!
      const original = variants.low!
      variants.low = { ...original, disabled: true }
      try {
        for (const kind of [
          'primary',
          'compaction',
          'generate',
          'title',
        ] as const) {
          for (const variant of ['not-registered', 'low', 'toString']) {
            const { response, text } = await execute(
              location,
              scope,
              job(kind, 'antigravity-gemini-3.8-flash', variant),
            )
            expect(response.status).toBe(412)
            expect(JSON.parse(text)).toEqual({
              error: {
                code: 412,
                status: 'FAILED_PRECONDITION',
                message:
                  'This Antigravity thinking level is unavailable. Choose another thinking level.',
              },
            })
            expect(networkCalls).toHaveLength(0)
          }
        }
      } finally {
        variants.low = original
        await location.dispose()
      }
    },
  )

  ownedIt(
    'isolates every auxiliary kind without changing primary steps',
    async (scope) => {
      const location = await transportLocation(scope, 'local', {})
      const begin = spyOn(AgySessionRegistry.prototype, 'beginRequest')
      const flash = 'antigravity-gemini-3.8-flash'
      const payload = (count: number) =>
        JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: Array.from({ length: count }, (_, i) => ({
                text: `Part ${i}`,
              })),
            },
          ],
        })
      try {
        for (const count of [1, 3, 2]) {
          await execute(
            location,
            scope,
            job('primary', flash, null, payload(count), 'all-primary'),
          )
        }
        await execute(
          location,
          scope,
          job('primary', flash, null, payload(1), 'mixed'),
        )
        for (const kind of ['title', 'compaction', 'generate'] as const) {
          await execute(
            location,
            scope,
            job(
              kind,
              'antigravity-claude-sonnet-5-5',
              null,
              payload(5),
              'mixed',
            ),
          )
        }
        for (const count of [3, 2]) {
          await execute(
            location,
            scope,
            job('primary', flash, null, payload(count), 'mixed'),
          )
        }
        expect(networkCalls).toHaveLength(9)
        expect(
          begin.mock.calls.map(([identity]) => identity.sessionId),
        ).toEqual([
          'all-primary',
          'all-primary',
          'all-primary',
          'mixed',
          'mixed#title',
          'mixed#compaction',
          'mixed#generate',
          'mixed',
          'mixed',
        ])
        const bodies = Array.from({ length: 9 }, (_, i) => physicalBody(i))
        const control = bodies.slice(0, 3)
        const primary = [bodies[3], bodies[7], bodies[8]]
        for (const sequence of [control, primary]) {
          expect(sequence.map((body) => body.requestId.split('/')[4])).toEqual([
            '2',
            '4',
            '3',
          ])
          expect(
            sequence.map((body) => body.request.labels.last_step_index),
          ).toEqual(['1', '3', '2'])
          expect(
            new Set(sequence.map((body) => body.request.labels.trajectory_id))
              .size,
          ).toBe(1)
          expect(
            sequence.map((body) => body.request.labels.used_claude),
          ).toEqual(['false', 'false', 'false'])
        }
        const auxiliaries = bodies.slice(4, 7)
        expect(
          new Set(
            [primary[0], ...auxiliaries].map(
              (body) => body.request.labels.trajectory_id,
            ),
          ).size,
        ).toBe(4)
        expect(
          new Set(
            [primary[0], ...auxiliaries].map(
              (body) => body.requestId.split('/')[1],
            ),
          ).size,
        ).toBe(4)
        for (const body of auxiliaries) {
          expect(body.request.labels.last_step_index).toBe('5')
          expect(body.requestId.split('/')[4]).toBe('6')
          expect(body.request.labels.used_claude).toBe('true')
        }
      } finally {
        begin.mockRestore()
        await location.dispose()
      }
    },
  )
})

describe('GA quota check authorization', () => {
  it('defaults absent purpose to required and skips refresh only on explicit advisory purpose', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      expect(
        (await authorizeGaQuotaCheck(repository, { rowRef: ref }, Date.now))
          .status,
      ).toBe('authorized')
      expect(exchanged).toEqual(['refresh-quota'])
      const expiredNow = () => Date.now() + 7_200_000
      expect(
        await authorizeGaQuotaCheck(
          repository,
          { rowRef: ref },
          expiredNow,
          'advisory',
        ),
      ).toEqual({ status: 'skipped', reason: 'refresh-needed' })
      expect(exchanged).toEqual(['refresh-quota'])
      expect(
        (
          await authorizeGaQuotaCheck(
            repository,
            { rowRef: ref },
            expiredNow,
            'required',
          )
        ).status,
      ).toBe('authorized')
      expect(exchanged).toEqual(['refresh-quota', 'refresh-quota'])
    } finally {
      await cleanup()
    }
  })

  for (const caller of ['manual', 'poller'] as const) {
    it(`${caller} quota still refreshes required credentials without advisory opt-in`, async () => {
      let issueExpired = true
      const {
        repository,
        ref: loginRef,
        exchanged,
        cleanup,
      } = await freshRepository({
        expiresAt: () => Date.now() + (issueExpired ? -3_600_000 : 3_600_000),
      })
      const seeded = await repository.refresh(loginRef)
      if (seeded.status !== 'rotated')
        throw new Error('expired credential unavailable')
      const ref = seeded.ref
      issueExpired = false
      exchanged.length = 0
      const manager = AccountManager.fromRepository(await repository.read(), {
        repository,
      })
      let quotaCalls = 0
      const transport = async () => {
        quotaCalls++
        return Response.json({ groups: [] })
      }
      const ensureProject = async (
        auth: ReturnType<typeof manager.toAuthDetails>,
      ) => ({ auth, effectiveProjectId: 'project-q' })
      const quota = createQuotaManager({
        keyOf: (account) => account.refreshToken,
        fetchAccountQuota: createGaFetchAccountQuota({
          repository,
          now: Date.now,
          logger: { debug: () => {} },
          overrides: {
            ensureProjectContext: ensureProject,
            quotaFetch: transport,
          },
        }),
      })
      const service = createStoreQuotaService({
        manager,
        repository,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        credentials: {
          ...createLocalAccountCredentials(manager, { repository }),
          ensureProject,
        },
        transport: () => transport,
      })
      let poller: BackgroundQuotaRefresh | undefined
      try {
        if (caller === 'manual') {
          await service.checkStoreQuota([ref])
        } else {
          const snapshots = createMemoryQuotaSnapshots()
          const observed = Promise.withResolvers<void>()
          const write = snapshots.write
          snapshots.write = async (state) => {
            await write(state)
            observed.resolve()
          }
          poller = new BackgroundQuotaRefresh({
            intervalMs: 60_000,
            snapshots,
            getAccountManager: () => manager,
            quotaManager: quota,
            random: () => 0,
          })
          poller.start()
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              observed.promise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('poller quota was not reached')),
                  3_000,
                )
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
        }
        expect(exchanged).toEqual(['refresh-quota'])
        expect(quotaCalls).toBe(1)
      } finally {
        await poller?.dispose()
        await quota.dispose()
        await service.dispose()
        await manager.dispose()
        await cleanup()
      }
    })
  }

  it('refuses a target without a captured ref', async () => {
    const { repository, exchanged, cleanup } = await freshRepository()
    try {
      expect(await authorizeGaQuotaCheck(repository, {}, Date.now)).toEqual({
        status: 'refused',
        reason: 'unattributed',
      })
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refreshes the captured credential through the repository', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      const result = await authorizeGaQuotaCheck(
        repository,
        { rowRef: ref },
        Date.now,
      )
      expect(result).toMatchObject({
        status: 'authorized',
        auth: { access: 'access-fresh', refresh: 'refresh-quota|project-q' },
      })
      expect(exchanged).toEqual(['refresh-quota'])
      // A second check reuses the stored, unexpired token.
      await authorizeGaQuotaCheck(repository, { rowRef: ref }, Date.now)
      expect(exchanged).toEqual(['refresh-quota'])
    } finally {
      await cleanup()
    }
  })

  it('fetches quota with the bearer of the manager target it was handed', async () => {
    const { repository, exchanged, cleanup } = await freshRepository()
    try {
      const manager = AccountManager.fromRepository(await repository.read(), {
        repository,
      })
      const calls: { url: string; authorization: string | null }[] = []
      const fetchQuota = createGaFetchAccountQuota({
        repository,
        now: Date.now,
        logger: { debug: () => undefined },
        overrides: {
          ensureProjectContext: async (auth) => ({
            auth,
            effectiveProjectId: 'project-q',
          }),
          quotaFetch: async (url, init) => {
            calls.push({
              url,
              authorization: new Headers(init.headers).get('authorization'),
            })
            return new Response(
              url.includes('retrieveUserQuotaSummary')
                ? '{"groups":[]}'
                : '{"buckets":[]}',
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          },
        },
      })
      const [target] = manager.getAccountsForQuotaCheck()
      if (!target) throw new Error('missing target')
      const result = await fetchQuota(target, new AbortController().signal)
      expect(result.status).toBe('ok')
      expect(exchanged).toEqual(['refresh-quota'])
      expect(calls.length).toBeGreaterThan(0)
      expect(
        calls.every((call) => call.authorization === 'Bearer access-fresh'),
      ).toBe(true)

      const { rowRef: _dropped, ...unattributed } = target
      const refused = await fetchQuota(
        unattributed,
        new AbortController().signal,
      )
      expect(refused).toMatchObject({
        status: 'error',
        error: 'quota check refused (unattributed)',
      })
    } finally {
      await cleanup()
    }
  })

  it('never checks a stale target on its successor, even with the same token and position', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      const manager = AccountManager.fromRepository(await repository.read(), {
        repository,
      })
      const [target] = manager.getAccountsForQuotaCheck()
      if (!target) throw new Error('missing target')
      // Same position, same refresh token; only the credential epoch moved on.
      await repository.replaceCredential(ref, {
        refreshToken: 'refresh-quota',
        disabled: 'keep',
      })
      const requests: string[] = []
      const fetchQuota = createGaFetchAccountQuota({
        repository,
        now: Date.now,
        logger: { debug: () => undefined },
        overrides: {
          quotaFetch: async (url) => {
            requests.push(url)
            return new Response('{}')
          },
        },
      })
      expect(
        await fetchQuota(target, new AbortController().signal),
      ).toMatchObject({
        status: 'error',
        error: 'quota check refused (stale)',
      })
      expect(requests).toEqual([])
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses a target whose credential was replaced, never checking its successor', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      await repository.replaceCredential(ref, {
        refreshToken: 'refresh-replacement',
        disabled: 'keep',
      })
      expect(
        await authorizeGaQuotaCheck(repository, { rowRef: ref }, Date.now),
      ).toEqual({ status: 'refused', reason: 'stale' })
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('createGaHostSlotReader', () => {
  const reader = (active: unknown, resolved: unknown) =>
    createGaHostSlotReader(
      {
        active: async (id: string) => {
          expect(id).toBe('google')
          return active
        },
        resolve: async () => resolved,
      },
      'google',
    )

  it('reads the host sign-in in the shape the vault library classifies', async () => {
    expect(await reader(undefined, undefined)()).toBeUndefined()
    expect(
      await reader(
        { id: 'connection-1' },
        {
          type: 'oauth',
          methodID: 'oauth',
          refresh: 'host-refresh',
          access: 'host-access',
          expires: 5,
          metadata: { email: 'x' },
        },
      )(),
    ).toEqual({
      type: 'oauth',
      refresh: 'host-refresh',
      access: 'host-access',
      expires: 5,
    })
    expect(
      await reader({ id: 'connection-2' }, { type: 'key', key: 'host-key' })(),
    ).toEqual({ type: 'api', key: 'host-key' })
  })

  it('refuses an active connection it cannot resolve or understand', async () => {
    await expect(reader({ id: 'c' }, undefined)()).rejects.toThrow(
      'could not be resolved',
    )
    await expect(reader({ id: 'c' }, { type: 'other' })()).rejects.toThrow(
      'unknown shape',
    )
  })
})

describe('createGaLocationServices (production factory)', () => {
  it('serves same-read state and exact-credential menu actions over a real store, then disposes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-factory-')))
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    }
    // Every user-level path the runtime derives lands under the test root.
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    process.env.XDG_CONFIG_HOME = join(root, 'xdg')
    try {
      const directory = join(root, 'location')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(directory)
      mkdirSync(join(directory, '.opencode'))
      // This test measures manual quota actions. Automatic refreshes would
      // change the same counters before the account is disabled.
      await writeFile(
        join(directory, '.opencode', 'antigravity.json'),
        JSON.stringify({
          background_quota_refresh: false,
          proactive_token_refresh: false,
        }),
      )
      const legacyPath = join(root, 'config', GA_ACCOUNTS_FILE)
      const modules = await loadCommonAuthStoreModules()
      await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
      const admission = await readAccountStoreAdmission(
        legacyPath,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const seed = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async () => {
          throw new Error('token exchange is not part of this test')
        },
      })
      for (const name of ['one', 'two']) {
        await seed.login({
          id: crypto.randomUUID(),
          refreshToken: `refresh-${name}`,
          metadata: {
            email: `${name}@example.com`,
            addedAt: 1,
            lastUsed: 1,
            // A managed project needs no project discovery request.
            managedProjectId: `managed-${name}`,
          },
        })
      }
      await seed.dispose()

      const observed: HarnessAccountsObservation[] = []
      const exchanged: string[] = []
      const notices: unknown[] = []
      const signIns: string[] = []
      const quotaRequests: { url: string; authorization: string | null }[] = []
      const services = await createGaLocationServices({
        directory,
        overrides: {
          refreshAccessToken: async (refreshToken) => {
            exchanged.push(refreshToken)
            return {
              access: `access-for-${refreshToken}`,
              refresh: refreshToken,
              expires: Date.now() + 3_600_000,
            }
          },
          quotaFetch: async (url, init) => {
            quotaRequests.push({
              url,
              authorization: new Headers(init.headers).get('authorization'),
            })
            return new Response(
              url.includes('retrieveUserQuotaSummary')
                ? '{"groups":[]}'
                : '{"buckets":[]}',
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          },
          oauth: {
            authorize: async () => ({
              url: 'https://accounts.example/auth?state=state-1',
              verifier: 'verifier-1',
              projectId: '',
            }),
            waitForCode: async (state) => {
              signIns.push(`wait:${state}`)
              return 'code-1'
            },
            exchange: async (code, state) => {
              signIns.push(`exchange:${code}:${state}`)
              return {
                type: 'success',
                refresh: 'refresh-one-reauthorized|',
                access: 'access-reauthorized',
                expires: Date.now() + 3_600_000,
                email: 'one@example.com',
                projectId: '',
              }
            },
          },
          observeAccountSnapshot: (observation) => {
            observed.push(observation)
            return undefined
          },
        },
      })
      expect(Object.keys(services.runtime)).not.toContain('sidebarStateFile')
      const runtime = await createLocationRuntime({
        ...services.runtime,
        directory,
        operatorSettingsRegistry: createOperatorSettingsRegistry(),
      })
      try {
        const serving = await services.start({
          runtime,
          generation: 'g-test',
          send: async () => new Response('not used'),
          notify: (_scope, entry) => {
            notices.push(entry)
            return null
          },
          isConnected: () => false,
        })
        const signal = new AbortController().signal
        const read = await serving.state.read({
          scope: { kind: 'sessionless' },
          signal,
        })
        if (read.accounts.kind !== 'complete') throw new Error('over limit')
        expect(read.accounts.rows).toHaveLength(2)
        expect(runtime.backgroundQuotaRefresh).toBeNull()
        expect(runtime.refreshQueue()).toBeNull()
        expect(observed.map((entry) => entry.readSeq)).toEqual([read.readSeq])
        const text = JSON.stringify(read)
        expect(text).not.toContain('@example.com')
        expect(text).not.toContain('refresh-')

        // A client learns the menu's item ids from any apply answer; an
        // action the menu does not offer answers with the current menu.
        const scope = { kind: 'sessionless' } as const
        const probe = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'accounts',
            actionId: 'not-an-action',
          },
          scope,
          signal,
        })
        expect(probe).toMatchObject({ ok: false, code: 'unavailable' })
        const items =
          probe.menu.sections.find((section) => section.id === 'accounts')
            ?.items ?? []
        expect(JSON.stringify(probe)).not.toContain('@example.com')
        const result = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'accounts',
            itemId: items[1]?.id ?? '',
            actionId: 'disable',
          },
          scope,
          signal,
        })
        expect(result.ok).toBe(true)
        expect(observed.at(-1)?.accounts.map((entry) => entry.enabled)).toEqual(
          [true, true],
        )
        const after = await serving.state.read({
          scope: { kind: 'sessionless' },
          signal,
        })
        expect(observed.at(-1)?.readSeq).toBe(after.readSeq)
        expect(observed.at(-1)?.accounts.map((entry) => entry.enabled)).toEqual(
          [true, false],
        )
        expect(typeof serving.execute).toBe('function')

        // The menu's quota check goes through the store quota service: the
        // enabled account's token is refreshed through the repository and
        // its requests carry exactly that bearer; the disabled one is not
        // checked.
        const checked = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'quota',
            actionId: 'refresh',
          },
          scope,
          signal,
        })
        expect(exchanged).toEqual(['refresh-one'])
        expect(quotaRequests.length).toBeGreaterThan(0)
        expect(
          quotaRequests.every(
            (request) =>
              request.authorization === 'Bearer access-for-refresh-one',
          ),
        ).toBe(true)
        expect(checked.text).toMatch(/^Quota checked for 1 of 2 accounts/)

        // Reauthorize the first account from its menu item: the action
        // answers once the sign-in waits for the browser, and the new login
        // then replaces exactly that row's credential and reaches routing.
        const reauthorized = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'accounts',
            itemId: items[0]?.id ?? '',
            actionId: 'reauthorize',
          },
          scope,
          signal,
        })
        expect(reauthorized.text).toContain('Waiting for the browser')
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (JSON.stringify(notices).includes('Account reauthorized.')) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(JSON.stringify(notices)).toContain('Account reauthorized.')
        expect(signIns).toEqual(['wait:state-1', 'exchange:code-1:state-1'])
        const stored = await createAccountRepositoryFactory(modules)({
          paths: admission.paths,
          now: Date.now,
          exchange: async () => {
            throw new Error('not used')
          },
        })
        try {
          const rows = await stored.read()
          if (rows.status !== 'ready') throw new Error(rows.status)
          expect(rows.rows.map((row) => row.credential?.refreshToken)).toEqual([
            'refresh-one-reauthorized',
            'refresh-two',
          ])
        } finally {
          await stored.dispose()
        }
        const routed = runtime.accounts()
        expect(
          routed?.getAccounts().map((account) => account.parts.refreshToken),
        ).toEqual(['refresh-one-reauthorized', 'refresh-two'])
      } finally {
        await services.dispose()
        await runtime.dispose()
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an uninitialized local store unopened and refuses its first local admission without creating it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-factory-empty-')))
    let getRepository:
      | (() => Promise<
          import('@cortexkit/antigravity-auth-core').AccountRepository
        >)
      | undefined
    let moduleLoads = 0
    const factory = createGaLocationServicesFactory({
      loadStoreModules: async () => {
        moduleLoads++
        return loadCommonAuthStoreModules()
      },
      resolveAccountFile: (directory) => join(directory, GA_ACCOUNTS_FILE),
      now: Date.now,
      runtime: (input) => {
        getRepository = input.getRepository
        return createGaRuntimeCollaborators({
          ...input,
          accounts: { current: null, quotaLogger: null },
          now: Date.now,
        })
      },
      createPipeline: async () => {
        throw new Error('no pipeline before admission')
      },
    })
    const services = await factory({ directory: root, overrides: {} })
    try {
      const { readdirSync } = await import('node:fs')
      expect(moduleLoads).toBe(0)
      expect(readdirSync(root)).toEqual([])
      if (!getRepository) throw new Error('repository binding missing')
      await expect(getRepository()).rejects.toThrow('not initialized')
      expect(moduleLoads).toBe(1)
      expect(readdirSync(root)).toEqual([])
    } finally {
      await services.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('GA vault custody location', () => {
  it("serves the vault's accounts without a local store, with settings and the Vault section", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-vault-')))
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    }
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    process.env.XDG_CONFIG_HOME = join(root, 'xdg')
    try {
      const routes = [
        {
          routeId: 'route-a',
          credentialId: 'credential-a',
          accountIdentity: 'identity-a',
          label: 'vault-a@example.com',
          email: 'vault-a@example.com',
        },
      ]
      let refreshed = 0
      let disposed = 0
      let localModuleLoads = 0
      let mode: 'local' | 'custody' | 'unreadable' = 'custody'
      let localConstructions = 0
      let localDisposals = 0
      let localRefreshes = 0
      const generations: string[] = []
      const committed: unknown[] = []
      const source = {
        refresh: async () => {
          refreshed += 1
          return undefined
        },
        routes: () => routes,
        admit: async () => {
          throw new Error('no send in this test')
        },
        reportServedStatus: async () => false,
        attribution: () => {
          throw new Error('no admission in this test')
        },
        commitState: async (
          by: { routeId: string; credentialId: string; recordVersion: number },
          update: (
            current: undefined,
          ) => { quota?: unknown } | null | undefined,
        ) => {
          const next = update(undefined)
          committed.push({ by, quota: next?.quota })
          return {
            status: 'written' as const,
            state: {
              observed: {
                routeId: by.routeId,
                credentialId: by.credentialId,
                recordVersion: by.recordVersion,
              },
            },
          }
        },
        send: async () => {
          throw new Error('no send in this test')
        },
      }
      const factory = createGaLocationServicesFactory({
        loadStoreModules: async () => {
          localModuleLoads++
          return loadCommonAuthStoreModules()
        },
        resolveAccountFile: (directory) =>
          join(directory, 'antigravity-accounts.json'),
        now: Date.now,
        runtime: (input) =>
          createGaRuntimeCollaborators({
            ...input,
            accounts: { current: null, quotaLogger: null },
            now: Date.now,
          }),
        createPipeline: async (input) => {
          localConstructions++
          generations.push(input.generation)
          return {
            execute: async () => {
              await input.assertAdmission?.()
              return new Response('local send')
            },
            refreshAccounts: async () => {
              await input.assertAdmission?.()
              localRefreshes++
            },
            dispose: async () => {
              localDisposals++
            },
          }
        },
        fetchVaultQuota: async ({ ref }) => ({
          quota: {
            groups: { gemini: { remainingFraction: 0.25, modelCount: 3 } },
            modelCount: 3,
          },
          quotaAttribution: {
            routeId: ref.routeId,
            credentialId: ref.credentialId,
            accountIdentity: ref.accountIdentity,
            recordVersion: 4,
          },
        }),
        custody: () => ({
          readMode: async () =>
            mode === 'unreadable'
              ? { ok: false, reason: 'unreadable' }
              : { ok: true, record: { version: 1, mode } },
          custodySource: async () => source,
          // A route's stored state, written for its current credential: the
          // cooldown comes back on restart.
          readState: async () => ({
            schemaVersion: 1,
            accounts: {
              'identity-a': {
                observed: {
                  routeId: 'route-a',
                  credentialId: 'credential-a',
                  recordVersion: 3,
                },
                metadata: {
                  addedAt: 1,
                  lastUsed: 2,
                  coolingDownUntil: Date.now() + 600_000,
                  cooldownReason: 'auth-failure',
                },
              },
            },
          }),
          menuSection: () => ({
            id: 'vault',
            title: 'Vault',
            build: () => ({
              lines: [`Mode: ${mode}`],
              actions: [
                {
                  id: mode === 'local' ? 'use-vault' : 'use-local',
                  label: 'Switch account source',
                  run: async () => {
                    mode = mode === 'local' ? 'custody' : 'local'
                    return 'Account source changed'
                  },
                },
              ],
            }),
          }),
          dispose: async () => {
            disposed += 1
          },
        }),
      })
      const directory = join(root, 'location')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(directory)
      const services = await factory({ directory, overrides: {} })
      const runtime = await createLocationRuntime({
        ...services.runtime,
        directory,
        operatorSettingsRegistry: createOperatorSettingsRegistry(),
      })
      try {
        const notices: unknown[] = []
        const serving = await services.start({
          runtime,
          generation: 'g-vault',
          send: async () => new Response('not used'),
          notify: (_scope, entry) => {
            notices.push(entry)
            return null
          },
          isConnected: () => false,
        })
        expect(refreshed).toBe(0)
        expect(localModuleLoads).toBe(0)
        const signal = new AbortController().signal
        const scope = { kind: 'sessionless' } as const
        const read = await serving.state.read({ scope, signal })
        expect(refreshed).toBe(1)
        expect(localModuleLoads).toBe(0)
        if (read.accounts.kind !== 'complete') throw new Error('over limit')
        expect(read.accounts.rows).toHaveLength(1)
        // The stored cooldown came back for the route's current credential.
        expect(read.accounts.rows[0]?.row.coolingDownUntil).toBeGreaterThan(
          Date.now(),
        )
        expect(JSON.stringify(read)).not.toContain('vault-a@example.com')

        const answer = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'limits',
            actionId: 'set',
            values: { enabled: true },
          },
          scope,
          signal,
        })
        expect(answer.ok).toBe(true)
        expect(answer.menu.sections.map((section) => section.slot)).toEqual([
          'accounts',
          'quota',
          'routing',
          'limits',
          'diagnostics',
          'extra',
        ])
        expect(JSON.stringify(answer)).not.toContain('vault-a@example.com')
        expect(runtime.operatorSettings.get().killswitch.enabled).toBe(true)
        // The apply re-read the vault roster for routing.
        expect(refreshed).toBe(2)

        // Check quota now: the reading is recorded through the source's
        // provider-state commit under the answering admission, and shown.
        const checked = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'quota',
            actionId: 'refresh',
          },
          scope,
          signal,
        })
        expect(checked.text).toBe('Quota checked for 1 of 1 accounts')
        expect(committed).toHaveLength(1)
        const after = await serving.state.read({ scope, signal })
        if (after.accounts.kind !== 'complete') throw new Error('over limit')
        expect(after.accounts.rows[0]?.row.cachedQuota?.gemini).toMatchObject({
          remainingFraction: 0.25,
        })
        expect(localModuleLoads).toBe(0)
        expect(await services.runtime.mayRun?.()).toBe(false)

        const legacyPath = join(directory, GA_ACCOUNTS_FILE)
        const modules = await loadCommonAuthStoreModules()
        await initializeFreshAccountStore(modules, {
          legacyPath,
          now: Date.now,
        })
        const admission = await readAccountStoreAdmission(
          legacyPath,
          modules,
          Date.now,
        )
        if (admission.status !== 'active') throw new Error(admission.status)
        const seed = createAccountRepositoryFactory(modules)({
          paths: admission.paths,
          now: Date.now,
          exchange: async () => {
            throw new Error('no token exchange')
          },
        })
        try {
          await seed.login({
            id: crypto.randomUUID(),
            refreshToken: 'local-refresh',
            metadata: { email: 'local@example.com', addedAt: 1, lastUsed: 1 },
          })
          mode = 'local'
          expect(await services.runtime.mayRun?.()).toBe(true)
          const localRead = await serving.state.read({ scope, signal })
          expect(localRead.readSeq).toBeGreaterThan(after.readSeq)
          expect(localConstructions).toBe(1)
          expect(localModuleLoads).toBe(1)
          const localMenu = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'accounts',
              actionId: 'not-an-action',
            },
            scope,
            signal,
          })
          const account = localMenu.menu.sections.find(
            (section) => section.slot === 'accounts',
          )?.items[0]
          if (!account) throw new Error('no local menu account')
          expect(account.actions.some((action) => action.id === 'remove')).toBe(
            true,
          )
          const before = await seed.read()
          routes.push({
            routeId: 'route-b',
            credentialId: 'credential-b',
            accountIdentity: 'identity-b',
            label: 'vault-b@example.com',
            email: 'vault-b@example.com',
          })
          const refreshesBeforeSwitch = refreshed
          const switched = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'vault',
              actionId: 'use-vault',
            },
            scope,
            signal,
          })
          expect(switched.ok).toBe(true)
          expect(refreshed).toBe(refreshesBeforeSwitch + 1)
          expect(JSON.stringify(notices)).not.toContain(
            'routing has not picked it up',
          )
          const refreshesBeforeReturn = localRefreshes
          const stale = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'accounts',
              actionId: 'remove',
              itemId: account.id,
              confirmed: true,
            },
            scope,
            signal,
          })
          expect(stale.ok).toBe(false)
          expect(await seed.read()).toEqual(before)
          const vaultAgain = await serving.state.read({ scope, signal })
          expect(vaultAgain.readSeq).toBeGreaterThan(localRead.readSeq)
          if (vaultAgain.accounts.kind !== 'complete')
            throw new Error('over limit')
          expect(vaultAgain.accounts.rows).toHaveLength(2)
          expect(localDisposals).toBe(0)
          const restored = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'vault',
              actionId: 'use-local',
            },
            scope,
            signal,
          })
          expect(restored.ok).toBe(true)
          expect(localRefreshes).toBe(refreshesBeforeReturn + 1)
          expect(JSON.stringify(notices)).not.toContain(
            'routing has not picked it up',
          )
          const localAgain = await serving.state.read({ scope, signal })
          expect(localAgain.readSeq).toBeGreaterThan(vaultAgain.readSeq)
          expect(localConstructions).toBe(1)
          expect(localModuleLoads).toBe(1)
          expect(generations).toEqual(['g-vault'])
          mode = 'unreadable'
          expect(await services.runtime.mayRun?.()).toBe(false)
          const recovery = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'accounts',
              actionId: 'not-an-action',
            },
            scope,
            signal,
          })
          expect(
            recovery.menu.sections.find(
              (section) => section.slot === 'accounts',
            )?.actions,
          ).toEqual([])
          expect(
            recovery.menu.sections.some((section) => section.id === 'vault'),
          ).toBe(true)
        } finally {
          await seed.dispose()
        }
      } finally {
        await runtime.dispose()
        await services.dispose()
      }
      expect(disposed).toBe(1)
      expect(localDisposals).toBe(1)
      expect(localModuleLoads).toBe(1)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('GA browser action lifetime', () => {
  it('returns the sign-in link before a held browser callback and drains it on disposal', async () => {
    const fixture = await freshRepository()
    let deliver: (code: string) => void = () => {}
    const browser = new Promise<string>((resolve) => {
      deliver = resolve
    })
    let exchanged = 0
    const notices: string[] = []
    const action = createGaReauthorize({
      repository: fixture.repository,
      afterChange: async () => {},
      overrides: {
        oauth: {
          authorize: async () => ({
            url: 'https://accounts.google.com/authorize?state=owned-test-state',
            verifier: 'synthetic-verifier',
            projectId: '',
          }),
          waitForCode: () => browser,
          exchange: async () => {
            exchanged++
            throw new Error('shutdown must prevent exchange')
          },
        },
      },
    })
    let answered = false
    const opening = action
      .run(fixture.ref, {
        notify: (message) => {
          notices.push(message)
        },
      })
      .then((response) => {
        answered = true
        return response
      })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(answered).toBe(true)
      const response = await opening
      expect(response).toContain('Waiting for the browser')
      expect(exchanged).toBe(0)
      await action.dispose()
      deliver('late-code')
      await Promise.resolve()
      expect(exchanged).toBe(0)
      expect(notices).toEqual([])
    } finally {
      await action.dispose()
      deliver('fixture-cleanup')
      await opening
      await fixture.cleanup()
    }
  })
})
