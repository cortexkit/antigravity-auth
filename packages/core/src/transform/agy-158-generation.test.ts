import { describe, expect, it } from 'bun:test'
import projection from '../../../../test-fixtures/agy-cli-1.5.8/identity-projection.json'
import { applyAgyNativeGenerationConfig } from './agy-generation.ts'

describe('agy 1.5.8 captured generation tiers', () => {
  for (const family of [
    'gemini-3.8-flash',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
  ]) {
    for (const tier of ['low', 'medium', 'high']) {
      const model = `${family}-${tier}`
      it(`${model} sends only the captured thinking level`, () => {
        const config: Record<string, unknown> = {}
        applyAgyNativeGenerationConfig(model, config)
        expect(config).toEqual({
          maxOutputTokens: family.startsWith('gemini-') ? 65536 : 128000,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: tier.toUpperCase(),
          },
        })
        if (model === 'gemini-3.8-flash-low')
          expect(config).toEqual(projection.runs.r2[0]!.generation_config)
        if (model === 'claude-sonnet-5-5-low')
          expect(config).toEqual(projection.runs.r2[2]!.generation_config)
      })

      it(`${model} preserves explicit thinking budgets and output caps`, () => {
        for (const thinkingBudget of [-1, 0, 1234]) {
          const config: Record<string, unknown> = {
            maxOutputTokens: 1,
            thinkingConfig: { includeThoughts: true, thinkingBudget },
          }
          applyAgyNativeGenerationConfig(model, config)
          expect(config).toEqual({
            maxOutputTokens: 1,
            thinkingConfig: { includeThoughts: true, thinkingBudget },
          })
        }
      })
    }
  }
})
