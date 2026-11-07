// Each host entry point settles where its vault files live before it touches
// one (`vault-folder.ts`): the OpenCode 1 plugin start, the CLI's login, and
// disconnect, which clears what the move left behind. Real files in temporary
// folders, the real move (`runtime-layout.ts`), the real vault library, and
// the vault fixture daemon where a request is served. OpenCode 2 activations
// are covered in `ga/server/plugin.test.ts` and
// `plugin/ga-shared-vault-custody.test.ts`.
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  VAULT_ACCOUNT_REMEDY,
  vaultAuthority,
} from '@cortexkit/antigravity-auth-core'
import { createDefaultCliDependencies, runCliProcess } from './cli'
import { startMenuVaultFixture } from './plugin/__fixtures__/vault-menu-daemon.test'
import { ANTIGRAVITY_MENU_COMMAND } from './plugin/commands'
import { createAntigravityPlugin } from './plugin/index'
import type { PluginClient, PluginInput, Provider } from './plugin/types'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
} from './plugin/vault-custody'
import {
  __resetProcessHeartbeatForTest,
  processConfigFolderKey,
  processHeartbeatPath,
} from './process-heartbeat'
import { drainNotifications } from './rpc/notifications'
import {
  __resetRuntimeLayoutRunsForTest,
  localAccountStoreAuthorized,
} from './runtime-layout'
import {
  __resetRuntimeLayoutsForTest,
  runtimeLayoutLocation,
} from './runtime-paths'
import { createSetupPlugin } from './setup'
import {
  __resetVaultFoldersForTest,
  currentVaultFolder,
  prepareVaultFolder,
} from './vault-folder'
import * as fence from './version-fence'
import { processHeartbeatDir } from './version-fence'

const ENV = [
  'OPENCODE_CONFIG_DIR',
  'XDG_STATE_HOME',
  'ANTIGRAVITY_AUTH_RPC_DIR',
  'ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE',
  'SUBC_CONNECTION_FILE',
  'OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR',
] as const
const TOKEN_FILE = 'opencode-enrollment.json'
const STATE_FILE = 'opencode-enrollment-state.json'
const MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse'
const ACCESS_TOKEN = 'synthetic-vault-access'
const PROJECT_ID = 'synthetic-vault-project'
const quiet = { info() {}, warn() {} }

let root: string
let saved: Record<string, string | undefined>
let fetchSpy: ReturnType<typeof spyOn> | undefined
const cleanups: (() => Promise<unknown>)[] = []

/** Stands in for a new process: nothing decided, refused or recorded. */
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
  root = realpathSync(mkdtempSync(join(temporary, 'agy-layout-entry-')))
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    // Heartbeats and the move's folders stay inside this test's root.
    XDG_STATE_HOME: join(root, 'state'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(root, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
  })
  delete process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR
  resetProcess()
  const realFetch = globalThis.fetch
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        return url.hostname === '127.0.0.1'
          ? realFetch(input, init)
          : new Response('not-found', { status: 404 })
      }) as typeof fetch,
      { preconnect: realFetch.preconnect },
    ),
  )
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {})
  fetchSpy?.mockRestore()
  for (const name of ENV) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetProcess()
  rmSync(root, { recursive: true, force: true })
})

const accountFile = () => join(root, 'config', 'antigravity-accounts.json')
/** Where versions before the move keep the vault files. */
const legacyVault = () => join(root, 'config', 'antigravity-auth-vault')
/** Where the move puts them. */
const stateVault = () =>
  join(runtimeLayoutLocation().stateHomeDir, 'antigravity-auth-vault')
