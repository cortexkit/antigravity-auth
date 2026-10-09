import { expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AccountManager,
  type AccountRepository,
  type AccountRow,
  type AccountStorePaths,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  type ManagedAccount,
  type RowRef,
  readAccountStoreAdmission,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandScope,
  reapPublicCommandScope,
} from '../../../../core/src/__fixtures__/public-command-processes.test.ts'
import * as publicFs from '../../../../core/src/common-auth-embedded/fs/index.js'
import * as publicStore from '../../../../core/src/common-auth-embedded/store/index.js'
import { extractAccountAccessErrorDetails } from '../account-access'
import { DEFAULT_CONFIG } from '../config'
import { createLocationDebug } from '../debug'
import {
  authorizeGaQuotaCheck,
  createGaFetchAccountQuota,
  createGaJobExecutor,
  createGaLocalCredentials,
} from '../ga-location-services'
import { createGeminiDumpState } from '../gemini-dump'
import { createLocationLogger } from '../logger'
import { createRequestWire, createRequestWireLocation } from '../request'
import { AgySessionRegistry } from '../session-context'
import { createSignatureStore } from '../stores/signature-store'
import {
  createRequestExecutor,
  type LocalRequestCredentials,
  type RequestServicesDeps,
} from './request-services'

const TOKEN_A = 'synthetic-access-before'
const TOKEN_B = 'synthetic-access-after'
const TOKEN_C = 'synthetic-access-again'
const modules = { store: publicStore, fs: publicFs }
const coreURL = new URL('../../../../core/dist/index.js', import.meta.url).href
const storeURL = new URL(
  '../../../../core/src/common-auth-embedded/store/index.js',
  import.meta.url,
).href
const fsURL = new URL(
  '../../../../core/src/common-auth-embedded/fs/index.js',
  import.meta.url,
).href

type Operation = 'clear' | 'refresh-B' | 'refresh-C' | 'remove' | 'identity'

// Each operation runs in a separate process against the real public store.
// The stdin handshake keeps it alive until its birth/session has been recorded.
const writerSource = `
import { readFile } from 'node:fs/promises';
import { ACCOUNT_STORE_PROVIDER, ACCOUNT_STATE_POLICY, QUOTA_CODEC,
  createAccountRepositoryFactory, createProviderStateCodec, sameRowRef } from ${JSON.stringify(coreURL)};
import * as store from ${JSON.stringify(storeURL)};
import * as fs from ${JSON.stringify(fsURL)};
await new Promise(resolve => process.stdin.once('data', resolve));
const { paths, ref, operation, root } = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!paths.storeDir.startsWith(root + '/')) throw new Error('writer outside private fixture');
const repository = createAccountRepositoryFactory({ store, fs })({ paths, now: Date.now,
  exchange: async ({refreshToken}) => ({ refreshToken,
    accessToken: operation === 'refresh-C' ? ${JSON.stringify(TOKEN_C)} : ${JSON.stringify(TOKEN_B)},
    expiresAt: Date.now() + 3600000, ...(ref.identity ? { identity: ref.identity } : {}) }) });
const native = store.openPoolStore({ provider: ACCOUNT_STORE_PROVIDER,
  configPath: paths.configPath, statePath: paths.statePath, quota: QUOTA_CODEC,
  providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
  requireCredentialStamps: true, now: Date.now });
try {
  console.log(JSON.stringify({writerPid:process.pid,operation,before:await repository.read()}));
  if (operation === 'clear') {
    const result = await native.updateProviderState(ref.id, ref, () => undefined);
    if (result.outcome !== 'cleared') throw new Error('clear failed');
  } else if (operation === 'remove') {
    await repository.remove(ref);
  } else if (operation === 'identity') {
    await native.recordIdentity(ref.id, 'synthetic-learned-identity', {credentialEpoch:ref.credentialEpoch});
  } else {
    const result = await repository.refresh(ref);
    if (result.status !== 'rotated' || !sameRowRef(result.ref, ref)) throw new Error('refresh changed lineage');
  }
  console.log(JSON.stringify({writerPid:process.pid,operation,after:await repository.read()}));
} finally { await repository.dispose(); }
`

