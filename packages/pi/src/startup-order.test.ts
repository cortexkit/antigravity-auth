import { expect, it, mock } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as actualCore from '@cortexkit/antigravity-auth-core'
import type { ClaustrumScopedClient } from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { PI_ANTIGRAVITY_ENROLLMENT_NAME, PiVaultSetup } from './vault-setup.ts'

const bearer = 'synthetic-native-request-vault-token'
const events: string[] = []
const sent: Array<{ authorization: string | null; body: string }> = []
const localRefresh = mock(actualCore.refreshAntigravityToken)
const localProject = mock(actualCore.ensureProjectContext)
const physicalTransport: typeof actualCore.fetchWithAgyCliTransport = async (
  _url,
  init,
) => {
  events.push('request:physical')
  sent.push({
    authorization: new Headers(init?.headers).get('authorization'),
    body: String(init?.body),
  })
  return new Response(
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"PI_STARTUP_OK"}]},"finishReason":"STOP"}]}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
mock.module('@cortexkit/antigravity-auth-core', () => ({
  ...actualCore,
  refreshAntigravityToken: localRefresh,
  ensureProjectContext: localProject,
  fetchWithAgyCliTransport: physicalTransport,
}))

const client: ClaustrumScopedClient = {
  listScoped: async () => ({
    view: 'startup-view',
    rows: [
      {
        id: 'cred-a',
        categories: ['antigravity-native'],
        credentialType: 'oauth',
        serves: [],
        providerIds: [],
        refreshAdapter: 'antigravity',
        state: 'active',
        recordVersion: 1,
        operations: ['read'],
        createdAtMs: null,
        accountId: 'account-a',
        email: 'synthetic@example.test',
      },
    ],
    grants: undefined,
    grantTuples: undefined,
  }),
  getScoped: async (input) => {
    expect(input.credentialId).toBe('cred-a')
    expect(input.minTtlMs).toBe(300_000)
    return {
      material: bearer,
      recordVersion: 1,
      expiresAtMs: Date.now() + 3_600_000,
      credentialId: 'cred-a',
      projectId: 'synthetic-vault-project',
      accountId: 'account-a',
    }
  },
  reportAuthFailureScoped: async () => {},
  close: () => {},
}