const marker = () => {
  const path = join(runtimeLayoutLocation().stateHomeDir, 'layout.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/** A dormant local login: serving it would mean a fallback to local accounts. */
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

/**
 * An approved enrollment in vault mode where a version before the move kept
 * it, through the real enrollment manager and token writer. With a daemon the
 * enrollment goes through it; otherwise a stand-in approves at once.
 */
async function enrollInConfigFolder(
  daemon?: Awaited<ReturnType<typeof startMenuVaultFixture>>,
  vaultDir = legacyVault(),
  approvedName: string = OPENCODE_VAULT_ENROLLMENT_NAME,
) {
  const custody = createOpenCodeVaultCustody({
    vaultDir,
    accountFile: accountFile(),
    reporterSource: 'direct',
    readHostSlot: async () => undefined,
    ...(daemon
      ? { connectionFile: () => daemon.connectionFile }
      : {
          connectEnrollment: async () => ({
            enrollPropose: async () => ({ requestId: 'request-1' }),
            enrollPoll: async () => ({
              status: 'approved' as const,
              name: approvedName,
              token: 'ab'.repeat(32),
              tokenGeneration: 1,
            }),
            close() {},
          }),
        }),
  })
  try {
    if (daemon) {
      expect((await custody.requestAccess()).state).toBe('pending')
      daemon.approve()
    }
    expect((await custody.requestAccess()).state).toBe('approved')
    await custody.useVault()
  } finally {
    await custody.dispose()
  }
  expect(existsSync(join(vaultDir, TOKEN_FILE))).toBe(true)
}

async function authorityAt(vaultDir: string) {
  const claustrum = await loadCommonAuthClaustrum()
  return vaultAuthority(
    claustrum.hostEnrollmentPaths({ stateDir: vaultDir, host: 'opencode' }),
    OPENCODE_VAULT_ENROLLMENT_NAME,
  )
}

function client(): PluginClient {
  return {
    app: { log: mock(async () => {}) },
    auth: { set: mock(async () => {}) },
    session: {
      abort: mock(async () => {}),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => {}),
    },
    tui: { showToast: mock(async () => {}) },
  } as unknown as PluginClient
}

/** Records each upstream request the plugin sends and answers it. */
function recordingTransport() {
  const bearers: (string | null)[] = []
  const transport = async (_url: string, init?: RequestInit) => {
    bearers.push(new Headers(init?.headers).get('authorization'))
    return new Response(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  return { bearers, transport }
}

/** Starts the OpenCode 1 plugin as OpenCode does, in a quiet project. */
async function startOpenCode1(
  transport: ReturnType<typeof recordingTransport>,
) {
  const directory = join(root, 'project')
  mkdirSync(join(directory, '.opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, '.opencode', 'antigravity.json'),
    JSON.stringify({
      background_quota_refresh: false,
      proactive_token_refresh: false,
      auto_update: false,
    }),
  )
  const plugin = await createAntigravityPlugin('google', {
    dependencies: {
      agyTransport: transport.transport as never,
    },
  })({
    client: client(),
    project: {} as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: mock(() => {}) },
    serverUrl: new URL('http://localhost:4096'),
    $: (() => {}) as unknown as PluginInput['$'],
  } as PluginInput)
  cleanups.push(async () => plugin.dispose?.())
  return plugin
}

type Plugin = Awaited<ReturnType<typeof startOpenCode1>>

/** One generate request through the plugin's auth loader. */
async function request(plugin: Plugin): Promise<Response> {
  const loaded = (await plugin.auth.loader(
    async () => {
      throw new Error('the host sign-in must not be read')
    },
    {
      id: 'google',
      name: 'Google',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    } as unknown as Provider,
  )) as unknown as { fetch: typeof fetch }
  return loaded.fetch(MODEL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
}

/** The heartbeat this process wrote, as other processes read it. */
const ownHeartbeat = () =>
  JSON.parse(readFileSync(processHeartbeatPath(process.pid), 'utf8'))

it('a vault-mode OpenCode 1 start moves the vault files and keeps serving without enrolling again', async () => {
  const daemon = await startMenuVaultFixture(root, {
    accessToken: ACCESS_TOKEN,
    projectId: PROJECT_ID,
  })
  cleanups.push(() => daemon.close())
  process.env.SUBC_CONNECTION_FILE = daemon.connectionFile
  writeDormantLocalAccount()
  await enrollInConfigFolder(daemon)
  const enrolledCalls = daemon.calls.length

  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)

  // Moved before the plugin used them, and the move finished.
  expect(existsSync(join(stateVault(), TOKEN_FILE))).toBe(true)
  expect(existsSync(join(stateVault(), 'opencode-mode.json'))).toBe(true)
  expect(existsSync(join(legacyVault(), TOKEN_FILE))).toBe(false)
  expect(marker()).toMatchObject({ oldFilesRemoved: true })
  expect(ownHeartbeat().layouts).toEqual({
    [processConfigFolderKey()]: 'state-home',
  })

  const response = await request(plugin)
  expect(response.status).toBe(200)
  expect(transport.bearers).toEqual([`Bearer ${ACCESS_TOKEN}`])
  const after = daemon.calls.slice(enrolledCalls)
  expect(after).toContain('credential.get_scoped')
  expect(after.filter((call) => call.startsWith('auth.enroll_'))).toEqual([])
  expect(daemon.errors).toEqual([])
}, 30_000)

it('a live legacy-layout process keeps an OpenCode 1 start on the vault files in the config folder', async () => {
  const daemon = await startMenuVaultFixture(root, {
    accessToken: ACCESS_TOKEN,
    projectId: PROJECT_ID,
  })
  cleanups.push(() => daemon.close())
  process.env.SUBC_CONNECTION_FILE = daemon.connectionFile
  await enrollInConfigFolder(daemon)
  const before = readFileSync(join(legacyVault(), TOKEN_FILE))
  // Another live process of this version on the old files: this test's
  // parent process stands in for it.
  const blocker = join(processHeartbeatDir(), `${process.ppid}.json`)
  mkdirSync(processHeartbeatDir(), { recursive: true, mode: 0o700 })
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  writeFileSync(
    blocker,
    JSON.stringify({
      pid: process.ppid,
      version: manifest.version,
      startedAt: Date.now(),
      layouts: { [processConfigFolderKey()]: 'legacy' },
    }),
  )
  cleanups.push(async () => rmSync(blocker, { force: true }))

  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)

  expect(readFileSync(join(legacyVault(), TOKEN_FILE))).toEqual(before)
  expect(existsSync(join(stateVault(), TOKEN_FILE))).toBe(false)
  expect(marker()).toBeUndefined()
  expect(ownHeartbeat().layouts).toEqual({
    [processConfigFolderKey()]: 'legacy',
  })
  // It serves from the files in the config folder, as before the move.
  expect((await request(plugin)).status).toBe(200)
  expect(transport.bearers).toEqual([`Bearer ${ACCESS_TOKEN}`])
}, 30_000)

it('an OpenCode 1 start that cannot settle the vault folder serves neither source and names both paths', async () => {
  writeDormantLocalAccount()
  await enrollInConfigFolder()
  // An earlier start moved the files.
  expect(
    (await prepareVaultFolder({ accountFile: accountFile(), log: quiet }))
      .refusal,
  ).toBeUndefined()
  // An older version enrolled again in the config folder since.
  resetProcess()
  copyFileSync(join(stateVault(), TOKEN_FILE), join(legacyVault(), TOKEN_FILE))
  chmodSync(join(legacyVault(), TOKEN_FILE), 0o600)
  const conflict = `vault files conflict between ${join(legacyVault(), TOKEN_FILE)} and ${join(stateVault(), TOKEN_FILE)}`

  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)

  // No local sign-in is offered, and a request gets the host's error, which
  // names both copies rather than giving the generic vault advice.
  expect(plugin.auth.methods).toEqual([])
  const refusal = await request(plugin).then(
    () => 'served',
    (failure: unknown) => String((failure as Error).message),
  )
  expect(refusal).toContain(conflict)
  expect(refusal).not.toContain(VAULT_ACCOUNT_REMEDY)
  expect(transport.bearers).toEqual([])
  // The menu says why, naming both copies.
  const sessionID = 'unsettled-vault-session'
  await expect(
    plugin['command.execute.before']?.(
      { command: ANTIGRAVITY_MENU_COMMAND, arguments: '', sessionID },
      { parts: [] },
    ),
  ).rejects.toThrow()
  const menu = JSON.stringify(await drainNotifications(0, sessionID))
  expect(menu).toContain(conflict)
  expect(menu).not.toContain('synthetic-dormant-local')
  // Both copies stay for the user to choose from.
  expect(existsSync(join(legacyVault(), TOKEN_FILE))).toBe(true)
  expect(existsSync(join(stateVault(), TOKEN_FILE))).toBe(true)
}, 30_000)

/** Words that only make sense to a host that uses a vault. */
const VAULT_ADVICE = [VAULT_ACCOUNT_REMEDY, 'enroll', 'Enroll', 'ck auth']

/**
 * What a local-mode OpenCode 1 host shows while its vault folder is
 * unsettled: the request error, the menu and the sidebar, as text.
 */
async function unsettledLocalHostTexts(sessionID: string) {
  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)
  const error = await request(plugin).then(
    () => {
      throw new Error('the request was served')
    },
    (failure: unknown) => String((failure as Error).message),
  )
  expect(transport.bearers).toEqual([])
  await expect(
    plugin['command.execute.before']?.(
      { command: ANTIGRAVITY_MENU_COMMAND, arguments: '', sessionID },
      { parts: [] },
    ),
  ).rejects.toThrow()
  const menu = JSON.stringify(await drainNotifications(0, sessionID))
  await plugin.dispose?.()
  const sidebar = readFileSync(join(root, 'sidebar.json'), 'utf8')
  return { error, menu, sidebar }
}

