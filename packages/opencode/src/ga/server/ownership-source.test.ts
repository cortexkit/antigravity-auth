import { afterEach, expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountRepository,
  AccountRepositoryError,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  QUOTA_MANAGER_DEFAULT_TIMEOUT_MS,
  readAccountStoreAdmission,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import { placeholderSecret } from '../../common-auth-embedded/opencode2/index.js'
import {
  createGaLocalRequestPipeline,
  createGaLocationServicesFactory,
  createGaRuntimeCollaborators,
} from '../../plugin/ga-location-services.ts'
import type { LocationLogRecord } from '../../plugin/neutral-types.ts'
import * as advisoryRepositoryModule from '../../plugin/shared/advisory-repository.ts'
import { createRequestCancellation } from '../../plugin/shared/request-cancellation.ts'
import * as requestServicesModule from '../../plugin/shared/request-services.ts'
import { createLocationRuntime } from '../../plugin/shared/runtime.ts'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
} from '../../plugin/vault-custody.ts'
import {
  createGaRawSender,
  type GaHttpRequestEvent,
  GaRequestOwnership,
  type GaSendInput,
  gaCatalogModels,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from './index.ts'

function successfulQuotaSummary(): Response {
  return Response.json({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly',
            window: 'weekly',
            remainingFraction: 0.5,
            resetTime: '2030-01-01T00:00:00Z',
          },
        ],
      },
    ],
  })
}

function createCleanupClocks() {
  const started = performance.now()
  const phases: {
    phase: string
    startedMs: number
    endedMs?: number
    failed?: boolean
  }[] = []
  let finished = false
  let failed = false
  return {
    finish: () => {
      finished = true
    },
    fail: () => {
      failed = true
    },
    snapshot: () => ({
      elapsedMs: performance.now() - started,
      finished,
      failed,
      pending: phases
        .filter((phase) => phase.endedMs === undefined)
        .map((phase) => phase.phase),
      phases: phases.map((phase) => ({
        ...phase,
        durationMs:
          (phase.endedMs ?? performance.now() - started) - phase.startedMs,
      })),
    }),
    async measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const entry: (typeof phases)[number] = {
        phase,
        startedMs: performance.now() - started,
      }
      phases.push(entry)
      try {
        return await work()
      } catch (error) {
        failed = true
        entry.failed = true
        throw error
      } finally {
        entry.endedMs = performance.now() - started
      }
    },
  }
}

interface OwnedFixture {
  name: string
  bound: number
  clocks: ReturnType<typeof createCleanupClocks>
  restores: (() => void)[]
  completion: Promise<void>
  settled: boolean
  closing: boolean
  finalized: boolean
  error?: unknown
  cleanupErrors: unknown[]
  cancelled: Error
  abort(): void
  requestSignal(timeoutMs?: number, signal?: AbortSignal): AbortSignal
  step<T>(phase: string, work: () => Promise<T>): Promise<T>
}

let currentFixture: OwnedFixture | undefined
let unsettledFixture: OwnedFixture | undefined

function finishFixture(fixture: OwnedFixture) {
  if (fixture.finalized) return
  fixture.finalized = true
  for (const restore of fixture.restores.splice(0).reverse()) {
    try {
      restore()
    } catch (error) {
      fixture.cleanupErrors.push(error)
    }
  }
  if (unsettledFixture === fixture) unsettledFixture = undefined
}

async function disposeFixture(
  fixture: OwnedFixture,
  resources: [string, () => Promise<unknown>][],
) {
  const errors: unknown[] = []
  for (const [phase, dispose] of resources) {
    try {
      await fixture.clocks.measure(phase, dispose)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'Owned fixture cleanup failed')
}

function ownedTest(
  name: string,
  bound: number,
  work: (fixture: OwnedFixture) => Promise<void>,
) {
  return () => {
    if (unsettledFixture)
      throw new Error(
        `Previous fixture still owns its work: ${unsettledFixture.name}`,
      )
    const controller = new AbortController()
    const fixture: OwnedFixture = {
      name,
      bound,
      clocks: createCleanupClocks(),
      restores: [],
      completion: Promise.resolve(),
      settled: false,
      closing: false,
      finalized: false,
      cleanupErrors: [],
      cancelled: new Error('Ownership fixture timed out'),
      abort() {
        fixture.closing = true
        controller.abort(fixture.cancelled)
      },
      requestSignal(timeoutMs, signal) {
        const cancellation = createRequestCancellation([
          controller.signal,
          ...(signal ? [signal] : []),
          ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : []),
        ])
        fixture.restores.push(() => cancellation.release())
        return cancellation.signal
      },
      async step<T>(phase: string, operation: () => Promise<T>): Promise<T> {
        if (fixture.closing) throw fixture.cancelled
        const result = await fixture.clocks.measure(phase, operation)
        // Return an acquired resource to its owner even after cancellation so
        // finally can dispose it. Admission closes before the next step starts.
        return result
      },
    }
    currentFixture = fixture
    unsettledFixture = fixture
    const pending = Promise.resolve().then(() => work(fixture))
    fixture.completion = pending.then(
      () => {
        fixture.settled = true
        fixture.clocks.finish()
      },
      (error: unknown) => {
        fixture.error = error
        fixture.settled = true
        fixture.clocks.fail()
        fixture.clocks.finish()
      },
    )
    return pending.catch((error: unknown) => {
      // Bun has already reported the timeout. Only the fixture's own stop
      // reason is absorbed; genuine setup, assertion and cleanup errors remain failures.
      if (fixture.closing && error === fixture.cancelled) return
      throw error
    })
  }
}

