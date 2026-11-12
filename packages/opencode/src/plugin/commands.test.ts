/**
 * The single `/antigravity` command: its host registration, the
 * `command.execute.before` hook that queues the menu for the TUI, and the
 * OpenCode menu over a real fresh account store with the genuine common-auth
 * commands entry. Every path lives under a temporary directory.
 */

import { describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_MODELS_REFUSAL_TEXT,
  AntigravityMenuRefusal,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreAdmission,
} from '@cortexkit/antigravity-auth-core'

import type { RpcNotificationPayload } from '../rpc/protocol'
import { createProtectionStore } from '../settings/protection'
import { createSettingsRuntime } from '../settings/runtime'
import { registerAntigravityCommands } from './catalog'
import {
  createStoreAccountLimits,
  createStoreAccountModels,
} from './command-apply'
import {
  createAccountTargets,
  createAntigravityCommandExecuteBefore,
  createCustodyAwareRequestPath,
  createOpenCodeAntigravityMenu,
  menuInvocation,
} from './commands'
import {
  accountKeyForRefreshToken,
  createOperatorSettingsController,
} from './operator-settings'
import { commitLogins } from './persist-account-pool'
import {
  type AccountStoreOpening,
  initializeFreshAccountStoreFor,
  openAccountStore,
} from './storage'

describe('registerAntigravityCommands', () => {
  it('registers only /antigravity and keeps the host commands', () => {
    const config: Record<string, unknown> = {
      command: { init: { template: 'init' } },
    }
    registerAntigravityCommands(config)
    expect(Object.keys(config.command as object).sort()).toEqual([
      'antigravity',
      'init',
    ])
    expect(
      (config.command as Record<string, { template: string }>).antigravity
        ?.template,
    ).toBe('antigravity')
  })
})

