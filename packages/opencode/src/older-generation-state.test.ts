import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ProviderRecord } from '@opencode/plugin/promise/provider'
import type { GaHostContext } from './ga/server/index'
import type { HeartbeatStoreRecord } from './runtime-paths'

// Seed before any production import, just as a previous bundle in OpenCode's
// service would. Keep references to prove that the new bundle repairs in place.
const heartbeatKey = Symbol.for('cortexkit.antigravity-auth.process-heartbeat')
const layoutKey = Symbol.for('@cortexkit/antigravity-auth/runtime-layout-runs')
const oldHeartbeat = {
  owners: 2,
  startedAt: 123,
  layouts: new Map([['older-location', 'state-home' as const]]),
  writtenPath: undefined,
  writtenLayouts: undefined,
  exitHookInstalled: false,
}
const oldLayout = { runs: new Map(), logged: new Set<string>() }
const pathsKey = Symbol.for('@cortexkit/antigravity-auth/runtime-layouts')
const oldPaths = { decisions: new Map(), locations: new Map() }
const retainedMaps = {
  runs: oldLayout.runs,
  logged: oldLayout.logged,
  decisions: oldPaths.decisions,
  locations: oldPaths.locations,
}
Reflect.set(globalThis, heartbeatKey, oldHeartbeat)
Reflect.set(globalThis, layoutKey, oldLayout)
Reflect.set(globalThis, pathsKey, oldPaths)

const heartbeat = await import('./process-heartbeat')
const layout = await import('./runtime-layout')
const paths = await import('./runtime-paths')
const { getStoragePath } = await import('./plugin/storage')
const server = await import('./ga/server/index')
const { createGaLocationServices } = await import(
  './plugin/ga-location-services'
)
const { initializeFreshAccountStore, loadCommonAuthStoreModules } =
  await import('@cortexkit/antigravity-auth-core')
const version = await heartbeat.pluginPackageVersion()
const normalized = oldHeartbeat as typeof oldHeartbeat & {
  stores: Map<string, HeartbeatStoreRecord>
}
const ENV = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_DB',
] as const
let saved: Record<string, string | undefined>
let count = 0
let root: string
const messages: string[] = []
const log = {
  info: (message: string) => messages.push(message),
  warn: (message: string) => messages.push(message),
}

beforeEach(() => {
  const testRoot = process.env.ANTIGRAVITY_TEST_ROOT
  if (!testRoot)
    throw new Error('test/setup.ts did not pin ANTIGRAVITY_TEST_ROOT')
  root = join(testRoot, 'older-generation', String(++count))
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DB: join(root, 'opencode.db'),
  })
  mkdirSync(process.env.OPENCODE_CONFIG_DIR!, { recursive: true, mode: 0o700 })
  messages.length = 0
})

