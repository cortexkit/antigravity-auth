import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStorageUnreadableError } from '@cortexkit/antigravity-auth-core'
import type { CommandModalName } from '../rpc/protocol'
import { registerAntigravityCommands } from './catalog'
import {
  applyCommand,
  buildDialogPayload,
  createCommandExecuteBefore,
  MODAL_COMMANDS,
} from './commands'
import { GEMINI_DUMP_COMMAND_NAME } from './gemini-dump'
import {
  createOperatorSettingsController,
  type OperatorSettingsController,
} from './operator-settings'

interface CommandContext {
  settings: OperatorSettingsController
}

async function makeContext(dir: string): Promise<CommandContext> {
  const settings = createOperatorSettingsController({
    projectConfigPath: join(dir, 'antigravity.json'),
    userConfigPath: join(dir, 'user.json'),
  })
  // Pre-create project file so updates land there.
  return { settings }
}

describe('registerAntigravityCommands', () => {
  it('merges the dump command into existing commands', () => {
    const config = {
      command: { existing: { template: 'existing', description: 'kept' } },
    }

    registerAntigravityCommands(config)

    expect(config.command.existing).toEqual({
      template: 'existing',
      description: 'kept',
    })
    expect(
      (config.command as Record<string, unknown>)[GEMINI_DUMP_COMMAND_NAME],
    ).toEqual({
      template: GEMINI_DUMP_COMMAND_NAME,
      description:
        'Show or toggle Gemini/Antigravity wire dump capture for debugging.',
    })
  })

  it('registers every modal command under its host-name key', () => {
    const config: Record<string, unknown> = {}

    registerAntigravityCommands(config)

    const registered = config.command as Record<string, unknown>
    for (const name of MODAL_COMMANDS) {
      expect(registered[name]).toBeDefined()
    }
  })
})

describe('three-wiring invariant', () => {
  it('catalog.ts registrations, MODAL_COMMANDS, and buildDialogPayload agree bidirectionally', async () => {
    const config: Record<string, unknown> = {}
    registerAntigravityCommands(config)
    const registered = new Set(Object.keys(config.command as object))

    const modals = new Set(MODAL_COMMANDS)

    // Set equality bidirectional — both directions catch drift.
    const registeredOnly = [...registered].filter(
      (key) => !modals.has(key as CommandModalName),
    )
    const modalsOnly = [...modals].filter((key) => !registered.has(key))

    // /gemini-dump is a backward-compat alias, so allow it in registered.
    const filteredRegisteredOnly = registeredOnly.filter(
      (key) => key !== GEMINI_DUMP_COMMAND_NAME,
    )
    expect(filteredRegisteredOnly).toEqual([])
    expect(modalsOnly).toEqual([])

    // Every modal command must produce a payload (round-trip via buildDialogPayload).
    const dir = mkdtempSync(join(tmpdir(), 'agy-commands-wiring-'))
    const ctx = await makeContext(dir)
    for (const command of MODAL_COMMANDS) {
      const payload = await buildDialogPayload(command, '', {
        client: {} as never,
        sessionID: 'session-1',
        settings: ctx.settings,
      })
      expect(payload.command).toBe(command)
      expect(typeof payload.text).toBe('string')
      expect(typeof payload.knobs).toBe('object')
    }
    await ctx.settings.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps /gemini-dump registered as the existing compatibility alias', () => {
    const config: Record<string, unknown> = {}
    registerAntigravityCommands(config)
    const registered = config.command as Record<string, unknown>

    expect(registered[GEMINI_DUMP_COMMAND_NAME]).toBeDefined()
    // The compatibility alias must remain alongside the modal name — the host
    // invokes the dump command as /gemini-dump, not /antigravity-dump.
    expect(MODAL_COMMANDS).toContain('antigravity-dump')
  })
})

