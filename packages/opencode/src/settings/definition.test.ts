import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { settingsJsonSchema } from '@cortexkit/antigravity-auth-core/common-auth/settings'
import { ANTIGRAVITY_SETTINGS } from '@cortexkit/antigravity-auth-core/settings'
import {
  AntigravityConfigSchema,
  DEFAULT_CONFIG,
} from '../plugin/config/schema.ts'

describe('shipped settings definition', () => {
  it('ships exactly the library-generated schema', () => {
    const shipped = JSON.parse(
      readFileSync(
        new URL('../../assets/antigravity-auth.schema.json', import.meta.url),
        'utf8',
      ),
    )
    expect(shipped).toEqual(settingsJsonSchema(ANTIGRAVITY_SETTINGS))
  })

  it('preserves every legacy default after renaming and the TTL split', () => {
    const {
      operator,
      tool_id_recovery: _retiredTool,
      max_backoff_seconds: _retiredBackoff,
      soft_quota_cache_ttl_minutes: ttl,
      ...ordinary
    } = DEFAULT_CONFIG
    const defaults = Object.fromEntries(
      Object.entries(ANTIGRAVITY_SETTINGS.settings).map(
        ([name, declaration]) => [name, declaration.default],
      ),
    )
    expect(ttl).toBe('auto')
    expect(defaults).toEqual({
      ...ordinary,
      log_dir: '',
      soft_quota_cache_ttl: 'auto',
      soft_quota_cache_ttl_minutes: 60,
      killswitch: { ...operator!.killswitch, accounts: {} },
      log_level: operator!.log_level,
      account_models: {},
    })
  })

  it('preserves every legacy numeric bound, including nested objects', () => {
    const old = AntigravityConfigSchema.toJSONSchema({
      unrepresentable: 'any',
    }) as { properties: Record<string, unknown> }
    const schema = settingsJsonSchema(ANTIGRAVITY_SETTINGS) as {
      properties: Record<string, unknown>
    }
    function bounds(node: unknown): unknown {
      if (!node || typeof node !== 'object') return undefined
      const value = node as Record<string, unknown>
      if (value.type === 'number')
        return { minimum: value.minimum, maximum: value.maximum }
      if (value.properties)
        return Object.fromEntries(
          Object.entries(value.properties as Record<string, unknown>)
            .map(([key, child]) => [key, bounds(child)])
            .filter(([, child]) => child !== undefined),
        )
      if (
        value.additionalProperties &&
        typeof value.additionalProperties === 'object'
      )
        return bounds(value.additionalProperties)
      return undefined
    }
    for (const [name, declaration] of Object.entries(
      ANTIGRAVITY_SETTINGS.settings,
    )) {
      if (name === 'account_models' || name === 'soft_quota_cache_ttl') continue
      let legacy = old.properties[name]
      if (name === 'killswitch' || name === 'log_level') {
        legacy = (
          old.properties.operator as { properties: Record<string, unknown> }
        ).properties[name]
      }
      if (name === 'soft_quota_cache_ttl_minutes') {
        legacy = (legacy as { anyOf: unknown[] }).anyOf[1]
      }
      expect(bounds(schema.properties[name]), name).toEqual(bounds(legacy))
      expect(declaration.hosts).toBe('opencode')
    }
  })
})
