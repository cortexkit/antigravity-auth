import { describe, expect, it } from 'bun:test'
import opus from '../../../../test-fixtures/agy-cli-1.3.3/native-opus-low.json'
import sonnet from '../../../../test-fixtures/agy-cli-1.3.3/native-sonnet-low.json'
import schemaDerived from '../../../../test-fixtures/agy-cli-1.3.3/schema-derived-thinking.json'
import { applyAgyNativeGenerationConfig } from './agy-generation.ts'

describe('native AGY generation defaults', () => {
  it('matches both captured Claude low configurations exactly', () => {
    for (const fixture of [opus, sonnet]) {
      const config: Record<string, unknown> = {}
      applyAgyNativeGenerationConfig(fixture.model, config)
      expect(config).toEqual(fixture.native_generation_config)
      expect(config).not.toEqual(fixture.as_sent_generation_config)
    }
  })

  it('uses schema-derived medium/high without claiming a capture', () => {
    for (const family of ['opus', 'sonnet']) {
      for (const effort of ['medium', 'high'] as const) {
        const config: Record<string, unknown> = {}
        applyAgyNativeGenerationConfig(`claude-${family}-5-5-${effort}`, config)
        expect(config).toEqual({
          maxOutputTokens: 128000,
          thinkingConfig: schemaDerived[effort],
        })
      }
    }
  })

  it('preserves explicit output caps and unrelated sampling settings', () => {
    for (const cap of [0, 1, 2048, 128000]) {
      for (const key of ['maxOutputTokens', 'max_output_tokens']) {
        const config: Record<string, unknown> = { [key]: cap, temperature: 0.2 }
        applyAgyNativeGenerationConfig(opus.model, config)
        expect(config).toEqual({
          ...opus.native_generation_config,
          maxOutputTokens: cap,
          temperature: 0.2,
        })
      }
    }
  })
})
