import { ANTIGRAVITY_MENU_COMMAND } from './commands'
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

/**
 * Register the plugin's one slash command, `/antigravity`, which opens the
 * Antigravity menu (the request dump switch is in its Diagnostics section).
 * Existing entries are preserved: the host ships its own slash commands and
 * the merge must not remove them.
 */
export function registerAntigravityCommands(
  config: Record<string, unknown>,
): void {
  const mutableConfig = config as OpencodeMutableConfig
  mutableConfig.command = {
    ...(mutableConfig.command ?? {}),
    [ANTIGRAVITY_MENU_COMMAND]: {
      template: ANTIGRAVITY_MENU_COMMAND,
      description:
        'Open the Antigravity menu: accounts, quota, routing, limits and diagnostics.',
    },
  }
}
