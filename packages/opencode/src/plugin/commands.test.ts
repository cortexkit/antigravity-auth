/**
 * The single `/antigravity` command: its host registration, the
 * `command.execute.before` hook that queues the menu for the TUI, and the
 * OpenCode menu over a real fresh account store with the genuine common-auth
 * commands entry. Every path lives under a temporary directory.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreAdmission,
} from '@cortexkit/antigravity-auth-core'

import type { RpcNotificationPayload } from '../rpc/protocol'
import { registerAntigravityCommands } from './catalog'
import { createStoreAccountLimits } from './command-apply'
import {
  createAccountTargets,
  createAntigravityCommandExecuteBefore,
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
            sectionId: 'routing',
            actionId: 'set',
            values: { cliFirst: true },
          },
          invocation,
        )
        expect(routed.ok).toBe(true)
        expect(settings.get().routing.cli_first).toBe(true)

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
