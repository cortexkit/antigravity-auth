import {
  executeGeminiDumpCommand,
  GEMINI_DUMP_COMMAND_NAME,
  parseGeminiDumpCommandAction,
  setGeminiDumpEnabled,
} from './gemini-dump'
import { resolvePromptContext } from './prompt-context'
import type { PluginClient, PluginResult } from './types'

const HANDLED_COMMAND_SENTINEL = 'ANTIGRAVITY_COMMAND_HANDLED'

async function sendIgnoredMessage(
  client: PluginClient,
  sessionID: string,
  text: string,
): Promise<void> {
  const session = client.session as
    | {
        promptAsync?: (input: unknown) => Promise<unknown>
        prompt?: (input: unknown) => Promise<unknown> | unknown
      }
    | undefined
  const promptContext = await resolvePromptContext(client, sessionID)
  const request = {
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: 'text', text, ignored: true }],
      ...(promptContext?.agent ? { agent: promptContext.agent } : {}),
      ...(promptContext?.model ? { model: promptContext.model } : {}),
      ...(promptContext?.variant ? { variant: promptContext.variant } : {}),
    },
  }

  if (typeof session?.promptAsync === 'function') {
    await session.promptAsync(request)
    return
  }

  if (typeof session?.prompt === 'function') {
    await Promise.resolve(session.prompt(request))
    return
  }

  throw new Error(
    'OpenCode session prompt API is unavailable for ignored replies.',
  )
}

function throwHandledCommandSentinel(): never {
  throw new Error(HANDLED_COMMAND_SENTINEL)
}

export function registerAntigravityCommands(
  config: Record<string, unknown>,
): void {
  const mutableConfig = config as Record<string, unknown> & {
    command?: Record<string, unknown>
  }
  mutableConfig.command = {
    ...(mutableConfig.command ?? {}),
    [GEMINI_DUMP_COMMAND_NAME]: {
      template: GEMINI_DUMP_COMMAND_NAME,
      description:
        'Show or toggle Gemini/Antigravity wire dump capture for debugging.',
    },
  }
}

export function createCommandExecuteBefore(
  client: PluginClient,
): PluginResult['command.execute.before'] {
  return async (input) => {
    if (input.command !== GEMINI_DUMP_COMMAND_NAME) return

    const action = parseGeminiDumpCommandAction(input.arguments)
    if (action.type === 'enable' || action.type === 'disable') {
      setGeminiDumpEnabled(action.type === 'enable')
    }

    await sendIgnoredMessage(
      client,
      input.sessionID,
      executeGeminiDumpCommand({ argumentsText: input.arguments }),
    )
    throwHandledCommandSentinel()
  }
}
