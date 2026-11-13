import { describe, expect, it } from 'bun:test'
import opus from '../../../../test-fixtures/agy-cli-1.3.3/native-opus-low.json'
import sonnet from '../../../../test-fixtures/agy-cli-1.3.3/native-sonnet-low.json'
import argon from '../../../../test-fixtures/agy-cli-1.3.5/native-argon-low.json'
import projection from '../../../../test-fixtures/agy-cli-1.5.8/identity-projection.json'
import { applyAgyNativeGenerationConfig } from './agy-generation.ts'

describe('native AGY generation defaults', () => {
  it('uses Argon levels without a budget for every variant and preserves output caps', () => {
    for (const effort of ['low', 'medium', 'high']) {
      for (const cap of [undefined, 0, 2048]) {
        for (const key of ['maxOutputTokens', 'max_output_tokens']) {
          const config: Record<string, unknown> = {
            thinkingConfig: { thinkingBudget: 1234 },
            ...(cap === undefined ? {} : { [key]: cap }),
          }
          applyAgyNativeGenerationConfig(`gemini-4-argon-${effort}`, config)
          expect(config).toEqual({
            maxOutputTokens: cap ?? 65536,
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: effort.toUpperCase(),
            },
          })
        }
      }
    }
    const captured: Record<string, unknown> = {}
    applyAgyNativeGenerationConfig('gemini-4-argon-low', captured)
    expect(captured).toEqual(argon.requests[0]!.native_generation_config)
  })
  it('matches both captured Claude low configurations exactly', () => {
    // agy 1.5.8 captures supersede the older zero-budget Claude defaults.
    for (const fixture of [opus, sonnet]) {
      const config: Record<string, unknown> = {}
      applyAgyNativeGenerationConfig(fixture.model, config)
      expect(config).toEqual(projection.runs.r2[2]!.generation_config)
      expect(config).not.toEqual(fixture.as_sent_generation_config)
    }
  })

  it('uses captured agy 1.5.8 Claude medium/high levels without a budget', () => {
    // All Claude efforts are now captured rather than schema-derived.
    for (const family of ['opus', 'sonnet']) {
      for (const effort of ['medium', 'high'] as const) {
        const config: Record<string, unknown> = {}
        applyAgyNativeGenerationConfig(`claude-${family}-5-5-${effort}`, config)
        expect(config).toEqual({
          maxOutputTokens: 128000,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: effort.toUpperCase(),
          },
        })
      }
    }
  })

  it('preserves explicit output caps and unrelated sampling settings', () => {
    // Update the default thinking shape to agy 1.5.8 while preserving cap precedence.
    for (const cap of [0, 1, 2048, 128000]) {
      for (const key of ['maxOutputTokens', 'max_output_tokens']) {
        const config: Record<string, unknown> = { [key]: cap, temperature: 0.2 }
        applyAgyNativeGenerationConfig(opus.model, config)
        expect(config).toEqual({
          ...projection.runs.r2[2]!.generation_config,
          maxOutputTokens: cap,
          temperature: 0.2,
        })
      }
    }
  })
})