afterEach(async () => {
  const fixture = currentFixture
  currentFixture = undefined
  if (!fixture) return
  const timedOut = !fixture.settled
  if (
    timedOut ||
    fixture.error !== undefined ||
    fixture.cleanupErrors.length > 0
  ) {
    console.error(
      'OWNERSHIP-CLEANUP-CLOCKS',
      JSON.stringify({ fixture: fixture.name, ...fixture.clocks.snapshot() }),
    )
  }
  if (timedOut) fixture.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fixture.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          console.error(
            'OWNERSHIP-FIXTURE-DRAIN-FAILED',
            JSON.stringify({
              fixture: fixture.name,
              bound: fixture.bound,
              ...fixture.clocks.snapshot(),
            }),
          )
          reject(
            new Error(
              `Owned fixture did not settle within ${fixture.bound}ms: ${fixture.name}`,
            ),
          )
        }, fixture.bound)
      }),
    ])
  } catch (error) {
    // Keep the admission fence closed until late work and its path restoration
    // finish; a later test must never inherit a still-running fixture's paths.
    void fixture.completion.then(() => {
      finishFixture(fixture)
      if (fixture.cleanupErrors.length > 0)
        console.error(
          'OWNERSHIP-FIXTURE-LATE-RESTORE-FAILED',
          JSON.stringify({
            fixture: fixture.name,
            errors: fixture.cleanupErrors.length,
          }),
        )
    })
    throw error
  } finally {
    clearTimeout(timer)
  }
  finishFixture(fixture)
  if (fixture.cleanupErrors.length > 0)
    throw new AggregateError(
      fixture.cleanupErrors,
      'Fixture restoration failed',
    )
  if (
    timedOut &&
    fixture.error !== undefined &&
    fixture.error !== fixture.cancelled
  ) {
    throw new AggregateError(
      [fixture.error],
      `Fixture failed while draining: ${fixture.name}`,
    )
  }
}, 10_000)