afterEach(() => {
  heartbeat.__resetProcessHeartbeatForTest()
  layout.__resetRuntimeLayoutRunsForTest()
  paths.__resetRuntimeLayoutsForTest()
  for (const name of ENV) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

it('repairs the old heartbeat in place, preserves live owners and writes config anchors', async () => {
  expect(Reflect.get(globalThis, heartbeatKey)).toBe(oldHeartbeat)
  expect(oldHeartbeat.owners).toBe(2)
  expect(oldHeartbeat.startedAt).toBe(123)
  expect(oldHeartbeat.layouts.get('older-location')).toBe('state-home')
  expect(oldLayout.runs).toBe(retainedMaps.runs)
  expect(oldLayout.logged).toBe(retainedMaps.logged)
  expect(oldPaths.decisions).toBe(retainedMaps.decisions)
  expect(oldPaths.locations).toBe(retainedMaps.locations)
  const handle = await heartbeat.startProcessHeartbeat({
    version,
    logger: log,
    layouts: { current: 'state-home' },
    stores: { current: 'state-home', 'vault-only': 'undecided' },
  })
  expect(handle.path).toBe(heartbeat.processHeartbeatPath())
  expect(JSON.parse(readFileSync(handle.path!, 'utf8'))).toMatchObject({
    startedAt: 123,
    layouts: { 'older-location': 'state-home', current: 'state-home' },
    stores: {
      'older-location': 'config',
      current: 'config',
      'vault-only': 'config',
    },
  })
  await handle.release()
  expect(oldHeartbeat.owners).toBe(2)

  const reloaded = (await import(
    new URL('./process-heartbeat.ts?next-generation', import.meta.url).href
  )) as typeof heartbeat
  const next = await reloaded.startProcessHeartbeat({
    version,
    logger: log,
    stores: { another: 'state-home' },
  })
  expect(JSON.parse(readFileSync(next.path!, 'utf8')).stores.another).toBe(
    'config',
  )
  await next.release()
  expect(oldHeartbeat.owners).toBe(2)
  expect(messages).toEqual([])
})

it('fills storeAnchors without replacing old layout decisions or locations', () => {
  expect(Reflect.get(globalThis, pathsKey)).toBe(oldPaths)
  expect(
    paths.decidedAccountStoreAnchor(paths.runtimeLayoutLocation()),
  ).toBeUndefined()
  expect(Reflect.get(oldPaths, 'storeAnchors')).toBeInstanceOf(Map)
})

it('fills storeRuns on the old runtime state before deciding the account store', async () => {
  expect(Reflect.get(globalThis, layoutKey)).toBe(oldLayout)
  await expect(layout.prepareAccountStore({ version, log })).resolves.toBe(
    'config',
  )
  expect(Reflect.get(oldLayout, 'storeRuns')).toBeInstanceOf(Map)
})

it.each([
  false,
  true,
])('repairs old layout state and defers a store move or fresh initialization (existing store: %s)', async (existing) => {
  const location = paths.runtimeLayoutLocation()
  const config = paths.legacyAccountFile(location.configDir)
  if (existing) {
    const result = await initializeFreshAccountStore(
      await loadCommonAuthStoreModules(),
      { legacyPath: config, now: Date.now },
    )
    expect(result.status).toBe('completed')
  }
  expect(Reflect.get(globalThis, layoutKey)).toBe(oldLayout)
  const options = {
    version,
    log,
    fence: async () => ({ open: true as const }),
    storeFence: async () => ({ open: true as const }),
  }
  expect(await layout.prepareRuntimeLayout(options)).toBe('state-home')
  expect(await layout.prepareAccountStore(options)).toBe('config')
  expect(getStoragePath()).toBe(config)
  expect(existsSync(paths.stateHomeAccountFile(location))).toBe(false)
  expect(
    JSON.parse(readFileSync(heartbeat.processHeartbeatPath(), 'utf8')).stores,
  ).toEqual({ [location.key]: 'config' })
  expect(
    messages.filter((message) => message.includes('older version')),
  ).toEqual([
    "antigravity-auth keeps the account store in OpenCode's config folder until OpenCode restarts, because an older version of the plugin ran in this process.",
  ])
  await layout.prepareAccountStore(options)
  process.env.OPENCODE_CONFIG_DIR = join(root, 'another-config')
  mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true, mode: 0o700 })
  expect(await layout.prepareAccountStore(options)).toBe('config')
  expect(
    messages.filter((message) => message.includes('older version')),
  ).toHaveLength(1)

  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
        const { versionFenceOpen } = await import(${JSON.stringify(new URL('./version-fence.ts', import.meta.url).href)})
        console.log(JSON.stringify(await versionFenceOpen({ currentVersion: ${JSON.stringify(version)}, storeMove: true })))
      `,
    ],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' },
  )
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  expect(await child.exited, errors).toBe(0)
  expect(JSON.parse(output)).toMatchObject({
    open: false,
    blockers: [{ pid: process.pid, version }],
  })
})

it.each([
  'layouts',
  'stores',
] as const)('contains a failure updating %s and retries on the next heartbeat start', async (field) => {
  const broken = spyOn(normalized[field], 'set').mockImplementationOnce(() => {
    throw new Error('bookkeeping failed')
  })
  try {
    const handle = await heartbeat.startProcessHeartbeat({
      version,
      logger: log,
      layouts: { current: 'state-home' },
      stores: { current: 'state-home' },
    })
    expect(handle.path).toBeUndefined()
    await handle.release()
    expect(messages).toContain('process heartbeat not written')
    const retry = await heartbeat.startProcessHeartbeat({
      version,
      logger: log,
    })
    expect(retry.path).toBe(heartbeat.processHeartbeatPath())
    await retry.release()
  } finally {
    broken.mockRestore()
  }
})

it('contains a bookkeeping failure while releasing the last heartbeat owner', async () => {
  const handle = await heartbeat.startProcessHeartbeat({ version, logger: log })
  const broken = spyOn(oldHeartbeat.layouts, 'values').mockImplementationOnce(
    () => {
      throw new Error('bookkeeping failed during release')
    },
  )
  try {
    await expect(handle.release()).resolves.toBeUndefined()
  } finally {
    broken.mockRestore()
  }
})

function isHostDirectory(
  value: string,
): value is GaHostContext['location']['directory'] {
  return isAbsolute(value)
}

function host(directory: string, registrations: string[]): GaHostContext {
  if (!isHostDirectory(directory))
    throw new Error('test host needs an absolute directory')
  const registration = { dispose: async () => {} }
  return {
    location: { directory },
    session: { hook: async () => registration },
    provider: {
      transform: async (callback) => {
        callback({
          list: () => [],
          get: () => ({
            provider: {
              id: 'google' as ProviderRecord['provider']['id'],
              name: 'Google',
              activation: 'auto',
              package: '@ai-sdk/google',
            },
            models: new Map(),
          }),
          add: () => undefined,
          update: () => undefined,
          remove: () => undefined,
          models: {
            set: (providerID) => {
              registrations.push(providerID)
            },
            update: () => undefined,
            remove: () => undefined,
          },
        })
        return registration
      },
      reload: async () => {},
    },
    rpc: {
      register: async () => ({
        ...registration,
        events: { emit: async () => {} },
      }),
    },
    command: {
      transform: async () => registration,
      reload: async () => {},
    },
  }
}

it.each([
  false,
  true,
])('registers the real GA provider after an older generation (bookkeeping failure: %s)', async (injectFailure) => {
  const providers: string[] = []
  let broken: ReturnType<typeof spyOn> | undefined
  let failedWrites = 0
  const cleanup = await server
    .setupGaActivation(
      host(join(root, 'project'), providers),
      async (input) => {
        const services = await createGaLocationServices(input)
        // Inject after the required layout decision writes, so only the
        // best-effort heartbeat's bookkeeping fails during setup.
        if (injectFailure) {
          broken = spyOn(normalized.stores, 'set').mockImplementationOnce(
            () => {
              failedWrites++
              throw new Error('GA heartbeat bookkeeping failed')
            },
          )
        }
        return services
      },
    )
    .finally(() => broken?.mockRestore())
  try {
    expect(cleanup).toBeFunction()
    expect(providers).toContain('google')
    expect(failedWrites).toBe(injectFailure ? 1 : 0)
  } finally {
    await cleanup?.()
  }
}, 15_000)