describe('createAntigravityCommandExecuteBefore', () => {
  const payload = {
    command: 'antigravity',
    menu: { command: 'antigravity', title: 'Antigravity', sections: [] },
  }

  function hook(connected: boolean, opening: 'menu' | 'unavailable') {
    const pushed: { payload: RpcNotificationPayload; sessionId?: string }[] = []
    const prompts: unknown[] = []
    const opened: string[] = []
    const before = createAntigravityCommandExecuteBefore({
      client: {
        session: {
          promptAsync: async (request: unknown) => {
            prompts.push(request)
          },
        },
      } as never,
      push: (entry, sessionId) => {
        pushed.push({
          payload: entry,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
      },
      open: async (sessionId) => {
        opened.push(sessionId)
        return opening === 'menu'
          ? { kind: 'menu', payload }
          : { kind: 'unavailable', message: 'migrate first' }
      },
      connection: { isTuiConnected: () => connected },
    })
    return { before, pushed, prompts, opened }
  }

  it('leaves every other command alone, retired ones included', async () => {
    const { before, pushed, opened } = hook(true, 'menu')
    for (const command of ['antigravity-quota', 'gemini-dump', 'init']) {
      await before?.({ command, sessionID: 's1', arguments: 'enable' }, {
        parts: [],
      } as never)
    }
    expect(opened).toEqual([])
    expect(pushed).toEqual([])
  })

  it('queues the menu for the session and stops the prompt', async () => {
    const { before, pushed, prompts, opened } = hook(true, 'menu')
    await expect(
      before?.({ command: 'antigravity', sessionID: 's1', arguments: '' }, {
        parts: [],
      } as never),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    expect(opened).toEqual(['s1'])
    expect(pushed).toEqual([{ payload, sessionId: 's1' }])
    expect(prompts).toEqual([])
  })

  it('queues the reason as a notice when the menu is unavailable, and writes it without a TUI', async () => {
    const { before, pushed, prompts } = hook(false, 'unavailable')
    await expect(
      before?.({ command: 'antigravity', sessionID: 's2', arguments: '' }, {
        parts: [],
      } as never),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    expect(pushed).toEqual([
      {
        payload: {
          command: 'antigravity',
          notify: { message: 'migrate first', kind: 'warning' },
        },
        sessionId: 's2',
      },
    ])
    expect(JSON.stringify(prompts)).toContain('migrate first')
  })
})

describe('menuInvocation', () => {
  it('turns menu notifications into notices for the invoking session', () => {
    const pushed: unknown[] = []
    const invocation = menuInvocation(
      (entry, sessionId) => pushed.push({ entry, sessionId }),
      's3',
    )
    expect(invocation.sessionId).toBe('s3')
    invocation.notify('Account added', 'info')
    invocation.notify('Default kind')
    expect(pushed).toEqual([
      {
        entry: {
          command: 'antigravity',
          notify: { message: 'Account added', kind: 'info' },
        },
        sessionId: 's3',
      },
      {
        entry: {
          command: 'antigravity',
          notify: { message: 'Default kind', kind: 'info' },
        },
        sessionId: 's3',
      },
    ])
  })
})

describe('createOpenCodeAntigravityMenu', () => {
  it('serves the fixed sections and sign-in over a real store and writes settings through the controller', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'v1-menu-')))
    const settings = createOperatorSettingsController({
      projectConfigPath: join(root, 'project', 'antigravity.json'),
      userConfigPath: join(root, 'user', 'antigravity.json'),
    })
    try {
      const legacyPath = join(root, 'antigravity-accounts.json')
      const modules = await loadCommonAuthStoreModules()
      await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
      const admission = await readAccountStoreAdmission(
        legacyPath,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const repository = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async () => {
          throw new Error('token exchange is not part of this test')
        },
      })
      try {
        await repository.login({
          id: crypto.randomUUID(),
          refreshToken: 'menu-refresh-secret',
          metadata: { email: 'menu@example.com', addedAt: 1, lastUsed: 1 },
        })
        let dumping = false
        const levels: string[] = []
        const signIns: string[] = []
        const menu = await createOpenCodeAntigravityMenu({
          selectionStrategy: () => 'hybrid',
          accounts: repository,
          settings,
          dump: {
            isEnabled: () => dumping,
            setEnabled: (enabled) => {
              dumping = enabled
            },
          },
          applyLogLevel: (level) => levels.push(level),
          vault: {
            id: 'vault',
            title: 'Vault',
            build: () => ({ lines: ['Mode: this computer'] }),
          },
          signIn: {
            start: async (sessionId) => {
              signIns.push(`start:${sessionId}`)
              return { url: 'https://accounts.example/auth', accounts: [] }
            },
            finish: async (sessionId, callback, label) => {
              signIns.push(`finish:${sessionId}:${callback}:${label ?? ''}`)
              return { text: 'Account added', accounts: [] }
            },
          },
        })
        const invocation = { sessionId: 's1', notify: () => undefined }
        const payload = await menu.open(invocation)
        expect(payload.menu.sections.map((section) => section.slot)).toEqual([
          'accounts',
          'quota',
          'routing',
          'limits',
          'diagnostics',
          'extra',
          'extra',
        ])
        expect(
          payload.menu.sections.slice(-2).map((section) => section.id),
        ).toEqual(['sign-in', 'vault'])
        const text = JSON.stringify(payload)
        expect(text).not.toContain('menu@example.com')
        expect(text).not.toContain('secret')

        const routed = await menu.apply(
          {
            command: 'antigravity',
            sectionId: 'limits',
            actionId: 'set',
            values: { enabled: true },
          },
          invocation,
        )
        expect(routed.ok).toBe(true)
        expect(settings.get().killswitch.enabled).toBe(true)

        const logged = await menu.apply(
          {
            command: 'antigravity',
            sectionId: 'diagnostics',
            actionId: 'logging',
            values: { level: 'debug' },
          },
          invocation,
        )
        expect(logged.ok).toBe(true)
        expect(settings.get().log_level).toBe('debug')
        expect(levels).toEqual(['debug'])

        const dumped = await menu.apply(
          {
            command: 'antigravity',
            sectionId: 'diagnostics',
            actionId: 'dump',
          },
          invocation,
        )
        expect(dumped.ok).toBe(true)
        expect(dumping).toBe(true)

        const started = await menu.apply(
          { command: 'antigravity', sectionId: 'sign-in', actionId: 'start' },
          invocation,
        )
        expect(started.text).toContain('https://accounts.example/auth')
        const finished = await menu.apply(
          {
            command: 'antigravity',
            sectionId: 'sign-in',
            actionId: 'finish',
            values: { callback: 'code-123', label: 'Work' },
          },
          invocation,
        )
        expect(finished.text).toBe('Account added')
        expect(signIns).toEqual(['start:s1', 'finish:s1:code-123:Work'])
      } finally {
        await repository.dispose()
      }
    } finally {
      await settings.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('createStoreAccountLimits', () => {
  async function storeWithSettings() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'v1-floor-')))
    const settings = createOperatorSettingsController({
      projectConfigPath: join(root, 'project', 'antigravity.json'),
      userConfigPath: join(root, 'user', 'antigravity.json'),
    })
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
    const admission = await readAccountStoreAdmission(
      legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const repository = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('token exchange is not part of this test')
      },
    })
    const { ref } = await repository.login({
      id: crypto.randomUUID(),
      refreshToken: 'floor-refresh-secret',
      metadata: { email: 'floor@example.com', addedAt: 1, lastUsed: 1 },
    })
    return {
      repository,
      settings,
      ref,
      cleanup: async () => {
        await repository.dispose()
        await settings.dispose()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  it('keeps the floor under the existing private key and drives it from the menu item', async () => {
    const { repository, settings, cleanup } = await storeWithSettings()
    try {
      const key = accountKeyForRefreshToken('floor-refresh-secret')
      const menu = await createOpenCodeAntigravityMenu({
        selectionStrategy: () => 'hybrid',
        accounts: repository,
        settings,
        dump: { isEnabled: () => false, setEnabled: () => undefined },
        applyLogLevel: () => undefined,
        accountLimits: createStoreAccountLimits({ repository, settings }),
      })
      const invocation = { notify: () => undefined }
      const opened = await menu.open(invocation)
      const item = opened.menu.sections.find(
        (section) => section.id === 'accounts',
      )?.items[0]
      expect(item?.actions.map((action) => action.id)).toContain('limit')
      const before = await repository.read()
      const result = await menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: item?.id ?? '',
          actionId: 'limit',
          values: { minimumRemainingPercent: 30 },
        },
        invocation,
      )
      expect(result).toMatchObject({
        ok: true,
        text: 'Account 1 quota floor set to 30%',
      })
      expect(settings.get().killswitch.accounts).toEqual({ [key]: 30 })
      // The private key and the token never reach the menu payload.
      const text = JSON.stringify(result)
      expect(text).not.toContain(key)
      expect(text).not.toContain('secret')
      // The row's metadata is left as it was.
      const after = await repository.read()
      expect(after.status === 'ready' && after.rows[0]?.metadata).toEqual(
        before.status === 'ready' && before.rows[0]?.metadata,
      )

      const cleared = await menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: item?.id ?? '',
          actionId: 'limit',
          values: { minimumRemainingPercent: null },
        },
        invocation,
      )
      expect(cleared.ok).toBe(true)
      expect(settings.get().killswitch.accounts ?? {}).toEqual({})
    } finally {
      await cleanup()
    }
  })

  it('holds the row lock across the settings write, so a concurrent replacement waits', async () => {
    const { repository, settings, ref, cleanup } = await storeWithSettings()
    try {
      let markStarted: () => void = () => undefined
      const writeStarted = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      let releaseWrite: () => void = () => undefined
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      const limits = createStoreAccountLimits({
        repository,
        settings: {
          get: () => settings.get(),
          update: async (mutator) => {
            markStarted()
            await writeGate
            await settings.update(mutator)
          },
        },
      })
      const writing = limits.write(ref, 35)
      await writeStarted
      // The floor write is now inside the fenced update; replace the same
      // row's credential from outside it and give the replacement time.
      let replacementSettled = false
      const replacing = repository.replaceCredential(ref, {
        refreshToken: 'floor-refresh-concurrent',
        disabled: 'keep',
      })
      void replacing.then(
        () => {
          replacementSettled = true
        },
        () => {
          replacementSettled = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(replacementSettled).toBe(false)
      releaseWrite()
      expect(await writing).toBe('applied')
      const replaced = await replacing
      expect(replaced.ref.credentialEpoch).toBeGreaterThan(ref.credentialEpoch)
      // The floor belongs to the credential it was written for; the
      // replacement holds a different token and so a different key.
      expect(settings.get().killswitch.accounts).toEqual({
        [accountKeyForRefreshToken('floor-refresh-secret')]: 35,
      })
      expect(await limits.read(replaced.ref)).toBeNull()
      expect(await limits.read(ref)).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('refuses a replaced credential before any setting is written', async () => {
    const { repository, settings, ref, cleanup } = await storeWithSettings()
    try {
      await repository.replaceCredential(ref, {
        refreshToken: 'floor-refresh-replacement',
        disabled: 'keep',
      })
      const limits = createStoreAccountLimits({ repository, settings })
      expect(await limits.write(ref, 40)).toBe('stale')
      expect(settings.get().killswitch.accounts ?? {}).toEqual({})
      expect(await limits.read(ref)).toBeNull()
    } finally {
      await cleanup()
    }
  })
})

describe('createStoreAccountLimits on the shared settings file', () => {
  async function storeWithSharedSettings(fileText: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'v1-shared-floor-')))
    const file = join(root, 'cortexkit', 'antigravity-auth.jsonc')
    mkdirSync(join(root, 'cortexkit'))
    writeFileSync(file, fileText)
    const runtime = createSettingsRuntime({
      file,
      separateInstall: false,
      legacyUserFile: join(root, 'user', 'antigravity.json'),
      log: { warn() {}, info() {} },
      fence: async () => true,
      protection: createProtectionStore(join(root, 'state', 'protection.json')),
      moveReportPath: join(root, 'state', 'report.json'),
    })
    const project = await runtime.openProject(join(root, 'project'), {
      config: () => {
        throw new Error('the shared file exists, so the old loader is unused')
      },
      operator: () => {
        throw new Error('the shared file exists, so the old writer is unused')
      },
    })
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
    const admission = await readAccountStoreAdmission(
      legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const repository = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('token exchange is not part of this test')
      },
    })
    const { ref } = await repository.login({
      id: crypto.randomUUID(),
      refreshToken: 'shared-floor-refresh-secret',
      metadata: { email: 'floor@example.com', addedAt: 1, lastUsed: 1 },
    })
    const menu = await createOpenCodeAntigravityMenu({
      selectionStrategy: () => 'hybrid',
      accounts: repository,
      settings: project.operator,
      settingsFile: project,
      dump: { isEnabled: () => false, setEnabled: () => undefined },
      applyLogLevel: () => undefined,
      accountLimits: createStoreAccountLimits({
        repository,
        settings: project.operator,
      }),
      accountModels: createStoreAccountModels({
        repository,
        settings: project,
        writable: () => project.mode() === 'shared',
      }),
    })
    return {
      file,
      ref,
      repository,
      project,
      menu,
      cleanup: async () => {
        await repository.dispose()
        await project.release()
        await runtime.dispose()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  it('keys the floor by the row id and keeps the file comments', async () => {
    const store = await storeWithSharedSettings(
      '// floors\n{\n  "schema_version": 1\n}\n',
    )
    try {
      const invocation = { notify: () => undefined }
      const opened = await store.menu.open(invocation)
      const item = opened.menu.sections.find(
        (section) => section.id === 'accounts',
      )?.items[0]
      const result = await store.menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: item?.id ?? '',
          actionId: 'limit',
          values: { minimumRemainingPercent: 30 },
        },
        invocation,
      )
      expect(result).toMatchObject({ ok: true })
      expect(store.project.operator.get().killswitch.accounts).toEqual({
        [store.ref.id]: 30,
      })
      const text = readFileSync(store.file, 'utf8')
      expect(text).toContain('// floors')
      expect(text).toContain(store.ref.id)
      expect(text).not.toContain(
        accountKeyForRefreshToken('shared-floor-refresh-secret'),
      )
      const routing = opened.menu.sections.find(
        (section) => section.id === 'routing',
      )
      expect(routing?.lines).toContain(
        'Configured in antigravity-auth.jsonc: account_selection_strategy',
      )
    } finally {
      await store.cleanup()
    }
  })

  it('refuses a floor write for a replaced credential', async () => {
    const store = await storeWithSharedSettings('{ "schema_version": 1 }\n')
    try {
      await store.repository.replaceCredential(store.ref, {
        refreshToken: 'shared-floor-refresh-replacement',
        disabled: 'keep',
      })
      const limits = createStoreAccountLimits({
        repository: store.repository,
        settings: store.project.operator,
      })
      expect(await limits.write(store.ref, 40)).toBe('stale')
      expect(store.project.operator.get().killswitch.accounts).toEqual({})
      expect(readFileSync(store.file, 'utf8')).toBe('{ "schema_version": 1 }\n')
    } finally {
      await store.cleanup()
    }
  })

  it('renders a refused Limits write with its fixed text', async () => {
    const store = await storeWithSharedSettings('{ "schema_version": 2 }\n')
    try {
      const invocation = { notify: () => undefined }
      await store.menu.open(invocation)
      const result = await store.menu.apply(
        {
          command: 'antigravity',
          sectionId: 'limits',
          actionId: 'set',
          values: { enabled: true, minimumRemainingPercent: 20 },
        },
        invocation,
      )
      expect(result).toMatchObject({
        ok: false,
        code: 'settings-newer-version',
        text: `The settings file is from a newer version of antigravity-auth, so nothing was changed. Update antigravity-auth or edit ${store.file} by hand.`,
      })
      expect(readFileSync(store.file, 'utf8')).toBe('{ "schema_version": 2 }\n')
    } finally {
      await store.cleanup()
    }
  })

  /** Every Models switch off, so a test turns on exactly the ones it names. */
  function modelValues(
    item: { actions: Array<{ id: string; knobs: Array<{ id: string }> }> },
    on: Record<string, boolean>,
  ): Record<string, boolean> {
    const knobs =
      item.actions.find((action) => action.id === 'models')?.knobs ?? []
    return {
      ...Object.fromEntries(knobs.map((knob) => [knob.id, false])),
      ...on,
    }
  }

  it('shows, sets and clears an account model list by row id, keeping comments', async () => {
    const store = await storeWithSharedSettings(
      '// models\n{\n  "schema_version": 1\n}\n',
    )
    try {
      const invocation = { notify: () => undefined }
      const accounts = async () =>
        (await store.menu.open(invocation)).menu.sections.find(
          (section) => section.id === 'accounts',
        )?.items[0]
      const shown = await accounts()
      expect(shown?.detail).toContain('All models')
      expect(shown?.facts).toMatchObject({ models: 'All models' })
      expect(shown?.actions.map((action) => action.id)).toContain('models')
      if (!shown) throw new Error('no account item')

      const set = await store.menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: shown.id,
          actionId: 'models',
          values: modelValues(shown, {
            'gemini-4-carbon': true,
            'claude-sonnet-5-5': true,
          }),
        },
        invocation,
      )
      expect(set).toMatchObject({
        ok: true,
        text: 'Account 1 serves gemini-4-carbon, claude-sonnet-5-5',
      })
      const written = readFileSync(store.file, 'utf8')
      expect(written).toContain('// models')
      expect(written).toContain(store.ref.id)
      expect(store.project.accountModels()).toEqual({
        [store.ref.id]: ['gemini-4-carbon', 'claude-sonnet-5-5'],
      })
      const access = store.project.modelAccess()
      expect(access.allows(store.ref.id, 'gemini-4-carbon-high')).toBe(true)
      expect(access.allows(store.ref.id, 'gemini-4-argon')).toBe(false)

      const listed = await accounts()
      expect(listed?.detail).toContain('gemini-4-carbon, claude-sonnet-5-5')
      // The row id is the key in the file but never reaches the menu.
      expect(JSON.stringify(listed)).not.toContain(store.ref.id)
      if (!listed) throw new Error('no account item')

      const cleared = await store.menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: listed.id,
          actionId: 'models',
          values: modelValues(listed, { 'all-models': true }),
        },
        invocation,
      )
      expect(cleared).toMatchObject({
        ok: true,
        text: 'Account 1 serves all models',
      })
      expect(store.project.accountModels()).toEqual({})
      expect(readFileSync(store.file, 'utf8')).toContain('// models')
      expect((await accounts())?.detail).toContain('All models')
    } finally {
      await store.cleanup()
    }
  })

  it('refuses an empty or unknown-only model list with fixed text and writes nothing', async () => {
    const original = '// models\n{\n  "schema_version": 1\n}\n'
    const store = await storeWithSharedSettings(original)
    try {
      const invocation = { notify: () => undefined }
      const item = (await store.menu.open(invocation)).menu.sections.find(
        (section) => section.id === 'accounts',
      )?.items[0]
      if (!item) throw new Error('no account item')
      const empty = await store.menu.apply(
        {
          command: 'antigravity',
          sectionId: 'accounts',
          itemId: item.id,
          actionId: 'models',
          values: modelValues(item, {}),
        },
        invocation,
      )
      expect(empty).toMatchObject({
        ok: false,
        code: 'invalid-input',
        text: ACCOUNT_MODELS_REFUSAL_TEXT['empty-list'],
      })
      const unknown = await store.project
        .updateAccountModels(store.ref.id, ['not-a-model', 'retired-route'])
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(unknown).toBeInstanceOf(AntigravityMenuRefusal)
      expect((unknown as AntigravityMenuRefusal).text).toBe(
        ACCOUNT_MODELS_REFUSAL_TEXT['unknown-only'],
      )
      expect(readFileSync(store.file, 'utf8')).toBe(original)
      expect(store.project.accountModels()).toEqual({})
    } finally {
      await store.cleanup()
    }
  })
})

