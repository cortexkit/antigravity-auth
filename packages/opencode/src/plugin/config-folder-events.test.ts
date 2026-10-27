/**
 * OpenCode 2 watches its config folder, so the plugin must not write there
 * while it runs in vault mode: no vault files, locks or staged files, no
 * signature cache, no debug log, no `.gitignore`, and no local account store.
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
import { afterEach, beforeEach, expect, it } from 'bun:test'
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
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { GaHostContext } from '../ga/server/index.ts'
import { setupGaActivation } from '../ga/server/index.ts'
import { __resetProcessHeartbeatForTest } from '../process-heartbeat.ts'
import { __resetRuntimeLayoutRunsForTest } from '../runtime-layout.ts'
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