it('a local-mode host with a malformed layout.json is told to check the old vault files and delete layout.json, with no vault advice', async () => {
  writeDormantLocalAccount()
  const markerPath = join(runtimeLayoutLocation().stateHomeDir, 'layout.json')
  mkdirSync(runtimeLayoutLocation().stateHomeDir, {
    recursive: true,
    mode: 0o700,
  })
  writeFileSync(markerPath, '{ not json', { mode: 0o600 })

  const { error, menu, sidebar } =
    await unsettledLocalHostTexts('malformed-marker')

  const remedy = `${markerPath} is malformed`
  const deleteIt = `If they are, delete ${markerPath}, then restart OpenCode`
  for (const text of [error, menu, sidebar]) {
    // The sidebar and menu are JSON, so compare against JSON-escaped text.
    const escaped = (value: string) => JSON.stringify(value).slice(1, -1)
    expect(text.includes(remedy) || text.includes(escaped(remedy))).toBe(true)
    expect(text.includes(deleteIt) || text.includes(escaped(deleteIt))).toBe(
      true,
    )
    for (const advice of VAULT_ADVICE) expect(text).not.toContain(advice)
  }
  expect(menu).not.toContain('synthetic-dormant-local')
  // Nothing was changed to recover by itself.
  expect(readFileSync(markerPath, 'utf8')).toBe('{ not json')
}, 30_000)

