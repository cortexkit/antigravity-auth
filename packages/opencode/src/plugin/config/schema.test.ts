import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { AntigravityConfigSchema, DEFAULT_CONFIG } from './schema'

describe('soft_quota_threshold_percent config', () => {
  it('disables the reserve by default in both config defaults', () => {
    expect(DEFAULT_CONFIG.soft_quota_threshold_percent).toBe(100)
    expect(AntigravityConfigSchema.parse({}).soft_quota_threshold_percent).toBe(
      100,
    )
  })

  for (const threshold of [1, 80, 100]) {
    it(`preserves an explicit threshold of ${threshold}`, () => {
      expect(
        AntigravityConfigSchema.parse({
          soft_quota_threshold_percent: threshold,
        }).soft_quota_threshold_percent,
      ).toBe(threshold)
    })
  }

  it('publishes the disabled default in the generated JSON schema', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../assets/antigravity.schema.json', import.meta.url),
        'utf8',
      ),
    )
    expect(schema.properties.soft_quota_threshold_percent).toMatchObject({
      type: 'number',
      default: 100,
    })
  })
})

describe('auto_resume config', () => {
  it('uses the same default in the schema and DEFAULT_CONFIG', () => {
    const parsed = AntigravityConfigSchema.parse({})

    expect(DEFAULT_CONFIG).toHaveProperty('auto_resume', true)
    expect(parsed.auto_resume).toBe(DEFAULT_CONFIG.auto_resume)
  })

  it('documents auto_resume in the JSON schema', () => {
    const schemaPath = new URL(
      '../../../assets/antigravity.schema.json',
      import.meta.url,
    )
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: Record<
        string,
        { type?: string; default?: unknown; description?: string }
      >
    }

    const autoResume = schema.properties?.auto_resume
    expect(autoResume).toBeDefined()
    expect(autoResume).toMatchObject({
      type: 'boolean',
      default: true,
    })
    expect(typeof autoResume?.description).toBe('string')
    expect(autoResume?.description?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('retired header routing config', () => {
  it('strips obsolete keys without validating their values or losing current settings', () => {
    const parsed = AntigravityConfigSchema.partial().parse({
      cli_first: 'obsolete',
      quota_fallback: {},
      quota_style_fallback: null,
      keep_thinking: true,
      operator: { routing: 'obsolete', log_level: 'debug' },
    })
    expect(parsed).toMatchObject({
      keep_thinking: true,
      operator: { log_level: 'debug' },
    })
    for (const key of ['cli_first', 'quota_fallback', 'quota_style_fallback'])
      expect(parsed).not.toHaveProperty(key)
    expect(parsed.operator).not.toHaveProperty('routing')
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../assets/antigravity.schema.json', import.meta.url),
        'utf8',
      ),
    )
    for (const key of ['cli_first', 'quota_fallback', 'quota_style_fallback']) {
      expect(DEFAULT_CONFIG).not.toHaveProperty(key)
      expect(schema.properties).not.toHaveProperty(key)
    }
    expect(schema.properties.operator.properties).not.toHaveProperty('routing')
  })
})

describe('claude_prompt_auto_caching config', () => {
  it('includes claude_prompt_auto_caching default in DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG).toHaveProperty('claude_prompt_auto_caching', false)
    expect(AntigravityConfigSchema.parse({}).claude_prompt_auto_caching).toBe(
      false,
    )
  })

  it('documents claude_prompt_auto_caching in the JSON schema', () => {
    const schemaPath = new URL(
      '../../../assets/antigravity.schema.json',
      import.meta.url,
    )
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: Record<
        string,
        { type?: string; default?: unknown; description?: string }
      >
    }

    const claudePromptAutoCaching =
      schema.properties?.claude_prompt_auto_caching
    expect(claudePromptAutoCaching).toBeDefined()
    expect(claudePromptAutoCaching).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(typeof claudePromptAutoCaching?.description).toBe('string')
    expect(claudePromptAutoCaching?.description?.length ?? 0).toBeGreaterThan(0)
  })
})
