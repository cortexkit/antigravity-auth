import { describe, expect, test } from 'bun:test'
import {
  boolean,
  defineSettings,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'

describe('common-auth settings public export', () => {
  test('defines a setting through the core package subpath', () => {
    const definition = defineSettings({
      plugin: 'antigravity-auth',
      settings: {
        enabled: { value: boolean(), default: false, hosts: 'both' },
      },
    })

    expect(definition.plugin).toBe('antigravity-auth')
    expect(definition.settings.enabled.default).toBe(false)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.settings.enabled)).toBe(true)
  })
})