describe('createCommandExecuteBefore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-cmd-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores unrelated commands', async () => {
    const promptAsync = mock(async () => {})
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const pushNotification = mock(() => 1)
    const handler = createCommandExecuteBefore(
      { session: { promptAsync } } as never,
      settings,
      pushNotification,
    )

    await expect(
      handler?.(
        { command: 'other', arguments: '', sessionID: 'session-1' },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()
    expect(promptAsync).not.toHaveBeenCalled()
    expect(pushNotification).not.toHaveBeenCalled()
    await settings.dispose()
  })

  it('sends an ignored assistant message then throws the handled sentinel for gemini-dump', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const pushNotification = mock(() => 1)
    const handler = createCommandExecuteBefore(
      { session: { messages, promptAsync } } as never,
      settings,
      pushNotification,
    )

    await expect(
      handler?.(
        {
          command: GEMINI_DUMP_COMMAND_NAME,
          arguments: '',
          sessionID: 'session-1',
        },
        { parts: [] },
      ),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          expect.objectContaining({
            type: 'text',
            ignored: true,
          }),
        ],
      },
    })
    await settings.dispose()
  })

  it('forwards each modal command through the same handled-sentinel abort', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const pushNotification = mock(() => 1)
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { messages, promptAsync } } as never,
      settings,
      pushNotification,
    )

    for (const command of MODAL_COMMANDS) {
      const result = handler?.(
        { command, arguments: '', sessionID: 'session-1' },
        { parts: [] },
      )
      await expect(result).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    }
    expect(promptAsync).toHaveBeenCalledTimes(MODAL_COMMANDS.length)
    expect(pushNotification).toHaveBeenCalledTimes(MODAL_COMMANDS.length)
    await settings.dispose()
  })

  it('includes cached accounts in the quota OPEN notification payload', async () => {
    const notifications: Array<Awaited<ReturnType<typeof buildDialogPayload>>> =
      []
    const pushNotification = (
      payload: Awaited<ReturnType<typeof buildDialogPayload>>,
    ) => {
      notifications.push(payload)
    }
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { promptAsync: mock(async () => {}) } } as never,
      settings,
      pushNotification,
      {
        listAccounts: async () => [
          {
            index: 0,
            label: 'Account 1',
            enabled: true,
            active: true,
            quota: {},
          },
        ],
      } as never,
      { isTuiConnected: () => true },
    )

    await expect(
      handler?.(
        { command: 'antigravity-quota', arguments: '', sessionID: 'session-1' },
        { parts: [] },
      ),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')

    const payload = notifications[0]
    expect(payload?.knobs.accounts as unknown[] | undefined).toHaveLength(1)
    await settings.dispose()
  })

  it('includes cached accounts in the account OPEN notification payload', async () => {
    const notifications: Array<Awaited<ReturnType<typeof buildDialogPayload>>> =
      []
    const pushNotification = (
      payload: Awaited<ReturnType<typeof buildDialogPayload>>,
    ) => {
      notifications.push(payload)
    }
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { promptAsync: mock(async () => {}) } } as never,
      settings,
      pushNotification,
      {
        listAccounts: async () => [
          {
            index: 0,
            label: 'Primary account',
            enabled: true,
            active: true,
            quota: {},
          },
        ],
      } as never,
      { isTuiConnected: () => true },
    )

    await expect(
      handler?.(
        {
          command: 'antigravity-account',
          arguments: '',
          sessionID: 'session-1',
        },
        { parts: [] },
      ),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')

    const payload = notifications[0]
    expect(payload?.knobs.accounts as unknown[] | undefined).toHaveLength(1)
    await settings.dispose()
  })

  it('suppresses the ignored fallback for every modal command when the tui is connected', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const pushNotification = mock(() => 1)
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { messages, promptAsync } } as never,
      settings,
      pushNotification,
      undefined,
      { isTuiConnected: () => true },
    )

    for (const command of MODAL_COMMANDS) {
      const result = handler?.(
        { command, arguments: '', sessionID: 'session-1' },
        { parts: [] },
      )
      await expect(result).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    }
    expect(promptAsync).toHaveBeenCalledTimes(0)
    expect(pushNotification).toHaveBeenCalledTimes(MODAL_COMMANDS.length)
    await settings.dispose()
  })

  it('suppresses the ignored fallback for /gemini-dump when the tui is connected', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const pushNotification = mock(() => 1)
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { messages, promptAsync } } as never,
      settings,
      pushNotification,
      undefined,
      { isTuiConnected: () => true },
    )

    await expect(
      handler?.(
        {
          command: GEMINI_DUMP_COMMAND_NAME,
          arguments: '',
          sessionID: 'session-1',
        },
        { parts: [] },
      ),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    expect(promptAsync).toHaveBeenCalledTimes(0)
    expect(pushNotification).toHaveBeenCalledTimes(0)
    await settings.dispose()
  })

  it('still sends the ignored fallback when the tui is disconnected', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const pushNotification = mock(() => 1)
    const settings = createOperatorSettingsController({
      projectConfigPath: join(dir, 'antigravity.json'),
      userConfigPath: join(dir, 'user.json'),
    })
    const handler = createCommandExecuteBefore(
      { session: { messages, promptAsync } } as never,
      settings,
      pushNotification,
      undefined,
      { isTuiConnected: () => false },
    )

    await expect(
      handler?.(
        {
          command: 'antigravity-quota',
          arguments: '',
          sessionID: 'session-1',
        },
        { parts: [] },
      ),
    ).rejects.toThrow('ANTIGRAVITY_COMMAND_HANDLED')
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(pushNotification).toHaveBeenCalledTimes(1)
    await settings.dispose()
  })
})