it('a local-mode host that timed out on the layout lock is told another OpenCode is moving the files, with no vault advice', async () => {
  writeDormantLocalAccount()
  const stateDir = runtimeLayoutLocation().stateHomeDir
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const fs = await loadCommonAuthFs()
  const held = await fs.acquireRefreshFileLock({
    name: 'runtime-layout',
    path: join(stateDir, 'layout.json'),
    ttlMs: 10_000,
    renew: true,
  })
  expect(held).not.toBeNull()
  cleanups.push(async () => held?.release())
  // The start's wait for the lock ends; the process keeps that refusal, so
  // the plugin start below reports it at once.
  expect(
    (
      await prepareVaultFolder({
        accountFile: accountFile(),
        log: quiet,
        layoutLockWaitMs: 100,
      })
    ).refusal?.errorClass,
  ).toBe('lock-timeout')

  const { error, menu, sidebar } = await unsettledLocalHostTexts('lock-timeout')

  for (const text of [error, menu, sidebar]) {
    expect(text).toContain('for the runtime-layout lock at')
    expect(text).toContain(
      'Try again, or restart OpenCode, once that OpenCode has finished the move.',
    )
    for (const advice of VAULT_ADVICE) expect(text).not.toContain(advice)
  }
}, 30_000)

it('disconnect after a move removes the state the move left, and an older version then reads local', async () => {
  await enrollInConfigFolder()
  const folder = await prepareVaultFolder({
    accountFile: accountFile(),
    log: quiet,
  })
  expect(folder.vaultDir).toBe(stateVault())
  // The move left the approved state so older versions kept vault mode.
  expect(existsSync(join(legacyVault(), STATE_FILE))).toBe(true)
  expect(await authorityAt(legacyVault())).toBe('vault')
  // Custody as the OpenCode 1 plugin builds it.
  const custody = createOpenCodeVaultCustody({
    vaultDir: folder.vaultDir,
    accountFile: accountFile(),
    reporterSource: 'direct',
    readHostSlot: async () => undefined,
  })
  cleanups.push(() => custody.dispose())
  await custody.useLocal()
  expect(await authorityAt(stateVault())).toBe('local')
  expect(existsSync(join(legacyVault(), STATE_FILE))).toBe(false)
  expect(await authorityAt(legacyVault())).toBe('local')
})

it('CLI login moves the vault files first and still refuses a local sign-in for a vault-enrolled host', async () => {
  await enrollInConfigFolder()
  const output = { stdout: '', stderr: '' }
  const code = await runCliProcess(['login', '--no-browser'], {
    ...createDefaultCliDependencies(),
    stdout: { write: (value: string) => (output.stdout += value) },
    stderr: { write: (value: string) => (output.stderr += value) },
  })
  expect(code).toBe(1)
  expect(output.stderr).toContain('Vault enrollment excludes local sign-in')
  expect(existsSync(join(stateVault(), TOKEN_FILE))).toBe(true)
  expect(existsSync(join(legacyVault(), TOKEN_FILE))).toBe(false)
  expect(marker()).toMatchObject({ oldFilesRemoved: true })
  // The CLI's heartbeat goes with the command.
  expect(existsSync(processHeartbeatPath(process.pid))).toBe(false)
})

