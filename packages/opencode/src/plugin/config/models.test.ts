import { describe, expect, it } from 'bun:test'

import { OPENCODE_MODEL_DEFINITIONS } from './models'

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name]
  if (!model) {
    throw new Error(`Missing model definition for ${name}`)
  }
  return model
}

describe('OPENCODE_MODEL_DEFINITIONS', () => {
  it('includes the full set of configured models', () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort()

    expect(modelNames).toEqual([
      'antigravity-claude-opus-4-6-thinking',
      'antigravity-claude-sonnet-4-6-thinking',
      'antigravity-gemini-3.1-flash-image',
      'antigravity-gemini-3.1-pro',
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.6-flash',
      'antigravity-gemini-3.7-flash',
      'antigravity-gemini-3.8-flash',
      'antigravity-gpt-oss-120b-medium',
    ])
  })

  it('defines Gemini variants for Antigravity models', () => {
    expect(getModel('antigravity-gemini-3.1-pro').variants).toEqual({
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.5-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.6-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.7-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.8-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })
  })
  it('does not expose restricted Gemini 3.8 Flash Cyber', () => {
    expect(OPENCODE_MODEL_DEFINITIONS).not.toHaveProperty(
      'antigravity-gemini-3.8-flash-cyber',
    )
  })

  it('exposes image output and live GPT-OSS capabilities', () => {
    expect(getModel('antigravity-gemini-3.1-flash-image')).toMatchObject({
      reasoning: false,
      modalities: { output: ['text', 'image'] },
    })
    expect(getModel('antigravity-gpt-oss-120b-medium')).toMatchObject({
      reasoning: true,
      limit: { context: 131072, output: 32768 },
    })
  })

  it('defines Claude thinking budget variants', () => {
    expect(getModel('antigravity-claude-opus-4-6-thinking').variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      medium: { thinkingConfig: { thinkingBudget: 16384 } },
      high: { thinkingConfig: { thinkingBudget: 32768 } },
    })
    expect(getModel('antigravity-claude-sonnet-4-6-thinking').variants).toEqual(
      {
        low: { thinkingConfig: { thinkingBudget: 8192 } },
        medium: { thinkingConfig: { thinkingBudget: 16384 } },
        high: { thinkingConfig: { thinkingBudget: 32768 } },
      },
    )
  })
})
