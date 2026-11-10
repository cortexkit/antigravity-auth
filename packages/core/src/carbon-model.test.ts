import { describe, expect, it } from 'bun:test'
import carbon from '../../../test-fixtures/agy-cli-1.5.5/native-carbon-low.json'
import {
  getAgyNativeModel,
  getAntigravityOpencodeModelIds,
  getPublicModelDefinitions,
  getQuotaGroupForModel,
  isRetiredAgyModel,
} from './model-registry.ts'
import { applyAgyNativeGenerationConfig } from './transform/agy-generation.ts'
import {
  resolveModelWithTier,
  resolveModelWithVariant,
} from './transform/model-resolver.ts'

describe('Gemini 4 Carbon', () => {
  it('resolves Carbon routes, grouped defaults and host variant overrides', () => {
    for (const prefix of ['', 'antigravity-']) {
      expect(resolveModelWithTier(`${prefix}gemini-4-carbon`)).toMatchObject({
        actualModel: 'gemini-4-carbon-medium',
        thinkingLevel: 'medium',
        tier: 'medium',
        isThinkingModel: true,
      })
      for (const tier of ['low', 'medium', 'high'] as const) {
        expect(
          resolveModelWithTier(`${prefix}gemini-4-carbon-${tier}`),
        ).toMatchObject({
          actualModel: `gemini-4-carbon-${tier}`,
          thinkingLevel: tier,
          tier,
        })
        expect(
          resolveModelWithVariant(`${prefix}gemini-4-carbon-low`, {
            thinkingLevel: tier,
          }),
        ).toMatchObject({
          actualModel: `gemini-4-carbon-${tier}`,
          configSource: 'variant',
        })
      }
    }
  })

  it('registers the server routes and uses the ordinary Gemini quota pool', () => {
    for (const [tier, modelEnum, level] of [
      ['low', 'MODEL_PLACEHOLDER_M438', 1],
      ['medium', 'MODEL_PLACEHOLDER_M437', 2],
      ['high', 'MODEL_PLACEHOLDER_M427', 3],
    ] as const) {
      const route = `gemini-4-carbon-${tier}`
      expect(getAgyNativeModel(route)).toEqual({
        displayName: `Gemini 4 Carbon (${tier[0]!.toUpperCase()}${tier.slice(1)})`,
        maxTokens: 1048576,
        maxOutputTokens: 262144,
        model: modelEnum,
        thinkingLevel: level,
        thinkingBudget: -1,
        supportsThinking: true,
      })
      for (const id of [route, `antigravity-${route}`]) {
        expect(isRetiredAgyModel(id)).toBe(false)
        expect(getQuotaGroupForModel(id)).toBe('gemini')
        expect(getQuotaGroupForModel(id, true)).toBe('gemini')
      }
    }
    for (const id of ['gemini-4-carbon', 'antigravity-gemini-4-carbon']) {
      expect(getQuotaGroupForModel(id)).toBe('gemini')
      expect(getQuotaGroupForModel(id, true)).toBe('gemini')
    }
  })

  it('publishes the Carbon selector with three effort variants', () => {
    expect(getAntigravityOpencodeModelIds()).toContain(
      'antigravity-gemini-4-carbon',
    )
    expect(
      getPublicModelDefinitions()['antigravity-gemini-4-carbon'],
    ).toMatchObject({
      name: 'Gemini 4 Carbon (Antigravity)',
      reasoning: true,
      limit: { context: 1048576, output: 262144 },
      variants: {
        low: { thinkingLevel: 'low' },
        medium: { thinkingLevel: 'medium' },
        high: { thinkingLevel: 'high' },
      },
    })
  })

  it('matches captured Carbon Low generation and infers Medium and High levels', () => {
    for (const tier of ['low', 'medium', 'high']) {
      const config: Record<string, unknown> = {}
      applyAgyNativeGenerationConfig(`gemini-4-carbon-${tier}`, config)
      expect(config).toEqual({
        maxOutputTokens: 262144,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: tier.toUpperCase(),
        },
      })
      if (tier === 'low')
        expect(config).toEqual(carbon.requests[0]!.native_generation_config)
    }
  })

  it('preserves explicit Carbon output caps and removes thinking budgets', () => {
    for (const key of ['maxOutputTokens', 'max_output_tokens']) {
      for (const cap of [0, 2048]) {
        const config: Record<string, unknown> = {
          [key]: cap,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 1234 },
        }
        applyAgyNativeGenerationConfig('gemini-4-carbon-low', config)
        expect(config).toEqual({
          maxOutputTokens: cap,
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' },
        })
      }
    }
  })
})
