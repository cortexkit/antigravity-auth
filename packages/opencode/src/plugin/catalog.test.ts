import { describe, expect, it } from 'bun:test'
import { RELEASE_MODEL_IDS } from './__fixtures__/release-model-ids'

import { applyAntigravityProviderCatalog } from './catalog'
import {
  getAntigravityOpencodeModelIds,
  OPENCODE_MODEL_DEFINITIONS,
  resolveModelWithVariant,
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
      'antigravity-gemini-4-hydrogen': {
        ...OPENCODE_MODEL_DEFINITIONS['antigravity-gemini-4-hydrogen'],
        variants: {
          low: { thinkingLevel: 'low' },
          medium: { thinkingLevel: 'medium' },
          high: { thinkingLevel: 'high' },
        },
      },
    })
    expect(config.provider.google.options).toEqual({ apiKey: 'kept' })
  })

  it('offers Hydrogen on OpenCode 1 with exactly low, medium and high and defaults to high', () => {
    const config: Record<string, unknown> = {}

    applyAntigravityProviderCatalog(config, 'google')

    const provider = config.provider as Record<
      string,
      { models: typeof OPENCODE_MODEL_DEFINITIONS }
    >
    const hydrogen = provider.google!.models['antigravity-gemini-4-hydrogen']!
    expect(hydrogen.variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
    expect(resolveModelWithVariant(hydrogen.id)).toMatchObject({
      actualModel: 'gemini-4-hydrogen-high',
      thinkingLevel: 'high',
    })
    expect(
      Object.keys(
        OPENCODE_MODEL_DEFINITIONS['antigravity-gemini-4-hydrogen']!.variants!,
      ),
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('installs the complete Antigravity whitelist', () => {
    const config: Record<string, unknown> = {}

    applyAntigravityProviderCatalog(config, 'custom-provider')

    const provider = config.provider as Record<string, { whitelist?: string[] }>
    expect(provider['custom-provider']?.whitelist).toEqual(
      getAntigravityOpencodeModelIds(),
    )
    expect([...provider['custom-provider']!.whitelist!].sort()).toEqual(
      RELEASE_MODEL_IDS,
    )
  })
})
