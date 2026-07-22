import { describe, expect, it } from 'bun:test'

import { applyAntigravityProviderCatalog } from './catalog'
import {
  getAntigravityOpencodeModelIds,
  OPENCODE_MODEL_DEFINITIONS,
} from './model-registry'

describe('applyAntigravityProviderCatalog', () => {
  it('merges Antigravity models without replacing provider configuration', () => {
    const config = {
      provider: {
        google: {
          models: { existing: { name: 'Existing model' } },
          options: { apiKey: 'kept' },
        },
      },
    }

    applyAntigravityProviderCatalog(config, 'google')

    expect(config.provider.google.models).toEqual({
      existing: { name: 'Existing model' },
      ...OPENCODE_MODEL_DEFINITIONS,
    })
    expect(config.provider.google.options).toEqual({ apiKey: 'kept' })
  })

  it('installs the complete Antigravity whitelist', () => {
    const config: Record<string, unknown> = {}

    applyAntigravityProviderCatalog(config, 'custom-provider')

    const provider = config.provider as Record<string, { whitelist?: string[] }>
    expect(provider['custom-provider']?.whitelist).toEqual(
      getAntigravityOpencodeModelIds(),
    )
  })
})
