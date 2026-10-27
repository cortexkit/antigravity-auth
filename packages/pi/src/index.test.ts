import { describe, expect, it, mock, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadCommonAuthClaustrum,
  loadCommonAuthPiSlot,
} from '@cortexkit/antigravity-auth-core'
import {
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent'

import cortexKitPiAntigravityAuth, {
  CUSTODY_PROVIDER_KEY_MARKER,
  registerCortexKitPiAntigravity,
} from './index.ts'
import {
  getPiAntigravityVaultDir,
  getPiAntigravityVaultModeFile,
} from './paths.ts'
import {
  PI_ANTIGRAVITY_ENROLLMENT_NAME,
  PI_ANTIGRAVITY_VAULT_HOST,
  PiVaultSetup,
} from './vault-setup.ts'
import type { PiVaultSeams } from './vault-source.ts'
import * as vaultSource from './vault-source.ts'

describe('Pi Antigravity model catalog', () => {
  it('exposes the live GPT-OSS route but not unsupported image-output chat models', async () => {
    const registerProvider = mock()
    await cortexKitPiAntigravityAuth({
      registerProvider,
      registerCommand: mock(),
    } as never)

    expect(registerProvider).toHaveBeenCalledTimes(1)
    const [providerId, config] = registerProvider.mock.calls[0] as [
      string,
      {
        models: Array<{
          id: string
          reasoning: boolean
          contextWindow: number
          maxTokens: number
        }>
      },
    ]
    expect(providerId).toBe('google')
    const modelIds = config.models.map((model) => model.id)

    expect(modelIds).toContain('antigravity-gemini-4-argon')
    expect(modelIds).not.toContain('antigravity-gemini-3.1-pro')
    expect(modelIds).not.toContain('antigravity-gemini-3.6-flash')
    expect(modelIds).not.toContain('antigravity-gemini-3.7-flash')
    expect(modelIds).toContain('antigravity-gemini-3.8-flash')
    expect(modelIds).toContain('antigravity-gpt-oss-120b-medium')
    expect(modelIds).not.toContain('antigravity-gemini-3.1-flash-image')
    expect(modelIds).not.toContain('antigravity-gemini-3.8-flash-cyber')
    expect(
      config.models.find(
        (model) => model.id === 'antigravity-gemini-3.8-flash',
      ),
    ).toMatchObject({
      reasoning: true,
      contextWindow: 1048576,
      maxTokens: 65536,
    })
    expect(
      config.models.find(
        (model) => model.id === 'antigravity-gpt-oss-120b-medium',
      ),
    ).toMatchObject({
      reasoning: true,
      contextWindow: 131072,
      maxTokens: 32768,
    })
  })
})

it('replaces the native Google catalog and reads only the google OAuth credential in the real Pi registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-pi-provider-'))
  try {
    const authPath = join(directory, 'auth.json')
    const credentials = JSON.stringify({
      google: {
        type: 'oauth',
        access: 'synthetic-google-access',
        refresh: 'synthetic-google-refresh|synthetic-project',
        expires: Date.now() + 3_600_000,
      },
      'google-antigravity': {
        type: 'oauth',
        access: 'synthetic-old-provider-access',
        refresh: 'synthetic-old-provider-refresh|synthetic-old-project',
        expires: Date.now() + 3_600_000,
      },
    })
    await writeFile(authPath, credentials, { mode: 0o600 })
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    const registry = new ModelRegistry(runtime)
    const nativeGoogle = registry
      .getAll()
      .filter((model) => model.provider === 'google')
    expect(nativeGoogle.length).toBeGreaterThan(0)
    expect(
      nativeGoogle.some((model) => !model.id.startsWith('antigravity-')),
    ).toBe(true)

    const registerProvider: ExtensionAPI['registerProvider'] =
      registry.registerProvider.bind(registry)
    await cortexKitPiAntigravityAuth({
      registerProvider,
      registerCommand: mock(),
    } as never)

    const models = registry
      .getAll()
      .filter((model) => model.provider === 'google')
    expect(models.map((model) => model.id).sort()).toEqual([
      'antigravity-claude-opus-5-5',
      'antigravity-claude-sonnet-5-5',
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.8-flash',
      'antigravity-gemini-4-argon',
      'antigravity-gpt-oss-120b-medium',
    ])
    for (const family of ['opus', 'sonnet']) {
      expect(
        registry.find('google', `antigravity-claude-${family}-5-5`),
      ).toMatchObject({
        reasoning: true,
        contextWindow: 1000000,
        maxTokens: 128000,
      })
      expect(
        registry.find('google', `antigravity-claude-${family}-4-6-thinking`),
      ).toBeUndefined()
    }
    expect(models.every((model) => model.id.startsWith('antigravity-'))).toBe(
      true,
    )
    expect(
      registry.find('google', 'antigravity-gemini-3.8-flash'),
    ).toBeDefined()
    expect(
      registry.find('google-antigravity', 'antigravity-gemini-3.8-flash'),
    ).toBeUndefined()
    expect(registry.getRegisteredProviderIds()).toEqual(['google'])
    expect(
      registry.getRegisteredProviderConfig('google')?.streamSimple,
    ).toBeDefined()
    expect((await registry.getProviderAuth('google'))?.auth.apiKey).toBe(
      'synthetic-google-access',
    )
    expect(await readFile(authPath, 'utf8')).toBe(credentials)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('the production default entry selects the vault stream and registers the shared menu', async () => {
  const directory = await mkdtemp(
    join(
      process.platform === 'win32' ? tmpdir() : '/tmp',
      'antigravity-pi-default-',
    ),
  )
  const previous = process.env.PI_ANTIGRAVITY_AUTH_FILE
  process.env.PI_ANTIGRAVITY_AUTH_FILE = join(directory, 'accounts.json')
  try {
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const modeFile = getPiAntigravityVaultModeFile()
    await mkdir(dirname(modeFile), { recursive: true, mode: 0o700 })
    await writeFile(
      modeFile,
      JSON.stringify({
        version: 1,
        mode: 'custody',
        routeId: 'synthetic-route',
      }),
      { mode: 0o600 },
    )
    const claustrum = await loadCommonAuthClaustrum()
    const setup = new PiVaultSetup({
      claustrum,
      stateDir: getPiAntigravityVaultDir(),
      modeFile,
      readHostSlot: () => {
        throw new Error('Vault setup must not read a native login')
      },
      connectEnrollment: async () => ({
        enrollPropose: async () => ({ requestId: 'synthetic-request' }),
        enrollPoll: async () => ({
          status: 'approved',
          name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
          token: 'b'.repeat(64),
          tokenGeneration: 1,
        }),
        close: () => {},
      }),
    })
    expect((await setup.connectStep()).state).toBe('approved')
    const registerProvider = mock()
    const registerCommand = mock()
    await cortexKitPiAntigravityAuth({
      registerProvider,
      registerCommand,
    } as never)
    expect(registerProvider).toHaveBeenCalledTimes(1)
    const [provider, config] = registerProvider.mock.calls[0] as [
      string,
      { apiKey?: string; oauth?: unknown; streamSimple?: unknown },
    ]
    expect(provider).toBe('google')
    expect(config.apiKey).toBe(CUSTODY_PROVIDER_KEY_MARKER)
    expect(config.oauth).toBeUndefined()
    expect(config.streamSimple).toBeFunction()
    expect(registerCommand).toHaveBeenCalledTimes(1)
    expect(registerCommand.mock.calls[0]?.[0]).toBe('antigravity')
  } finally {
    if (previous === undefined) delete process.env.PI_ANTIGRAVITY_AUTH_FILE
    else process.env.PI_ANTIGRAVITY_AUTH_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
})

/** Owned temporary Pi and plugin paths; nothing reads the user's real slots. */
async function recoveryFixture() {
  const directory = await mkdtemp(
    join(
      process.platform === 'win32' ? tmpdir() : '/tmp',
      'antigravity-pi-recovery-',
    ),
  )
  const vaultDir = join(directory, 'plugin-vault')
  await mkdir(vaultDir, { recursive: true, mode: 0o700 })
  const claustrum = await loadCommonAuthClaustrum()
  const paths = {
    directory,
    vaultDir,
    modeFile: join(vaultDir, 'pi-mode.json'),
    authPath: join(directory, 'native-agent', 'auth.json'),
    stashPath: join(vaultDir, 'google-login-stash.json'),
  }
  await mkdir(join(directory, 'native-agent'), { recursive: true, mode: 0o700 })
  const enrollment = claustrum.hostEnrollmentPaths({
    stateDir: vaultDir,
    host: PI_ANTIGRAVITY_VAULT_HOST,
  })
  const seams: PiVaultSeams = {
    vaultDir,
    modeFile: paths.modeFile,
    rosterFile: join(vaultDir, 'roster.json'),
    nativeAuthPath: paths.authPath,
    nativeStashPath: paths.stashPath,
    readHostSlot: () => {
      throw new Error('Startup recovery read the native Google login')
    },
    connect: async () => {
      throw new Error('Startup recovery opened a vault connection')
    },
    connectEnrollment: async () => {
      throw new Error('Startup recovery opened an enrollment connection')
    },
  }
  return { ...paths, claustrum, enrollment, seams }
}

// Pretty-printed with a neighbour so a re-serialization would change the bytes.
const NATIVE_AUTH = `{
  "google": { "type": "oauth", "access": "synthetic-native-access", "refresh": "synthetic-native-refresh|synthetic-native-project", "expires": 1 },
  "anthropic": { "type": "api_key", "key": "synthetic-neighbour" }
}
`

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>

/**
 * States in which the startup slot synchronization refuses: authority or mode
 * cannot be read, custody is selected without an approved enrollment, or the
 * native google entry differs from the saved login. Before the recovery
 * provider existed, each one made the extension fail to load on every start.
 */
const LOCKOUTS: Array<{
  name: string
  prepare: (fixture: RecoveryFixture) => Promise<void>
  reason: string
  /** Local mode: the Vault section legitimately reports the native login. */
  local?: boolean
}> = [
  {
    name: 'an unreadable enrollment state',
    prepare: async (fixture) => {
      await writeFile(fixture.enrollment.statePath, '{ torn', { mode: 0o600 })
      await writeFile(fixture.authPath, NATIVE_AUTH, { mode: 0o600 })
    },
    reason: 'cannot be read',
  },
  {
    name: 'an unreadable mode file',
    prepare: async (fixture) => {
      await writeFile(fixture.modeFile, '{ torn', { mode: 0o600 })
      await writeFile(fixture.authPath, NATIVE_AUTH, { mode: 0o600 })
    },
    reason: 'cannot be read',
  },
  {
    name: 'custody mode with no enrollment',
    prepare: async (fixture) => {
      await writeFile(
        fixture.modeFile,
        JSON.stringify({ version: 1, mode: 'custody' }),
        { mode: 0o600 },
      )
      await writeFile(fixture.authPath, NATIVE_AUTH, { mode: 0o600 })
    },
    reason: 'must be approved',
  },
  {
    name: 'a native Google login that conflicts with the saved one',
    prepare: async (fixture) => {
      // The genuine slot helper saves the login and installs the placeholder;
      // a later native /login then writes a different google entry.
      await writeFile(
        fixture.authPath,
        JSON.stringify({ google: { type: 'oauth', access: 'saved' } }),
        { mode: 0o600 },
      )
      const { openPiSlot } = await loadCommonAuthPiSlot()
      await openPiSlot({
        authPath: fixture.authPath,
        stashPath: fixture.stashPath,
        provider: 'google',
        placeholderKey: CUSTODY_PROVIDER_KEY_MARKER,
      }).enterVault()
      await writeFile(fixture.authPath, NATIVE_AUTH, { mode: 0o600 })
    },
    reason: 'native Google login changed',
    local: true,
  },
]

/** Model ids of the provider a clean local start registers. */
async function localModelIds(): Promise<string[]> {
  const fixture = await recoveryFixture()
  try {
    const registerProvider = mock()
    await registerCortexKitPiAntigravity(
      { registerProvider, registerCommand: mock() } as never,
      fixture.seams,
    )
    const [, config] = registerProvider.mock.calls[0] as unknown as [
      string,
      ProviderConfig,
    ]
    expect(config.oauth).toBeDefined()
    return (config.models ?? []).map((model) => model.id).sort()
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
}

async function refusal(
  config: ProviderConfig,
  apiKey: string,
): Promise<{ stopReason: string; errorMessage?: string }> {
  const model = {
    ...config.models?.find(
      (entry) => entry.id === 'antigravity-gemini-3.8-flash',
    ),
    api: config.api,
    provider: 'google',
    baseUrl: config.baseUrl,
  } as never
  const stream = config.streamSimple?.(
    model,
    {
      messages: [{ role: 'user', content: 'recovery-nonce', timestamp: 0 }],
    } as never,
    { apiKey },
  )
  if (!stream) throw new Error('The provider has no stream')
  return stream.result()
}

describe('Pi startup when the credential slot cannot be synchronized', () => {
  for (const lockout of LOCKOUTS)
    it(`registers the menu and a refusing google provider for ${lockout.name}`, async () => {
      const fixture = await recoveryFixture()
      const savedFetch = globalThis.fetch
      let fetches = 0
      globalThis.fetch = Object.assign(async () => {
        fetches++
        throw new Error('The recovery fixture refuses network fetches')
      }, savedFetch)
      try {
        await lockout.prepare(fixture)
        const nativeBefore = await readFile(fixture.authPath, 'utf8')
        const stashBefore = await readFile(fixture.stashPath, 'utf8').catch(
          () => undefined,
        )
        const order: string[] = []
        const registerProvider = mock((id: string) => {
          order.push(`provider:${id}`)
        })
        const registerCommand = mock((name: string) => {
          order.push(`command:${name}`)
        })

        const extension = await registerCortexKitPiAntigravity(
          { registerProvider, registerCommand } as never,
          lockout.local
            ? {
                ...fixture.seams,
                readHostSlot: () =>
                  JSON.parse(readFileSync(fixture.authPath, 'utf8')).google,
              }
            : fixture.seams,
        )

        expect(order).toEqual(['provider:google', 'command:antigravity'])
        const [, config] = registerProvider.mock.calls[0] as unknown as [
          string,
          ProviderConfig,
        ]
        // Same provider id and the same models local and vault serving list.
        expect(config.models?.map((model) => model.id).sort()).toEqual(
          await localModelIds(),
        )
        // No OAuth: Pi can never refresh or replace the native login here.
        expect(config.oauth).toBeUndefined()
        for (const apiKey of [
          CUSTODY_PROVIDER_KEY_MARKER,
          'synthetic-native-access',
        ]) {
          const result = await refusal(config, apiKey)
          expect(result.stopReason).toBe('error')
          expect(result.errorMessage).toContain('No request was sent')
        }
        expect(fetches).toBe(0)
        expect(await readFile(fixture.authPath, 'utf8')).toBe(nativeBefore)
        expect(
          await readFile(fixture.stashPath, 'utf8').catch(() => undefined),
        ).toBe(stashBefore)
        // The Vault section is reachable and offers, as the state allows,
        // requesting vault access again, serving from the local login, or
        // forgetting the enrollment.
        // Restoring a conflicting native login stays with Pi's /login and /logout.
        const content = await extension.vaultSection.build({
          sessionId: 'recovery',
          notify: () => {},
        })
        expect(content.actions?.length ?? 0).toBeGreaterThan(0)
      } finally {
        globalThis.fetch = savedFetch
        await rm(fixture.directory, { recursive: true, force: true })
      }
    })

  it('names the slot failure in the refusal', async () => {
    for (const lockout of LOCKOUTS) {
      const fixture = await recoveryFixture()
      try {
        await lockout.prepare(fixture)
        const registerProvider = mock()
        await registerCortexKitPiAntigravity(
          { registerProvider, registerCommand: mock() } as never,
          fixture.seams,
        )
        const [, config] = registerProvider.mock.calls[0] as unknown as [
          string,
          ProviderConfig,
        ]
        expect(
          (await refusal(config, CUSTODY_PROVIDER_KEY_MARKER)).errorMessage,
        ).toContain(lockout.reason)
      } finally {
        await rm(fixture.directory, { recursive: true, force: true })
      }
    }
  })

  it('serves local again once the Vault section chooses the local login', async () => {
    const fixture = await recoveryFixture()
    try {
      await LOCKOUTS[2]?.prepare(fixture)
      const nativeBefore = await readFile(fixture.authPath, 'utf8')
      const registerProvider = mock()
      const extension = await registerCortexKitPiAntigravity(
        { registerProvider, registerCommand: mock() } as never,
        fixture.seams,
      )
      const content = await extension.vaultSection.build({
        sessionId: 'recovery',
        notify: () => {},
      })
      const useLocal = content.actions?.find(
        (entry) => entry.id === 'use-local',
      )
      if (!useLocal) throw new Error('The Vault section offers no local remedy')
      await useLocal.run({
        values: {},
        invocation: { sessionId: 'recovery', notify: () => {} },
      })
      expect(registerProvider).toHaveBeenCalledTimes(2)
      const [, config] = registerProvider.mock.calls[1] as unknown as [
        string,
        ProviderConfig,
      ]
      expect(config.oauth).toBeDefined()
      expect(await readFile(fixture.authPath, 'utf8')).toBe(nativeBefore)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})

it('finishes an older slot synchronization before a mode change registers its provider', async () => {
  const fixture = await recoveryFixture()
  const admitted = Promise.withResolvers<void>()
  let armed = false
  let readEntries = 0
  let readsBeforeRequest = 0
  const createRuntime = vaultSource.createPiVaultRuntime
  const runtimeSpy = spyOn(
    vaultSource,
    'createPiVaultRuntime',
  ).mockImplementation((readHostSlot, seams, changed) =>
    createRuntime(
      readHostSlot,
      seams,
      changed &&
        ((record) => {
          if (armed && record.mode === 'local') readsBeforeRequest = readEntries
          const pending = changed(record)
          if (armed && record.mode === 'local') admitted.resolve()
          return pending
        }),
    ),
  )
  try {
    await writeFile(
      fixture.modeFile,
      JSON.stringify({ version: 1, mode: 'custody' }),
      { mode: 0o600 },
    )
    await writeFile(fixture.authPath, NATIVE_AUTH, { mode: 0o600 })
    const setup = new PiVaultSetup({
      claustrum: fixture.claustrum,
      stateDir: fixture.vaultDir,
      modeFile: fixture.modeFile,
      readHostSlot: () => {
        throw new Error('Vault setup must not read a native login')
      },
      connectEnrollment: async () => ({
        enrollPropose: async () => ({ requestId: 'synthetic-request' }),
        enrollPoll: async () => ({
          status: 'approved',
          name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
          token: 'b'.repeat(64),
          tokenGeneration: 1,
        }),
        close: () => {},
      }),
    })
    expect((await setup.connectStep()).state).toBe('approved')

    // Hold one enrollment read after it has read the files, the way a slow
    // continuation would deliver an authority that a later change overtook.
    let holdAt: number | undefined
    let release = () => {}
    const held = Promise.withResolvers<void>()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const claustrum = {
      ...fixture.claustrum,
      readClaustrumEnrollmentStatus: async (
        ...args: Parameters<
          typeof fixture.claustrum.readClaustrumEnrollmentStatus
        >
      ) => {
        readEntries++
        const status = await fixture.claustrum.readClaustrumEnrollmentStatus(
          ...args,
        )
        if (holdAt !== undefined && --holdAt === 0) {
          held.resolve()
          await gate
        }
        return status
      },
    }
    const slotModule = await loadCommonAuthPiSlot()
    let restored = false
    const loadPiSlot: typeof loadCommonAuthPiSlot = async () => ({
      ...slotModule,
      openPiSlot: (options) => {
        const slot = slotModule.openPiSlot(options)
        return {
          ...slot,
          exitVault: async () => {
            const result = await slot.exitVault()
            restored = true
            return result
          },
        }
      },
    })
    const handlers: Array<(event: unknown, context: unknown) => Promise<void>> =
      []
    const registerProvider = mock()
    const extension = await registerCortexKitPiAntigravity(
      {
        registerProvider,
        registerCommand: mock(),
        on: (_event: string, handler: never) => handlers.push(handler),
      } as never,
      {
        ...fixture.seams,
        loadClaustrum: async () => claustrum,
        loadPiSlot,
      },
    )
    expect(
      (registerProvider.mock.calls.at(-1) as [string, ProviderConfig])[1]
        .apiKey,
    ).toBe(CUSTODY_PROVIDER_KEY_MARKER)
    const content = await extension.vaultSection.build({
      sessionId: 'race',
      notify: () => {},
    })
    const forget = content.actions?.find((entry) => entry.id === 'forget')
    if (!forget) throw new Error('The Vault section offers no forget action')

    // The session_start synchronization reads custody twice; hold its second read.
    holdAt = 2
    const handler = handlers[0]
    if (!handler) throw new Error('No session_start handler was registered')
    const sessionStart = handler(
      { type: 'session_start' },
      { modelRegistry: { refresh: () => {} } },
    )
    await held.promise
    const registrationsBeforeRequest = registerProvider.mock.calls.length
    const authBeforeRequest = await readFile(fixture.authPath, 'utf8')
    armed = true
    const forgetting = forget.run({
      values: {},
      invocation: { sessionId: 'race', notify: () => {} },
    })
    const finished = Promise.allSettled([sessionStart, forgetting])
    try {
      // The mode-change callback has queued its synchronization before acknowledging admission.
      await admitted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(readEntries).toBe(readsBeforeRequest)
      expect(restored).toBe(false)
      expect(registerProvider.mock.calls).toHaveLength(
        registrationsBeforeRequest,
      )
      expect(await readFile(fixture.authPath, 'utf8')).toBe(authBeforeRequest)
    } finally {
      release()
      await finished
    }
    // The held run may fail closed once it re-reads authority (Pi reports a
    // session_start failure without stopping); the Forget itself must succeed.
    const [, forgot] = await finished
    expect(forgot.status).toBe('fulfilled')

    expect(restored).toBe(true)
    const [, last] = registerProvider.mock.calls.at(-1) as [
      string,
      ProviderConfig,
    ]
    // The mode file now says local and the native login is back: the last
    // registration must be the local provider, not whatever the overtaken
    // session_start run registered (the vault provider when it trusted its
    // stale authority read, the refusing provider when it failed closed).
    expect(last.oauth).toBeDefined()
    expect(await readFile(fixture.authPath, 'utf8')).toBe(NATIVE_AUTH)
  } finally {
    runtimeSpy.mockRestore()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