/** Read the approved identity in a fresh host with wholly separate roots. */
async function sharedEnrollmentInChild(home: string, vaultDir: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const {prepareVaultFolder} = await import('./vault-folder.ts');
       const {accountFileForVault} = await import('./plugin/storage.ts');
       const {createOpenCodeVaultCustody} = await import('./plugin/vault-custody.ts');
       const folder = await prepareVaultFolder({accountFile: accountFileForVault()});
       if (folder.refusal) throw folder.refusal;
       const custody = createOpenCodeVaultCustody({...folder, reporterSource: 'direct', readHostSlot: async () => undefined});
       try { console.log(JSON.stringify({folder, status: await custody.status(), principal: custody.grantPrincipal()})); }
       finally { await custody.dispose(); }`,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'),
        OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: vaultDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`shared enrollment child failed: ${stderr}`)
  return JSON.parse(stdout)
}

it('two real processes with different HOME and XDG roots read one approved override enrollment', async () => {
  const vaultDir = join(root, 'shared-vault')
  const approvedName = 'antigravity-auth-opencode-runner'
  await enrollInConfigFolder(undefined, vaultDir, approvedName)
  const token = readFileSync(join(vaultDir, TOKEN_FILE))
  const first = await sharedEnrollmentInChild(join(root, 'host-a'), vaultDir)
  const second = await sharedEnrollmentInChild(join(root, 'host-b'), vaultDir)
  for (const host of [first, second]) {
    expect(host.folder.vaultDir).toBe(vaultDir)
    expect(host.status.enrollment).toMatchObject({
      state: 'approved',
      approvedName,
    })
    expect(host.principal).toBe(approvedName)
  }
  expect(first.folder.accountFile).not.toBe(second.folder.accountFile)
  expect(readFileSync(join(vaultDir, TOKEN_FILE))).toEqual(token)
  expect(existsSync(join(root, 'host-a', 'state'))).toBe(false)
  expect(existsSync(join(root, 'host-b', 'state'))).toBe(false)
}, 30_000)

it('OpenCode 1 startup serves the approved override instead of a config-folder enrollment', async () => {
  const daemon = await startMenuVaultFixture(root, {
    accessToken: ACCESS_TOKEN,
    projectId: PROJECT_ID,
  })
  cleanups.push(() => daemon.close())
  process.env.SUBC_CONNECTION_FILE = daemon.connectionFile
  const vaultDir = join(root, 'shared-vault')
  await enrollInConfigFolder(daemon, vaultDir)
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = vaultDir
  writeDormantLocalAccount()
  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)
  expect((await request(plugin)).status).toBe(200)
  expect(await localAccountStoreAuthorized()).toBe(false)
  expect(transport.bearers).toEqual([`Bearer ${ACCESS_TOKEN}`])
  expect(marker()).toBeUndefined()
  expect(existsSync(legacyVault())).toBe(false)
}, 30_000)

it('a relative override refuses OpenCode 1 for the process lifetime without creating files', async () => {
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = 'relative-vault'
  const initial = readdirSync(root)
  const folder = await prepareVaultFolder({
    accountFile: accountFile(),
    log: quiet,
  })
  expect(folder.refusal?.message).toContain(
    'OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR must be an absolute path',
  )
  expect(readdirSync(root)).toEqual(initial)
  expect(readdirSync(join(root, 'config'))).toEqual([])
  delete process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR
  expect(currentVaultFolder(accountFile()).refusal).toBe(folder.refusal)
  expect(
    (await prepareVaultFolder({ accountFile: accountFile(), log: quiet }))
      .refusal,
  ).toBe(folder.refusal)
  const transport = recordingTransport()
  const plugin = await startOpenCode1(transport)
  await expect(request(plugin)).rejects.toThrow(
    'OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR must be an absolute path',
  )
  expect(transport.bearers).toEqual([])
  expect(existsSync(legacyVault())).toBe(false)
  expect(marker()).toBeUndefined()
}, 30_000)

it('an empty override behaves exactly as unset', async () => {
  const unset = currentVaultFolder(accountFile())
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = ''
  expect(currentVaultFolder(accountFile())).toEqual(unset)
  const preparedEmpty = await prepareVaultFolder({
    accountFile: accountFile(),
    log: quiet,
  })
  delete process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR
  expect(
    await prepareVaultFolder({ accountFile: accountFile(), log: quiet }),
  ).toEqual(preparedEmpty)
  expect(preparedEmpty.refusal).toBeUndefined()
  expect(preparedEmpty.vaultDir).toBe(stateVault())
})

it('an override leaves old vault bytes alone, bypasses the layout fence and creates a private folder', async () => {
  await enrollInConfigFolder()
  const old = Object.fromEntries(
    readdirSync(legacyVault()).map((name) => [
      name,
      readFileSync(join(legacyVault(), name)),
    ]),
  )
  const vaultDir = join(root, 'nested', 'shared-vault')
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = vaultDir
  const gate = spyOn(fence, 'versionFenceOpen').mockImplementation(async () => {
    throw new Error('vault layout fence must not run')
  })
  try {
    expect(currentVaultFolder(accountFile()).vaultDir).toBe(vaultDir)
    expect(existsSync(vaultDir)).toBe(false)
    const folder = await prepareVaultFolder({
      accountFile: accountFile(),
      log: quiet,
      accountStore: false,
    })
    expect(folder).toEqual({ accountFile: accountFile(), vaultDir })
    expect(await localAccountStoreAuthorized()).toBe(true)
    expect(gate).not.toHaveBeenCalled()
    expect(marker()).toBeUndefined()
    expect(existsSync(join(vaultDir, 'layout.json'))).toBe(false)
    expect(readdirSync(legacyVault()).sort()).toEqual(Object.keys(old).sort())
    for (const [name, bytes] of Object.entries(old))
      expect(readFileSync(join(legacyVault(), name))).toEqual(bytes)
    if (process.platform !== 'win32')
      expect(statSync(vaultDir).mode & 0o777).toBe(0o700)
  } finally {
    gate.mockRestore()
  }
})

it('CLI login and setup real-run callbacks use the override while setup preview does not create it', async () => {
  const vaultDir = join(root, 'shared-vault')
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = vaultDir
  const deps = createDefaultCliDependencies()
  deps.prepareVaultFolder = async (options) => {
    const folder = await prepareVaultFolder({
      accountFile: accountFile(),
      log: quiet,
      ...options,
    })
    if (folder.refusal) throw folder.refusal
  }
  let output = ''
  deps.stderr = {
    write: (value) => {
      output += value
    },
  }
  deps.stdout = { write() {} }
  const plugin = await createSetupPlugin(deps, async () => 0)
  expect(plugin.vault.hosts.opencode.paths.stateDir).toBe(vaultDir)
  expect(existsSync(vaultDir)).toBe(false)
  await plugin.beforeSignIn?.('opencode', {
    hosts: ['opencode'],
    mode: 'claustrum',
    opencodeGeneration: '2',
    piAgentDir: join(root, 'pi'),
  })
  expect(existsSync(vaultDir)).toBe(true)
  await enrollInConfigFolder(
    undefined,
    vaultDir,
    'antigravity-auth-opencode-runner',
  )
  await plugin.beforeRegister?.('opencode', 'claustrum', {
    hosts: ['opencode'],
    mode: 'claustrum',
    opencodeGeneration: '2',
    piAgentDir: join(root, 'pi'),
  })
  expect(await runCliProcess(['login', '--no-browser'], deps)).toBe(1)
  expect(output).toContain('Vault enrollment excludes local sign-in')
  expect(marker()).toBeUndefined()
  expect(existsSync(legacyVault())).toBe(false)
}, 30_000)

it('disconnect with an override at the old move destination never deletes config-folder vault files', async () => {
  await enrollInConfigFolder()
  const moved = await prepareVaultFolder({
    accountFile: accountFile(),
    log: quiet,
  })
  expect(moved.refusal).toBeUndefined()
  const keptState = readFileSync(join(legacyVault(), STATE_FILE))
  process.env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR = moved.vaultDir
  const custody = createOpenCodeVaultCustody({
    vaultDir: moved.vaultDir,
    accountFile: accountFile(),
    reporterSource: 'direct',
    readHostSlot: async () => undefined,
  })
  try {
    await custody.useLocal()
  } finally {
    await custody.dispose()
  }
  expect(readFileSync(join(legacyVault(), STATE_FILE))).toEqual(keptState)
})
