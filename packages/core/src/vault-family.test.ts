import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

import {
  ANTIGRAVITY_VAULT_ENROLLMENT_NAMES,
  ANTIGRAVITY_VAULT_FAMILY,
  ANTIGRAVITY_VAULT_REQUIRE_ASSERTION,
  getAntigravityVaultEnrollmentName,
} from './vault-family.ts'

describe('Antigravity vault family policy', () => {
  it('matches the Claustrum family shape and requires an asserted identity', () => {
    expect(ANTIGRAVITY_VAULT_FAMILY).toEqual({
      refreshAdapter: 'antigravity',
      category: 'antigravity-native',
      apiKeys: false,
    })
    expect(ANTIGRAVITY_VAULT_REQUIRE_ASSERTION).toBe(true)
  })

  it('provides immutable, independent enrollment names for both hosts', () => {
    expect(getAntigravityVaultEnrollmentName('opencode')).toBe(
      'antigravity-auth-opencode',
    )
    expect(getAntigravityVaultEnrollmentName('pi')).toBe('antigravity-auth-pi')

    expect(Object.isFrozen(ANTIGRAVITY_VAULT_FAMILY)).toBe(true)
    expect(Object.isFrozen(ANTIGRAVITY_VAULT_ENROLLMENT_NAMES)).toBe(true)
    expect(Reflect.set(ANTIGRAVITY_VAULT_FAMILY, 'category', 'changed')).toBe(
      false,
    )
    expect(
      Reflect.set(ANTIGRAVITY_VAULT_ENROLLMENT_NAMES, 'opencode', 'changed'),
    ).toBe(false)
    expect(getAntigravityVaultEnrollmentName('opencode')).toBe(
      'antigravity-auth-opencode',
    )
    expect(getAntigravityVaultEnrollmentName('pi')).toBe('antigravity-auth-pi')
  })

  it('fails closed for unsupported, empty, undefined, and historical host values', () => {
    for (const host of [undefined, '', 'vscode', 'opencode-auth'] as const) {
      expect(() =>
        Reflect.apply(getAntigravityVaultEnrollmentName, undefined, [host]),
      ).toThrow(TypeError)
    }
  })

  it('keeps the policy module free of runtime and credential machinery imports', async () => {
    const source = await readFile(
      new URL('./vault-family.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })
})