describe('buildDialogPayload', () => {
  let dir: string
  let ctx: CommandContext

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agy-payload-'))
    ctx = await makeContext(dir)
  })

  afterEach(async () => {
    await ctx.settings.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects unknown commands explicitly', async () => {
    await expect(
      buildDialogPayload('not-a-command' as CommandModalName, '', {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      }),
    ).rejects.toThrow()
  })

  it('produces the quota refresh payload', async () => {
    const payload = await buildDialogPayload('antigravity-quota', '', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-quota')
    expect(payload.knobs).toHaveProperty('mode')
  })

  it('produces the account CRUD payload with action argument', async () => {
    const payload = await buildDialogPayload('antigravity-account', 'add', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-account')
    expect(payload.knobs).toHaveProperty('action', 'add')
  })

  it('produces the routing toggle payload (argument override flows through)', async () => {
    const payload = await buildDialogPayload(
      'antigravity-routing',
      'cli_first=true',
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(payload.command).toBe('antigravity-routing')
    expect(payload.knobs).toHaveProperty('cli_first', true)
  })

  it('produces the killswitch threshold payload (argument override flows through)', async () => {
    const payload = await buildDialogPayload(
      'antigravity-killswitch',
      'minimum_remaining_percent=15',
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(payload.command).toBe('antigravity-killswitch')
    expect(payload.knobs).toHaveProperty('minimum_remaining_percent', 15)
  })

  // -------------------------------------------------------------------------
  // Task 11 — state-first routing/killswitch dialogs.
  //
  // The opening payload must report the CURRENT persisted state (no
  // inversion), so the dialog mounts with the operator's existing
  // settings as the user sees them. The plan trap: prior code negated
  // the boolean fallback (`!settings.routing.cli_first`) which showed
  // the wrong value on open.
  // -------------------------------------------------------------------------

  it('routing payload reports the current state when no argument is provided', async () => {
    await ctx.settings.update((draft) => {
      draft.routing.cli_first = true
      draft.routing.quota_style_fallback = true
    })
    const payload = await buildDialogPayload('antigravity-routing', '', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-routing')
    // Both flags report the seeded (true) state — no inversion.
    expect(payload.knobs).toHaveProperty('cli_first', true)
    expect(payload.knobs).toHaveProperty('quota_style_fallback', true)
    expect(payload.knobs).toHaveProperty('timeoutMs', 2_000)
  })

  it('routing payload reports the current state (false defaults) without inversion', async () => {
    const payload = await buildDialogPayload('antigravity-routing', '', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    // Defaults: both false. The pre-fix code inverted these to `true`,
    // which is the regression this assertion pins against.
    expect(payload.knobs).toHaveProperty('cli_first', false)
    expect(payload.knobs).toHaveProperty('quota_style_fallback', false)
  })

  it('killswitch payload reports the current state when no argument is provided', async () => {
    await ctx.settings.update((draft) => {
      draft.killswitch.enabled = true
      draft.killswitch.minimum_remaining_percent = 15
    })
    const payload = await buildDialogPayload('antigravity-killswitch', '', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-killswitch')
    expect(payload.knobs).toHaveProperty('enabled', true)
    expect(payload.knobs).toHaveProperty('minimum_remaining_percent', 15)
    // accounts map (empty after no overrides) is always present.
    expect(payload.knobs).toHaveProperty('accounts')
    expect(payload.knobs).toHaveProperty('timeoutMs', 2_000)
  })

  it('killswitch payload surfaces per-account override map when present', async () => {
    const key = 'abcdef012345'
    await ctx.settings.update((draft) => {
      draft.killswitch.accounts = { [key]: 30 }
    })
    const payload = await buildDialogPayload('antigravity-killswitch', '', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    const accounts = payload.knobs.accounts as Record<string, number>
    expect(accounts[key]).toBe(30)
  })

  it('produces the dump toggle payload', async () => {
    const payload = await buildDialogPayload('antigravity-dump', 'on', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-dump')
    expect(payload.knobs).toHaveProperty('mode', 'enable')
  })

  it('produces the logging level payload', async () => {
    const payload = await buildDialogPayload('antigravity-logging', 'debug', {
      client: {} as never,
      sessionID: '',
      settings: ctx.settings,
    })
    expect(payload.command).toBe('antigravity-logging')
    expect(payload.knobs).toHaveProperty('log_level', 'debug')
  })
})

describe('applyCommand', () => {
  let dir: string
  let ctx: CommandContext

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agy-apply-'))
    ctx = await makeContext(dir)
  })

  afterEach(async () => {
    await ctx.settings.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('dispatches every modal command through applyCommand and returns an ApplyResult', async () => {
    for (const command of MODAL_COMMANDS) {
      const result = await applyCommand(
        { command, arguments: '', sessionId: 'session-1' },
        {
          client: {} as never,
          sessionID: 'session-1',
          settings: ctx.settings,
        },
      )
      expect(result.text).toBeTruthy()
      expect(result.knobs).toBeDefined()
    }
  })

  it('rejects apply for an unknown command', async () => {
    await expect(
      applyCommand(
        { command: 'not-a-command' as CommandModalName, arguments: '' },
        {
          client: {} as never,
          sessionID: '',
          settings: ctx.settings,
        },
      ),
    ).rejects.toThrow()
  })

  it('account add and refresh opt into the 120s RPC timeout', async () => {
    const add = await applyCommand(
      { command: 'antigravity-account', arguments: 'add' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(add.knobs.timeoutMs).toBe(120_000)
    const refresh = await applyCommand(
      { command: 'antigravity-account', arguments: 'refresh' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(refresh.knobs.timeoutMs).toBe(120_000)
  })

  it('returns an OAuth URL and current rows when add-oauth-start is applied', async () => {
    const start = mock(async () => ({
      url: 'https://accounts.google.test/authorize',
      accounts: [
        {
          id: 'acct-0',
          index: 0,
          label: 'Primary account',
          enabled: true,
          current: true,
          quota: [],
        },
      ],
    }))

    const result = await applyCommand(
      { command: 'antigravity-account', arguments: 'add-oauth-start' },
      {
        client: {} as never,
        sessionID: 'session-1',
        settings: ctx.settings,
        accountOAuth: { start } as never,
      },
    )

    expect(start).toHaveBeenCalledWith('session-1')
    expect(result.text).toContain('Open this URL')
    expect(result.knobs.oauthUrl).toBe('https://accounts.google.test/authorize')
    expect(result.knobs.accounts as unknown[]).toHaveLength(1)
    expect(result.knobs.timeoutMs).toBe(120_000)
  })

  it('returns refreshed rows after add-oauth-finish', async () => {
    const finish = mock(async () => ({
      text: 'OAuth account added.',
      accounts: [
        {
          id: 'acct-0',
          index: 0,
          label: 'Primary account',
          enabled: true,
          current: true,
          quota: [],
        },
        {
          id: 'acct-1',
          index: 1,
          label: 'Work account',
          enabled: true,
          current: false,
          quota: [],
        },
      ],
    }))

    const result = await applyCommand(
      {
        command: 'antigravity-account',
        arguments: 'add-oauth-finish callback-code',
      },
      {
        client: {} as never,
        sessionID: 'session-1',
        settings: ctx.settings,
        accountOAuth: { finish } as never,
      },
    )

    expect(finish).toHaveBeenCalledWith('session-1', 'callback-code')
    expect(result.text).toBe('OAuth account added.')
    expect(result.knobs.accounts as unknown[]).toHaveLength(2)
    expect(result.knobs.timeoutMs).toBe(120_000)
  })

  it('returns the expired-pending result from add-oauth-finish', async () => {
    const finish = mock(async () => ({
      text: 'OAuth session expired. Please start again.',
      accounts: [],
    }))

    const result = await applyCommand(
      {
        command: 'antigravity-account',
        arguments: 'add-oauth-finish callback-code',
      },
      {
        client: {} as never,
        sessionID: 'session-1',
        settings: ctx.settings,
        accountOAuth: { finish } as never,
      },
    )

    expect(finish).toHaveBeenCalledWith('session-1', 'callback-code')
    expect(result.text).toBe('OAuth session expired. Please start again.')
    expect(result.knobs.accounts as unknown[]).toHaveLength(0)
  })

  it('account apply dispatches current/toggle/remove through the data service', async () => {
    const toggleSpy = mock(async () => [
      {
        id: 'acct-0',
        index: 0,
        label: 'Alpha',
        enabled: false,
        current: true,
        quota: [],
      },
    ])
    const setCurrentSpy = mock(async () => [
      {
        id: 'acct-1',
        index: 1,
        label: 'Beta',
        enabled: true,
        current: true,
        quota: [],
      },
    ])
    const removeSpy = mock(async () => [
      {
        id: 'acct-0',
        index: 0,
        label: 'Alpha',
        enabled: true,
        current: true,
        quota: [],
      },
    ])
    const commandData = {
      listAccounts: mock(async () => []),
      refreshQuota: mock(async () => []),
      setCurrentAccount: setCurrentSpy,
      toggleAccountEnabled: toggleSpy,
      removeAccount: removeSpy,
    }

    const toggle = await applyCommand(
      { command: 'antigravity-account', arguments: 'toggle 0' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(toggleSpy).toHaveBeenCalledWith(0)
    expect(toggle.knobs.timeoutMs).toBe(2_000)
    expect(toggle.text).toContain('enabled')

    const setCurrent = await applyCommand(
      { command: 'antigravity-account', arguments: 'current 1' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(setCurrentSpy).toHaveBeenCalledWith(1)
    expect(setCurrent.knobs.timeoutMs).toBe(2_000)

    const remove = await applyCommand(
      { command: 'antigravity-account', arguments: 'remove 0' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(removeSpy).toHaveBeenCalledWith(0)
    expect(remove.knobs.timeoutMs).toBe(2_000)
    expect(remove.text).toContain('removed')
  })

  it('account apply rejects an out-of-range index with a friendly text', async () => {
    const setCurrentSpy = mock(async () => null)
    const commandData = {
      listAccounts: mock(async () => []),
      refreshQuota: mock(async () => []),
      setCurrentAccount: setCurrentSpy,
      toggleAccountEnabled: mock(async () => null),
      removeAccount: mock(async () => null),
    }
    const result = await applyCommand(
      { command: 'antigravity-account', arguments: 'current 99' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(setCurrentSpy).toHaveBeenCalledWith(99)
    expect(result.text).toContain('99')
    expect(result.knobs.timeoutMs).toBe(2_000)
  })

  it('account apply rejects malformed arguments without throwing', async () => {
    const commandData = {
      listAccounts: mock(async () => []),
      refreshQuota: mock(async () => []),
      setCurrentAccount: mock(async () => null),
      toggleAccountEnabled: mock(async () => null),
      removeAccount: mock(async () => null),
    }
    const result = await applyCommand(
      { command: 'antigravity-account', arguments: 'toggle not-a-number' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(result.text).toContain('Unknown account action')
    expect(result.knobs.timeoutMs).toBe(2_000)
  })

  it('account apply degrades to a friendly error when the data service is missing', async () => {
    const result = await applyCommand(
      { command: 'antigravity-account', arguments: 'toggle 0' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    // Without a data service the locked-storage write cannot land,
    // so the apply surfaces a friendly error rather than silently
    // toasting success and leaving the runtime ahead of disk.
    expect(result.text).toContain('Command data service is not wired')
    expect(result.knobs.timeoutMs).toBe(2_000)
    expect(result.knobs.error).toBe(true)
  })

  // SHOULD-3 — when the data service throws AccountStorageUnreadableError
  // (corrupt file) or a lock-contention error, the apply layer must
  // surface the message as `text` so the dialog toasts it and stays
  // mounted (T8 pattern). The runtime view is left untouched because
  // the service does not apply the live mutation on a failed write.
  it('account apply surfaces locked-storage errors as friendly text', async () => {
    const removeSpy = mock(async () => {
      throw new AccountStorageUnreadableError('corrupt', {
        path: '/tmp/accounts.json',
        reason: 'invalid-shape',
        detail: 'unexpected',
        backupPath: null,
      })
    })
    const commandData = {
      listAccounts: mock(async () => []),
      refreshQuota: mock(async () => []),
      setCurrentAccount: mock(async () => null),
      toggleAccountEnabled: mock(async () => null),
      removeAccount: removeSpy,
    }
    const result = await applyCommand(
      { command: 'antigravity-account', arguments: 'remove 0' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
        commandData: commandData as never,
      },
    )
    expect(removeSpy).toHaveBeenCalledWith(0)
    // The friendly text surfaces the actual storage failure so the
    // dialog can toast a real cause rather than a generic "failed".
    expect(result.text).toContain('unreadable')
    expect(result.text).toContain('invalid-shape')
    expect(result.knobs.timeoutMs).toBe(2_000)
    expect(result.knobs.error).toBe(true)
  })

  it('quota refresh keeps the 2s default timeout', async () => {
    const result = await applyCommand(
      { command: 'antigravity-quota', arguments: 'refresh' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(result.knobs.timeoutMs).toBe(2_000)
  })

  // -------------------------------------------------------------------------
  // Task 11 — state-first apply: return the complete persisted state in
  // knobs so the dialog can re-render in place from the same shape
  // `buildDialogPayload` produced on open. The pre-fix code returned
  // only the parsed delta, which left the dialog with stale data after
  // a toggle.
  // -------------------------------------------------------------------------

  it('routing apply returns the complete persisted state in knobs', async () => {
    // Seed both flags true; toggle only cli_first.
    await ctx.settings.update((draft) => {
      draft.routing.cli_first = true
      draft.routing.quota_style_fallback = true
    })
    const result = await applyCommand(
      { command: 'antigravity-routing', arguments: 'cli_first=false' },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(result.text).toBe('Routing updated')
    // Complete state in knobs (not just the parsed delta).
    expect(result.knobs).toHaveProperty('cli_first', false)
    expect(result.knobs).toHaveProperty('quota_style_fallback', true)
    expect(result.knobs).toHaveProperty('timeoutMs', 2_000)
  })

  it('killswitch apply returns the complete persisted state in knobs', async () => {
    await ctx.settings.update((draft) => {
      draft.killswitch.enabled = true
      draft.killswitch.minimum_remaining_percent = 15
    })
    const result = await applyCommand(
      {
        command: 'antigravity-killswitch',
        arguments: 'minimum_remaining_percent=25',
      },
      {
        client: {} as never,
        sessionID: '',
        settings: ctx.settings,
      },
    )
    expect(result.text).toBe('Killswitch updated')
    expect(result.knobs).toHaveProperty('enabled', true)
    expect(result.knobs).toHaveProperty('minimum_remaining_percent', 25)
    // accounts map is always carried back so the dialog re-renders it.
    expect(result.knobs).toHaveProperty('accounts')
    expect(result.knobs).toHaveProperty('timeoutMs', 2_000)
  })

  // -------------------------------------------------------------------------
  // Task 11 — error path: when the fenced-lock writer rejects (lock
  // contention or unreadable config), the apply layer surfaces the
  // message as friendly `text` so the dialog can toast it and keep the
  // user on the same dialog (T8/T10 pattern). The pre-fix code would
  // throw, blowing the apply promise and leaving the dialog without
  // feedback.
  // -------------------------------------------------------------------------

  it('routing apply surfaces a friendly error when the writer is contended', async () => {
    const updateMock = mock(async () => {
      throw new Error(
        'Could not acquire operator-config lock at /tmp/test.json (already held by another writer).',
      )
    })
    // Replace the controller's update method to force the lock failure.
    const origUpdate = ctx.settings.update
    ctx.settings.update = updateMock as never
    try {
      const result = await applyCommand(
        { command: 'antigravity-routing', arguments: 'cli_first=true' },
        {
          client: {} as never,
          sessionID: '',
          settings: ctx.settings,
        },
      )
      expect(updateMock).toHaveBeenCalled()
      // The friendly text surfaces the lock reason, not a stack trace.
      expect(result.text).toContain('Routing update failed')
      expect(result.text).toContain('lock')
      expect(result.knobs).toHaveProperty('timeoutMs', 2_000)
      expect(result.knobs.error).toBe(true)
    } finally {
      ctx.settings.update = origUpdate
    }
  })

  it('killswitch apply surfaces a friendly error when the writer is contended', async () => {
    const updateMock = mock(async () => {
      throw new Error(
        'Could not acquire operator-config lock at /tmp/test.json (already held by another writer).',
      )
    })
    const origUpdate = ctx.settings.update
    ctx.settings.update = updateMock as never
    try {
      const result = await applyCommand(
        { command: 'antigravity-killswitch', arguments: 'enabled=true' },
        {
          client: {} as never,
          sessionID: '',
          settings: ctx.settings,
        },
      )
      expect(updateMock).toHaveBeenCalled()
      expect(result.text).toContain('Killswitch update failed')
      expect(result.text).toContain('lock')
      expect(result.knobs).toHaveProperty('timeoutMs', 2_000)
      expect(result.knobs.error).toBe(true)
    } finally {
      ctx.settings.update = origUpdate
    }
  })
})