async function runWriter(
  dir: string,
  paths: AccountStorePaths,
  ref: RowRef,
  operation: Operation,
) {
  const script = join(dir, 'writer.mjs')
  const input = join(dir, 'writer-input.json')
  await writeFile(script, writerSource, { mode: 0o600 })
  await writeFile(input, JSON.stringify({ paths, ref, operation, root: dir }), {
    mode: 0o600,
  })
  const inspector = await createPublicCommandInspector()
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  }
  for (const [key, name] of Object.entries({
    HOME: 'home',
    USERPROFILE: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    XDG_DATA_HOME: 'data',
    PI_AGENT_DIR: 'pi',
    OPENCODE_CONFIG_DIR: 'opencode',
    TMPDIR: 'tmp',
  })) {
    env[key] = join(dir, name)
    await mkdir(env[key], { recursive: true, mode: 0o700 })
  }
  env.OPENCODE_DB = join(dir, 'opencode.db')
  env.PI_ANTIGRAVITY_AUTH_FILE = join(dir, 'pi/auth.json')
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(dir, 'cache/transpiler')
  const child = spawn(process.execPath, ['--no-env-file', script, input], {
    env,
    cwd: dir,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let scope: PublicCommandScope | undefined
  let primary: unknown
  let output = ''
  let bytes = 0
  let exited = false
  let closed = false
  let status: number | null = null
  let wake = () => {}
  const stopped = new Promise<void>((resolve) => {
    wake = resolve
  })
  const stop = (error: unknown) => {
    primary ??= error
    wake()
  }
  child.once('error', stop)
  child.once('exit', (code) => {
    exited = true
    status = code
    wake()
  })
  const pipes = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true
      resolve()
    }),
  )
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 128 * 1024) stop(new Error('writer output cap exceeded'))
      else output += chunk.toString()
    })
    pipe.on('error', stop)
  }
  const timeout = setTimeout(
    () => stop(new Error('writer execution bound exceeded')),
    15_000,
  )
  let monitor: ReturnType<typeof setInterval> | undefined
  let pipeTimer: ReturnType<typeof setTimeout> | undefined
  let cleanupConfirmed = false
  try {
    if (!child.pid) throw new Error('no writer PID')
    const leader = inspector.read(child.pid)
    if (
      !leader ||
      leader.ppid !== process.pid ||
      leader.sid !== child.pid ||
      leader.pgid !== child.pid
    )
      throw new Error('writer birth/session/group identity unavailable')
    const owned: PublicCommandScope = {
      leader,
      observed: new Map([[leader.pid, leader]]),
      signals: [],
    }
    scope = owned
    monitor = setInterval(() => {
      try {
        inspectPublicCommandScope(owned, inspector)
      } catch (error) {
        stop(error)
      }
    }, 100)
    child.stdin.end('go\n')
    await stopped
    clearTimeout(timeout)
    clearInterval(monitor)
    const deadline = performance.now() + 5_000
    await reapPublicCommandScope(owned, inspector, deadline, 500)
    await Promise.race([
      pipes,
      new Promise<never>((_, reject) => {
        pipeTimer = setTimeout(
          () => reject(new Error('writer pipes not closed')),
          Math.max(1, deadline - performance.now()),
        )
      }),
    ])
    cleanupConfirmed =
      exited &&
      closed &&
      inspectPublicCommandScope(owned, inspector).length === 0
  } catch (error) {
    primary ??= error
  } finally {
    clearTimeout(timeout)
    clearTimeout(pipeTimer)
    clearInterval(monitor)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    inspector.close()
  }
  const receipt = {
    operation,
    runtime: process.execPath,
    parentPid: process.pid,
    childPid: child.pid,
    leader: scope
      ? { ...scope.leader, start: scope.leader.start.toString() }
      : null,
    executionMs: 15_000,
    reapMs: 5_000,
    termGraceMs: 500,
    outputCapBytes: 128 * 1024,
    status,
    exited,
    closed,
    cleanupConfirmed,
    signals: scope?.signals ?? [],
    primary: primary ? String(primary) : null,
  }
  console.log(output.trim())
  console.log(JSON.stringify({ ownedWriter: receipt }))
  if (!cleanupConfirmed) throw new Error(`retain fixture: ${dir}`)
  if (primary) throw primary
  expect<number | null>(status).toBe(0)
  expect(child.pid).not.toBe(process.pid)
}

