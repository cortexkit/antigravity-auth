import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('produces the routing toggle payload', async () => {
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

  it('produces the killswitch threshold payload', async () => {
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
})
