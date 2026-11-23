import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import capturedCatalog from '../../../test-fixtures/agy-cli-1.3.3/current-model-metadata.json'
import serverCatalog from '../../../test-fixtures/agy-cli-1.3.5/server-model-catalog.json'
import carbonMetadata from '../../../test-fixtures/agy-cli-1.5.5/carbon-model-metadata.json'
import hydrogen from '../../../test-fixtures/agy-cli-1.5.5/hydrogen-evidence.json'
import neon from '../../../test-fixtures/agy-cli-1.5.9/neon-evidence.json'
import { getAgyModelEnum } from './agy-request-metadata.ts'
import {
  AGY_NATIVE_MODEL_DEFINITIONS,
  getAgyNativeModel,
  getGemini35FlashAntigravityModel,
  getGemini36FlashAntigravityModel,
  getGemini37FlashAntigravityModel,
  getGemini38FlashAntigravityModel,
  getPublicModelDefinitions,
  getQuotaGroupForModel,
  getResolverAliasMap,
  isRetiredAgyModel,
} from './model-registry.ts'
import {
  resolveModelWithTier,
  resolveModelWithVariant,
} from './transform/model-resolver.ts'

const EXPECTED_NATIVE_IDS = [
  'gemini-4-neon-low',
  'gemini-4-neon-medium',
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-hydrogen-low',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-carbon-low',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
].sort()

const REQUIRED_PUBLIC_MODEL_FIELDS = [
  'id',
  'name',
  'release_date',
  'attachment',
  'reasoning',
  'temperature',
  'tool_call',
  'limit',
  'cost',
  'options',
] as const