async function freshPool(identified = true) {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('private test root required')
  const dir = await mkdtemp(join(root, 'local-grant-'))
  const legacyPath = join(dir, 'antigravity-accounts.json')
  const init = await initializeFreshAccountStore(modules, {
    legacyPath,
    now: Date.now,
  })
  if (init.status !== 'completed')
    throw new Error(`initialization ${init.status}`)
  const admission = await readAccountStoreAdmission(
    legacyPath,
    modules,
    Date.now,
  )
  if (admission.status !== 'active')
    throw new Error(`admission ${admission.status}`)
  const exchangeCalls: string[] = []
  const repository = createAccountRepositoryFactory(modules)({
    paths: admission.paths,
    now: Date.now,
    exchange: async ({ refreshToken }) => {
      exchangeCalls.push(refreshToken)
      return {
        refreshToken,
        accessToken: TOKEN_A,
        expiresAt: Date.now() + 3_600_000,
        ...(identified ? { identity: 'synthetic-authenticated-identity' } : {}),
      }
    },
  })
  const login = await repository.login({
    id: crypto.randomUUID(),
    refreshToken: 'synthetic-refresh',
    ...(identified ? { identity: 'synthetic-authenticated-identity' } : {}),
    metadata: {
      addedAt: Date.now(),
      lastUsed: 0,
      projectId: 'synthetic-project',
      enabled: true,
    },
  })
  const seeded = await repository.refresh(login.ref)
  if (seeded.status !== 'rotated') throw new Error(`seed ${seeded.status}`)
  return {
    dir,
    paths: admission.paths,
    repository,
    ref: seeded.ref,
    exchangeCalls,
  }
}

async function rowFor(
  repository: Pick<AccountRepository, 'read'>,
  ref: RowRef,
): Promise<AccountRow | undefined> {
  const read = await repository.read()
  expect(read.status).toBe('ready')
  return read.status === 'ready'
    ? read.rows.find((row) => row.ref.id === ref.id)
    : undefined
}

type Mode =
  | 'healthy'
  | 'loaded-clear'
  | 'reloaded-clear'
  | 'refresh'
  | 'twice'
  | 'remove'
  | 'identity'
  | 'not-ready'
  | 'after-physical'
type Stage = 'project' | 'main' | 'thinking' | 'cache'

