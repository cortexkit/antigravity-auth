import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  applyGeminiTransforms,
  buildGemini3ThinkingConfig,
  buildGemini25ThinkingConfig,
  buildImageGenerationConfig,
  isGemini3Model,
  isGemini25Model,
  isGeminiModel,
  isImageGenerationModel,
  normalizeGeminiTools,
  toGeminiSchema,
  wrapToolsAsFunctionDeclarations,
} from './gemini'
import type { RequestPayload } from './types'

describe('transform/gemini', () => {
  describe('isGeminiModel', () => {
    it('returns true for gemini-pro', () => {
      expect(isGeminiModel('gemini-pro')).toBe(true)
    })

    it('returns true for gemini-1.5-pro', () => {
      expect(isGeminiModel('gemini-1.5-pro')).toBe(true)
    })

    it('returns true for gemini-2.5-flash', () => {
      expect(isGeminiModel('gemini-2.5-flash')).toBe(true)
    })

    it('returns true for gemini-3-pro-high', () => {
      expect(isGeminiModel('gemini-3-pro-high')).toBe(true)
    })

    it('returns true for uppercase GEMINI-PRO', () => {
      expect(isGeminiModel('GEMINI-PRO')).toBe(true)
    })

    it('returns true for mixed case Gemini-Pro', () => {
      expect(isGeminiModel('Gemini-Pro')).toBe(true)
    })

    it('returns false for claude-3-opus', () => {
      expect(isGeminiModel('claude-3-opus')).toBe(false)
    })

    it('returns false for gpt-4', () => {
      expect(isGeminiModel('gpt-4')).toBe(false)
    })

    it('returns false for gemini-claude hybrid (contains both)', () => {
      expect(isGeminiModel('gemini-claude-hybrid')).toBe(false)
    })

    it('returns false for claude-on-gemini', () => {
      expect(isGeminiModel('claude-on-gemini')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isGeminiModel('')).toBe(false)
    })
  })

  describe('isGemini3Model', () => {
    it('returns true for gemini-3-pro', () => {
      expect(isGemini3Model('gemini-3-pro')).toBe(true)
    })

    it('returns true for gemini-3-pro-high', () => {
      expect(isGemini3Model('gemini-3-pro-high')).toBe(true)
    })

    it('returns true for gemini-3-flash', () => {
      expect(isGemini3Model('gemini-3-flash')).toBe(true)
    })

    it('returns true for gemini-3.1-pro', () => {
      expect(isGemini3Model('gemini-3.1-pro')).toBe(true)
    })

    it('returns true for uppercase GEMINI-3-PRO', () => {
      expect(isGemini3Model('GEMINI-3-PRO')).toBe(true)
    })

    it('returns false for gemini-2.5-pro', () => {
      expect(isGemini3Model('gemini-2.5-pro')).toBe(false)
    })

    it('returns false for gemini-pro', () => {
      expect(isGemini3Model('gemini-pro')).toBe(false)
    })

    it('returns false for claude-3-opus', () => {
      expect(isGemini3Model('claude-3-opus')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isGemini3Model('')).toBe(false)
    })
  })

  describe('isGemini25Model', () => {
    it('returns true for gemini-2.5-pro', () => {
      expect(isGemini25Model('gemini-2.5-pro')).toBe(true)
    })

    it('returns true for gemini-2.5-flash', () => {
      expect(isGemini25Model('gemini-2.5-flash')).toBe(true)
    })

    it('returns true for gemini-2.5-pro-preview', () => {
      expect(isGemini25Model('gemini-2.5-pro-preview')).toBe(true)
    })

    it('returns true for uppercase GEMINI-2.5-PRO', () => {
      expect(isGemini25Model('GEMINI-2.5-PRO')).toBe(true)
    })

    it('returns false for gemini-3-pro', () => {
      expect(isGemini25Model('gemini-3-pro')).toBe(false)
    })

    it('returns false for gemini-2.0-flash', () => {
      expect(isGemini25Model('gemini-2.0-flash')).toBe(false)
    })

    it('returns false for gemini-pro', () => {
      expect(isGemini25Model('gemini-pro')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isGemini25Model('')).toBe(false)
    })
  })

  describe('buildGemini3ThinkingConfig', () => {
    it('builds config with includeThoughts true and low tier', () => {
      const config = buildGemini3ThinkingConfig(true, 'low')
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: 'low',
      })
    })

    it('builds config with includeThoughts true and medium tier', () => {
      const config = buildGemini3ThinkingConfig(true, 'medium')
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: 'medium',
      })
    })

    it('builds config with includeThoughts true and high tier', () => {
      const config = buildGemini3ThinkingConfig(true, 'high')
      expect(config).toEqual({
        includeThoughts: true,
        thinkingLevel: 'high',
      })
    })

    it('builds config with includeThoughts false', () => {
      const config = buildGemini3ThinkingConfig(false, 'high')
      expect(config).toEqual({
        includeThoughts: false,
        thinkingLevel: 'high',
      })
    })
  })

  describe('buildGemini25ThinkingConfig', () => {
    it('builds config with includeThoughts true and budget', () => {
      const config = buildGemini25ThinkingConfig(true, 8192)
      expect(config).toEqual({
        includeThoughts: true,
        thinkingBudget: 8192,
      })
    })

    it('builds config with includeThoughts false and budget', () => {
      const config = buildGemini25ThinkingConfig(false, 16384)
      expect(config).toEqual({
        includeThoughts: false,
        thinkingBudget: 16384,
      })
    })

    it('builds config without budget when undefined', () => {
      const config = buildGemini25ThinkingConfig(true, undefined)
      expect(config).toEqual({
        includeThoughts: true,
      })
      expect(config).not.toHaveProperty('thinkingBudget')
    })

    it('builds config without budget when zero', () => {
      const config = buildGemini25ThinkingConfig(true, 0)
      expect(config).toEqual({
        includeThoughts: true,
      })
      expect(config).not.toHaveProperty('thinkingBudget')
    })

    it('builds config without budget when negative', () => {
      const config = buildGemini25ThinkingConfig(true, -1000)
      expect(config).toEqual({
        includeThoughts: true,
      })
      expect(config).not.toHaveProperty('thinkingBudget')
    })

    it('builds config with large budget', () => {
      const config = buildGemini25ThinkingConfig(true, 100000)
      expect(config).toEqual({
        includeThoughts: true,
        thinkingBudget: 100000,
      })
    })
  })

  describe('normalizeGeminiTools', () => {
    it('returns empty debug info when tools is not an array', () => {
      const payload: RequestPayload = { contents: [] }
      const result = normalizeGeminiTools(payload)
      expect(result).toEqual({
        toolDebugMissing: 0,
        toolDebugSummaries: [],
      })
    })

    it('returns empty debug info when tools is undefined', () => {
      const payload: RequestPayload = { contents: [], tools: undefined }
      const result = normalizeGeminiTools(payload)
      expect(result).toEqual({
        toolDebugMissing: 0,
        toolDebugSummaries: [],
      })
    })

    it('normalizes tool with function.input_schema', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'test_tool',
              description: 'A test tool',
              input_schema: {
                type: 'object',
                properties: { foo: { type: 'string' } },
              },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)
      expect(payload.tools).toEqual([
        {
          function: {
            name: 'test_tool',
            description: 'A test tool',
            input_schema: {
              type: 'OBJECT',
              properties: { foo: { type: 'STRING' } },
            },
          },
        },
      ])
    })

    it('normalizes tool with function.parameters', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'test_tool',
              description: 'A test tool',
              parameters: {
                type: 'object',
                properties: { bar: { type: 'number' } },
              },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)
      expect(payload.tools).toEqual([
        {
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: { bar: { type: 'number' } },
            },
            input_schema: {
              type: 'OBJECT',
              properties: { bar: { type: 'NUMBER' } },
            },
          },
        },
      ])
    })

    it('creates custom from function and strips it for Gemini', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'my_func',
              description: 'My function',
              input_schema: { type: 'object' },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)
      expect((payload.tools as unknown[])[0]).not.toHaveProperty('custom')
      expect((payload.tools as unknown[])[0]).toHaveProperty('function')
    })

    it('creates custom when both function and custom are missing', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: 'standalone_tool',
            description: 'A standalone tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }
      normalizeGeminiTools(payload)
      wrapToolsAsFunctionDeclarations(payload)
      expect(payload.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'standalone_tool',
              description: 'A standalone tool',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ])
    })

    it('extracts schema from custom.input_schema', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            custom: {
              name: 'custom_tool',
              input_schema: {
                type: 'object',
                properties: { x: { type: 'string' } },
              },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)
      expect((payload.tools as unknown[])[0]).not.toHaveProperty('custom')
    })

    it('extracts schema from inputSchema (camelCase)', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: 'camel_tool',
            inputSchema: {
              type: 'object',
              properties: { y: { type: 'boolean' } },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)
      wrapToolsAsFunctionDeclarations(payload)
      expect(payload.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'camel_tool',
              description: '',
              parameters: {
                type: 'object',
                properties: { y: { type: 'boolean' } },
              },
            },
          ],
        },
      ])
    })
  })

  describe('applyGeminiTransforms', () => {
    it('applies Gemini 3 thinking config with thinkingLevel', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro-high',
        tierThinkingLevel: 'high',
        normalizedThinking: { includeThoughts: true },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(genConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: 'high',
      })
    })

    it('applies Gemini 2.5 thinking config with thinkingBudget', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-2.5-flash',
        tierThinkingBudget: 8192,
        normalizedThinking: { includeThoughts: true },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(genConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 8192,
      })
    })

    it('prefers tierThinkingBudget over normalizedThinking.thinkingBudget', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-2.5-pro',
        tierThinkingBudget: 16384,
        normalizedThinking: { includeThoughts: true, thinkingBudget: 8192 },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(
        (genConfig.thinkingConfig as Record<string, unknown>).thinkingBudget,
      ).toBe(16384)
    })

    it('falls back to normalizedThinking.thinkingBudget when tierThinkingBudget is undefined', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-2.5-pro',
        normalizedThinking: { includeThoughts: true, thinkingBudget: 4096 },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(
        (genConfig.thinkingConfig as Record<string, unknown>).thinkingBudget,
      ).toBe(4096)
    })

    it('does not apply thinking config when normalizedThinking is undefined', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro',
      })
      expect(payload.generationConfig).toBeUndefined()
    })

    it('preserves existing generationConfig properties', () => {
      const payload: RequestPayload = {
        contents: [],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1000 },
      }
      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro-medium',
        tierThinkingLevel: 'medium',
        normalizedThinking: { includeThoughts: true },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(genConfig.temperature).toBe(0.7)
      expect(genConfig.maxOutputTokens).toBe(1000)
      expect(genConfig.thinkingConfig).toBeDefined()
    })

    it('defaults includeThoughts to true when not specified', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro-low',
        tierThinkingLevel: 'low',
        normalizedThinking: {},
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(
        (genConfig.thinkingConfig as Record<string, unknown>).includeThoughts,
      ).toBe(true)
    })

    it('respects includeThoughts false', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro-high',
        tierThinkingLevel: 'high',
        normalizedThinking: { includeThoughts: false },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      expect(
        (genConfig.thinkingConfig as Record<string, unknown>).includeThoughts,
      ).toBe(false)
    })

    it('handles Gemini 2.5 without tierThinkingBudget or normalizedThinking.thinkingBudget', () => {
      const payload: RequestPayload = { contents: [] }
      applyGeminiTransforms(payload, {
        model: 'gemini-2.5-pro',
        normalizedThinking: { includeThoughts: true },
      })
      const genConfig = payload.generationConfig as Record<string, unknown>
      const thinkingConfig = genConfig.thinkingConfig as Record<string, unknown>
      expect(thinkingConfig.includeThoughts).toBe(true)
      expect(thinkingConfig).not.toHaveProperty('thinkingBudget')
    })

    describe('Google Search (Grounding)', () => {
      it("injects googleSearch tool when mode is 'auto'", () => {
        const payload: RequestPayload = { contents: [], tools: [] }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-pro',
          googleSearch: { mode: 'auto' },
        })
        const tools = payload.tools as unknown[]
        expect(tools).toHaveLength(1)
        expect(tools[0]).toEqual({
          googleSearch: {},
        })
      })

      it('ignores threshold value (deprecated in new API)', () => {
        const payload: RequestPayload = { contents: [] }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-flash',
          googleSearch: { mode: 'auto', threshold: 0.7 },
        })
        const tools = payload.tools as unknown[]
        const searchTool = tools[0] as Record<string, unknown>
        // New API uses simple googleSearch: {} without threshold
        expect(searchTool).toEqual({ googleSearch: {} })
      })

      it("does not inject search tool when mode is 'off'", () => {
        const payload: RequestPayload = { contents: [], tools: [] }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-pro',
          googleSearch: { mode: 'off' },
        })
        const tools = payload.tools as unknown[]
        expect(tools).toHaveLength(0)
      })

      it('does not inject search tool when googleSearch is undefined', () => {
        const payload: RequestPayload = { contents: [], tools: [] }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-pro',
        })
        const tools = payload.tools as unknown[]
        expect(tools).toHaveLength(0)
      })

      it('appends search tool to existing tools array', () => {
        const payload: RequestPayload = {
          contents: [],
          tools: [
            {
              function: {
                name: 'existing_tool',
                input_schema: { type: 'object' },
              },
            },
          ],
        }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-pro',
          googleSearch: { mode: 'auto' },
        })
        const tools = payload.tools as unknown[]
        expect(tools).toHaveLength(2)
        const lastTool = tools[1] as Record<string, unknown>
        expect(lastTool).toHaveProperty('googleSearch')
      })

      it('search tool is not normalized (skipped by normalizeGeminiTools)', () => {
        const payload: RequestPayload = { contents: [] }
        applyGeminiTransforms(payload, {
          model: 'gemini-3-pro',
          googleSearch: { mode: 'auto' },
        })
        const tools = payload.tools as unknown[]
        const searchTool = tools[0] as Record<string, unknown>
        expect(searchTool).toHaveProperty('googleSearch')
        expect(searchTool).not.toHaveProperty('function')
        expect(searchTool).not.toHaveProperty('custom')
      })
    })
  })

  describe('isImageGenerationModel', () => {
    it('returns true for gemini-3-pro-image', () => {
      expect(isImageGenerationModel('gemini-3-pro-image')).toBe(true)
    })

    it('returns true for gemini-3-pro-image-preview', () => {
      expect(isImageGenerationModel('gemini-3-pro-image-preview')).toBe(true)
    })

    it('returns true for gemini-2.5-flash-image', () => {
      expect(isImageGenerationModel('gemini-2.5-flash-image')).toBe(true)
    })

    it('returns true for imagen-3', () => {
      expect(isImageGenerationModel('imagen-3')).toBe(true)
    })

    it('returns true for uppercase GEMINI-3-PRO-IMAGE', () => {
      expect(isImageGenerationModel('GEMINI-3-PRO-IMAGE')).toBe(true)
    })

    it('returns false for gemini-3-pro', () => {
      expect(isImageGenerationModel('gemini-3-pro')).toBe(false)
    })

    it('returns false for gemini-2.5-flash', () => {
      expect(isImageGenerationModel('gemini-2.5-flash')).toBe(false)
    })

    it('returns false for claude-sonnet-4-6', () => {
      expect(isImageGenerationModel('claude-sonnet-4-6')).toBe(false)
    })
  })

  describe('buildImageGenerationConfig', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // Reset environment before each test
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns default 1:1 aspect ratio when no env var set', () => {
      delete process.env.OPENCODE_IMAGE_ASPECT_RATIO
      const config = buildImageGenerationConfig()
      expect(config).toEqual({ aspectRatio: '1:1' })
    })

    it('uses OPENCODE_IMAGE_ASPECT_RATIO env var when set to valid value', () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = '16:9'
      const config = buildImageGenerationConfig()
      expect(config).toEqual({ aspectRatio: '16:9' })
    })

    it('accepts all valid aspect ratios', () => {
      const validRatios = [
        '1:1',
        '2:3',
        '3:2',
        '3:4',
        '4:3',
        '4:5',
        '5:4',
        '9:16',
        '16:9',
        '21:9',
      ]
      for (const ratio of validRatios) {
        process.env.OPENCODE_IMAGE_ASPECT_RATIO = ratio
        const config = buildImageGenerationConfig()
        expect(config.aspectRatio).toBe(ratio)
      }
    })

    it('falls back to 1:1 for invalid aspect ratio', () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = 'invalid'
      const config = buildImageGenerationConfig()
      expect(config).toEqual({ aspectRatio: '1:1' })
    })

    it('falls back to 1:1 for unsupported aspect ratio', () => {
      process.env.OPENCODE_IMAGE_ASPECT_RATIO = '5:3'
      const config = buildImageGenerationConfig()
      expect(config).toEqual({ aspectRatio: '1:1' })
    })
  })

  describe('toGeminiSchema', () => {
    describe('nullable type arrays', () => {
      it.each([
        'string',
        'number',
        'integer',
        'boolean',
        'object',
        'array',
      ])('converts nullable %s without mutating its input', (type) => {
        const schema = Object.freeze({
          type: Object.freeze([type, 'null']),
          description: 'Nullable input',
        })
        const expected = {
          type: type.toUpperCase(),
          nullable: true,
          description: 'Nullable input',
          ...(type === 'array' ? { items: { type: 'STRING' } } : {}),
        }
        const converted = toGeminiSchema(schema)
        expect(converted).toEqual(expected)
        expect(toGeminiSchema(converted)).toEqual(converted)
        expect(schema.type).toEqual([type, 'null'])
      })

      it('preserves required versus optional fields and keyword-like property names', () => {
        expect(
          toGeminiSchema({
            type: 'object',
            properties: {
              type: { type: ['string', 'null'] },
              nullable: { type: ['boolean', 'null'] },
            },
            required: ['type'],
          }),
        ).toEqual({
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', nullable: true },
            nullable: { type: 'BOOLEAN', nullable: true },
          },
          required: ['type'],
        })
      })

      it('recurses through nullable objects, array items and existing union branches', () => {
        expect(
          toGeminiSchema({
            type: ['object', 'null'],
            properties: {
              rows: {
                type: ['array', 'null'],
                items: {
                  type: ['object', 'null'],
                  properties: { id: { type: ['integer', 'null'] } },
                },
              },
              choice: {
                anyOf: [{ type: ['string', 'null'] }, { type: 'integer' }],
              },
              alternative: { oneOf: [{ type: ['boolean', 'null'] }] },
            },
          }),
        ).toEqual({
          type: 'OBJECT',
          nullable: true,
          properties: {
            rows: {
              type: 'ARRAY',
              nullable: true,
              items: {
                type: 'OBJECT',
                nullable: true,
                properties: { id: { type: 'INTEGER', nullable: true } },
              },
            },
            choice: {
              anyOf: [{ type: 'STRING', nullable: true }, { type: 'INTEGER' }],
            },
            alternative: { anyOf: [{ type: 'BOOLEAN', nullable: true }] },
          },
        })
      })

      it('normalizes before integer constraints and preserves array constraints', () => {
        expect(
          toGeminiSchema({ type: ['integer', 'null'], exclusiveMinimum: 0 }),
        ).toEqual({ type: 'INTEGER', nullable: true, minimum: 1 })
        expect(
          toGeminiSchema({
            type: ['array', 'null'],
            minItems: 1,
            maxItems: 4,
            items: { type: ['string', 'null'] },
          }),
        ).toEqual({
          type: 'ARRAY',
          nullable: true,
          minItems: 1,
          maxItems: 4,
          items: { type: 'STRING', nullable: true },
        })
      })

      it('preserves explicit null regardless of nullable field order', () => {
        expect(
          toGeminiSchema({ nullable: false, type: ['null', 'string'] }),
        ).toEqual({ type: 'STRING', nullable: true })
        expect(
          toGeminiSchema({ type: ['string', 'null'], nullable: false }),
        ).toEqual({ type: 'STRING', nullable: true })
      })

      it('handles singleton, duplicate, mixed-case and null-only arrays', () => {
        expect(toGeminiSchema({ type: ['string'] })).toEqual({ type: 'STRING' })
        expect(toGeminiSchema({ type: ['STRING', 'string', 'NuLl'] })).toEqual({
          type: 'STRING',
          nullable: true,
        })
        expect(toGeminiSchema({ type: ['null', 'NULL'] })).toEqual({
          type: 'NULL',
        })
      })

      it.each([
        [[]],
        [[null]],
        [['bogus']],
        [['string', 1]],
      ])('leaves existing invalid-array provider validation unchanged: %j', (members) => {
        expect(toGeminiSchema({ type: members })).toEqual({ type: members })
      })

      it('passes through unsupported multi-type arrays without narrowing to a single branch', () => {
        const schema = { type: ['string', 'number', 'null'] }
        expect(
          (toGeminiSchema(schema) as Record<string, unknown>).type,
        ).not.toBe('STRING')
        expect(
          (toGeminiSchema(schema) as Record<string, unknown>).type,
        ).not.toBe('NUMBER')
      })

      it.each([
        'antigravity-gemini-3.8-flash',
        'antigravity-gemini-4-argon',
      ])('serializes the real knowledge-tool nullable fields for %s', (model) => {
        const properties = {
          kind: { type: 'string', enum: ['note', 'todo', 'plan'] },
          id: {
            type: 'string',
            description: 'From list or save; omit on save to create',
          },
          planId: {
            type: ['string', 'null'],
            description:
              'The plan a note or todo belongs to; null unlinks, omission keeps it. On list: only that plan and its notes and todos',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Todo ids of the same plan to complete first; [] clears, omission keeps them. Deleting a todo drops it from the todos that depended on it',
          },
          sessionId: {
            type: ['string', 'null'],
            description:
              'Existing plan, saved without body: the session linked to it; null clears. Links only, starts nothing',
          },
        }
        const actions = [
          {
            const: 'knowledge.list',
            description:
              'Notes with text, todos with state and links, plans with their file paths and session. Optional planId and ready filters. List before adding, to avoid duplicates',
          },
          {
            const: 'knowledge.save',
            description:
              'Requires kind and body; with id it replaces. A plan body is the whole markdown, and the answer gives its path. An update may send only the fields it changes: completed, planId or dependsOn; sessionId on a plan, without body',
          },
          { const: 'knowledge.delete', description: 'Requires kind and id' },
          {
            const: 'knowledge.show',
            description:
              'Open a plan for the user to read, comment on and send to a session; requires kind plan and id',
          },
        ]
        const parametersDescription =
          'Inputs for the action; use an empty object when none are needed'
        const input = {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              oneOf: actions,
              description: 'Knowledge action to perform',
            },
            parameters: {
              type: 'object',
              properties,
              additionalProperties: false,
              description: parametersDescription,
            },
          },
          required: ['action'],
          additionalProperties: true,
        }
        const before = JSON.stringify(input)
        const payload: RequestPayload = {
          tools: [{ function: { name: 'knowledge_tool', parameters: input } }],
        }
        applyGeminiTransforms(payload, { model })
        expect(payload.tools).toEqual([
          {
            functionDeclarations: [
              {
                name: 'knowledge_tool',
                description: '',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    action: {
                      type: 'STRING',
                      anyOf: actions.map(({ const: action, description }) => ({
                        enum: [action],
                        description,
                      })),
                      description: 'Knowledge action to perform',
                    },
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        kind: { ...properties.kind, type: 'STRING' },
                        id: { ...properties.id, type: 'STRING' },
                        planId: {
                          ...properties.planId,
                          type: 'STRING',
                          nullable: true,
                        },
                        dependsOn: {
                          ...properties.dependsOn,
                          type: 'ARRAY',
                          items: { type: 'STRING' },
                        },
                        sessionId: {
                          ...properties.sessionId,
                          type: 'STRING',
                          nullable: true,
                        },
                      },
                      description: parametersDescription,
                    },
                  },
                  required: ['action'],
                },
              },
            ],
          },
        ])
        const wire = JSON.stringify(payload.tools)
        expect(wire).toContain('knowledge_tool')
        expect(wire).not.toMatch(/"type"\s*:\s*\[/)
        expect(wire).not.toContain('_placeholder')
        expect(JSON.stringify(input)).toBe(before)
      })
    })

    it('omits items on a non-array schema', () => {
      expect(
        toGeminiSchema({ type: 'string', items: { type: 'string' } }),
      ).toEqual({ type: 'STRING' })
    })

    it('omits properties on a non-object schema', () => {
      expect(
        toGeminiSchema({
          type: 'number',
          properties: { x: { type: 'string' } },
        }),
      ).toEqual({ type: 'NUMBER' })
    })

    it('omits incompatible structure recursively without changing numeric constraints', () => {
      expect(
        toGeminiSchema({
          type: 'object',
          items: { type: 'string' },
          properties: {
            count: {
              type: 'NuMbEr',
              minimum: 1,
              maximum: 9,
              properties: { x: { type: 'string' } },
              required: ['x'],
              propertyOrdering: ['x'],
              items: { type: 'string' },
            },
            values: {
              type: 'ArRaY',
              properties: { x: { type: 'string' } },
              required: ['x'],
              propertyOrdering: ['x'],
              items: {
                type: 'BOOLEAN',
                items: { type: 'string' },
                properties: { x: { type: 'string' } },
              },
            },
          },
        }),
      ).toEqual({
        type: 'OBJECT',
        properties: {
          count: { type: 'NUMBER', minimum: 1, maximum: 9 },
          values: { type: 'ARRAY', items: { type: 'BOOLEAN' } },
        },
      })
    })

    it('retains structural fields on untyped nodes', () => {
      expect(
        toGeminiSchema({
          properties: { x: { type: 'string', items: { type: 'number' } } },
          required: ['x'],
          propertyOrdering: ['x'],
          items: { type: 'array' },
        }),
      ).toEqual({
        properties: { x: { type: 'STRING' } },
        required: ['x'],
        propertyOrdering: ['x'],
        items: { type: 'ARRAY', items: { type: 'STRING' } },
      })
    })

    it('normalizes union branches while preserving anyOf and converted oneOf', () => {
      const branches = [
        { type: 'string', items: { type: 'string' } },
        { type: 'array', properties: { x: { type: 'number' } } },
        { type: 'object', properties: { x: { type: 'number' } } },
      ]
      const expected = {
        anyOf: [
          { type: 'STRING' },
          { type: 'ARRAY', items: { type: 'STRING' } },
          { type: 'OBJECT', properties: { x: { type: 'NUMBER' } } },
        ],
      }
      expect(toGeminiSchema({ anyOf: branches })).toEqual(expected)
      expect(toGeminiSchema({ oneOf: branches })).toEqual(expected)
    })

    it('preserves keyword-like property names and is idempotent', () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'integer' } },
          properties: {
            type: 'object',
            properties: { type: { type: 'string' } },
            required: ['type'],
          },
          required: { type: 'boolean', items: { type: 'string' } },
        },
        required: ['items', 'properties', 'required'],
        propertyOrdering: ['items', 'properties', 'required'],
      }
      const expected = {
        type: 'OBJECT',
        properties: {
          items: { type: 'ARRAY', items: { type: 'INTEGER' } },
          properties: {
            type: 'OBJECT',
            properties: { type: { type: 'STRING' } },
            required: ['type'],
          },
          required: { type: 'BOOLEAN' },
        },
        required: ['items', 'properties', 'required'],
        propertyOrdering: ['items', 'properties', 'required'],
      }
      expect(toGeminiSchema(schema)).toEqual(expected)
      expect(toGeminiSchema(toGeminiSchema(schema))).toEqual(expected)
    })

    it('returns null/undefined as-is', () => {
      expect(toGeminiSchema(null)).toBe(null)
      expect(toGeminiSchema(undefined)).toBe(undefined)
    })

    it('returns primitives as-is', () => {
      expect(toGeminiSchema('string')).toBe('string')
      expect(toGeminiSchema(123)).toBe(123)
      expect(toGeminiSchema(true)).toBe(true)
    })

    it('returns arrays as-is', () => {
      const arr = [1, 2, 3]
      expect(toGeminiSchema(arr)).toBe(arr)
    })

    it('converts type to uppercase', () => {
      expect(toGeminiSchema({ type: 'object' })).toEqual({ type: 'OBJECT' })
      expect(toGeminiSchema({ type: 'string' })).toEqual({ type: 'STRING' })
      expect(toGeminiSchema({ type: 'boolean' })).toEqual({ type: 'BOOLEAN' })
      expect(toGeminiSchema({ type: 'number' })).toEqual({ type: 'NUMBER' })
      expect(toGeminiSchema({ type: 'integer' })).toEqual({ type: 'INTEGER' })
      expect(toGeminiSchema({ type: 'array' })).toEqual({
        type: 'ARRAY',
        items: { type: 'STRING' },
      })
    })

    it('removes additionalProperties field', () => {
      const schema = {
        type: 'object',
        properties: { foo: { type: 'string' } },
        additionalProperties: false,
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('additionalProperties')
      expect(result.type).toBe('OBJECT')
    })

    it('removes $schema field', () => {
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('$schema')
      expect(result.type).toBe('OBJECT')
    })

    it('removes $id and $comment fields', () => {
      const schema = {
        $id: 'my-schema',
        $comment: 'This is a comment',
        type: 'object',
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('$id')
      expect(result).not.toHaveProperty('$comment')
      expect(result.type).toBe('OBJECT')
    })

    it('recursively transforms properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          active: { type: 'boolean' },
        },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      const props = result.properties as Record<string, Record<string, string>>
      expect(props.name?.type).toBe('STRING')
      expect(props.age?.type).toBe('NUMBER')
      expect(props.active?.type).toBe('BOOLEAN')
    })

    it('transforms nested objects recursively', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              email: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      const props = result.properties as Record<string, Record<string, unknown>>
      expect(props.user?.type).toBe('OBJECT')
      expect(props.user).not.toHaveProperty('additionalProperties')
      const userProps = props.user?.properties as Record<
        string,
        Record<string, string>
      >
      expect(userProps.email?.type).toBe('STRING')
    })

    it('transforms array items schema', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
          },
        },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.type).toBe('ARRAY')
      const items = result.items as Record<string, unknown>
      expect(items.type).toBe('OBJECT')
      const itemProps = items.properties as Record<
        string,
        Record<string, string>
      >
      expect(itemProps.id?.type).toBe('NUMBER')
    })

    it('transforms anyOf schemas', () => {
      const schema = {
        anyOf: [{ type: 'string' }, { type: 'number' }],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      const anyOf = result.anyOf as Array<Record<string, string>>
      expect(anyOf[0]?.type).toBe('STRING')
      expect(anyOf[1]?.type).toBe('NUMBER')
    })

    it('converts oneOf to anyOf without losing branch types', () => {
      const schema = {
        oneOf: [{ type: 'boolean' }, { type: 'string' }],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      const anyOf = result.anyOf as Array<Record<string, string>>
      expect(result.oneOf).toBeUndefined()
      expect(anyOf[0]?.type).toBe('BOOLEAN')
      expect(anyOf[1]?.type).toBe('STRING')
    })

    it('merges disjoint allOf object schemas without losing property types', () => {
      const schema = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { properties: { b: { type: 'number' } } },
        ],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).toEqual({
        type: 'OBJECT',
        properties: { a: { type: 'STRING' }, b: { type: 'NUMBER' } },
      })
    })

    it('preserves enum values', () => {
      const schema = {
        type: 'string',
        enum: ['low', 'medium', 'high'],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.type).toBe('STRING')
      expect(result.enum).toEqual(['low', 'medium', 'high'])
    })

    it('preserves required array when all properties exist', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.required).toEqual(['name'])
    })

    it('omits required field when no valid properties remain', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['nonexistent', 'alsoMissing'],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('required')
    })

    it('handles MCP tool with missing properties in required (issue #161)', () => {
      // Simulates the group_execute_tool schema from issue #161
      const schema = {
        type: 'object',
        properties: {
          mcp_name: { type: 'string', enum: ['exa-mcp-server', 'context7'] },
          tool_name: { type: 'string' },
          // Note: "arguments" is missing from properties but present in required
        },
        required: ['mcp_name', 'tool_name', 'arguments'],
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      // Should filter out "arguments" since it doesn't exist in properties
      expect(result.required).toEqual(['mcp_name', 'tool_name'])
      expect(result.type).toBe('OBJECT')
    })

    it('preserves description', () => {
      const schema = {
        type: 'string',
        description: "User's full name",
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.description).toBe("User's full name")
    })

    it('preserves default value', () => {
      const schema = {
        type: 'number',
        default: 42,
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.default).toBe(42)
    })

    it('handles complex real-world MCP schema', () => {
      // Simulates a PostHog-like complex schema with enums and nested types
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          event_name: {
            type: 'string',
            description: 'Event name to track',
          },
          properties: {
            type: 'object',
            additionalProperties: true,
            description: 'Event properties',
          },
          level: {
            type: 'string',
            enum: ['info', 'warning', 'error'],
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                value: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['event_name'],
        additionalProperties: false,
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>

      // Should remove unsupported fields
      expect(result).not.toHaveProperty('$schema')
      expect(result).not.toHaveProperty('additionalProperties')

      // Should uppercase types
      expect(result.type).toBe('OBJECT')

      const props = result.properties as Record<string, Record<string, unknown>>
      expect(props.event_name?.type).toBe('STRING')
      expect(props.properties?.type).toBe('OBJECT')
      expect(props.properties).not.toHaveProperty('additionalProperties')
      expect(props.level?.type).toBe('STRING')
      expect(props.level?.enum).toEqual(['info', 'warning', 'error'])
      expect(props.items?.type).toBe('ARRAY')

      const itemsSchema = props.items?.items as Record<string, unknown>
      expect(itemsSchema.type).toBe('OBJECT')
      expect(itemsSchema).not.toHaveProperty('additionalProperties')

      const itemProps = itemsSchema.properties as Record<
        string,
        Record<string, string>
      >
      expect(itemProps.id?.type).toBe('STRING')
      expect(itemProps.value?.type).toBe('NUMBER')

      // Should preserve required
      expect(result.required).toEqual(['event_name'])
    })
  })

  describe('normalizeGeminiTools schema transformation', () => {
    it('transforms tool schemas to Gemini format with uppercase types', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'test_tool',
              description: 'A test tool',
              input_schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  count: { type: 'number' },
                },
              },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)

      const tool = (payload.tools as unknown[])[0] as Record<string, unknown>
      const func = tool.function as Record<string, unknown>
      const schema = func.input_schema as Record<string, unknown>

      expect(schema.type).toBe('OBJECT')
      const props = schema.properties as Record<string, Record<string, string>>
      expect(props.name?.type).toBe('STRING')
      expect(props.count?.type).toBe('NUMBER')
    })

    it('removes additionalProperties from tool schemas', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'strict_tool',
              input_schema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          },
        ],
      }
      normalizeGeminiTools(payload)

      const tool = (payload.tools as unknown[])[0] as Record<string, unknown>
      const func = tool.function as Record<string, unknown>
      const schema = func.input_schema as Record<string, unknown>

      expect(schema).not.toHaveProperty('additionalProperties')
      expect(schema.type).toBe('OBJECT')
    })

    it('uses uppercase placeholder schemas and default names for schema-less tools', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { name: 'tool1' },
          { name: 'tool2' },
          {},
          { function: { name: 'tool3', input_schema: { type: 'object' } } },
        ],
      }
      applyGeminiTransforms(payload, { model: 'gemini-2.5-flash' })
      expect(payload.tools).toEqual([
        {
          functionDeclarations: [
            ...['tool1', 'tool2', 'tool-2'].map((name) => ({
              name,
              description: '',
              parameters: {
                type: 'OBJECT',
                properties: {
                  _placeholder: {
                    type: 'BOOLEAN',
                    description: 'Placeholder. Always pass true.',
                  },
                },
                required: ['_placeholder'],
              },
            })),
            { name: 'tool3', description: '', parameters: { type: 'OBJECT' } },
          ],
        },
      ])
    })
  })

  describe('wrapToolsAsFunctionDeclarations (fixes #203, #206)', () => {
    it('wraps tools in functionDeclarations format', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'OBJECT',
              properties: { path: { type: 'STRING' } },
            },
          },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[0]).not.toHaveProperty('parameters')

      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls).toHaveLength(1)
      expect(decls[0]?.name).toBe('read_file')
      expect(decls[0]?.description).toBe('Read a file')
      expect(decls[0]?.parameters).toEqual({
        type: 'OBJECT',
        properties: { path: { type: 'STRING' } },
      })
    })

    it('extracts schema from function.input_schema', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'test_fn',
              description: 'Test function',
              input_schema: { type: 'OBJECT', properties: {} },
            },
          },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls[0]?.name).toBe('test_fn')
      expect(decls[0]?.parameters).toEqual({ type: 'OBJECT', properties: {} })
    })

    it('extracts schema from custom.input_schema', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            custom: {
              name: 'custom_fn',
              description: 'Custom function',
              input_schema: {
                type: 'OBJECT',
                properties: { x: { type: 'NUMBER' } },
              },
            },
          },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls[0]?.name).toBe('custom_fn')
      expect(decls[0]?.parameters).toEqual({
        type: 'OBJECT',
        properties: { x: { type: 'NUMBER' } },
      })
    })

    it('preserves googleSearch tools as passthrough (new API)', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { name: 'tool1', parameters: { type: 'OBJECT', properties: {} } },
          { googleSearch: {} },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(2)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[1]).toHaveProperty('googleSearch')
    })

    it('preserves googleSearchRetrieval tools as passthrough (legacy API)', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { name: 'tool1', parameters: { type: 'OBJECT', properties: {} } },
          {
            googleSearchRetrieval: {
              dynamicRetrievalConfig: {
                mode: 'MODE_DYNAMIC',
                dynamicThreshold: 0.3,
              },
            },
          },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(2)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[1]).toHaveProperty('googleSearchRetrieval')
    })

    it('preserves codeExecution tools as passthrough', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { name: 'tool1', parameters: { type: 'OBJECT', properties: {} } },
          { codeExecution: {} },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(2)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[1]).toHaveProperty('codeExecution')
    })

    it('merges existing functionDeclarations into output', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'existing',
                description: 'Existing fn',
                parameters: { type: 'OBJECT' },
              },
            ],
          },
          { name: 'new_tool', parameters: { type: 'OBJECT', properties: {} } },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls).toHaveLength(2)
      expect(decls[0]?.name).toBe('existing')
      expect(decls[1]?.name).toBe('new_tool')
    })

    it('handles multiple tools correctly', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            name: 'tool1',
            description: 'First',
            parameters: { type: 'OBJECT' },
          },
          {
            name: 'tool2',
            description: 'Second',
            parameters: { type: 'OBJECT' },
          },
          {
            name: 'tool3',
            description: 'Third',
            parameters: { type: 'OBJECT' },
          },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls).toHaveLength(3)
      expect(decls.map((d) => d.name)).toEqual(['tool1', 'tool2', 'tool3'])
    })

    it('provides default schema when no schema found', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [{ name: 'no_schema_tool' }],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls[0]?.parameters).toEqual({ type: 'OBJECT', properties: {} })
    })

    it('generates default name when missing', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          { description: 'Anonymous tool', parameters: { type: 'OBJECT' } },
        ],
      }
      wrapToolsAsFunctionDeclarations(payload)

      const tools = payload.tools as Array<Record<string, unknown>>
      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls[0]?.name).toBe('tool-0')
    })

    it('does nothing when tools is empty', () => {
      const payload: RequestPayload = { contents: [], tools: [] }
      wrapToolsAsFunctionDeclarations(payload)
      expect(payload.tools).toEqual([])
    })

    it('does nothing when tools is undefined', () => {
      const payload: RequestPayload = { contents: [] }
      wrapToolsAsFunctionDeclarations(payload)
      expect(payload.tools).toBeUndefined()
    })
  })

  describe('toGeminiSchema - array items fix (issue #80)', () => {
    it('adds default items to array schema without items', () => {
      const schema = { type: 'array' }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result.type).toBe('ARRAY')
      expect(result.items).toEqual({ type: 'STRING' })
    })

    it('handles nested array without items', () => {
      const schema = {
        type: 'object',
        properties: {
          tags: { type: 'array' },
        },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      const props = result.properties as Record<string, Record<string, unknown>>
      expect(props.tags?.type).toBe('ARRAY')
      expect(props.tags?.items).toEqual({ type: 'STRING' })
    })
  })

  describe('toGeminiSchema - unsupported fields removal (issue #161)', () => {
    it('removes $ref field', () => {
      const schema = { $ref: '#/definitions/MyType', type: 'object' }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('$ref')
      expect(result.type).toBe('OBJECT')
    })

    it('removes $defs field', () => {
      const schema = {
        type: 'object',
        $defs: { MyType: { type: 'string' } },
        properties: { name: { type: 'string' } },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('$defs')
    })

    it('removes definitions field', () => {
      const schema = {
        type: 'object',
        definitions: { MyType: { type: 'string' } },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('definitions')
    })

    it('removes const field', () => {
      const schema = { const: 'fixed_value' }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('const')
    })

    it('removes conditional schema fields (if/then/else/not)', () => {
      const schema = {
        type: 'object',
        if: { properties: { type: { const: 'a' } } },
        then: { properties: { a: { type: 'string' } } },
        else: { properties: { b: { type: 'string' } } },
        not: { type: 'null' },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('if')
      expect(result).not.toHaveProperty('then')
      expect(result).not.toHaveProperty('else')
      expect(result).not.toHaveProperty('not')
    })

    it('removes patternProperties and propertyNames', () => {
      const schema = {
        type: 'object',
        patternProperties: { '^S_': { type: 'string' } },
        propertyNames: { pattern: '^[a-z]+$' },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('patternProperties')
      expect(result).not.toHaveProperty('propertyNames')
    })

    it('removes unevaluatedProperties and unevaluatedItems', () => {
      const schema = {
        type: 'object',
        unevaluatedProperties: false,
        unevaluatedItems: false,
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('unevaluatedProperties')
      expect(result).not.toHaveProperty('unevaluatedItems')
    })

    it('removes contentMediaType and contentEncoding', () => {
      const schema = {
        type: 'string',
        contentMediaType: 'application/json',
        contentEncoding: 'base64',
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('contentMediaType')
      expect(result).not.toHaveProperty('contentEncoding')
    })

    it('removes dependentRequired and dependentSchemas', () => {
      const schema = {
        type: 'object',
        dependentRequired: { credit_card: ['billing_address'] },
        dependentSchemas: { name: { properties: { age: { type: 'number' } } } },
      }
      const result = toGeminiSchema(schema) as Record<string, unknown>
      expect(result).not.toHaveProperty('dependentRequired')
      expect(result).not.toHaveProperty('dependentSchemas')
    })

    it('handles complex MCP schema with all unsupported fields', () => {
      const complexSchema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'complex-mcp-schema',
        $comment: 'This is a complex schema',
        $ref: '#/definitions/Base',
        $defs: { Base: { type: 'object' } },
        definitions: { Legacy: { type: 'string' } },
        type: 'object',
        properties: {
          name: { type: 'string', const: 'fixed' },
          data: {
            type: 'array',
            items: { type: 'object' },
            minContains: 1,
            maxContains: 10,
          },
        },
        additionalProperties: false,
        patternProperties: { '^x-': { type: 'string' } },
        propertyNames: { minLength: 1 },
        unevaluatedProperties: false,
        if: { properties: { type: { const: 'a' } } },
        then: { required: ['a'] },
        else: { required: ['b'] },
        not: { type: 'null' },
        dependentRequired: { foo: ['bar'] },
        dependentSchemas: {},
        contentMediaType: 'application/json',
        contentEncoding: 'utf-8',
        required: ['name', 'missing_prop'],
      }

      const result = toGeminiSchema(complexSchema) as Record<string, unknown>

      const unsupportedFields = [
        '$schema',
        '$id',
        '$comment',
        '$ref',
        '$defs',
        'definitions',
        'additionalProperties',
        'patternProperties',
        'propertyNames',
        'unevaluatedProperties',
        'if',
        'then',
        'else',
        'not',
        'dependentRequired',
        'dependentSchemas',
        'contentMediaType',
        'contentEncoding',
      ]

      for (const field of unsupportedFields) {
        expect(result).not.toHaveProperty(field)
      }

      expect(result.type).toBe('OBJECT')
      expect(result.required).toEqual(['name'])

      const props = result.properties as Record<string, Record<string, unknown>>
      expect(props.name?.type).toBe('STRING')
      expect(props.name).not.toHaveProperty('const')
      expect(props.data?.type).toBe('ARRAY')
      expect(props.data).not.toHaveProperty('minContains')
      expect(props.data).not.toHaveProperty('maxContains')
    })
  })

  describe('applyGeminiTransforms - full integration', () => {
    it('wraps tools in functionDeclarations after normalization', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            function: {
              name: 'test_tool',
              description: 'A test',
              input_schema: {
                type: 'object',
                properties: { x: { type: 'string' } },
              },
            },
          },
        ],
      }

      applyGeminiTransforms(payload, { model: 'gemini-3-pro' })

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[0]).not.toHaveProperty('function')
      expect(tools[0]).not.toHaveProperty('parameters')

      const decls = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      expect(decls[0]?.name).toBe('test_tool')

      const params = decls[0]?.parameters as Record<string, unknown>
      expect(params.type).toBe('OBJECT')
      const props = params.properties as Record<string, Record<string, string>>
      expect(props.x?.type).toBe('STRING')
    })

    it('normalizes existing GPT-OSS function declarations and numeric constraints', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'prompt_tool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    prompt: { type: 'string', minLength: '1' },
                  },
                  required: ['prompt'],
                },
              },
            ],
          },
        ],
      }

      applyGeminiTransforms(payload, { model: 'gpt-oss-120b-medium' })

      const tools = payload.tools as Array<Record<string, unknown>>
      const declarations = tools[0]?.functionDeclarations as Array<
        Record<string, unknown>
      >
      const parameters = declarations[0]?.parameters as Record<string, unknown>
      const properties = parameters.properties as Record<
        string,
        Record<string, unknown>
      >
      expect(parameters.type).toBe('OBJECT')
      expect(properties.prompt).toEqual({
        type: 'STRING',
        description: 'minLength: 1',
      })
      expect(declarations[0]).not.toHaveProperty('parametersJsonSchema')
    })

    it('handles mixed tools and googleSearch', () => {
      const payload: RequestPayload = {
        contents: [],
        tools: [{ name: 'my_tool', parameters: { type: 'object' } }],
      }

      applyGeminiTransforms(payload, {
        model: 'gemini-3-pro',
        googleSearch: { mode: 'auto' },
      })

      const tools = payload.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(2)
      expect(tools[0]).toHaveProperty('functionDeclarations')
      expect(tools[1]).toHaveProperty('googleSearch')
    })
  })
})

