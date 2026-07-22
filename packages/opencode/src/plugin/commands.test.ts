import { describe, expect, it, mock } from 'bun:test'

import {
  createCommandExecuteBefore,
  registerAntigravityCommands,
} from './commands'
import { GEMINI_DUMP_COMMAND_NAME } from './gemini-dump'

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
})

describe('createCommandExecuteBefore', () => {
  it('ignores unrelated commands', async () => {
    const promptAsync = mock(async () => {})
    const handler = createCommandExecuteBefore({
      session: { promptAsync },
    } as never)

    await expect(
      handler?.(
        { command: 'other', arguments: '', sessionID: 'session-1' },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()
    expect(promptAsync).not.toHaveBeenCalled()
  })

  it('sends an ignored assistant message then throws the handled sentinel', async () => {
    const promptAsync = mock(async () => {})
    const messages = mock(async () => ({ data: [] }))
    const handler = createCommandExecuteBefore({
      session: { messages, promptAsync },
    } as never)

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
  })
})