async function runScenario(mode: Mode, stage: Stage = 'project') {
  const pool = await freshPool(mode !== 'identity')
  let manager: AccountManager | undefined
  let cleanupAllowed = true
  let writes = 0
  let projectCalls = 0
  let checks = 0
  let reads = 0
  let adoptions = 0
  const capturedTokens: string[] = []
  const snapshots: unknown[] = []
  const preparedBodies: string[] = []
  const sent: Array<{
    authorization: string | null
    body: string
    signal: AbortSignal | undefined
  }> = []
  const health = { failures: 0, limits: 0, successes: 0 }
  const bucket = { debits: 0, refunds: 0 }
  let ref = pool.ref
  const writer = async (operation: Operation) => {
    cleanupAllowed = false
    await runWriter(pool.dir, pool.paths, ref, operation)
    cleanupAllowed = true
    writes++
    const row = await rowFor(pool.repository, ref)
    snapshots.push({ phase: 'after-writer', row })
    if (operation === 'clear') {
      expect(row).toMatchObject({
        ref,
        enabled: true,
        usable: true,
        stamp: 'bound',
        metadata: { status: 'absent' },
      })
    } else if (operation === 'refresh-B' || operation === 'refresh-C') {
      expect(row).toMatchObject({
        ref,
        enabled: true,
        usable: true,
        metadata: { status: 'present' },
        credential: {
          accessToken: operation === 'refresh-C' ? TOKEN_C : TOKEN_B,
        },
      })
    } else if (operation === 'remove') expect(row).toBeUndefined()
    else {
      expect(row?.ref.credentialEpoch).toBe(ref.credentialEpoch)
      if (!row) throw new Error('identity row missing')
      expect(sameRowRef(row.ref, ref)).toBe(false)
      expect(row?.ref.identity).toBe('synthetic-learned-identity')
    }
  }
  try {
    if (stage === 'cache') {
      const other = createAccountRepositoryFactory(modules)({
        paths: pool.paths,
        now: Date.now,
        exchange: async ({ refreshToken }) => ({
          refreshToken,
          accessToken: TOKEN_A,
          expiresAt: Date.now() + 3_600_000,
          identity: 'synthetic-second-identity',
        }),
      })
      try {
        const login = await other.login({
          id: crypto.randomUUID(),
          refreshToken: 'synthetic-second-refresh',
          identity: 'synthetic-second-identity',
          metadata: {
            addedAt: Date.now(),
            lastUsed: 0,
            projectId: 'synthetic-project',
          },
        })
        const seeded = await other.refresh(login.ref)
        if (seeded.status !== 'rotated') throw new Error('second seed failed')
        ref = seeded.ref
      } finally {
        await other.dispose()
      }
    }
    if (mode === 'reloaded-clear') await writer('clear')
    manager = AccountManager.fromRepository(await pool.repository.read(), {
      repository: pool.repository,
    })
    const heldManager = manager
    // Flush generated device-fingerprint writes before the child clears
    // provider metadata, so that clear is not racing with initialization.
    await manager.flushSaveToDisk()
    const adopt = manager.adoptCurrentRow.bind(manager)
    manager.adoptCurrentRow = (account, row) => {
      adoptions++
      return adopt(account, row)
    }
    const config = {
      ...DEFAULT_CONFIG,
      quiet_mode: true,
      account_selection_strategy: 'hybrid' as const,
      scheduling_mode: 'balance' as const,
      max_account_switches: 1,
      switch_on_first_rate_limit: false,
      soft_quota_threshold_percent: 100,
      quota_refresh_interval_minutes: 0,
      proactive_rotation_threshold_percent: 0,
      cache_warmup_on_switch: stage === 'cache',
      thinking_warmup: stage === 'thinking',
      request_jitter_max_ms: 0,
      switch_account_delay_ms: 0,
    }
    const initialOperation: Operation =
      mode === 'loaded-clear'
        ? 'clear'
        : mode === 'remove'
          ? 'remove'
          : mode === 'identity'
            ? 'identity'
            : 'refresh-B'
    let selected: ManagedAccount | undefined
    const native = createGaLocalCredentials(manager, {
      repository: {
        async read() {
          reads++
          if (mode === 'not-ready' && projectCalls > 0)
            return { status: 'pending-migration' }
          const read = await pool.repository.read()
          snapshots.push({ phase: 'guard-read', read })
          return read
        },
      },
      overrides: {
        async ensureProjectContext(auth) {
          projectCalls++
          if (
            stage === 'project' &&
            mode !== 'healthy' &&
            mode !== 'reloaded-clear' &&
            mode !== 'not-ready'
          ) {
            if (writes === 0) await writer(initialOperation)
            else if (mode === 'twice' && writes === 1) await writer('refresh-C')
          }
          // A cached project lookup can return the previously resolved token A.
          // It must not replace token B captured from the refreshed store row.
          return {
            auth: { ...auth, access: TOKEN_A },
            effectiveProjectId:
              selected?.parts.projectId ?? 'synthetic-default-project',
          }
        },
      },
    })
    const credentials: LocalRequestCredentials<ManagedAccount> = {
      ...native,
      captureGrant(grant) {
        selected = grant.account
        capturedTokens.push(grant.accessToken)
        const captured = native.captureGrant(grant)
        return {
          ...captured,
          async check() {
            checks++
            const target = grant.account.ref?.id === ref.id
            if (
              stage !== 'project' &&
              target &&
              mode !== 'healthy' &&
              mode !== 'after-physical'
            ) {
              if (writes === 0) await writer(initialOperation)
              else if (
                mode === 'twice' &&
                writes === 1 &&
                (stage !== 'thinking' || checks >= 3)
              )
                await writer('refresh-C')
            }
            await captured.check()
          },
        }
      },
    }
    const debug = createLocationDebug({ ...config, debug: false })
    const logger = createLocationLogger({
      sinkEnabled: () => false,
    }).createLogger('grant-test')
    const wire = createRequestWire(
      createRequestWireLocation({
        signatures: {
          keepThinking: stage === 'thinking',
          signatureStore: createSignatureStore(),
          cacheSignature: () => {},
          getCachedSignature: () => undefined,
        },
        debug,
        logger,
      }),
    )
    const controller = new AbortController()
    const deps: RequestServicesDeps<ManagedAccount> = {
      config,
      accounts: manager,
      credentials,
      sessions: new AgySessionRegistry(pool.dir),
      wire: {
        ...wire,
        prepare(...args) {
          const prepared = wire.prepare(...args)
          if (stage === 'thinking')
            expect(prepared.needsSignedThinkingWarmup).toBe(true)
          preparedBodies.push(String(prepared.init.body))
          return prepared
        },
      },
      async transport(url, init, options) {
        sent.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: String(init?.body),
          signal: options?.signal ?? undefined,
        })
        if (mode === 'after-physical' && sent.length === 1)
          throw new Error('synthetic warmup transport failure')
        if (mode === 'after-physical' && sent.length === 2) {
          await writer('refresh-B')
          return new Response('missing', { status: 404 })
        }
        if (stage === 'cache' && sent.length === 1)
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                message: 'Account is not eligible',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'ACCOUNT_INELIGIBLE',
                  },
                ],
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        const payload = JSON.stringify({
          response: {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'ok' }] },
                finishReason: 'STOP',
              },
            ],
          },
        })
        return new Response(
          url.includes('streamGenerateContent')
            ? `data: ${payload}\n\ndata: [DONE]\n\n`
            : payload,
          {
            headers: {
              'content-type': url.includes('streamGenerateContent')
                ? 'text/event-stream'
                : 'application/json',
            },
          },
        )
      },
      fetchImpl: async () => {
        throw new Error('standard network fetch forbidden')
      },
      debug,
      dump: createGeminiDumpState({ enabled: false }),
      logger,
      trackers: {
        health: {
          recordFailure: () => {
            health.failures++
          },
          recordRateLimit: () => {
            health.limits++
          },
          recordSuccess: () => {
            health.successes++
          },
        },
        token: {
          consume: () => {
            bucket.debits++
            return true
          },
          refund: () => {
            bucket.refunds++
          },
        },
      },
      classifyAccessError: extractAccountAccessErrorDetails,
    }
    const executor = createRequestExecutor(deps)
    try {
      const body =
        stage === 'thinking'
          ? {
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'thinking',
                      thinking: 'foreign thought',
                      signature: 'x'.repeat(100),
                    },
                    {
                      type: 'tool_use',
                      id: 'tool-1',
                      name: 'weather',
                      input: {},
                    },
                  ],
                },
              ],
            }
          : { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
      const model =
        stage === 'thinking'
          ? 'claude-opus-4-6-thinking'
          : 'gemini-3.7-flash-medium'
      const response = await createGaJobExecutor(executor)(
        {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          sessionID: 'grant-session',
          parentSessionID: 'grant-parent',
          kind: 'primary',
          modelID: model,
          variant: null,
          body: JSON.stringify(body),
        },
        {
          signal: controller.signal,
          send: async () => {
            throw new Error('unexpected host sender')
          },
        },
      )
      const responseBody = await response.text()
      const current = await rowFor(pool.repository, ref)
      console.log(
        JSON.stringify({
          witness: {
            mode,
            stage,
            ref,
            capturedTokens,
            projectCalls,
            checks,
            reads,
            adoptions,
            writes,
            status: response.status,
            body: responseBody,
            sent,
            current,
            health,
            bucket,
            snapshots,
          },
        }),
      )
      return {
        status: response.status,
        responseBody,
        retryAfter: response.headers.get('retry-after'),
        sent,
        preparedBodies,
        capturedTokens,
        projectCalls,
        checks,
        reads,
        adoptions,
        writes,
        health,
        bucket,
        current,
        exchangeCalls: [...pool.exchangeCalls],
        managerCount: heldManager.getAccountCount(),
        ref,
        signal: controller.signal,
      }
    } finally {
      executor.dispose()
    }
  } finally {
    await manager?.dispose()
    await pool.repository.dispose()
    if (cleanupAllowed) await rm(pool.dir, { recursive: true, force: true })
    else console.log(JSON.stringify({ retainedFixture: pool.dir }))
  }
}