it.each([
  {
    name: 'awaits the native slot swap before the real Pi loader resolves its first google model request',
    transition: 'enter',
  },
  {
    name: 'clears the vault marker and legacy stash before the real Pi loader starts in local mode',
    transition: 'cleared',
  },
  {
    name: 'leaves an existing local Google login unchanged in the real Pi loader',
    transition: 'nothing-to-do',
  },
  {
    name: 'refuses the leftover vault placeholder locally with a sign-in message in the real Pi loader',
    transition: 'leftover',
  },
])('$name', async ({ transition }) => {
  const directory = await mkdtemp(
    join(
      process.platform === 'win32' ? tmpdir() : '/tmp',
      'antigravity-pi-startup-',
    ),
  )
  const agentDir = join(directory, 'native-agent')
  const vaultDir = join(directory, 'plugin-vault')
  const modeFile = join(vaultDir, 'pi-mode.json')
  const authPath = join(agentDir, 'auth.json')
  const stashPath = join(vaultDir, 'google-login-stash.json')
  const key = Symbol.for('antigravity.pi.startup.fixture')
  const previous = new Map(
    [
      'HOME',
      'PI_CODING_AGENT_DIR',
      'PI_AGENT_DIR',
      'PI_ANTIGRAVITY_AUTH_FILE',
      'PI_OFFLINE',
    ].map((name) => [name, process.env[name]]),
  )
  let session: AgentSession | undefined
  const savedFetch = globalThis.fetch
  let nativeRefreshes = 0
  const original = {
    type: 'oauth',
    access: 'synthetic-expired-local-access',
    refresh: 'synthetic-local-refresh|synthetic-local-project',
    expires: 1,
  }
  try {
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (
        url.hostname === 'oauth2.googleapis.com' ||
        url.hostname === 'accounts.google.com'
      )
        nativeRefreshes++
      throw new Error('The owned Pi startup fixture refuses network fetches')
    }, savedFetch)
    events.length = 0
    sent.length = 0
    localRefresh.mockClear()
    localProject.mockClear()
    process.env.PI_OFFLINE = '1'
    process.env.HOME = directory
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_AGENT_DIR = join(directory, 'decoy-extension-agent')
    process.env.PI_ANTIGRAVITY_AUTH_FILE = join(
      directory,
      'plugin-accounts.json',
    )
    await mkdir(join(agentDir, 'extensions'), { recursive: true, mode: 0o700 })
    await mkdir(vaultDir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'google',
        defaultModel: 'antigravity-gemini-3.8-flash',
      }),
      { mode: 0o600 },
    )
    await writeFile(authPath, JSON.stringify({ google: original }), {
      mode: 0o600,
    })
    const claustrum = await actualCore.loadCommonAuthClaustrum()
    const setup = new PiVaultSetup({
      claustrum,
      stateDir: vaultDir,
      modeFile,
      readHostSlot: () => {
        throw new Error('Approved vault setup read the native OAuth login')
      },
      connectEnrollment: async () => ({
        enrollPropose: async () => ({ requestId: 'startup-enrollment' }),
        enrollPoll: async () => ({
          status: 'approved',
          name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
          token: 'b'.repeat(64),
          tokenGeneration: 1,
        }),
        close: () => {},
      }),
    })
    if (transition === 'enter')
      expect((await setup.connectStep()).state).toBe('approved')
    const slotModule = await actualCore.loadCommonAuthPiSlot()
    if (transition === 'cleared' || transition === 'leftover') {
      await slotModule
        .openPiSlot({
          authPath,
          stashPath,
          provider: 'google',
          placeholderKey: 'antigravity-vault-custody',
        })
        .enterVault()
    }
    if (transition !== 'leftover')
      await writeFile(stashPath, 'legacy credentials, not JSON', {
        mode: 0o600,
      })
    const authBefore = await readFile(authPath, 'utf8')
    const statBefore = await stat(authPath)
    const loadPiSlot: typeof actualCore.loadCommonAuthPiSlot = async () => ({
      ...slotModule,
      openPiSlot: (options) => {
        const slot = slotModule.openPiSlot(options)
        return {
          ...slot,
          enterVault: async () => {
            events.push('slot:start')
            await slot.enterVault()
            events.push('slot:end')
          },
          exitVault: async () => {
            events.push('slot:start')
            try {
              // Simulate an interrupted synchronization that leaves the marker.
              if (transition === 'leftover') return 'nothing-to-do'
              return await slot.exitVault()
            } finally {
              events.push('slot:end')
            }
          },
        }
      },
    })
    Reflect.set(globalThis, key, { events, client, loadPiSlot })
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
    await writeFile(
      join(agentDir, 'extensions', 'observe.ts'),
      `
import { registerCortexKitPiAntigravity } from ${JSON.stringify(entry)}
export default async function(pi) {
  const fixture = Reflect.get(globalThis, Symbol.for('antigravity.pi.startup.fixture'))
  if (!fixture) throw new Error('Owned startup fixture missing')
  fixture.events.push('factory:start')
  await registerCortexKitPiAntigravity(pi, {
    vaultDir: ${JSON.stringify(vaultDir)}, modeFile: ${JSON.stringify(modeFile)},
    rosterFile: ${JSON.stringify(join(vaultDir, 'roster.json'))},
    nativeStashPath: ${JSON.stringify(stashPath)},
    connect: async () => fixture.client, loadPiSlot: fixture.loadPiSlot,
    readHostSlot: () => { throw new Error('Vault activation read a dormant native login') },
  })
  fixture.events.push('factory:end')
}
`,
      { mode: 0o600 },
    )
    const created = await createAgentSession({
      cwd: directory,
      agentDir,
      sessionManager: SessionManager.inMemory(directory),
      noTools: 'all',
    })
    session = created.session
    expect(created.extensionsResult.errors).toEqual([])
    expect(
      created.extensionsResult.extensions.flatMap((extension) => [
        ...extension.commands.keys(),
      ]),
    ).toContain('antigravity')
    expect(events.indexOf('slot:end')).toBeGreaterThan(
      events.indexOf('factory:start'),
    )
    expect(events.indexOf('slot:end')).toBeLessThan(
      events.indexOf('factory:end'),
    )
    const native = JSON.parse(await readFile(authPath, 'utf8'))
    if (transition === 'nothing-to-do') expect(native.google).toEqual(original)
    else if (transition === 'cleared') expect(native.google).toBeUndefined()
    else
      expect(native.google).toEqual({
        type: 'api_key',
        key: 'antigravity-vault-custody',
      })
    expect(existsSync(stashPath)).toBe(false)
    await session.bindExtensions({})
    if (transition === 'cleared' || transition === 'nothing-to-do') {
      if (transition === 'nothing-to-do') {
        expect(await readFile(authPath, 'utf8')).toBe(authBefore)
        expect((await stat(authPath)).ino).toBe(statBefore.ino)
        expect((await stat(authPath)).mtimeMs).toBe(statBefore.mtimeMs)
      }
      expect(localRefresh).not.toHaveBeenCalled()
      expect(nativeRefreshes).toBe(0)
      expect(sent).toHaveLength(0)
      return
    }
    const model = (await session.modelRuntime.getAvailable('google')).find(
      (model) => model.id === 'antigravity-gemini-3.8-flash',
    )
    expect(model).toBeDefined()
    if (!model)
      throw new Error(
        'The real Pi runtime did not offer google/antigravity-gemini-3.8-flash',
      )
    const response = await session.modelRuntime
      .streamSimple(model, {
        messages: [
          { role: 'user', content: 'startup-owned-nonce', timestamp: 0 },
        ],
      })
      .result()
    if (transition === 'leftover') {
      expect(response.stopReason).toBe('error')
      expect(response.errorMessage).toBe(
        'Pi is no longer using the vault. Sign in to Google again with /login google.',
      )
      expect(sent).toHaveLength(0)
      expect(await readFile(authPath, 'utf8')).toBe(authBefore)
      const statAfter = await stat(authPath)
      expect(statAfter.ino).toBe(statBefore.ino)
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    } else {
      expect(response.stopReason).toBe('stop')
      expect(sent).toHaveLength(1)
      expect(sent[0]?.authorization).toBe(`Bearer ${bearer}`)
      expect(sent[0]?.body).toContain('startup-owned-nonce')
      expect(sent[0]?.body).toContain('synthetic-vault-project')
      expect(sent[0]?.body).not.toContain(original.access)
      expect(sent[0]?.body).not.toContain(original.refresh)
      expect(events.indexOf('request:physical')).toBeGreaterThan(
        events.indexOf('factory:end'),
      )
    }
    expect(localRefresh).not.toHaveBeenCalled()
    expect(nativeRefreshes).toBe(0)
    expect(localProject).not.toHaveBeenCalled()
  } finally {
    try {
      await session?.dispose()
    } finally {
      globalThis.fetch = savedFetch
      Reflect.deleteProperty(globalThis, key)
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
})

