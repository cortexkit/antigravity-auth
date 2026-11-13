import { describe, expect, it } from 'bun:test'
import hydrogen from '../../../test-fixtures/agy-cli-1.5.5/hydrogen-evidence.json'
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

describe('Gemini 4 Hydrogen', () => {
  it('resolves all four routes with high as the default and host variant overrides', () => {
    for (const prefix of ['', 'antigravity-']) {
      expect(resolveModelWithTier(`${prefix}gemini-4-hydrogen`)).toMatchObject({
        actualModel: 'gemini-4-hydrogen-high',
        thinkingLevel: 'high',
        tier: 'high',
        isThinkingModel: true,
      })
      for (const tier of ['low', 'medium', 'high', 'xhigh'] as const) {
        expect(
          resolveModelWithTier(`${prefix}gemini-4-hydrogen-${tier}`),
        ).toMatchObject({
          actualModel: `gemini-4-hydrogen-${tier}`,
          thinkingLevel: tier,
          tier,
          isThinkingModel: true,
        })
        for (const source of ['low', 'medium', 'high', 'xhigh']) {
          expect(
            resolveModelWithVariant(`${prefix}gemini-4-hydrogen-${source}`, {
              thinkingLevel: tier,
            }),
          ).toMatchObject({
            actualModel: `gemini-4-hydrogen-${tier}`,
            thinkingLevel: tier,
            tier,
            configSource: 'variant',
          })
        }
      }
    }
  })

  it('registers the captured server routes and keeps the ordinary Gemini quota pool', () => {
    for (const [tier, displayTier, modelEnum] of [
      ['low', 'Low', 'MODEL_PLACEHOLDER_M527'],
      ['medium', 'Medium', 'MODEL_PLACEHOLDER_M526'],
      ['high', 'High', 'MODEL_PLACEHOLDER_M525'],
      ['xhigh', 'XHigh', 'MODEL_PLACEHOLDER_M528'],
    ]) {
      const route = `gemini-4-hydrogen-${tier}`
      expect(getAgyNativeModel(route)).toEqual({
        displayName: `Gemini 4 Hydrogen (${displayTier})`,
        maxTokens: 1048576,
        maxOutputTokens: 262144,
        model: modelEnum,
        supportsThinking: true,
      })
      for (const id of [route, `antigravity-${route}`]) {
        expect(isRetiredAgyModel(id)).toBe(false)
        expect(getQuotaGroupForModel(id)).toBe('gemini')
        expect(getQuotaGroupForModel(id, true)).toBe('gemini')
      }
    }
    for (const id of ['gemini-4-hydrogen', 'antigravity-gemini-4-hydrogen']) {
      expect(getQuotaGroupForModel(id)).toBe('gemini')
      expect(getQuotaGroupForModel(id, true)).toBe('gemini')
    }
  })

  it('publishes the Hydrogen selector with exactly four effort variants', () => {
    expect(getAntigravityOpencodeModelIds()).toContain(
      'antigravity-gemini-4-hydrogen',
    )
    const model = getPublicModelDefinitions()['antigravity-gemini-4-hydrogen']
    expect(model).toMatchObject({
      name: 'Gemini 4 Hydrogen (Antigravity)',
      reasoning: true,
      limit: { context: 1048576, output: 262144 },
    })
    expect(model?.variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
      xhigh: { thinkingLevel: 'xhigh' },
    })
    for (const internal of [
      'gemini-flash-worker-agy',
      'gemini-pro-orchestrator',
      'gemini-pro-orchestrator-argon',
    ]) {
      expect(getAgyNativeModel(internal)).toBeUndefined()
      expect(getPublicModelDefinitions()).not.toHaveProperty(internal)
      expect(getAntigravityOpencodeModelIds()).not.toContain(
        `antigravity-${internal}`,
      )
    }
  })

  it('matches captured Low and numeric XHigh wire configs and inferred Medium/High', () => {
    // CLI 1.5.5 captured LOW and numeric 100; MEDIUM/HIGH are inferred
    // from the server routes and Carbon's mapping, not accepted traffic.
    for (const [tier, thinkingLevel] of [
      ['low', 'LOW'],
      ['medium', 'MEDIUM'],
      ['high', 'HIGH'],
      ['xhigh', 100],
    ] as const) {
      const config: Record<string, unknown> = {}
      applyAgyNativeGenerationConfig(`gemini-4-hydrogen-${tier}`, config)
      expect(JSON.parse(JSON.stringify(config))).toEqual({
        maxOutputTokens: 262144,
        thinkingConfig: { includeThoughts: true, thinkingLevel },
      })
      if (tier === 'low')
        expect(config).toEqual(hydrogen.native_generation_config_low)
      if (tier === 'xhigh') {
        expect(config).toEqual(hydrogen.native_generation_config_xhigh)
        expect(
          typeof (config.thinkingConfig as { thinkingLevel: unknown })
            .thinkingLevel,
        ).toBe('number')
      }
    }
  })

  it('preserves explicit output caps and replaces budgets even for numeric XHigh', () => {
    for (const key of ['maxOutputTokens', 'max_output_tokens']) {
      for (const cap of [0, 2048]) {
        const config: Record<string, unknown> = {
          [key]: cap,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 1234 },
        }
        applyAgyNativeGenerationConfig('gemini-4-hydrogen-xhigh', config)
        expect(config).toEqual({
          maxOutputTokens: cap,
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
        })
      }
    }
  })
})