function expectPolicyFailure(result: Awaited<ReturnType<typeof runScenario>>) {
  expect(result.status).toBe(412)
  expect(JSON.parse(result.responseBody).error).toMatchObject({
    code: 412,
    status: 'FAILED_PRECONDITION',
  })
  expect(result.responseBody).not.toMatch(
    /429|500|502|503|504|524|synthetic-access|synthetic-authenticated|[0-9a-f]{8}-[0-9a-f]{4}/,
  )
  expect(result.retryAfter).toBeNull()
  expect(result.health.failures).toBe(0)
  expect(result.health.limits).toBe(0)
}

it('admits a freshly initialized healthy row through the real shared executor', async () => {
  const result = await runScenario('healthy')
  expect(result.status).toBe(200)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_A}`,
  ])
  expect(result.sent[0]?.signal).toBe(result.signal)
  expect(result.checks).toBe(1)
  expect(result.adoptions).toBe(0)
  expect(result.exchangeCalls).toEqual(['synthetic-refresh'])
})

it('refuses a loaded grant after a child publicly clears provider metadata', async () => {
  const result = await runScenario('loaded-clear')
  expect(result.sent).toHaveLength(0)
  expectPolicyFailure(result)
  expect(result.checks).toBe(1)
  expect(result.adoptions).toBe(0)
  expect(result.current?.metadata.status).toBe('absent')
  expect(result.current?.enabled).toBe(true)
  expect(result.managerCount).toBe(1)
})

it('reconstruction does not admit missing metadata while management reads remain usable', async () => {
  const result = await runScenario('reloaded-clear')
  expect(result.managerCount).toBe(0)
  expect(result.status).toBe(401)
  expect(result.sent).toHaveLength(0)
  expect(result.capturedTokens).toEqual([])
  expect(result.current).toMatchObject({
    enabled: true,
    usable: true,
    metadata: { status: 'absent' },
  })
})

it('recaptures child-refreshed B once and sends zero old-token requests after project wait', async () => {
  const result = await runScenario('refresh')
  expect(result.status).toBe(200)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_B}`,
  ])
  expect(result.capturedTokens).toEqual([TOKEN_A, TOKEN_B])
  expect(result.adoptions).toBe(1)
  expect(result.reads).toBe(3)
  expect(result.projectCalls).toBe(2)
  expect(result.preparedBodies).toHaveLength(2)
  expect(result.preparedBodies[1]).toBe(result.preparedBodies[0])
  expect(result.current?.metadata.status).toBe('present')
  expect(result.exchangeCalls).toEqual(['synthetic-refresh'])
  expect(result.health.failures).toBe(0)
  expect(result.health.limits).toBe(0)
  expect(result.bucket).toEqual({ debits: 2, refunds: 1 })
})