describe('Antigravity schema subset edge cases', () => {
  it('retains property names that look like schema keywords and leaves default data alone', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        vendorExtension: true,
        properties: {
          readOnly: { type: 'boolean', const: false },
          const: { type: 'string', const: 'x' },
          thinking: {
            type: 'object',
            default: { readOnly: true, const: 3 },
            properties: { x: { type: 'string' } },
          },
        },
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: {
        readOnly: { type: 'BOOLEAN', description: 'Must be false.' },
        const: { type: 'STRING', enum: ['x'] },
        thinking: {
          type: 'OBJECT',
          default: { readOnly: true, const: 3 },
          properties: { x: { type: 'STRING' } },
        },
      },
    })
  })

  it('hints object and null enum values rather than stringifying their wire types', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        description: 'Value',
        enum: [null, { x: 3 }],
      }),
    ).toEqual({
      type: 'OBJECT',
      description: 'Value (Allowed values: null, {"x":3}.)',
    })
    expect(
      toGeminiSchema({ type: 'boolean', const: false, enum: [false, true] }),
    ).toEqual({
      type: 'BOOLEAN',
      description: 'Must be false., Allowed values: false, true.',
    })
  })

  it('folds fractional integer bounds regardless of keyword order and retains tighter bounds', () => {
    expect(
      toGeminiSchema({
        type: 'integer',
        exclusiveMinimum: 1.5,
        minimum: 0,
        exclusiveMaximum: 9.5,
        maximum: 20,
      }),
    ).toEqual({
      type: 'INTEGER',
      minimum: 2,
      maximum: 9,
    })
    expect(
      toGeminiSchema({
        type: 'INTEGER',
        exclusiveMinimum: 0,
        minimum: 5,
        exclusiveMaximum: 10,
        maximum: 6,
      }),
    ).toEqual({
      type: 'INTEGER',
      minimum: 5,
      maximum: 6,
    })
  })

  it('hints boolean exclusive modifiers without folding them as numbers', () => {
    expect(
      toGeminiSchema({
        type: 'integer',
        minimum: 0,
        maximum: 10,
        exclusiveMinimum: true,
        exclusiveMaximum: false,
      }),
    ).toEqual({
      type: 'INTEGER',
      minimum: 0,
      maximum: 10,
      description: 'exclusiveMinimum: true, exclusiveMaximum: false',
    })
  })

  it('keeps the first ambiguous allOf branch and explains the dropped intersection', () => {
    expect(
      toGeminiSchema({
        description: 'Choice',
        allOf: [
          {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
          {
            type: 'object',
            properties: { x: { type: 'integer' } },
            required: ['x'],
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: { x: { type: 'STRING' } },
      required: ['x'],
      description:
        'Choice (allOf: using the first branch; other intersection constraints omitted.)',
    })
    expect(
      toGeminiSchema({
        allOf: [{ type: 'number', minimum: 1 }, { type: 'string' }],
      }),
    ).toEqual({
      type: 'NUMBER',
      minimum: 1,
      description:
        'allOf: using the first branch; other intersection constraints omitted.',
    })
  })

  it('unions required names across disjoint allOf branches and filters missing properties', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        properties: { base: { type: 'string' } },
        required: ['base'],
        allOf: [
          {
            type: 'object',
            properties: { first: { type: 'string' } },
            required: ['first', 'missing'],
          },
          {
            type: 'object',
            properties: { second: { type: 'number' } },
            required: ['second', 'first'],
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: {
        base: { type: 'STRING' },
        first: { type: 'STRING' },
        second: { type: 'NUMBER' },
      },
      required: ['base', 'first', 'second'],
    })
  })

  it('preserves existing anyOf when oneOf is also present', () => {
    expect(
      toGeminiSchema({
        anyOf: [{ type: 'boolean' }],
        oneOf: [{ type: 'string', const: 'x' }],
      }),
    ).toEqual({
      anyOf: [{ type: 'BOOLEAN' }],
      description: 'oneOf: additional union constraints omitted.',
    })
  })

  it('normalizes idempotently without mutating the source', () => {
    const schema = {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          const: 3,
          exclusiveMinimum: 0,
          multipleOf: 2,
        },
      },
    }
    const before = JSON.stringify(schema)
    const normalized = toGeminiSchema(schema)
    expect(toGeminiSchema(normalized)).toEqual(normalized)
    expect(JSON.stringify(schema)).toBe(before)
  })
})

