import { describe, expect, it } from 'bun:test'
import {
  canonicalModelId,
  compileModelAccess,
} from '@cortexkit/antigravity-auth-core/settings'

describe('model access', () => {
  it('canonicalizes all Hydrogen efforts and applies one allowlist entry to all four', () => {
    const policy = compileModelAccess({ local: ['gemini-4-hydrogen-xhigh'] })
    expect(policy.valid).toBe(true)
    for (const tier of ['', '-low', '-medium', '-high', '-xhigh']) {
      const id = `antigravity-gemini-4-hydrogen${tier}`
      expect(canonicalModelId(id)).toBe('gemini-4-hydrogen')
      expect(policy.allows('local', id)).toBe(true)
    }
    expect(policy.allows('local', 'gemini-4-carbon')).toBe(false)
  })

  it('canonicalizes public tiers and prefixes without stripping GPT wire suffixes', () => {
    for (const id of [
      'gemini-4-carbon',
      'gemini-4-carbon-low',
      'antigravity-gemini-4-carbon-medium',
      'ANTIGRAVITY-GEMINI-4-CARBON-HIGH',
    ]) {
      expect(canonicalModelId(id)).toBe('gemini-4-carbon')
    }
    expect(canonicalModelId('claude-sonnet-5-5-high')).toBe('claude-sonnet-5-5')
    expect(canonicalModelId('gpt-oss-120b-medium')).toBe('gpt-oss-120b-medium')
    expect(canonicalModelId('gpt-oss-120b')).toBe('gpt-oss-120b-medium')
    expect(canonicalModelId('unknown-high')).toBe('unknown-high')
  })

  it('covers all tiers when either the entry or the request has a tier', () => {
    const policy = compileModelAccess({ local: ['gemini-4-carbon-high'] })
    expect(policy.valid).toBe(true)
    for (const tier of ['', '-low', '-medium', '-high']) {
      expect(policy.allows('local', `antigravity-gemini-4-carbon${tier}`)).toBe(
        true,
      )
    }
    expect(policy.allows('local', 'gemini-4-argon')).toBe(false)
  })

  it('does not let a resolver alias bypass the allowlist', () => {
    const policy = compileModelAccess({ local: ['gemini-4-carbon'] })
    expect(policy.allows('local', 'gpt-oss-120b')).toBe(false)
    const gpt = compileModelAccess({ local: ['gpt-oss-120b'] })
    expect(gpt.allows('local', 'antigravity-gpt-oss-120b-medium')).toBe(true)
    expect(gpt.allows('local', 'gemini-4-carbon-high')).toBe(false)
  })

  it('reports unknown-only lists and allows nothing for that account', () => {
    const policy = compileModelAccess({
      local: ['not-a-model', 'retired-route'],
    })
    expect(policy.valid).toBe(true)
    expect(
      policy.issues.filter((issue) => issue.reason === 'unknown-model'),
    ).toHaveLength(2)
    expect(policy.issues).toContainEqual({
      accountKey: 'local',
      reason: 'unknown-only',
    })
    expect(policy.allows('local', 'not-a-model')).toBe(false)
    expect(policy.allows('local', 'gemini-4-carbon')).toBe(false)
  })

  it('reports unknown members without widening a mixed list', () => {
    const policy = compileModelAccess({
      local: ['gemini-4-carbon', 'not-a-model'],
    })
    expect(policy.allows('local', 'gemini-4-carbon-low')).toBe(true)
    expect(policy.allows('local', 'not-a-model')).toBe(false)
    expect(policy.allows('local', 'gemini-4-argon')).toBe(false)
    expect(policy.issues).toContainEqual({
      accountKey: 'local',
      modelId: 'not-a-model',
      reason: 'unknown-model',
    })
  })

  it('allows all models for a missing entry or missing account key', () => {
    const policy = compileModelAccess({ local: ['gemini-4-carbon'] })
    expect(policy.allows('other', 'gemini-4-argon')).toBe(true)
    expect(policy.allows(undefined, 'gemini-4-argon')).toBe(true)
    expect(compileModelAccess({}).allows('local', 'future-model')).toBe(true)
  })

  it('rejects an empty list without skipping just that entry', () => {
    const policy = compileModelAccess({ empty: [], local: ['gemini-4-carbon'] })
    expect(policy.valid).toBe(false)
    expect(policy.issues).toContainEqual({
      accountKey: 'empty',
      reason: 'empty-list',
    })
    expect(policy.allows('empty', 'gemini-4-carbon')).toBe(false)
    expect(policy.allows('local', 'gemini-4-carbon')).toBe(false)
    expect(policy.allows('other', 'gemini-4-carbon')).toBe(false)
  })

  it('fails restrictive when unusable and nothing was last applied', () => {
    const policy = compileModelAccess({}, { unusable: true })
    expect(policy.valid).toBe(false)
    for (const key of ['local', 'vault:credential~abcdef0123', undefined]) {
      expect(policy.allows(key, 'gemini-4-carbon')).toBe(false)
    }
  })

  it('retains a last-applied policy when the new setting is unusable', () => {
    const policy = compileModelAccess(
      {},
      {
        unusable: true,
        lastApplied: { local: ['gemini-4-carbon'] },
      },
    )
    expect(policy.valid).toBe(false)
    expect(policy.allows('local', 'gemini-4-carbon-high')).toBe(true)
    expect(policy.allows('local', 'gemini-4-argon')).toBe(false)
    expect(policy.allows('other', 'gemini-4-argon')).toBe(true)
  })

  it('rejects malformed records and unusable persisted values as a whole', () => {
    for (const value of [
      undefined,
      null,
      [],
      'bad',
      { local: [1] },
      { local: 'gemini-4-carbon' },
    ]) {
      const policy = compileModelAccess(value)
      expect(policy.valid).toBe(false)
      expect(policy.allows('other', 'gemini-4-carbon')).toBe(false)
    }
    expect(
      compileModelAccess(null, { lastApplied: { local: [] } }).allows(
        'other',
        'gemini-4-carbon',
      ),
    ).toBe(false)
  })

  it('treats vault roster route ids and local row ids as opaque keys', () => {
    const route = 'vault:credential~abcdef0123~2'
    const policy = compileModelAccess({
      [route]: ['gemini-4-carbon'],
      'local-row': ['gpt-oss-120b'],
    })
    expect(policy.allows(route, 'gemini-4-argon')).toBe(false)
    expect(policy.allows(route, 'gemini-4-carbon')).toBe(true)
    expect(policy.allows('vault:credential~abcdef0124', 'gemini-4-argon')).toBe(
      true,
    )
    expect(policy.allows('person@example.com', 'gemini-4-argon')).toBe(true)
    expect(policy.allows('local-row', 'gemini-4-carbon')).toBe(false)
  })

  it('does not confuse object prototype names with account or model ids', () => {
    const policy = compileModelAccess(
      JSON.parse(
        '{"__proto__":["gemini-4-carbon"],"constructor":["toString"]}',
      ),
    )
    expect(policy.allows('__proto__', 'gemini-4-argon')).toBe(false)
    expect(policy.allows('__proto__', 'gemini-4-carbon')).toBe(true)
    expect(policy.allows('constructor', 'toString')).toBe(false)
    expect(policy.allows('toString', 'gemini-4-carbon')).toBe(true)
  })

  it('compiles a snapshot independent of later input mutation', () => {
    const entries = { local: ['gemini-4-carbon'] }
    const policy = compileModelAccess(entries)
    entries.local.push('gemini-4-argon')
    expect(policy.allows('local', 'gemini-4-argon')).toBe(false)
  })
})