it('bounds a second same-lineage supersession at main dispatch without endpoint retries', async () => {
  const result = await runScenario('twice', 'main')
  expect(result.sent).toHaveLength(0)
  expectPolicyFailure(result)
  expect(result.checks).toBe(2)
  expect(result.adoptions).toBe(1)
  expect(result.capturedTokens).toEqual([TOKEN_A, TOKEN_B])
  expect(result.current?.credential?.accessToken).toBe(TOKEN_C)
  expect(result.bucket).toEqual({ debits: 2, refunds: 2 })
})

it('rebuilds after supersession at thinking warmup before any old-token physical send', async () => {
  const result = await runScenario('refresh', 'thinking')
  expect(result.status).toBe(200)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_B}`,
    `Bearer ${TOKEN_B}`,
  ])
  expect(result.checks).toBe(3)
  expect(result.adoptions).toBe(1)
  expect(result.bucket).toEqual({ debits: 1, refunds: 0 })
})

it('shares one recapture budget across thinking warmup and main dispatch, retaining the real auxiliary send', async () => {
  const result = await runScenario('twice', 'thinking')
  expectPolicyFailure(result)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_B}`,
  ])
  expect(result.checks).toBe(3)
  expect(result.adoptions).toBe(1)
  expect(result.bucket).toEqual({ debits: 1, refunds: 1 })
})