describe('documented Gemini Schema compatibility', () => {
  it('retains documented fields previously forwarded by the 3.0.2 converter', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        title: 'Ordered input',
        propertyOrdering: ['timestamp'],
        example: { timestamp: '2026-10-13T00:00:00Z' },
        examples: [{}],
        properties: {
          timestamp: {
            type: 'string',
            format: 'date-time',
            pattern: '^2026-',
            title: 'Timestamp',
            nullable: true,
            example: '2026-10-13T00:00:00Z',
          },
        },
      }),
    ).toEqual({
      type: 'OBJECT',
      title: 'Ordered input',
      propertyOrdering: ['timestamp'],
      example: { timestamp: '2026-10-13T00:00:00Z' },
      properties: {
        timestamp: {
          type: 'STRING',
          format: 'date-time',
          pattern: '^2026-',
          title: 'Timestamp',
          nullable: true,
          example: '2026-10-13T00:00:00Z',
        },
      },
    })
  })

  it('merges zod-style allOf branches despite dropped keywords and retained annotations', () => {
    expect(
      toGeminiSchema({
        allOf: [
          {
            type: 'object',
            title: 'First',
            additionalProperties: false,
            $schema: 'https://json-schema.org/draft-07/schema#',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
          {
            type: 'object',
            title: 'Second',
            additionalProperties: false,
            properties: { b: { type: 'integer' } },
            required: ['b'],
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      title: 'First',
      properties: {
        a: { type: 'STRING' },
        b: { type: 'INTEGER' },
      },
      required: ['a', 'b'],
    })
  })

  it('merges identical shared properties without confusing them with real conflicts', () => {
    expect(
      toGeminiSchema({
        allOf: [
          {
            type: 'object',
            properties: { shared: { type: 'string', minLength: 1 } },
            required: ['shared'],
          },
          {
            type: 'object',
            properties: {
              extra: { type: 'boolean' },
              shared: { minLength: 1, type: 'string' },
            },
            required: ['extra'],
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: {
        shared: { type: 'STRING', minLength: 1 },
        extra: { type: 'BOOLEAN' },
      },
      required: ['shared', 'extra'],
    })
  })

  it('preserves nullable on allOf only when every contributing branch is nullable', () => {
    expect(
      toGeminiSchema({
        allOf: [
          {
            type: ['object', 'null'],
            properties: { a: { type: 'string' } },
          },
          {
            type: 'object',
            properties: { b: { type: 'number' } },
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' }, b: { type: 'NUMBER' } },
    })

    expect(
      toGeminiSchema({
        allOf: [
          {
            type: ['object', 'null'],
            properties: { a: { type: 'string' } },
          },
          {
            type: ['object', 'null'],
            properties: { b: { type: 'number' } },
          },
        ],
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' }, b: { type: 'NUMBER' } },
      nullable: true,
    })
  })
})
