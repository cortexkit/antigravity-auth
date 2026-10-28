/**
 * OpenCode 2 watches its config folder, so the plugin must not write there
 * while it runs after the vault files or local account store have moved:
 * no locks or staged files, signature cache, debug log or `.gitignore`.
 *
 * A vault-mode host whose vault files an earlier start already moved into
 * the state home starts one location through the real OpenCode 2 entry point
 * (`setupGaActivation` with the production location services), with debug
 * logging and the signature disk cache on, and lets the vault roster be
 * listed several times. A stand-in vault client sits at the services'
 * `connect` boundary and offers no change notices, so custody lists the
 * roster on every poll. Every file event in OpenCode's config folder is
 * recorded, through the location's start, its polls and its cleanup.
 */
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import * as fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'
import type { GaHostContext, GaServingServices } from '../ga/server/index.ts'
import { setupGaActivation } from '../ga/server/index.ts'
import {
  __resetProcessHeartbeatForTest,
  pluginPackageVersion,
} from '../process-heartbeat.ts'
import {
  __resetRuntimeLayoutRunsForTest,
  prepareAccountStore,
} from '../runtime-layout.ts'
import {
  __resetRuntimeLayoutsForTest,
  legacyVaultDir,
  runtimeLayoutLocation,
} from '../runtime-paths.ts'
import {
  __resetVaultFoldersForTest,
  prepareVaultFolder,
} from '../vault-folder.ts'
import { createGaLocationServicesForHost } from './ga-location-services.ts'
import { getStoragePath } from './storage.ts'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
} from './vault-custody.ts'

const ENV_NAMES = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'XDG_STATE_HOME',
  'ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE',
  'ANTIGRAVITY_AUTH_RPC_DIR',
  'OPENCODE_ANTIGRAVITY_LOG_DIR',
  'OPENCODE_ANTIGRAVITY_DEBUG',
] as const
const POLLS = 6
/** Prefix of the files the test itself writes to prove the watchers work. */
const PROBE = 'events-probe-'

let root: string
let saved: Record<string, string | undefined>
const cleanups: Array<() => unknown> = []

function resetProcess() {
  __resetRuntimeLayoutsForTest()
  __resetRuntimeLayoutRunsForTest()
  __resetVaultFoldersForTest()
  __resetProcessHeartbeatForTest()
}

