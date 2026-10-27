import { describe, expect, it } from 'bun:test'
import { RELEASE_MODEL_IDS } from '../__fixtures__/release-model-ids'

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

    expect(modelNames).toEqual(RELEASE_MODEL_IDS)
  })

  it('defines Gemini variants for Antigravity models', () => {
    expect(getModel('antigravity-gemini-4-argon').variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.5-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })

    expect(getModel('antigravity-gemini-3.8-flash').variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
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

  it('offers native adaptive Claude efforts without automatic budget variants', () => {
    expect(getModel('antigravity-claude-opus-5-5').variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
    expect(getModel('antigravity-claude-sonnet-5-5').variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
  })
})
