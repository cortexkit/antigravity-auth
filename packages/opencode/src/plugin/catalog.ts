import type { CommandModalName } from '../rpc/protocol'
import {
  ANTIGRAVITY_ACCOUNT_COMMAND_NAME,
  ANTIGRAVITY_DUMP_COMMAND_NAME,
  ANTIGRAVITY_KILLSWITCH_COMMAND_NAME,
  ANTIGRAVITY_LOGGING_COMMAND_NAME,
  ANTIGRAVITY_QUOTA_COMMAND_NAME,
  ANTIGRAVITY_ROUTING_COMMAND_NAME,
  MODAL_COMMANDS,
} from './commands'
import { GEMINI_DUMP_COMMAND_NAME } from './gemini-dump'
import {
  getAntigravityOpencodeModelIds,
  OPENCODE_MODEL_DEFINITIONS,
} from './model-registry'

type OpencodeMutableConfig = Record<string, unknown> & {
  provider?: Record<
    string,
    Record<string, unknown> & {
      models?: Record<string, unknown>
      whitelist?: string[]
    }
  >
  command?: Record<string, unknown>
}

export function applyAntigravityProviderCatalog(
  config: Record<string, unknown>,
  providerId: string,
): void {
  const mutableConfig = config as OpencodeMutableConfig
  mutableConfig.provider ??= {}

  const providerConfig = mutableConfig.provider[providerId] ?? {}
  providerConfig.models = {
    ...(providerConfig.models ?? {}),
    ...OPENCODE_MODEL_DEFINITIONS,
  }
  providerConfig.whitelist = getAntigravityOpencodeModelIds()
  mutableConfig.provider[providerId] = providerConfig
}

const COMMAND_DESCRIPTIONS: Record<CommandModalName, string> = {
  'antigravity-quota': 'Refresh Antigravity quota for the active account pool.',
  'antigravity-account': 'Add, refresh, or remove Antigravity accounts.',
  'antigravity-routing':
    'Toggle routing overrides for Gemini / Antigravity fallback.',
  'antigravity-killswitch':
    'Configure the quota killswitch threshold and per-account overrides.',
  'antigravity-dump':
    'Show or toggle Gemini/Antigravity wire dump capture for debugging.',
  'antigravity-logging': 'Adjust the runtime logging level.',
}

/**
 * Register every modal command with the host `config.command` map.
 *
 * Existing entries are preserved — the host may ship its own slash
 * commands (e.g. `init`, `undo`, …) and the merge must not blow them
 * away. `/gemini-dump` is registered in addition to the modal
 * `antigravity-dump` so legacy sessions keep working.
 *
 * This function is the FIRST of three places that must agree on the
 * set of modal commands — see the three-wiring test in
 * `commands.test.ts` for the invariant.
 */
export function registerAntigravityCommands(
  config: Record<string, unknown>,
): void {
  const mutableConfig = config as OpencodeMutableConfig
  const existing = mutableConfig.command ?? {}
  const next: Record<string, unknown> = { ...existing }
  for (const command of MODAL_COMMANDS) {
    next[command] = {
      template: command,
      description: COMMAND_DESCRIPTIONS[command],
    }
  }
  next[GEMINI_DUMP_COMMAND_NAME] = {
    template: GEMINI_DUMP_COMMAND_NAME,
    description:
      'Show or toggle Gemini/Antigravity wire dump capture for debugging.',
  }
  mutableConfig.command = next
}

// Re-export so existing callers can keep importing from catalog.
export const ANTIGRAVITY_COMMAND_NAMES = {
  quota: ANTIGRAVITY_QUOTA_COMMAND_NAME,
  account: ANTIGRAVITY_ACCOUNT_COMMAND_NAME,
  routing: ANTIGRAVITY_ROUTING_COMMAND_NAME,
  killswitch: ANTIGRAVITY_KILLSWITCH_COMMAND_NAME,
  dump: ANTIGRAVITY_DUMP_COMMAND_NAME,
  logging: ANTIGRAVITY_LOGGING_COMMAND_NAME,
} as const