const recoveryKey = Symbol.for('antigravity.pi.startup.recovery.fixture')

// Pretty-printed with a neighbour so any re-serialization changes the bytes.
const NATIVE_AUTH = `{
  "google": { "type": "oauth", "access": "synthetic-native-access", "refresh": "synthetic-native-refresh|synthetic-native-project", "expires": 1 },
  "anthropic": { "type": "api_key", "key": "synthetic-neighbour" }
}
`

interface OwnedPiHome {
  directory: string
  agentDir: string
  vaultDir: string
  modeFile: string
  authPath: string
  stashPath: string
  statePath: string
}

/**
 * Lockout states the real Pi loader must survive with /antigravity and a
 * refusing google provider registered. Each writes synthetic owner-only files:
 * the enrollment state file, the mode file and Pi's auth.json. An unsafe legacy
 * credential path must also refuse. The extension must not overwrite auth.json; only the
 * Vault section, /login or /logout may change them.
 */
const LOCKOUTS: Array<{
  name: string
  prepare: (home: OwnedPiHome) => Promise<void>
  /** Text of the synchronization error the session_start handler reports. */
  reason: string
  /**
   * Text of the request failure. With no native OAuth entry, Pi reaches the
   * extension's stream and the extension refuses. With a native OAuth entry,
   * Pi itself finds no usable auth for a provider without OAuth and refuses
   * before the stream runs.
   */
  refusal: string
}> = [
  {
    name: 'an unreadable enrollment state beside a native login',
    prepare: async (home) => {
      await writeFile(home.statePath, '{ torn', { mode: 0o600 })
      await writeFile(home.authPath, NATIVE_AUTH, { mode: 0o600 })
    },
    reason: 'cannot be read',
    refusal: 'Provider is not configured: google',
  },
  {
    name: 'custody mode with no enrollment and no native login',
    prepare: async (home) => {
      await writeFile(
        home.modeFile,
        JSON.stringify({ version: 1, mode: 'custody' }),
        { mode: 0o600 },
      )
      await writeFile(home.authPath, '{}\n', { mode: 0o600 })
    },
    reason: 'must be approved',
    refusal: 'must be approved',
  },
  {
    name: 'an unsafe legacy Google login path',
    prepare: async (home) => {
      await writeFile(home.authPath, NATIVE_AUTH, { mode: 0o600 })
      await mkdir(home.stashPath, { mode: 0o700 })
    },
    reason:
      'antigravity-auth could not update the host credential slot. Check the plugin log for details.',
    refusal: 'Provider is not configured: google',
  },
]