describe('createAccountTargets', () => {
  it('creates the empty store of a fresh installation before its first login, and writes no pool file', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'v1-fresh-')))
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    const opened: AccountStoreOpening[] = []
    const open = async () => {
      const opening = await openAccountStore({
        modules,
        createRepository: createAccountRepositoryFactory(modules),
        exchange: async () => {
          throw new Error('token exchange is not part of this test')
        },
        legacyPath,
      })
      opened.push(opening)
      return opening
    }
    let initialized = 0
    const targets = createAccountTargets({
      accountStore: open,
      usesPoolFile: (opening) =>
        opening.status === 'initialization-required' ||
        opening.status === 'migration-required',
      initializeFreshStore: async () => {
        const opening = await open()
        if (opening.status !== 'initialization-required') return opening
        initialized += 1
        const result = await initializeFreshAccountStoreFor(modules, {
          legacyPath,
        })
        if (result.status !== 'completed') throw new Error(result.status)
        return open()
      },
    })
    try {
      expect(await targets.accountSource()).toEqual({ kind: 'none' })
      const target = await targets.loginTarget()
      expect(initialized).toBe(1)
      if (target === 'pool-file') throw new Error('expected the store')
      const [committed] = await commitLogins(target, [
        {
          type: 'success',
          refresh: 'fresh-refresh|fresh-project',
          access: 'fresh-access',
          expires: Date.now() + 3_600_000,
          email: 'fresh@example.com',
          projectId: 'fresh-project',
        },
      ])
      expect(committed?.status).toBe('committed')
      const read = await target.read()
      expect(read.status === 'ready' && read.rows.length).toBe(1)
      // The first login lands in the store; no pool file is created.
      expect(existsSync(legacyPath)).toBe(false)
    } finally {
      for (const opening of opened)
        if (opening.status === 'ready') await opening.repository.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a login while the store is in any state other than fresh, ready or unmigrated', async () => {
    const targets = createAccountTargets<{
      status: string
      message?: string
    }>({
      accountStore: async () => ({ status: 'refused', message: 'recovering' }),
      usesPoolFile: () => false,
      initializeFreshStore: async () => ({
        status: 'refused',
        message: 'a migration is pending',
      }),
    })
    await expect(targets.loginTarget()).rejects.toThrow(
      'a migration is pending',
    )
    await expect(targets.accountSource()).rejects.toThrow('recovering')
  })
})

