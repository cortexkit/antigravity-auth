import { ANTIGRAVITY_MENU_COMMAND } from './commands'
import { getOpencode1ModelDefinitions } from './config/models'
import { createLogger } from './logger'
import { getAntigravityOpencodeModelIds } from './model-registry'

const log = createLogger('catalog')

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

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
  logger: Pick<typeof log, 'warn'> = log,
): void {
  const mutableConfig = config as OpencodeMutableConfig
  mutableConfig.provider ??= {}

  const providerConfig = mutableConfig.provider[providerId] ?? {}
  const models = getOpencode1ModelDefinitions()
  for (const entry of Object.values(providerConfig.models ?? {})) {
    const model = readObject(entry)
    for (const options of [
      readObject(model?.options),
      ...Object.values(readObject(model?.variants) ?? {}).map(readObject),
    ]) {
      if (!options || !Object.hasOwn(options, 'googleSearch')) continue
      logger.warn('Ignored removed googleSearch model option')
      delete options.googleSearch
    }
  }
  providerConfig.models = {
    ...(providerConfig.models ?? {}),
    ...models,
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