describe('model registry', () => {
  it('preserves the remaining pre-Carbon public catalog', () => {
    // Pin the older definitions separately from Carbon, Hydrogen and Neon.
    // The expected hash removes only the retired image model from that snapshot.
    const baseline = Object.fromEntries(
      Object.entries(getPublicModelDefinitions()).filter(
        ([id]) =>
          id !== 'antigravity-gemini-4-carbon' &&
          id !== 'antigravity-gemini-4-hydrogen' &&
          id !== 'antigravity-gemini-4-neon',
      ),
    )
    const digest = createHash('sha256')
      .update(JSON.stringify(baseline))
      .digest('hex')
    expect(digest).toBe(
      'd85607a79e61876b511c41f3354114494cc5ce6ff4fb0ae00d76830091fe8994',
    )
  })

  it('retires Gemini 3.5 Flash selectors and routes but not the helper models', () => {
    for (const suffix of ['', '-low', '-medium', '-high', '-extra-low']) {
      for (const prefix of ['', 'antigravity-']) {
        expect(isRetiredAgyModel(`${prefix}gemini-3.5-flash${suffix}`)).toBe(
          true,
        )
      }
    }
    for (const route of [
      'gemini-3-flash-agent',
      'gemini-3.5-flash-low',
      'gemini-3.5-flash-extra-low',
    ]) {
      expect(isRetiredAgyModel(route)).toBe(true)
      expect(getAgyNativeModel(route)).toBeUndefined()
      expect(getResolverAliasMap()).not.toHaveProperty(route)
    }
    for (const helper of ['gemini-3.5-flash-lite', 'gemini-3-flash']) {
      expect(isRetiredAgyModel(helper)).toBe(false)
      expect(isRetiredAgyModel(`antigravity-${helper}`)).toBe(false)
    }
  })

  it('is the source of truth for the current public OpenCode model catalog', () => {
    const definitions = getPublicModelDefinitions()
    const modelNames = Object.keys(definitions).sort()

    expect(modelNames).toEqual([
      'antigravity-claude-opus-5-5',
      'antigravity-claude-sonnet-5-5',
      'antigravity-gemini-3.8-flash',
      'antigravity-gemini-4-argon',
      'antigravity-gemini-4-carbon',
      'antigravity-gemini-4-hydrogen',
      'antigravity-gemini-4-neon',
      'antigravity-gpt-oss-120b-medium',
    ])

    for (const definition of Object.values(definitions)) {
      for (const field of REQUIRED_PUBLIC_MODEL_FIELDS) {
        expect(definition).toHaveProperty(field)
      }
    }
  })

  it('defaults Neon to high and keeps all Neon routes on the Gemini quota pool', () => {
    const selector = 'antigravity-gemini-4-neon'
    expect(resolveModelWithVariant(selector)).toMatchObject({
      actualModel: 'gemini-4-neon-high',
      thinkingLevel: 'high',
    })
    expect(
      resolveModelWithVariant(`${selector}-xhigh`, { thinkingLevel: 'low' })
        .actualModel,
    ).toBe('gemini-4-neon-low')
    for (const id of [selector, ...Object.keys(neon.routes)]) {
      expect(getQuotaGroupForModel(id, true)).toBe('gemini')
    }
    expect(getAgyNativeModel('gemini-pro-orchestrator-neon')).toBeUndefined()
  })

  it('preserves historical Gemini 3.5 effort parsing without authorizing admission', () => {
    expect(getGemini35FlashAntigravityModel()).toBe('gemini-3-flash-agent')
    expect(getGemini35FlashAntigravityModel('high')).toBe(
      'gemini-3-flash-agent',
    )
    expect(getGemini35FlashAntigravityModel('medium')).toBe(
      'gemini-3.5-flash-low',
    )
    expect(getGemini35FlashAntigravityModel('low')).toBe(
      'gemini-3.5-flash-extra-low',
    )
  })

  it('preserves historical Gemini 3.6 Flash parsing without authorizing admission', () => {
    expect(getGemini36FlashAntigravityModel()).toBe('gemini-3.6-flash-medium')
    expect(getGemini36FlashAntigravityModel('high')).toBe(
      'gemini-3.6-flash-high',
    )
    expect(getGemini36FlashAntigravityModel('medium')).toBe(
      'gemini-3.6-flash-medium',
    )
    expect(getGemini36FlashAntigravityModel('low')).toBe('gemini-3.6-flash-low')
  })

  it('preserves historical Gemini 3.7 Flash parsing without authorizing admission', () => {
    expect(getGemini37FlashAntigravityModel()).toBe('gemini-3.7-flash-medium')
    expect(getGemini37FlashAntigravityModel('high')).toBe(
      'gemini-3.7-flash-high',
    )
    expect(getGemini37FlashAntigravityModel('medium')).toBe(
      'gemini-3.7-flash-medium',
    )
    expect(getGemini37FlashAntigravityModel('low')).toBe('gemini-3.7-flash-low')
  })

  it('preserves live Gemini 3.8 Flash route mappings', () => {
    expect(getGemini38FlashAntigravityModel()).toBe('gemini-3.8-flash-medium')
    expect(getGemini38FlashAntigravityModel('high')).toBe(
      'gemini-3.8-flash-high',
    )
    expect(getGemini38FlashAntigravityModel('medium')).toBe(
      'gemini-3.8-flash-medium',
    )
    expect(getGemini38FlashAntigravityModel('low')).toBe('gemini-3.8-flash-low')
  })

  it('keeps historical parsing aliases without remapping retired Claude to a new family', () => {
    const aliases = getResolverAliasMap()

    expect(aliases['gemini-3.5-flash-medium']).toBe('gemini-3.5-flash')
    expect(aliases['gemini-3.6-flash-medium']).toBe('gemini-3.6-flash')
    expect(aliases['gemini-3.7-flash-medium']).toBe('gemini-3.7-flash')
    expect(aliases['gemini-3.8-flash-medium']).toBe('gemini-3.8-flash')
    expect(aliases['gemini-claude-opus-4-6-thinking-medium']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['gemini-claude-sonnet-4-6-thinking-high']).toBe(
      'claude-sonnet-4-6',
    )
    expect(aliases['gpt-oss-120b']).toBe('gpt-oss-120b-medium')
  })

  it('does not expose restricted Gemini 3.8 Flash Cyber', () => {
    expect(getPublicModelDefinitions()).not.toHaveProperty(
      'antigravity-gemini-3.8-flash-cyber',
    )
  })

  it('matches the live GPT-OSS capability metadata', () => {
    expect(
      getPublicModelDefinitions()['antigravity-gpt-oss-120b-medium'],
    ).toMatchObject({
      reasoning: true,
      limit: { context: 131072, output: 32768 },
    })
  })

  it('pins supported metadata to the server map rather than CLI picker omissions', () => {
    expect(Object.keys(capturedCatalog.models)).toHaveLength(18)
    expect(Object.keys(AGY_NATIVE_MODEL_DEFINITIONS).sort()).toEqual(
      EXPECTED_NATIVE_IDS,
    )
    for (const id of EXPECTED_NATIVE_IDS) {
      const metadata = AGY_NATIVE_MODEL_DEFINITIONS[id]!
      const observed = Object.entries({
        ...serverCatalog.models,
        ...carbonMetadata.models,
        ...hydrogen.routes,
        ...neon.routes,
      }).find(([key]) => key === id)?.[1]
      expect(observed).toBeDefined()
      // Carbon, Hydrogen and Neon map projections record routes and enums, not limits.
      // Native output caps are pinned separately to their request captures.
      if (
        Object.hasOwn(carbonMetadata.models, id) ||
        Object.hasOwn(hydrogen.routes, id) ||
        Object.hasOwn(neon.routes, id)
      )
        expect(observed).toMatchObject({
          displayName: metadata.displayName,
          model: metadata.model,
        })
      else expect(observed).toMatchObject(metadata)
      expect(getAgyModelEnum(id)).toBe(metadata.model)
    }
    for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      expect(AGY_NATIVE_MODEL_DEFINITIONS[id]).toBeUndefined()
      expect(isRetiredAgyModel(id)).toBe(true)
      expect(serverCatalog.models).not.toHaveProperty(id)
    }
  })

  it('keeps native IDs intact', () => {
    expect(Object.keys(AGY_NATIVE_MODEL_DEFINITIONS).sort()).toEqual(
      EXPECTED_NATIVE_IDS,
    )
    for (const id of EXPECTED_NATIVE_IDS) {
      expect(resolveModelWithTier(id).actualModel).toBe(id)
      expect(resolveModelWithTier(`antigravity-${id}`).actualModel).toBe(id)
    }
  })

  it('groups current families with sourced limits and all supported efforts', () => {
    const definitions = getPublicModelDefinitions()
    for (const family of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-4-hydrogen',
      'gemini-4-neon',
    ]) {
      const efforts =
        family === 'gemini-4-hydrogen' || family === 'gemini-4-neon'
          ? ['low', 'medium', 'high', 'xhigh']
          : ['low', 'medium', 'high']
      const definition = definitions[`antigravity-${family}`]!
      expect(Object.keys(definition.variants ?? {})).toEqual(efforts)
      for (const effort of efforts) {
        const metadata = AGY_NATIVE_MODEL_DEFINITIONS[`${family}-${effort}`]
        if (
          metadata?.maxTokens === undefined ||
          metadata.maxOutputTokens === undefined
        ) {
          throw new Error(`Missing captured limits for ${family}-${effort}`)
        }
        expect(definition.limit).toEqual({
          context: metadata.maxTokens,
          output: metadata.maxOutputTokens,
        })
        expect(
          resolveModelWithTier(`antigravity-${family}-${effort}`).actualModel,
        ).toBe(`${family}-${effort}`)
      }
    }
  })
})

