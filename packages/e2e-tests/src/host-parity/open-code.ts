import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AccountRepository,
  AccountRow,
} from '@cortexkit/antigravity-auth-core'
import { placeholderSecret } from '../../../opencode/src/common-auth-embedded/opencode2/index.js'
import {
  type GaPluginOverrides,
  GaRequestOwnership,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from '../../../opencode/src/ga/server/index.ts'
import { AccountManager } from '../../../opencode/src/plugin/accounts.ts'
import {
  type AntigravityConfig,
  DEFAULT_CONFIG,
} from '../../../opencode/src/plugin/config/index.ts'
import { initRuntimeConfig } from '../../../opencode/src/plugin/config/loader.ts'
import {
  createFetchInterceptor,
  createVaultFetchInterceptor,
} from '../../../opencode/src/plugin/fetch-interceptor.ts'
import {
  createGaLocalRequestPipeline,
  createGaRouteBook,
  createGaVaultRequestPipeline,
} from '../../../opencode/src/plugin/ga-location-services.ts'
import { AgySessionRegistry } from '../../../opencode/src/plugin/session-context.ts'
import {
  createLocationRuntime,
  createMemoryQuotaSnapshots,
  type LocationRuntime,
} from '../../../opencode/src/plugin/shared/runtime.ts'
import { createVaultAccountPool } from '../../../opencode/src/plugin/shared/vault-request-credentials.ts'
import type { Conversation, Custody } from './cases.ts'
import type { Environment } from './environment.ts'
import { credential, epoch } from './fixtures.ts'
import { google1, google2 } from './native-google.ts'

export const route = {
  routeId: 'parity-route',
  credentialId: 'parity-credential',
  accountIdentity: 'parity-identity',
  label: 'Parity account',
}
const auth = {
  type: 'oauth' as const,
  access: credential.accessToken,
  refresh: `fixture-refresh|${credential.projectId}|${credential.projectId}`,
  expires: epoch + 86_400_000,
}

const config = (keepThinking = false) => ({
  ...DEFAULT_CONFIG,
  keep_thinking: keepThinking,
  quiet_mode: false,
  request_jitter_max_ms: 0,
  quota_refresh_interval_minutes: 0,
  proactive_rotation_threshold_percent: 0,
  cache_warmup_on_switch: false,
  thinking_warmup: false,
  switch_on_first_rate_limit: false,
  scheduling_mode: 'balance' as const,
  account_selection_strategy: 'sticky' as const,
})

function source(environment: Environment) {
  return {
    refresh: async () => undefined,
    routes: () => [route],
    admit: async () => ({
      ...route,
      ...credential,
      expiresAtMs: null,
      recordVersion: 1,
    }),
    reportServedStatus: async () => false,
    reportCondition: async (_admission: unknown, condition: unknown) => {
      environment.reports.push({ condition })
      return 'reported' as const
    },
  }
}

const noNetwork = async (): Promise<never> => {
  throw new Error('Parity cannot bypass the public Google adapter')
}
const noop = () => {}

async function ingress(
  request: Request,
  input: Conversation,
  session?: string,
) {
  const headers = new Headers(request.headers)
  if (session !== undefined) headers.set('x-opencode-session-id', session)
  // This fixture supplies the very same SDK-generated JSON to the other
  // supported ingress envelope. No contents are manufactured by the test.
  const nativeBody = await request.text()
  const body =
    input.options.raw === false
      ? JSON.stringify({
          project: credential.projectId,
          request: JSON.parse(nativeBody),
        })
      : nativeBody
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  })
}

