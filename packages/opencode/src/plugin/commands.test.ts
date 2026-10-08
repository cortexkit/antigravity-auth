/**
 * The single `/antigravity` command: its host registration, the
 * `command.execute.before` hook that queues the menu for the TUI, and the
 * OpenCode menu over a real fresh account store with the genuine common-auth
 * commands entry. Every path lives under a temporary directory.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import {
  createAntigravityCommandExecuteBefore,
  createOpenCodeAntigravityMenu,
  menuInvocation,
} from './commands'
import { createOperatorSettingsController } from './operator-settings'

describe('registerAntigravityCommands', () => {
  it('registers /antigravity and the /gemini-dump alias, keeping host commands', () => {
    const config: Record<string, unknown> = {
      command: { init: { template: 'init' } },
    }
    registerAntigravityCommands(config)
    expect(Object.keys(config.command as object).sort()).toEqual([
      'antigravity',
      'gemini-dump',
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

  it('leaves every other command alone', async () => {
    const { before, pushed, opened } = hook(true, 'menu')
    await before?.(
      { command: 'antigravity-quota', sessionID: 's1', arguments: '' },
      { parts: [] } as never,
    )
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
        ])
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