it(
  'selects pool then approved vault under the same prepared placeholder through existing source seams',
  ownedTest('source-selection', 5_000, async (fixture) => {
    const clocks = fixture.clocks
    const sourceClockRestores = fixture.restores
    const ownerSpy = spyOn(
      advisoryRepositoryModule,
      'createAdvisoryRepositoryOwner',
    )
    sourceClockRestores.push(() => ownerSpy.mockRestore())
    const originalExecutor = requestServicesModule.createRequestExecutor
    const executorSpy = spyOn(
      requestServicesModule,
      'createRequestExecutor',
    ).mockImplementation((deps) => {
      const executor = originalExecutor(deps)
      const dispose = executor.dispose
      executor.dispose = () =>
        clocks.measure(`executor.${deps.credentials.domain}.dispose`, dispose)
      return executor
    })
    sourceClockRestores.push(() => executorSpy.mockRestore())
    const root = mkdtempSync(join(tmpdir(), 'ga-ownership-source-'))
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    fixture.restores.push(() => {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
      rmSync(root, { recursive: true, force: true })
    })
    let mode: 'local' | 'custody' = 'local'
    let localCalls = 0
    let vaultAdmissions = 0
    let storeLoads = 0
    let tokenRefreshes = 0
    const sends: GaSendInput[] = []
    const accounts: Parameters<
      typeof createGaLocalRequestPipeline
    >[0]['accounts'] = { current: null, quotaLogger: null }
    const directory = join(root, 'location')
    const legacyPath = join(directory, 'antigravity-accounts.json')
    const route = {
      routeId: 'vault-route',
      credentialId: 'vault-credential',
      accountIdentity: 'vault-identity',
      label: 'Vault account',
    }
    const factory = createGaLocationServicesFactory({
      loadStoreModules: () => {
        storeLoads++
        return fixture.step('loadStoreModules', loadCommonAuthStoreModules)
      },
      resolveAccountFile: () => legacyPath,
      now: Date.now,
      runtime: (input) =>
        createGaRuntimeCollaborators({
          ...input,
          accounts,
          now: Date.now,
        }),
      createPipeline: async (input) => {
        const pipeline = await createGaLocalRequestPipeline({
          ...input,
          accounts,
        })
        const owner = ownerSpy.mock.results.at(-1)
        if (owner?.type !== 'return' || !owner.value)
          throw new Error('advisory owner unavailable')
        const drain = owner.value.drain
        const drainSpy = spyOn(owner.value, 'drain').mockImplementation(() =>
          clocks.measure('advisory.drain', drain),
        )
        sourceClockRestores.push(() => drainSpy.mockRestore())
        const manager = accounts.current
        if (!manager) throw new Error('request manager unavailable')
        const disposeManager = manager.dispose.bind(manager)
        const managerSpy = spyOn(manager, 'dispose').mockImplementation(() =>
          clocks.measure('manager.dispose', disposeManager),
        )
        sourceClockRestores.push(() => managerSpy.mockRestore())
        return {
          ...pipeline,
          dispose: () =>
            clocks.measure('localPipeline.dispose', () => pipeline.dispose()),
          execute: async (job, context) => {
            localCalls++
            return pipeline.execute(job, context)
          },
        }
      },
      custody: () => ({
        readMode: async () => ({ ok: true, record: { version: 1, mode } }),
        custodySource: async () => ({
          refresh: async () => undefined,
          routes: () => [route],
          admit: async () => {
            vaultAdmissions++
            return {
              ...route,
              recordVersion: 1,
              accessToken: 'approved-vault-access',
              projectId: 'approved-vault-project',
              expiresAtMs: null,
            }
          },
          reportServedStatus: async () => false,
          attribution: () => ({ ...route, recordVersion: 1 }),
          commitState: async () => ({ status: 'unchanged' as const }),
          send: async () => {
            throw new Error('composed sender required')
          },
        }),
        readState: async () => ({ schemaVersion: 1, accounts: {} }),
        menuSection: () => ({
          id: 'vault',
          title: 'Vault',
          build: () => ({ lines: [], actions: [] }),
        }),
        dispose: async () => {},
      }),
    })
    let services: Awaited<ReturnType<typeof factory>> | undefined
    let runtime: Awaited<ReturnType<typeof createLocationRuntime>> | undefined
    let bridge: Awaited<ReturnType<typeof startGaLoopbackBridge>> | undefined
    try {
      mkdirSync(join(directory, '.opencode'), { recursive: true })
      writeFileSync(
        join(directory, '.opencode', 'antigravity.json'),
        JSON.stringify({
          background_quota_refresh: false,
          proactive_token_refresh: false,
          request_jitter_max_ms: 0,
        }),
      )
      const modules = await fixture.step(
        'loadStoreModules',
        loadCommonAuthStoreModules,
      )
      await fixture.step('initializeFreshAccountStore', () =>
        initializeFreshAccountStore(modules, { legacyPath, now: Date.now }),
      )
      const admission = await fixture.step('readAccountStoreAdmission', () =>
        readAccountStoreAdmission(legacyPath, modules, Date.now),
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const seed = await fixture.step('repository.create', async () =>
        createAccountRepositoryFactory(modules)({
          paths: admission.paths,
          now: Date.now,
          exchange: async () => {
            throw new Error('seed cannot refresh')
          },
        }),
      )
      try {
        await fixture.step('seed.login', () =>
          seed.login({
            id: crypto.randomUUID(),
            refreshToken: 'pool-refresh',
            metadata: {
              addedAt: 1,
              lastUsed: 1,
              managedProjectId: 'pool-project',
            },
          }),
        )
      } finally {
        await fixture.clocks.measure('seed.dispose', () => seed.dispose())
      }
      const repositoryPrototype = Object.getPrototypeOf(
        seed,
      ) as AccountRepository
      const disposeRepository = repositoryPrototype.dispose
      const repositorySpy = spyOn(
        repositoryPrototype,
        'dispose',
      ).mockImplementation(function (this: AccountRepository) {
        return clocks.measure('repository.dispose', () =>
          disposeRepository.call(this),
        )
      })
      sourceClockRestores.push(() => repositorySpy.mockRestore())
      services = await fixture.step('factory', () =>
        factory({
          directory,
          overrides: {
            // Teardown drains successful-send quota work, so stub its transport as
            // well as request sends instead of contacting the live quota service.
            quotaFetch: async () => successfulQuotaSummary(),
            refreshAccessToken: async (refresh) => {
              tokenRefreshes++
              return {
                access: 'pool-access',
                refresh,
                expires: Date.now() + 3_600_000,
              }
            },
            send: async (input) => {
              sends.push(input)
              return new Response(
                'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"vault reply"}]},"finishReason":"STOP"}]}}\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              )
            },
          },
        }),
      )
      runtime = await fixture.step(
        'runtime.create',
        createLocationRuntime.bind(undefined, {
          ...services.runtime,
          directory,
        }),
      )
      const disposeQuota = runtime.quotaManager.dispose
      const quotaSpy = spyOn(
        runtime.quotaManager,
        'dispose',
      ).mockImplementation(() =>
        clocks.measure('quotaManager.dispose', disposeQuota),
      )
      sourceClockRestores.push(() => quotaSpy.mockRestore())
      const serving = await fixture.step(
        'start',
        services.start.bind(services, {
          runtime,
          generation: 'ownership-source',
          send: createGaRawSender(),
          notify: () => null,
          isConnected: () => false,
        }),
      )
      bridge = await fixture.step('bridge.start', () =>
        startGaLoopbackBridge({
          execute: serving.execute,
          send: createGaRawSender(),
        }),
      )
      const ownership = new GaRequestOwnership()
      const catalog = gaCatalogModels()
      const dispatch = async (
        kind: GaHttpRequestEvent['kind'],
        modelID: string,
      ) => {
        const event: GaHttpRequestEvent = {
          sessionID: 'ses_source',
          kind,
          model: { id: modelID, providerID: 'google' },
          request: new Request(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers: { 'x-goog-api-key': placeholderSecret('google') },
              body: JSON.stringify({
                contents: [
                  { role: 'user', parts: [{ text: 'source selection' }] },
                ],
              }),
            },
          ),
        }
        if (!bridge) throw new Error('bridge unavailable')
        await rewriteGaHttpRequest(event, {
          bridge,
          ownership,
          isRegisteredModel: (id) => catalog.has(id),
          env: {},
        })
        expect(event.request.url.startsWith(bridge.origin)).toBe(true)
        expect(event.request.headers.has('x-goog-api-key')).toBe(false)
        return fixture.step('request.dispatch', () =>
          fetch(event.request, {
            signal: fixture.requestSignal(undefined, event.request.signal),
          }),
        )
      }
      const refuseCustomOrigin = async () => {
        if (!bridge) throw new Error('bridge unavailable')
        const before = {
          storeLoads,
          tokenRefreshes,
          localCalls,
          vaultAdmissions,
        }
        const sendCount = sends.length
        const original = new Request(
          'http://127.0.0.1:1234/direct/v1/models/antigravity-gemini-3.5-flash:streamGenerateContent',
          {
            method: 'POST',
            headers: { 'x-goog-api-key': placeholderSecret('google') },
            body: JSON.stringify({ contents: [] }),
          },
        )
        const event: GaHttpRequestEvent = {
          sessionID: 'ses_custom_origin',
          kind: 'primary',
          model: { id: 'antigravity-gemini-3.5-flash', providerID: 'google' },
          request: original,
        }
        await expect(
          rewriteGaHttpRequest(event, {
            bridge,
            ownership,
            isRegisteredModel: (id) => catalog.has(id),
            env: {},
          }),
        ).rejects.toThrow(
          'Antigravity pool requests need the default Google base URL. Remove the custom baseURL from the Google provider settings.',
        )
        expect({
          storeLoads,
          tokenRefreshes,
          localCalls,
          vaultAdmissions,
        }).toEqual(before)
        expect(sends).toHaveLength(sendCount)
        expect(bridge.pendingJobs()).toBe(0)
        expect(event.request).toBe(original)
      }
      await refuseCustomOrigin()
      const pool = await dispatch('primary', 'antigravity-gemini-3.5-flash')
      expect(pool.status).toBe(200)
      await fixture.step('response.pool.body', () => pool.text())
      expect(localCalls).toBe(1)
      expect(storeLoads).toBeGreaterThan(0)
      expect(tokenRefreshes).toBe(1)
      expect(vaultAdmissions).toBe(0)
      expect(sends[0]?.auth.access).toBe('pool-access')
      expect(sends[0]?.envelope.project).toBe('pool-project')
      await fixture.step('accounts.flush.before-switch', async () =>
        accounts.current?.flushSaveToDisk(),
      )
      mode = 'custody'
      await refuseCustomOrigin()
      const vault = await dispatch('primary', 'antigravity-gemini-3.5-flash')
      expect(vault.status).toBe(200)
      expect(
        await fixture.step('response.vault.body', () => vault.text()),
      ).toContain('vault reply')
      expect(localCalls).toBe(1)
      expect(vaultAdmissions).toBe(1)
      expect(sends[1]?.auth.access).toBe('approved-vault-access')
      expect(sends[1]?.envelope.project).toBe('approved-vault-project')
      expect(JSON.stringify(sends)).not.toContain(placeholderSecret('google'))

      const beforeRetired = sends.length
      const retired = await dispatch('generate', 'antigravity-gemini-3.1-pro')
      expect(retired.status).toBe(412)
      expect(await retired.json()).toEqual({
        error: {
          code: 412,
          status: 'FAILED_PRECONDITION',
          message:
            'This Antigravity model is no longer offered. Choose another model.',
        },
      })
      expect(sends).toHaveLength(beforeRetired)
      expect(vaultAdmissions).toBe(1)
      const title = await dispatch('title', 'antigravity-gemini-3.1-pro')
      expect(title.status).toBe(200)
      await fixture.step('response.title.body', () => title.text())
      expect(sends.at(-1)?.envelope.model).toBe('gemini-3.5-flash-extra-low')
      expect(sends.at(-1)?.kind).toBe('title')
    } catch (error) {
      clocks.fail()
      throw error
    } finally {
      await disposeFixture(fixture, [
        ['bridge.dispose', async () => bridge?.dispose()],
        ['runtime.dispose', async () => runtime?.dispose()],
        ['services.dispose', async () => services?.dispose()],
      ])
    }
  }),
)

for (const scenario of [
  'refusal',
  'required-failure',
  'hung-quota',
  'expired-quota',
] as const) {
  const requiredFailure = scenario === 'required-failure'
  const hungQuota = scenario === 'hung-quota'
  const expiredQuota = scenario === 'expired-quota'
  it(
    expiredQuota
      ? 'successful-send advisory quota skips an expired credential without refresh or network work'
      : hungQuota
        ? 'disposal cancels a never-resolving successful-send quota fetch within the existing bound'
        : requiredFailure
          ? 'preserves a required credential failure in the same flush as a refused advisory write'
          : 'absorbs refused advisory work after a real pool request switches to vault',
    ownedTest(`advisory-${scenario}`, 10_000, async (fixture) => {
      const root = mkdtempSync(join(tmpdir(), 'ga-advisory-source-'))
      const previous = process.env.OPENCODE_CONFIG_DIR
      process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
      fixture.restores.push(() => {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previous
        rmSync(root, { recursive: true, force: true })
      })
      const directory = join(root, 'location')
      const legacyPath = join(directory, 'antigravity-accounts.json')
      const accounts: Parameters<
        typeof createGaLocalRequestPipeline
      >[0]['accounts'] = {
        current: null,
        quotaLogger: null,
      }
      let mode: 'local' | 'custody' = 'local'
      let localCalls = 0
      let vaultAdmissions = 0
      const sends: GaSendInput[] = []
      const quotaReached = Promise.withResolvers<void>()
      const quotaGate = Promise.withResolvers<void>()
      const quotaRecorded = Promise.withResolvers<void>()
      const quotaSkipped = Promise.withResolvers<void>()
      const quotaAuthorizationReached = Promise.withResolvers<void>()
      const quotaAuthorizationGate = Promise.withResolvers<void>()
      let quotaCalls = 0
      let quotaReleased = false
      let quotaTransportSettled = false
      let quotaSignal: AbortSignal | undefined
      let disposeLocal: (() => Promise<void>) | undefined
      let recordQuotaAttempts = 0
      let underlyingQuotaWrites = 0
      let failRequiredRefresh = false
      let tokenRefreshes = 0
      let quotaNow = Date.now()
      const requiredError = new Error('required credential persistence failed')
      const refusals: unknown[] = []
      const unhandled: unknown[] = []
      const phases: { operation: string; error: unknown }[] = []
      const fileEvents: string[] = []
      const logs: LocationLogRecord[] = []
      let watcher: ReturnType<typeof watch> | undefined
      let beforeFiles: Record<string, string> | undefined
      let afterFiles: Record<string, string> | undefined
      let beforeAdvisoryFiles: Record<string, string> | undefined
      let afterAdvisoryFiles: Record<string, string> | undefined
      const snapshot = (path: string): Record<string, string> => {
        const files: Record<string, string> = {}
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name)
          if (entry.isDirectory()) Object.assign(files, snapshot(child))
          else files[child] = readFileSync(child).toString('base64')
        }
        return files
      }
      const capture = async (
        operation: string,
        work: () => Promise<unknown>,
      ) => {
        try {
          await fixture.clocks.measure(operation, work)
        } catch (error) {
          phases.push({ operation, error })
          if (operation.endsWith('.dispose')) fixture.cleanupErrors.push(error)
        }
      }
      const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
      const deadline = async <T>(
        name: string,
        work: Promise<T>,
      ): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${name} was not reached`)),
                3_000,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      const route = {
        routeId: 'vault-route',
        credentialId: 'vault-credential',
        accountIdentity: 'vault-identity',
        label: 'Vault account',
      }
      const factory = createGaLocationServicesFactory({
        loadStoreModules: async () => {
          const modules = await fixture.step(
            'loadStoreModules',
            loadCommonAuthStoreModules,
          )
          return {
            ...modules,
            store: {
              ...modules.store,
              openPoolStore: (options) => {
                const store = modules.store.openPoolStore(options)
                const refresh: typeof store.refresh = async (...args) => {
                  if (failRequiredRefresh) throw requiredError
                  return store.refresh(...args)
                }
                const recordQuota: typeof store.recordQuota = async (
                  ...args
                ) => {
                  underlyingQuotaWrites++
                  return store.recordQuota(...args)
                }
                return new Proxy(store, {
                  get(target, key) {
                    const value: unknown = Reflect.get(target, key, target)
                    return key === 'refresh'
                      ? refresh
                      : key === 'recordQuota'
                        ? recordQuota
                        : typeof value === 'function'
                          ? value.bind(target)
                          : value
                  },
                })
              },
            },
          }
        },
        resolveAccountFile: () => legacyPath,
        now: Date.now,
        runtime: (input) => {
          const collaborators = createGaRuntimeCollaborators({
            ...input,
            accounts,
            now: () => quotaNow,
          })
          return {
            ...collaborators,
            fetchAccountQuota: async (...args) => {
              if (expiredQuota) {
                quotaAuthorizationReached.resolve()
                await quotaAuthorizationGate.promise
              }
              return collaborators.fetchAccountQuota(...args)
            },
          }
        },
        createPipeline: async (input) => {
          // Observe quota writes from the request pipeline while retaining the
          // supplied repository's source-authority check. A direct test call would
          // not prove that successful-send quota work reached that check.
          const recordQuota: AccountRepository['recordQuota'] = async (
            ...args
          ) => {
            recordQuotaAttempts++
            try {
              return await input.repository.recordQuota(...args)
            } catch (error) {
              refusals.push(error)
              throw error
            } finally {
              quotaRecorded.resolve()
            }
          }
          const repository = new Proxy(input.repository, {
            get(target, key) {
              return key === 'recordQuota'
                ? recordQuota
                : Reflect.get(target, key)
            },
          })
          const pipeline = await createGaLocalRequestPipeline({
            ...input,
            repository,
            accounts,
          })
          disposeLocal = () => pipeline.dispose()
          return {
            ...pipeline,
            execute: async (job, context) => {
              localCalls++
              return pipeline.execute(job, context)
            },
          }
        },
        custody: () => ({
          readMode: async () => ({ ok: true, record: { version: 1, mode } }),
          custodySource: async () => ({
            refresh: async () => undefined,
            routes: () => [route],
            admit: async () => {
              vaultAdmissions++
              return {
                ...route,
                recordVersion: 1,
                accessToken: 'approved-vault-access',
                projectId: 'approved-vault-project',
                expiresAtMs: null,
              }
            },
            reportServedStatus: async () => false,
            attribution: () => ({ ...route, recordVersion: 1 }),
            commitState: async () => ({ status: 'unchanged' as const }),
            send: async () => {
              throw new Error('composed sender required')
            },
          }),
          readState: async () => ({ schemaVersion: 1, accounts: {} }),
          menuSection: () => ({
            id: 'vault',
            title: 'Vault',
            build: () => ({ lines: [], actions: [] }),
          }),
          dispose: async () => {},
        }),
      })
      let services: Awaited<ReturnType<typeof factory>> | undefined
      let runtime: Awaited<ReturnType<typeof createLocationRuntime>> | undefined
      let bridge: Awaited<ReturnType<typeof startGaLoopbackBridge>> | undefined
      try {
        mkdirSync(join(directory, '.opencode'), { recursive: true })
        writeFileSync(
          join(directory, '.opencode', 'antigravity.json'),
          JSON.stringify({
            background_quota_refresh: false,
            proactive_token_refresh: false,
            quota_refresh_interval_minutes: 30,
            debug_tui: true,
            request_jitter_max_ms: 0,
          }),
        )
        const modules = await fixture.step(
          'loadStoreModules',
          loadCommonAuthStoreModules,
        )
        await fixture.step('initializeFreshAccountStore', () =>
          initializeFreshAccountStore(modules, { legacyPath, now: Date.now }),
        )
        const admission = await fixture.step('readAccountStoreAdmission', () =>
          readAccountStoreAdmission(legacyPath, modules, Date.now),
        )
        if (admission.status !== 'active') throw new Error(admission.status)
        const seed = await fixture.step('repository.create', async () =>
          createAccountRepositoryFactory(modules)({
            paths: admission.paths,
            now: Date.now,
            exchange: async () => {
              throw new Error('seed cannot refresh')
            },
          }),
        )
        try {
          await fixture.step('seed.login', () =>
            seed.login({
              id: crypto.randomUUID(),
              refreshToken: 'pool-refresh',
              metadata: {
                addedAt: 1,
                lastUsed: 1,
                managedProjectId: 'pool-project',
              },
            }),
          )
        } finally {
          await capture('seed.dispose', () =>
            fixture.clocks.measure('seed.dispose', () => seed.dispose()),
          )
        }
        services = await fixture.step('factory', () =>
          factory({
            directory,
            overrides: {
              refreshAccessToken: async (refresh) => {
                tokenRefreshes++
                return {
                  access: 'pool-access',
                  refresh,
                  expires: Date.now() + 3_600_000,
                }
              },
              send: async (input) => {
                sends.push(input)
                if (expiredQuota) quotaNow = Date.now() + 7_200_000
                return new Response(
                  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"source reply"}]},"finishReason":"STOP"}]}}\n\n',
                  { headers: { 'content-type': 'text/event-stream' } },
                )
              },
              quotaFetch: async (url, init, extra) => {
                quotaCalls++
                expect(url).toEndWith('/v1internal:retrieveUserQuotaSummary')
                expect(new Headers(init.headers).get('authorization')).toBe(
                  'Bearer pool-access',
                )
                expect(JSON.parse(String(init.body)).project).toBe(
                  'pool-project',
                )
                quotaSignal = extra.signal ?? undefined
                quotaReached.resolve()
                if (expiredQuota) return successfulQuotaSummary()
                await quotaGate.promise
                quotaTransportSettled = true
                return successfulQuotaSummary()
              },
            },
          }),
        )
        runtime = await fixture.step(
          'runtime.create',
          createLocationRuntime.bind(undefined, {
            ...services.runtime,
            directory,
            logSink: (record) => {
              logs.push(record)
              if (record.message === 'advisory-quota-skipped-refresh-needed')
                quotaSkipped.resolve()
            },
          }),
        )
        runtime.logger.setLevel('debug')
        const serving = await fixture.step(
          'start',
          services.start.bind(services, {
            runtime,
            generation: 'advisory-source',
            send: createGaRawSender(),
            notify: () => null,
            isConnected: () => false,
          }),
        )
        bridge = await fixture.step('bridge.start', () =>
          startGaLoopbackBridge({
            execute: serving.execute,
            send: createGaRawSender(),
          }),
        )
        const ownership = new GaRequestOwnership()
        const catalog = gaCatalogModels()
        const dispatch = async () => {
          if (!bridge) throw new Error('bridge unavailable')
          const event: GaHttpRequestEvent = {
            sessionID: 'ses_advisory_source',
            kind: 'primary',
            model: { id: 'antigravity-gemini-3.5-flash', providerID: 'google' },
            request: new Request(
              'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse',
              {
                method: 'POST',
                headers: { 'x-goog-api-key': placeholderSecret('google') },
                body: JSON.stringify({
                  contents: [
                    { role: 'user', parts: [{ text: 'source selection' }] },
                  ],
                }),
                signal: fixture.requestSignal(3_000),
              },
            ),
          }
          await rewriteGaHttpRequest(event, {
            bridge,
            ownership,
            isRegisteredModel: (id) => catalog.has(id),
            env: {},
          })
          expect(event.request.url.startsWith(bridge.origin)).toBe(true)
          expect(event.request.headers.has('x-goog-api-key')).toBe(false)
          return fixture.step('request.dispatch', () =>
            fetch(event.request, {
              signal: fixture.requestSignal(undefined, event.request.signal),
            }),
          )
        }
        const reply = dispatch()
        if (!expiredQuota)
          await deadline('quota summary transport', quotaReached.promise)
        else
          await deadline(
            'quota authorization',
            quotaAuthorizationReached.promise,
          )
        const pool = await reply
        expect(pool.status).toBe(200)
        expect(quotaReleased).toBe(false)
        if (!expiredQuota) expect(quotaTransportSettled).toBe(false)
        expect(
          await fixture.step('response.pool.body', () => pool.text()),
        ).toContain('source reply')
        expect(pool.bodyUsed).toBe(true)
        expect(quotaReleased).toBe(false)
        if (!expiredQuota) expect(quotaTransportSettled).toBe(false)
        if (!expiredQuota) expect(quotaCalls).toBe(1)
        expect(sends[0]?.auth.access).toBe('pool-access')
        expect(sends[0]?.envelope.project).toBe('pool-project')
        await capture('accounts.flush.before-switch', async () =>
          accounts.current?.flushSaveToDisk(),
        )
        if (expiredQuota) {
          beforeAdvisoryFiles = snapshot(directory)
          expect(beforeAdvisoryFiles[admission.paths.configPath]).toBeDefined()
          expect(beforeAdvisoryFiles[admission.paths.statePath]).toBeDefined()
          quotaAuthorizationGate.resolve()
          await capture('advisory.skip-refresh-needed', () =>
            deadline('advisory skip', quotaSkipped.promise),
          )
        }
        if (hungQuota || expiredQuota) {
          const dispose = disposeLocal
          if (!dispose) throw new Error('local pipeline unavailable')
          const started = performance.now()
          await capture('pipeline.dispose.advisory-quota', () =>
            deadline('pipeline disposal with hung quota', dispose()),
          )
          expect(performance.now() - started).toBeLessThan(
            QUOTA_MANAGER_DEFAULT_TIMEOUT_MS,
          )
          if (hungQuota) {
            expect(quotaSignal?.aborted).toBe(true)
            expect(quotaSignal?.reason).toMatchObject({
              message: 'The Antigravity request executor is disposed',
            })
          }
          if (expiredQuota) {
            afterAdvisoryFiles = snapshot(directory)
            if (!beforeAdvisoryFiles)
              throw new Error('advisory file snapshot unavailable')
            expect(afterAdvisoryFiles).toEqual(beforeAdvisoryFiles)
            expect(tokenRefreshes).toBe(1)
          }
          expect(quotaReleased).toBe(false)
          expect(quotaTransportSettled).toBe(false)
        }
        if (requiredFailure) {
          const manager = accounts.current
          const account = manager?.getAccounts()[0]
          if (!manager || !account) throw new Error('local account unavailable')
          // Fail the credential store before switching authority. The repository
          // must report this same failure when writes are flushed after the switch.
          failRequiredRefresh = true
          await capture('required.refresh', () =>
            manager.refreshAccount(account),
          )
        }
        beforeFiles = snapshot(directory)
        expect(beforeFiles[admission.paths.configPath]).toBeDefined()
        expect(beforeFiles[admission.paths.statePath]).toBeDefined()
        // Watch the directory as well as comparing bytes: atomic temp files may disappear.
        watcher = watch(directory, { recursive: true }, (event, filename) => {
          fileEvents.push(`${event}:${filename}`)
        })
        watcher.on('error', (error) =>
          phases.push({ operation: 'files.watch', error }),
        )
        mode = 'custody'
        if (!hungQuota && !expiredQuota) {
          quotaReleased = true
          quotaGate.resolve()
          await capture('advisory.recordQuota.settled', () =>
            deadline('advisory recordQuota', quotaRecorded.promise),
          )
        }
        await turn()
        await capture('accounts.flush.after-switch', async () =>
          accounts.current?.flushSaveToDisk(),
        )
        const vault = await dispatch()
        expect(vault.status).toBe(200)
        expect(
          await fixture.step('response.vault.body', () => vault.text()),
        ).toContain('source reply')
        expect(localCalls).toBe(1)
        expect(vaultAdmissions).toBe(1)
        expect(sends).toHaveLength(2)
        expect(sends[1]?.auth.access).toBe('approved-vault-access')
        expect(sends[1]?.envelope.project).toBe('approved-vault-project')
      } finally {
        quotaAuthorizationGate.resolve()
        quotaReleased = true
        quotaGate.resolve()
        await capture('bridge.dispose', async () => bridge?.dispose())
        await capture('runtime.dispose', async () => runtime?.dispose())
        await capture('services.dispose', async () => services?.dispose())
        await turn()
        try {
          if (beforeFiles) afterFiles = snapshot(directory)
        } catch (error) {
          phases.push({ operation: 'files.snapshot.after', error })
        }
        watcher?.close()
        process.removeListener('unhandledRejection', onUnhandled)
        const describeError = (error: unknown): unknown =>
          error instanceof AggregateError
            ? {
                type: error.name,
                message: error.message,
                errors: error.errors.map(describeError),
              }
            : error instanceof Error
              ? { type: error.name, message: error.message }
              : String(error)
        console.info(
          'ADVISORY-REFUSAL',
          JSON.stringify({
            quotaCalls,
            scenario,
            recordQuotaAttempts,
            underlyingQuotaWrites,
            refusals: refusals.map(describeError),
            unhandled: unhandled.map(describeError),
            phases: phases.map(({ operation, error }) => ({
              operation,
              error: describeError(error),
            })),
            fileEvents,
            filesUnchanged:
              beforeFiles !== undefined &&
              JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
            ...(expiredQuota
              ? {
                  advisoryFilesUnchanged:
                    JSON.stringify(beforeAdvisoryFiles) ===
                    JSON.stringify(afterAdvisoryFiles),
                }
              : {}),
          }),
        )
      }
      expect(recordQuotaAttempts).toBe(hungQuota || expiredQuota ? 0 : 1)
      if (expiredQuota) {
        expect(quotaCalls).toBe(0)
        expect(
          logs
            .filter(
              ({ message }) =>
                message === 'advisory-quota-skipped-refresh-needed',
            )
            .map(({ message, extra }) => ({ message, extra })),
        ).toEqual([
          {
            message: 'advisory-quota-skipped-refresh-needed',
            extra: undefined,
          },
        ])
      }
      expect(underlyingQuotaWrites).toBe(0)
      expect(refusals).toHaveLength(hungQuota || expiredQuota ? 0 : 1)
      if (!hungQuota && !expiredQuota) {
        expect(refusals[0]).toBeInstanceOf(Error)
        expect((refusals[0] as Error).message).toBe(VAULT_ACCOUNT_REMEDY)
      }
      expect(unhandled).toEqual([])
      if (requiredFailure) {
        expect(phases.map(({ operation }) => operation)).toEqual([
          'required.refresh',
          'accounts.flush.after-switch',
        ])
        const direct = phases[0]?.error
        const flushed = phases[1]?.error
        expect(direct).toBeInstanceOf(AccountRepositoryError)
        expect(flushed).toBeInstanceOf(Error)
        expect((flushed as Error).name).toBe('AccountManagerPersistError')
        if (
          !(direct instanceof AccountRepositoryError) ||
          !(flushed instanceof Error)
        ) {
          throw new Error('required credential failure was not preserved')
        }
        expect(direct.failure.message).toContain(requiredError.message)
        expect(Reflect.get(flushed, 'failure')).toBe(direct.failure)
        expect(Reflect.get(flushed, 'report')).toMatchObject({
          failures: [direct.failure],
        })
      } else {
        expect(phases).toEqual([])
      }
      expect(
        logs.filter(
          (record) => record.message === 'post-response-local-write-refused',
        ),
      ).toEqual(
        hungQuota || expiredQuota
          ? []
          : [
              {
                service: 'antigravity.request',
                level: 'debug',
                message: 'post-response-local-write-refused',
                extra: { count: 1 },
              },
            ],
      )
      expect(fileEvents).toEqual([])
      expect(afterFiles).toEqual(beforeFiles)
    }),
    10_000,
  )
}

for (const source of ['cold local', 'unavailable vault'] as const) {
  it(
    `rejects retired non-title requests before ${source} construction through loopback`,
    ownedTest(`retired-${source}`, 5_000, async (fixture) => {
      // The vault rejects enrollment-token paths with writable shared ancestors.
      // A test runner may put TMPDIR under such a node_modules directory.
      const root = realpathSync(
        mkdtempSync(
          join(
            process.platform === 'win32' ? tmpdir() : '/tmp',
            'ga-retired-source-',
          ),
        ),
      )
      const directory = join(root, 'location')
      const accountFile = join(directory, 'antigravity-accounts.json')
      const missingConnection = join(root, 'absent-connection.json')
      const previous = process.env.OPENCODE_CONFIG_DIR
      process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
      fixture.restores.push(() => {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previous
        rmSync(root, { recursive: true, force: true })
      })
      let connects = 0
      let storeLoads = 0
      let sourceLoads = 0
      let refreshFailures = 0
      let sends = 0
      let localPipelines = 0
      let hostSlotReads = 0
      const initialConnection = Promise.withResolvers<void>()
      const custody = createOpenCodeVaultCustody({
        vaultDir: join(directory, 'antigravity-auth-vault'),
        accountFile,
        reporterSource: 'direct',
        readHostSlot: async () => {
          hostSlotReads++
          throw new Error('The isolated fixture has no host credential slot')
        },
        connectionFile: () => missingConnection,
        connectEnrollment: async () => ({
          enrollPropose: async () => ({ requestId: 'synthetic-request' }),
          enrollPoll: async () => ({
            status: 'approved',
            name: OPENCODE_VAULT_ENROLLMENT_NAME,
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }),
          close() {},
        }),
        connect: async () => {
          connects++
          // The enrolled vault connector reads a missing owned file, so refresh
          // fails with the OS ENOENT rather than a fabricated admission error.
          try {
            await readFile(missingConnection)
            throw new Error('The absent connection file unexpectedly exists')
          } finally {
            initialConnection.resolve()
          }
        },
      })
      const accounts: Parameters<
        typeof createGaLocalRequestPipeline
      >[0]['accounts'] = { current: null, quotaLogger: null }
      const factory = createGaLocationServicesFactory({
        now: Date.now,
        loadStoreModules: () => {
          storeLoads++
          return fixture.step('loadStoreModules', loadCommonAuthStoreModules)
        },
        resolveAccountFile: () => accountFile,
        runtime: (input) =>
          createGaRuntimeCollaborators({ ...input, accounts, now: Date.now }),
        createPipeline: async (input) => {
          localPipelines++
          return createGaLocalRequestPipeline({ ...input, accounts })
        },
        ...(source === 'unavailable vault'
          ? {
              custody: () => ({
                ...custody,
                custodySource: async () => {
                  sourceLoads++
                  const actual = await custody.custodySource()
                  return {
                    ...actual,
                    refresh: async () => {
                      try {
                        await actual.refresh()
                      } catch (error) {
                        refreshFailures++
                        throw error
                      }
                    },
                  }
                },
              }),
            }
          : {}),
      })
      let services: Awaited<ReturnType<typeof factory>> | undefined
      let runtime: Awaited<ReturnType<typeof createLocationRuntime>> | undefined
      let bridge: Awaited<ReturnType<typeof startGaLoopbackBridge>> | undefined
      try {
        mkdirSync(join(directory, '.opencode'), { recursive: true })
        writeFileSync(
          join(directory, '.opencode', 'antigravity.json'),
          JSON.stringify({
            background_quota_refresh: false,
            proactive_token_refresh: false,
            request_jitter_max_ms: 0,
          }),
        )
        if (source === 'unavailable vault') {
          expect((await custody.requestAccess()).state).toBe('approved')
        }
        const send = async () => {
          sends++
          throw new Error('Unavailable sources cannot send')
        }
        services = await fixture.step('factory', () =>
          factory({ directory, overrides: { send } }),
        )
        runtime = await fixture.step(
          'runtime.create',
          createLocationRuntime.bind(undefined, {
            ...services.runtime,
            directory,
          }),
        )
        const serving = await fixture.step(
          'start',
          services.start.bind(services, {
            runtime,
            generation: 'retired-source',
            send,
            notify: () => null,
            isConnected: () => false,
          }),
        )
        bridge = await fixture.step('bridge.start', () =>
          startGaLoopbackBridge({ execute: serving.execute, send }),
        )
        const ownership = new GaRequestOwnership()
        const catalog = gaCatalogModels()
        const dispatch = async (
          kind: GaHttpRequestEvent['kind'],
          modelID: string,
        ) => {
          if (!bridge) throw new Error('Bridge not started')
          const event: GaHttpRequestEvent = {
            sessionID: 'ses_retired_source',
            kind,
            model: { id: modelID, providerID: 'google' },
            request: new Request(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`,
              {
                method: 'POST',
                headers: { 'x-goog-api-key': placeholderSecret('google') },
                body: JSON.stringify({
                  contents: [
                    { role: 'user', parts: [{ text: 'source admission' }] },
                  ],
                }),
              },
            ),
          }
          await rewriteGaHttpRequest(event, {
            bridge,
            ownership,
            isRegisteredModel: (id) => catalog.has(id),
            env: {},
          })
          expect(new URL(event.request.url).origin).toBe(bridge.origin)
          return fixture.step('request.dispatch', () =>
            fetch(event.request, {
              signal: fixture.requestSignal(undefined, event.request.signal),
            }),
          )
        }
        // Approval starts a background connection attempt. Finish it before
        // measuring request-driven source access, without disabling the observer.
        if (source === 'unavailable vault') await initialConnection.promise
        const before = { connects, storeLoads, sourceLoads, refreshFailures }
        for (const kind of ['primary', 'compaction', 'generate'] as const) {
          const retired = await dispatch(kind, 'antigravity-gemini-3.1-pro')
          expect(retired.status).toBe(412)
          expect(await retired.json()).toEqual({
            error: {
              code: 412,
              status: 'FAILED_PRECONDITION',
              message:
                'This Antigravity model is no longer offered. Choose another model.',
            },
          })
        }
        expect({ connects, storeLoads, sourceLoads, refreshFailures }).toEqual(
          before,
        )
        expect(sends).toBe(0)
        expect(localPipelines).toBe(0)
        expect(existsSync(accountFile)).toBe(false)
        // Title replacements and live models still initialize local storage or
        // refresh vault credentials, unlike retired non-title selections.
        for (const [kind, modelID] of [
          ['title', 'antigravity-gemini-3.1-pro'],
          ['primary', 'antigravity-gemini-3.5-flash'],
        ] as const) {
          const control = await dispatch(kind, modelID)
          expect(control.status).toBe(502)
          expect(await control.text()).toContain(
            source === 'cold local' ? 'not initialized' : 'ENOENT',
          )
        }
        if (source === 'cold local') expect(storeLoads).toBeGreaterThan(0)
        else {
          expect(sourceLoads).toBeGreaterThan(before.sourceLoads)
          expect(refreshFailures).toBe(2)
          expect(connects).toBeGreaterThan(before.connects)
        }
        expect(sends).toBe(0)
        expect(localPipelines).toBe(0)
        expect(hostSlotReads).toBe(0)
        expect(bridge.pendingJobs()).toBe(0)
      } finally {
        await disposeFixture(fixture, [
          ['bridge.dispose', async () => bridge?.dispose()],
          ['runtime.dispose', async () => runtime?.dispose()],
          ['services.dispose', async () => services?.dispose()],
          ['custody.dispose', () => custody.dispose()],
        ])
      }
    }),
  )
}