export async function openCode1(
  environment: Environment,
  custody: Custody,
  input: Conversation,
) {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('Host parity requires the root test preload')
  const settings = config(input.options.keepThinking)
  initRuntimeConfig(settings)
  const common = {
    client: {
      tui: {
        showToast: async ({ body }: { body: unknown }) => {
          environment.notices.push(body)
        },
      },
      auth: { set: async () => {} },
    },
    config: settings,
    agySessionRegistry: new AgySessionRegistry({ now: () => Date.now() }),
    onRouting: noop,
    fetchImpl: noNetwork,
  } as unknown as Omit<
    Parameters<typeof createVaultFetchInterceptor>[0],
    'source'
  >

  let manager: AccountManager | undefined
  const interceptor =
    custody === 'local'
      ? (() => {
          let stored = {
            version: 4 as const,
            accounts: [
              {
                refreshToken: 'fixture-refresh',
                projectId: credential.projectId,
                managedProjectId: credential.projectId,
                addedAt: epoch,
                lastUsed: epoch,
              },
            ],
            activeIndex: 0,
          }
          manager = new AccountManager(auth, stored, {
            now: () => Date.now(),
            random: () => Math.random(),
            storagePath: `${root}/host-parity-memory-only.json`,
            store: {
              load: async () => stored,
              saveMerged: async (_path, next) =>
                (stored = next as typeof stored),
              mutate: async (_path, edit) =>
                (stored = ((await edit(stored)) ?? stored) as typeof stored),
              clear: async () => {
                stored = { ...stored, accounts: [] }
              },
            },
          })
          return createFetchInterceptor({
            ...common,
            directory: root,
            providerId: 'google',
            accountManager: manager,
            accountSource: { kind: 'pool-file' },
            getAuth: async () => auth,
            quotaManager: {
              refreshAccount: async () => ({ status: 'ok' }),
              hashedLogLabel: () => 'parity',
            } as never,
          })
        })()
      : createVaultFetchInterceptor({ ...common, source: source(environment) })
  return {
    run: (conversation: Conversation, session?: string, signal?: AbortSignal) =>
      google1(
        conversation,
        async (native) => {
          const request = await ingress(native, conversation, session)
          const response = await interceptor.fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
            signal: request.signal,
          })
          return response
        },
        signal,
      ),
    async dispose() {
      await interceptor.dispose()
      await manager?.dispose()
    },
  }
}

function repository(): AccountRepository {
  const row: AccountRow = {
    ref: {
      id: route.credentialId,
      credentialEpoch: 1,
      identity: route.accountIdentity,
    },
    index: 0,
    enabled: true,
    usable: true,
    stamp: 'bound',
    quota: { status: 'absent' },
    metadata: {
      status: 'present',
      metadata: {
        addedAt: epoch,
        lastUsed: epoch,
        managedProjectId: credential.projectId,
      },
    },
    credential: {
      refreshToken: 'fixture-refresh',
      accessToken: credential.accessToken,
      expiresAt: auth.expires,
    },
  }
  return {
    read: async () => ({ status: 'ready', rows: [{ ...row }] }),
    setEnabled: async (
      _ref: AccountRow['ref'],
      { enabled }: { enabled: boolean },
    ) => {
      row.enabled = enabled
      return { ref: row.ref }
    },
    remove: async () => {
      row.enabled = false
    },
    readAccountIssues: async () => [],
    selectAccount: async () => {},
    updateMetadata: async () => ({ ref: row.ref }),
    writeQuota: async () => ({ ref: row.ref }),
    recordFingerprint: async () => ({ ref: row.ref }),
    recordAccessVerdict: async (
      _ref: AccountRow['ref'],
      verdict: Parameters<AccountRepository['recordAccessVerdict']>[1],
    ) => {
      if (verdict.kind !== 'cleared') row.enabled = false
      else if (verdict.enable) row.enabled = true
      return { ref: row.ref }
    },
    recordUsage: async () => ({ ref: row.ref }),
    settled: async () => {},
    flush: async () => ({ failures: [] }),
    dispose: async () => {},
  } as unknown as AccountRepository
}

let locationSetupId = 0x100_0000_0000