beforeEach(() => {
  // The vault library refuses enrollment files below folders other users can
  // write; the system temporary folder is sticky, the test root may not be.
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  root = realpathSync(mkdtempSync(join(temporary, 'agy-config-events-')))
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  for (const name of ENV_NAMES) delete process.env[name]
  // OpenCode's config folder is the default one for this configuration
  // home, as for most users: older versions also kept the signature cache
  // and debug logs there.
  Object.assign(process.env, {
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    XDG_CONFIG_HOME: join(root, 'config'),
    APPDATA: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(root, 'state', 'sidebar.json'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(root, 'state', 'rpc'),
  })
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  resetProcess()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await Promise.resolve(cleanup()).catch(() => {})
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetProcess()
  rmSync(root, { recursive: true, force: true })
})

const configDir = () => join(root, 'config', 'opencode')
const accountFile = () => join(configDir(), 'antigravity-accounts.json')
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function waitUntil(condition: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** A dormant local login: binding it would write next to it. */
function writeDormantLocalAccount() {
  writeFileSync(
    accountFile(),
    JSON.stringify({
      version: 4,
      accounts: [
        {
          refreshToken: 'synthetic-dormant-local',
          projectId: 'synthetic-local-project',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    }),
    { mode: 0o600 },
  )
}

/** Approves this host's enrollment where older versions kept it. */
async function approveInConfigFolder() {
  let approve = false
  const custody = createOpenCodeVaultCustody({
    vaultDir: legacyVaultDir(accountFile()),
    accountFile: accountFile(),
    readHostSlot: async () => undefined,
    reporterSource: 'direct',
    connectionFile: () => join(root, 'vault-connection.json'),
    connectEnrollment: async () =>
      ({
        async enrollPropose() {
          return { requestId: 'request-1' }
        },
        async enrollPoll() {
          return approve
            ? {
                status: 'approved' as const,
                name: OPENCODE_VAULT_ENROLLMENT_NAME,
                token: 'ab'.repeat(32),
                tokenGeneration: 1,
              }
            : { status: 'pending' as const }
        },
        close() {},
      }) as never,
    connect: async () => {
      throw new Error('enrollment only')
    },
  })
  expect((await custody.requestAccess()).state).toBe('pending')
  approve = true
  expect((await custody.requestAccess()).state).toBe('approved')
  await custody.dispose()
}

/**
 * A scoped vault client serving one account. It has no `watchScoped`, so
 * custody lists the roster on every poll.
 */
function fakeVault() {
  const counts = { lists: 0 }
  return {
    counts,
    connect: async () =>
      ({
        listScoped: async () => {
          counts.lists++
          return {
            view: 'view-1',
            rows: [
              {
                id: 'credential-a',
                accountId: 'identity-a',
                credentialType: 'oauth',
                createdAtMs: 1,
                state: 'active',
                recordVersion: 1,
                categories: ['antigravity-native'],
                serves: ['google'],
                providerIds: ['google'],
                operations: ['read'],
                refreshAdapter: 'antigravity',
              },
            ],
            grants: undefined,
            grantTuples: undefined,
          }
        },
        getScoped: async ({ credentialId }: { credentialId: string }) => ({
          material: `bearer-${credentialId}`,
          credentialId,
          accountId: 'identity-a',
          recordVersion: 1,
          projectId: 'vault-project',
          expiresAtMs: Date.now() + 3_600_000,
        }),
        reportAuthFailureScoped: async () => {},
        close: () => {},
      }) as never,
  }
}

function isAbsoluteLocationDirectory(
  value: string,
): value is GaHostContext['location']['directory'] {
  return isAbsolute(value)
}

/** An OpenCode 2 host context that registers everything and does nothing. */
function fakeHost(directory: string): GaHostContext {
  if (!isAbsoluteLocationDirectory(directory))
    throw new Error(`not an absolute path: ${directory}`)
  const registration = { dispose: async () => {} }
  return {
    location: { directory },
    session: { hook: async () => registration },
    provider: {
      transform: async (callback) => {
        callback({
          list: () => [],
          get: () => undefined,
          add: () => undefined,
          update: () => undefined,
          remove: () => undefined,
          models: {
            set: () => undefined,
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
        events: { emit: async () => undefined },
      }),
    },
    command: {
      transform: async (callback) => {
        callback({ add: () => {} })
        return registration
      },
      reload: async () => {},
    },
  }
}

/**
 * Records every file event in `dir` and in each folder below it that exists
 * now. A folder created later shows up as an event in its parent.
 */
function watchFolder(dir: string) {
  const events: string[] = []
  const folders = [dir]
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) folders.push(join(dir, entry.name))
  const watchers: FSWatcher[] = folders.map((folder) =>
    watch(folder, (kind, name) => {
      events.push(`${kind} ${join(folder, String(name ?? ''))}`)
    }),
  )
  return {
    events,
    folders,
    close: () => {
      for (const watcher of watchers) watcher.close()
    },
  }
}

/** Writes a probe file in each watched folder and waits until each is seen. */
async function probe(
  watched: ReturnType<typeof watchFolder>,
  tag: string,
): Promise<void> {
  for (const folder of watched.folders) {
    const path = join(folder, `${PROBE}${tag}`)
    writeFileSync(path, tag)
    await waitUntil(
      () => watched.events.some((event) => event.endsWith(path)),
      `the watcher to see ${path}`,
      5_000,
    )
  }
}

it('a vault-mode start and its roster polls never inspect any account-store path', async () => {
  writeDormantLocalAccount()
  await approveInConfigFolder()
  const reads = [
    spyOn(fs, 'readFileSync'),
    spyOn(fs, 'readFile'),
    spyOn(fs, 'openSync'),
    spyOn(fs, 'open'),
    spyOn(fs, 'existsSync'),
    spyOn(fs, 'statSync'),
    spyOn(fs, 'lstatSync'),
    spyOn(fs.realpathSync, 'native'),
    spyOn(fs, 'readdirSync'),
    spyOn(fs, 'createReadStream'),
    spyOn(fsp, 'readFile'),
    spyOn(fsp, 'open'),
    spyOn(fsp, 'stat'),
    spyOn(fsp, 'lstat'),
    spyOn(fsp, 'access'),
    spyOn(fsp, 'realpath'),
    spyOn(fsp, 'readdir'),
  ]
  syncBuiltinESMExports()
  let inspected: string[] = []
  try {
    const vault = fakeVault()
    const cleanup = await setupGaActivation(
      fakeHost(join(root, 'project')),
      createGaLocationServicesForHost({
        readHostSlot: async () => undefined,
        connectionFile: () => join(root, 'vault-connection.json'),
        custody: { connect: vault.connect, pollIntervalMs: 50 },
      }),
    )
    cleanups.push(() => cleanup?.())
    await waitUntil(() => vault.counts.lists >= POLLS, `${POLLS} roster polls`)
    await cleanup?.()
    inspected = reads.flatMap((read) =>
      read.mock.calls
        .map((args) => String(args[0]))
        .filter((path) => path.includes('antigravity-accounts.json')),
    )
  } finally {
    for (const read of reads) read.mockRestore()
    syncBuiltinESMExports()
  }
  expect(inspected).toEqual([])
}, 60_000)

it('a vault-mode OpenCode 2 start and its roster polls cause no file events in the config folder', async () => {
  writeDormantLocalAccount()
  await approveInConfigFolder()
  // An earlier start moved the vault files; this one starts after it.
  const moved = join(
    runtimeLayoutLocation().stateHomeDir,
    'antigravity-auth-vault',
  )
  expect(
    (
      await prepareVaultFolder({
        accountFile: accountFile(),
        log: { info() {}, warn() {} },
      })
    ).vaultDir,
  ).toBe(moved)
  resetProcess()

  // Debug logging and the signature disk cache are on, at their defaults.
  const directory = join(root, 'project')
  mkdirSync(join(directory, '.opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, '.opencode', 'antigravity.json'),
    JSON.stringify({
      debug: true,
      keep_thinking: true,
      background_quota_refresh: false,
      proactive_token_refresh: false,
      auto_update: false,
    }),
  )

  const watched = watchFolder(configDir())
  cleanups.push(watched.close)
  // The watchers report events before the window opens.
  await probe(watched, 'before')
  const before = watched.events.length

  const vault = fakeVault()
  const cleanup = await setupGaActivation(
    fakeHost(directory),
    createGaLocationServicesForHost({
      readHostSlot: async () => undefined,
      connectionFile: () => join(root, 'vault-connection.json'),
      custody: { connect: vault.connect, pollIntervalMs: 50 },
    }),
  )
  expect(cleanup).toBeFunction()
  await waitUntil(() => vault.counts.lists >= POLLS, `${POLLS} roster polls`)
  await cleanup?.()
  // Late events from the cleanup's writes, if any, arrive by now.
  await sleep(300)

  const during = watched.events.slice(before)
  // The watchers were still working at the end of the window.
  await probe(watched, 'after')
  expect(during).toEqual([])

  // The files were written, just not in the config folder: the roster in the
  // moved vault folder, the debug log in the state home.
  expect(existsSync(join(moved, 'opencode-roster.json'))).toBe(true)
  const logs = join(root, 'state', 'cortexkit', 'antigravity-auth', 'logs')
  expect(readdirSync(logs).some((name) => name.endsWith('.log'))).toBe(true)
  // Vault mode never opened the local account store.
  expect(
    existsSync(
      join(configDir(), 'antigravity-accounts.json.store.pointer.json'),
    ),
  ).toBe(false)
}, 60_000)

it('a local-mode OpenCode 2 start, request and quota check cause no file events in the config folder after the store moves', async () => {
  const modules = await loadCommonAuthStoreModules()
  expect(
    (
      await initializeFreshAccountStore(modules, {
        legacyPath: accountFile(),
        now: Date.now,
      })
    ).status,
  ).toBe('completed')
  const binding = await readAccountStoreBinding(
    accountFile(),
    modules,
    Date.now,
  )
  if (binding.status !== 'bound')
    throw new Error(`seed store is ${binding.status}`)
  const seed = createAccountRepositoryFactory(modules)({
    paths: binding.paths,
    now: Date.now,
    exchange: async () => {
      throw new Error('seeding must not refresh credentials')
    },
  })
  try {
    await seed.login({
      id: '00000000-0000-4000-8000-000000000001',
      refreshToken: 'synthetic-local-events-refresh',
      metadata: {
        addedAt: 1,
        lastUsed: 0,
        managedProjectId: 'synthetic-local-project',
      },
    })
  } finally {
    await seed.dispose()
  }
  // Count the next start's activity, not the one-time move itself.
  await prepareVaultFolder({
    accountFile: accountFile(),
    log: { info() {}, warn() {} },
  })
  await prepareAccountStore({
    version: await pluginPackageVersion(),
    log: { info() {}, warn() {} },
  })
  resetProcess()

  const directory = join(root, 'project')
  mkdirSync(join(directory, '.opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, '.opencode', 'antigravity.json'),
    JSON.stringify({
      debug: true,
      keep_thinking: true,
      background_quota_refresh: false,
      proactive_token_refresh: false,
      auto_update: false,
    }),
  )
  const watched = watchFolder(configDir())
  cleanups.push(watched.close)
  await probe(watched, 'before')
  const before = watched.events.length

  let serving: GaServingServices | undefined
  let sends = 0
  let quotaChecks = 0
  const send = async () => {
    sends++
    return new Response(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"synthetic reply"}]},"finishReason":"STOP"}]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const factory = createGaLocationServicesForHost()
  const cleanup = await setupGaActivation(
    fakeHost(directory),
    async (input) => {
      const services = await factory(input)
      return {
        ...services,
        start: async (input) => {
          serving = await services.start(input)
          return serving
        },
      }
    },
    {
      send,
      refreshAccessToken: async () => ({
        type: 'success',
        access: 'synthetic-local-events-access',
        refresh: 'synthetic-local-events-refresh',
        expires: Date.now() + 3_600_000,
      }),
      quotaFetch: async () => {
        quotaChecks++
        return new Response(
          JSON.stringify({
            models: {
              'claude-sonnet-4-6': {
                quotaInfo: {
                  remainingFraction: 0.75,
                  resetTime: '2099-01-01T00:00:00Z',
                },
              },
            },
          }),
        )
      },
    },
  )
  cleanups.push(() => cleanup?.())
  expect(cleanup).toBeFunction()
  if (!serving) throw new Error('the local location did not start')
  const signal = new AbortController().signal
  const response = await serving.execute(
    {
      sessionID: 'local-events-session',
      parentSessionID: null,
      kind: 'primary',
      modelID: 'antigravity-gemini-3.8-flash',
      variant: null,
      url: 'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    },
    { signal, send },
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('synthetic reply')
  expect(sends).toBe(1)
  const checked = await serving.commands.apply({
    request: {
      command: 'antigravity',
      sectionId: 'quota',
      actionId: 'refresh',
    },
    scope: { kind: 'sessionless' },
    signal,
  })
  expect(checked.ok).toBe(true)
  expect(checked.text).toBe('Quota checked for 1 of 1 accounts')
  expect(quotaChecks).toBeGreaterThan(0)
  await sleep(2_500)
  await cleanup?.()
  await sleep(300)

  const during = watched.events.slice(before)
  await probe(watched, 'after')
  expect(during).toEqual([])
  expect(getStoragePath()).toBe(
    join(runtimeLayoutLocation().stateHomeDir, 'antigravity-accounts.json'),
  )
}, 60_000)