it('rebuilds the unsent cache probe on the same selected row after supersession', async () => {
  const result = await runScenario('refresh', 'cache')
  expect(result.status).toBe(200)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_A}`,
    `Bearer ${TOKEN_B}`,
    `Bearer ${TOKEN_B}`,
  ])
  expect(result.adoptions).toBe(1)
  expect(result.checks).toBe(4)
  expect(result.preparedBodies.at(-1)).toBe(result.preparedBodies.at(-2))
})

it.each([
  'remove',
  'identity',
  'not-ready',
] as const)('refuses %s at dispatch without re-resolving another credential', async (mode) => {
  const result = await runScenario(mode)
  expectPolicyFailure(result)
  expect(result.sent).toHaveLength(0)
  expect(result.adoptions).toBe(0)
  expect(result.checks).toBe(1)
})

it.each([
  'initial-clear',
  'project-clear',
  'project-refresh',
] as const)('quota %s refuses absent or superseded grants before every physical send', async (mode) => {
  const pool = await freshPool()
  let cleanupAllowed = true
  let manager: AccountManager | undefined
  try {
    manager = AccountManager.fromRepository(await pool.repository.read(), {
      repository: pool.repository,
    })
    await manager.flushSaveToDisk()
    const target = manager.getAccountsForQuotaCheck()[0]
    if (!target) throw new Error('missing quota target')
    const writer = async (operation: Operation) => {
      cleanupAllowed = false
      await runWriter(pool.dir, pool.paths, pool.ref, operation)
      cleanupAllowed = true
    }
    if (mode === 'initial-clear') {
      await writer('clear')
      expect(
        await authorizeGaQuotaCheck(
          pool.repository,
          { rowRef: pool.ref },
          Date.now,
        ),
      ).toEqual({ status: 'refused', reason: 'stale' })
    }
    let projectCalls = 0
    const sends: string[] = []
    const fetchQuota = createGaFetchAccountQuota({
      repository: pool.repository,
      now: Date.now,
      logger: { debug: () => {} },
      overrides: {
        async ensureProjectContext(auth) {
          projectCalls++
          if (mode !== 'initial-clear')
            await writer(mode === 'project-clear' ? 'clear' : 'refresh-B')
          return { auth, effectiveProjectId: 'synthetic-project' }
        },
        async quotaFetch(_url, init) {
          sends.push(new Headers(init.headers).get('authorization') ?? '')
          return new Response('{"groups":[],"buckets":[]}', {
            headers: { 'content-type': 'application/json' },
          })
        },
      },
    })
    const result = await fetchQuota(target, new AbortController().signal)
    expect(sends).toHaveLength(0)
    expect(result.status).toBe('error')
    expect(projectCalls).toBe(mode === 'initial-clear' ? 0 : 1)
    expect(pool.exchangeCalls).toEqual(['synthetic-refresh'])
    console.log(
      JSON.stringify({
        quotaWitness: {
          mode,
          result,
          sends,
          projectCalls,
          row: await rowFor(pool.repository, pool.ref),
        },
      }),
    )
  } finally {
    await manager?.dispose()
    await pool.repository.dispose()
    if (cleanupAllowed) await rm(pool.dir, { recursive: true, force: true })
    else console.log(JSON.stringify({ retainedFixture: pool.dir }))
  }
})

it('quota refuses provider metadata cleared after its attributed refresh before authorization returns', async () => {
  const pool = await freshPool()
  let cleanupAllowed = true
  try {
    let reads = 0
    const current = await rowFor(pool.repository, pool.ref)
    if (!current?.credential?.expiresAt) throw new Error('missing expiry')
    const repository: Pick<AccountRepository, 'read' | 'refresh'> = {
      refresh: (ref, options) => pool.repository.refresh(ref, options),
      async read() {
        reads++
        if (reads === 2) {
          cleanupAllowed = false
          await runWriter(pool.dir, pool.paths, pool.ref, 'clear')
          cleanupAllowed = true
        }
        return pool.repository.read()
      },
    }
    expect(
      await authorizeGaQuotaCheck(
        repository,
        { rowRef: pool.ref },
        () => current.credential!.expiresAt! + 1,
      ),
    ).toEqual({ status: 'refused', reason: 'stale' })
    expect(reads).toBe(2)
    expect(pool.exchangeCalls).toEqual([
      'synthetic-refresh',
      'synthetic-refresh',
    ])
    expect((await rowFor(pool.repository, pool.ref))?.metadata.status).toBe(
      'absent',
    )
  } finally {
    await pool.repository.dispose()
    if (cleanupAllowed) await rm(pool.dir, { recursive: true, force: true })
    else console.log(JSON.stringify({ retainedFixture: pool.dir }))
  }
})

it('quota admits healthy initialized metadata and confirms both physical sends with the exact signal', async () => {
  const pool = await freshPool()
  let manager: AccountManager | undefined
  try {
    manager = AccountManager.fromRepository(await pool.repository.read(), {
      repository: pool.repository,
    })
    const target = manager.getAccountsForQuotaCheck()[0]
    if (!target) throw new Error('missing target')
    const controller = new AbortController()
    const sends: {
      token: string | null
      signal: AbortSignal | null | undefined
    }[] = []
    const fetchQuota = createGaFetchAccountQuota({
      repository: pool.repository,
      now: Date.now,
      logger: { debug: () => {} },
      overrides: {
        ensureProjectContext: async (auth) => ({
          auth,
          effectiveProjectId: 'synthetic-project',
        }),
        async quotaFetch(url, init, extra) {
          sends.push({
            token: new Headers(init.headers).get('authorization'),
            signal: extra.signal,
          })
          return new Response(
            url.includes('retrieveUserQuotaSummary')
              ? '{"groups":[]}'
              : '{"buckets":[]}',
            { headers: { 'content-type': 'application/json' } },
          )
        },
      },
    })
    expect((await fetchQuota(target, controller.signal)).status).toBe('ok')
    expect(sends).toHaveLength(2)
    expect(sends.map((send) => send.token)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
    ])
    expect(sends.every((send) => send.signal === controller.signal)).toBe(true)
    expect(pool.exchangeCalls).toEqual(['synthetic-refresh'])
  } finally {
    await manager?.dispose()
    await pool.repository.dispose()
    await rm(pool.dir, { recursive: true, force: true })
  }
})

it('does not refund an earlier physical main debit when supersession blocks the next auxiliary attempt', async () => {
  const result = await runScenario('after-physical', 'thinking')
  expect(result.status).toBe(200)
  expect(result.sent.map((send) => send.authorization)).toEqual([
    `Bearer ${TOKEN_A}`,
    `Bearer ${TOKEN_A}`,
    `Bearer ${TOKEN_B}`,
    `Bearer ${TOKEN_B}`,
  ])
  expect(result.adoptions).toBe(1)
  expect(result.checks).toBe(5)
  expect(result.bucket).toEqual({ debits: 2, refunds: 0 })
  expect(result.health.failures).toBe(0)
  expect(result.preparedBodies.at(-1)).toBe(result.preparedBodies.at(-2))
})