export async function openCode2(
  environment: Environment,
  custody: Custody,
  input: Conversation,
  overrides: Partial<AntigravityConfig> = {},
) {
  initRuntimeConfig(config())
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('Host parity requires the root test preload')
  const directory = await mkdtemp(join(root, 'host-parity-ga-'))
  const previousConfig = process.env.OPENCODE_CONFIG_DIR
  const nextRequestId = environment.nextNodeId
  const finishSetup = () => {
    environment.nextNodeId = nextRequestId
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfig
  }
  let runtime: LocationRuntime | undefined
  let pipeline:
    | Awaited<ReturnType<typeof createGaLocalRequestPipeline>>
    | undefined
  const disposeLocation = async () => {
    try {
      await pipeline?.dispose()
    } finally {
      try {
        await runtime?.dispose()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
  try {
    // The fixture has its own user settings, including keys projects cannot set.
    process.env.OPENCODE_CONFIG_DIR = directory
    await writeFile(
      join(directory, 'antigravity.json'),
      JSON.stringify({
        ...config(input.options.keepThinking),
        background_quota_refresh: false,
        proactive_token_refresh: false,
        signature_cache: { ...DEFAULT_CONFIG.signature_cache, enabled: false },
        ...overrides,
      }),
    )
    // Runtime bookkeeping does not advance the captured request timeline.
    environment.nextNodeId = () =>
      `00000000-0000-4000-8000-${(++locationSetupId).toString(16).padStart(12, '0')}`
    runtime = await createLocationRuntime({
      directory,
      quotaSnapshots: createMemoryQuotaSnapshots(),
      fetchAccountQuota: async (account) => ({
        index: 0,
        email: account.email,
        status: 'ok',
        disabled: false,
        quota: { groups: {}, modelCount: 0 },
      }),
      refreshToken: noNetwork,
    })
    finishSetup()
    const common = {
      runtime,
      overrides: {
        ensureProjectContext: async (resolvedAuth) => ({
          auth: resolvedAuth,
          effectiveProjectId: credential.projectId,
        }),
      } satisfies GaPluginOverrides,
      routes: createGaRouteBook(),
      notify: (_scope, entry) => {
        if (!('notify' in entry)) return null
        const { message, kind } = entry.notify
        return environment.notices.push({ message, variant: kind })
      },
    } satisfies Pick<
      Parameters<typeof createGaVaultRequestPipeline>[0],
      'runtime' | 'overrides' | 'routes' | 'notify'
    >
    const accounts: Parameters<
      typeof createGaLocalRequestPipeline
    >[0]['accounts'] = {
      current: null,
      quotaLogger: null,
    }
    pipeline =
      custody === 'local'
        ? await createGaLocalRequestPipeline({
            ...common,
            accounts,
            repository: repository(),
            send: noNetwork,
            generation: 'parity',
          })
        : await createGaVaultRequestPipeline({
            ...common,
            pool: createVaultAccountPool({ source: source(environment) }),
          })
    const bridge = await startGaLoopbackBridge({
      execute: pipeline.execute,
      send: noNetwork,
    })
    const ownership = new GaRequestOwnership()
    return {
      runtime,
      accounts,
      run: (
        conversation: Conversation,
        session?: string,
        signal?: AbortSignal,
      ) =>
        google2(
          conversation,
          async (native) => {
            const request = await ingress(native, conversation, session)
            const event = {
              sessionID: session ?? '',
              kind: 'primary' as const,
              model: {
                id: conversation.model,
                providerID: 'google',
                variant: conversation.options.level,
              },
              request,
            }
            await rewriteGaHttpRequest(event, {
              bridge,
              env: {},
              ownership,
              isRegisteredModel: (model) => model === conversation.model,
            })
            if (new URL(event.request.url).origin !== bridge.origin)
              throw new Error('OpenCode 2 bypassed the parity bridge')
            const response = await fetch(event.request)
            const adapted = bridge.adaptResponse(event.request, response)
            if (!adapted) throw new Error('The bridge did not own the response')
            return adapted
          },
          signal,
          placeholderSecret('google'),
        ),
      async dispose() {
        try {
          await bridge.dispose()
        } finally {
          await disposeLocation()
        }
      },
    }
  } catch (error) {
    finishSetup()
    await disposeLocation()
    throw error
  }
}