describe('createCustodyAwareRequestPath', () => {
  function harness() {
    let mode:
      | { ok: true; record: { mode: 'local' | 'custody' } }
      | { ok: false; reason: string } = {
      ok: true,
      record: { mode: 'local' },
    }
    let source = { id: 'source-1' }
    const events: string[] = []
    const path = createCustodyAwareRequestPath({
      readMode: async () => mode,
      custodySource: async () => source,
      local: {
        fetch: async () => {
          events.push('local')
          return new Response('local')
        },
        dispose: () => events.push('local-disposed'),
      },
      vault: (served) => {
        events.push(`vault-built:${served.id}`)
        return {
          fetch: async () => {
            events.push(`vault:${served.id}`)
            return new Response('vault')
          },
          dispose: () => events.push(`vault-disposed:${served.id}`),
        }
      },
    })
    return {
      path,
      events,
      setMode(next: typeof mode) {
        mode = next
      },
      setSource(next: { id: string }) {
        source = next
      },
    }
  }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/x'

  it('serves the path the mode file names, switching on the next request', async () => {
    const h = harness()
    await h.path.fetch(url)
    h.setMode({ ok: true, record: { mode: 'custody' } })
    await h.path.fetch(url)
    await h.path.fetch(url)
    h.setSource({ id: 'source-2' })
    await h.path.fetch(url)
    h.setMode({ ok: true, record: { mode: 'local' } })
    await h.path.fetch(url)
    h.path.dispose()
    expect(h.events).toEqual([
      'local',
      'vault-built:source-1',
      'vault:source-1',
      'vault:source-1',
      'vault-disposed:source-1',
      'vault-built:source-2',
      'vault:source-2',
      'vault-disposed:source-2',
      'local',
      'local-disposed',
    ])
  })

  it('refuses a request while the mode file is unclear', async () => {
    const h = harness()
    h.setMode({ ok: false, reason: 'the vault mode file is not valid JSON' })
    await expect(h.path.fetch(url)).rejects.toThrow('vault mode is unclear')
    expect(h.events).toEqual([])
  })
})
