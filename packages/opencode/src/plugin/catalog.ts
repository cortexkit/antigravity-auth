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