for (const lockout of LOCKOUTS)
  it(`the real Pi loader keeps /antigravity and refuses google requests for ${lockout.name}`, async () => {
    const directory = await mkdtemp(
      join(
        process.platform === 'win32' ? tmpdir() : '/tmp',
        'antigravity-pi-recovery-',
      ),
    )
    const agentDir = join(directory, 'native-agent')
    const vaultDir = join(directory, 'plugin-vault')
    const claustrum = await actualCore.loadCommonAuthClaustrum()
    const home: OwnedPiHome = {
      directory,
      agentDir,
      vaultDir,
      modeFile: join(vaultDir, 'pi-mode.json'),
      authPath: join(agentDir, 'auth.json'),
      stashPath: join(vaultDir, 'google-login-stash.json'),
      statePath: claustrum.hostEnrollmentPaths({
        stateDir: vaultDir,
        host: 'pi',
      }).statePath,
    }
    const previous = new Map(
      [
        'HOME',
        'PI_CODING_AGENT_DIR',
        'PI_AGENT_DIR',
        'PI_ANTIGRAVITY_AUTH_FILE',
        'PI_OFFLINE',
      ].map((name) => [name, process.env[name]]),
    )
    let session: AgentSession | undefined
    const savedFetch = globalThis.fetch
    let fetches = 0
    try {
      globalThis.fetch = Object.assign(async () => {
        fetches++
        throw new Error('The owned Pi recovery fixture refuses network fetches')
      }, savedFetch)
      events.length = 0
      sent.length = 0
      localRefresh.mockClear()
      localProject.mockClear()
      process.env.PI_OFFLINE = '1'
      process.env.HOME = directory
      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.PI_AGENT_DIR = join(directory, 'decoy-extension-agent')
      process.env.PI_ANTIGRAVITY_AUTH_FILE = join(
        directory,
        'plugin-accounts.json',
      )
      await mkdir(join(agentDir, 'extensions'), {
        recursive: true,
        mode: 0o700,
      })
      await mkdir(vaultDir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'google',
          defaultModel: 'antigravity-gemini-3.8-flash',
        }),
        { mode: 0o600 },
      )
      await lockout.prepare(home)
      const nativeBefore = await readFile(home.authPath, 'utf8')
      const stashBefore = await readFile(home.stashPath, 'utf8').catch(
        () => undefined,
      )
      Reflect.set(globalThis, recoveryKey, { events })
      const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
      await writeFile(
        join(agentDir, 'extensions', 'observe.ts'),
        `
import { registerCortexKitPiAntigravity } from ${JSON.stringify(entry)}
export default async function(pi) {
  const fixture = Reflect.get(globalThis, Symbol.for('antigravity.pi.startup.recovery.fixture'))
  if (!fixture) throw new Error('Owned recovery fixture missing')
  // Record the order of real registrations without changing what Pi receives.
  const observed = new Proxy(pi, {
    get(target, name) {
      const value = Reflect.get(target, name)
      if (name === 'registerProvider' || name === 'registerCommand')
        return (id, config) => {
          fixture.events.push(name + ':' + id)
          return value.call(target, id, config)
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await registerCortexKitPiAntigravity(observed, {
    vaultDir: ${JSON.stringify(vaultDir)}, modeFile: ${JSON.stringify(home.modeFile)},
    rosterFile: ${JSON.stringify(join(vaultDir, 'roster.json'))},
    nativeStashPath: ${JSON.stringify(home.stashPath)},
    connect: async () => { throw new Error('Recovery opened a vault connection') },
    connectEnrollment: async () => { throw new Error('Recovery opened an enrollment connection') },
    readHostSlot: () => { throw new Error('Recovery read the native login') },
  })
  fixture.events.push('factory:end')
}
`,
        { mode: 0o600 },
      )
      const created = await createAgentSession({
        cwd: directory,
        agentDir,
        sessionManager: SessionManager.inMemory(directory),
        noTools: 'all',
      })
      session = created.session
      const loaded = [...events]
      // Pi's own session start retries the synchronization; it still fails.
      const hostErrors: Array<{ event?: string; error: string }> = []
      await session.bindExtensions({
        onError: (error) => {
          hostErrors.push(error)
        },
      })
      // One comparison so a failed load shows every consequence at once: the
      // load error, the missing menu, and Pi's built-in Google catalog left
      // active instead of the extension's refusing provider.
      expect({
        errors: created.extensionsResult.errors.map((error) => error.error),
        commands: created.extensionsResult.extensions.flatMap((extension) => [
          ...extension.commands.keys(),
        ]),
        registrations: loaded,
        builtInGoogle: session.modelRuntime
          .getModels('google')
          .filter((model) => !model.id.startsWith('antigravity-'))
          .map((model) => model.id),
      }).toEqual({
        errors: [],
        commands: ['antigravity'],
        registrations: [
          'registerProvider:google',
          'registerCommand:antigravity',
          'factory:end',
        ],
        builtInGoogle: [],
      })
      // The host caught the failed session_start synchronization and reported
      // it; the menu is still a registered command afterwards.
      expect(
        hostErrors.map((error) => ({
          event: error.event,
          reported: error.error.includes(lockout.reason),
        })),
      ).toEqual([{ event: 'session_start', reported: true }])
      expect(hostErrors[0]?.error).not.toContain('unsafe-path')
      expect(session.extensionRunner.getCommand('antigravity')).toBeDefined()
      expect(session.modelRuntime.getModels('google').length).toBeGreaterThan(0)
      const model = session.modelRuntime.getModel(
        'google',
        'antigravity-gemini-3.8-flash',
      )
      if (!model) throw new Error('The real Pi runtime lost the google model')
      const response = await session.modelRuntime
        .streamSimple(model, {
          messages: [
            { role: 'user', content: 'recovery-owned-nonce', timestamp: 0 },
          ],
        })
        .result()
      expect(response.stopReason).toBe('error')
      expect(response.errorMessage).toContain(lockout.refusal)
      expect(sent).toHaveLength(0)
      expect(fetches).toBe(0)
      expect(localRefresh).not.toHaveBeenCalled()
      expect(localProject).not.toHaveBeenCalled()
      expect(await readFile(home.authPath, 'utf8')).toBe(nativeBefore)
      expect(
        await readFile(home.stashPath, 'utf8').catch(() => undefined),
      ).toBe(stashBefore)
    } finally {
      try {
        await session?.dispose()
      } finally {
        globalThis.fetch = savedFetch
        Reflect.deleteProperty(globalThis, recoveryKey)
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