describe('server catalog authority', () => {
  it('refuses every withdrawn Gemini selector and native route absent from the current map', () => {
    for (const family of [
      'gemini-3.1-pro',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
    ]) {
      const efforts =
        family === 'gemini-3.1-pro'
          ? ['low', 'high']
          : ['low', 'medium', 'high', 'tiered']
      for (const suffix of ['', ...efforts.map((effort) => `-${effort}`)]) {
        for (const prefix of ['', 'antigravity-']) {
          const id = prefix + family + suffix
          expect(isRetiredAgyModel(id)).toBe(true)
          expect(getPublicModelDefinitions()).not.toHaveProperty(id)
          expect(serverCatalog.models).not.toHaveProperty(family + suffix)
        }
      }
    }
    for (const id of ['gemini-pro-agent', 'antigravity-gemini-pro-agent']) {
      expect(isRetiredAgyModel(id)).toBe(true)
      expect(serverCatalog.models).not.toHaveProperty(
        id.replace(/^antigravity-/, ''),
      )
    }
    expect(Object.keys(serverCatalog.models)).toHaveLength(29)
  })

  it('defaults grouped Argon to medium and keeps every effort on its native route', () => {
    expect(resolveModelWithTier('antigravity-gemini-4-argon').actualModel).toBe(
      'gemini-4-argon-medium',
    )
    for (const effort of ['low', 'medium', 'high']) {
      expect(
        resolveModelWithTier(`antigravity-gemini-4-argon-${effort}`)
          .actualModel,
      ).toBe(`gemini-4-argon-${effort}`)
      expect(resolveModelWithTier(`gemini-4-argon-${effort}`).actualModel).toBe(
        `gemini-4-argon-${effort}`,
      )
    }
  })
  it('keeps every public selector and effort on a server-listed route', () => {
    for (const definition of Object.values(getPublicModelDefinitions())) {
      const efforts = Object.keys(definition.variants ?? {})
      for (const effort of ['', ...efforts]) {
        const selector = `${definition.id}${effort ? `-${effort}` : ''}`
        const wire = resolveModelWithTier(selector).actualModel
        expect(
          Object.hasOwn(
            {
              ...serverCatalog.models,
              ...carbonMetadata.models,
              ...hydrogen.routes,
              ...neon.routes,
            },
            wire,
          ),
        ).toBe(true)
        expect(isRetiredAgyModel(selector)).toBe(false)
      }
    }
    expect(
      resolveModelWithTier('antigravity-gemini-3.5-flash-low').actualModel,
    ).toBe('gemini-3.5-flash-extra-low')
    expect(
      resolveModelWithTier('antigravity-gemini-3.1-pro-high').actualModel,
    ).toBe('gemini-3.1-pro-high')
  })

  it('applies Antigravity admission to historical preview aliases', () => {
    expect(isRetiredAgyModel('gemini-3.1-pro-preview')).toBe(true)
    expect(isRetiredAgyModel('gemini-3.1-pro-preview-customtools')).toBe(true)
    expect(isRetiredAgyModel('gemini-3.5-flash-preview')).toBe(true)
  })

  it('refuses absent historical Claude routes without treating offered Gemini routes as retired', () => {
    for (const family of ['opus', 'sonnet']) {
      for (const thinking of ['', '-thinking']) {
        for (const effort of ['', '-low', '-medium', '-high']) {
          for (const prefix of ['', 'antigravity-', 'gemini-']) {
            const route = `claude-${family}-4-6${thinking}${effort}`
            expect(isRetiredAgyModel(prefix + route)).toBe(true)
            expect(serverCatalog.models).not.toHaveProperty(route)
          }
        }
      }
    }
    expect(isRetiredAgyModel('gemini-3.8-flash-low')).toBe(false)
    expect(Object.hasOwn(serverCatalog.models, 'gemini-3.8-flash-low')).toBe(
      true,
    )
  })
})
