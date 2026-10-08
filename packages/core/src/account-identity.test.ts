import { describe, expect, it } from 'bun:test'
import {
  credentialFenceOf,
  refMismatchReason,
  rowHoldsRef,
  rowRefKey,
  rowRefOf,
  sameRowRef,
} from './account-identity.ts'

describe('rowRefOf', () => {
  it('counts a row without a per-row entry as epoch 1', () => {
    expect(rowRefOf({ id: 'a' })).toEqual({ id: 'a', credentialEpoch: 1 })
  })

  it('leaves the identity out when none is recorded', () => {
    const ref = rowRefOf({ id: 'a', credentialEpoch: 3 })
    expect('identity' in ref).toBe(false)
    expect(rowRefOf({ id: 'a', credentialEpoch: 3, identity: 'acct' })).toEqual(
      {
        id: 'a',
        credentialEpoch: 3,
        identity: 'acct',
      },
    )
  })
})

describe('sameRowRef', () => {
  const base = { id: 'a', credentialEpoch: 2 }

  it('matches only the same id, epoch and identity', () => {
    expect(sameRowRef(base, { ...base })).toBe(true)
    expect(sameRowRef(base, { ...base, credentialEpoch: 3 })).toBe(false)
    expect(sameRowRef(base, { ...base, id: 'b' })).toBe(false)
  })

  it('treats an absent identity as matching only an absent identity', () => {
    expect(sameRowRef(base, { ...base, identity: 'acct' })).toBe(false)
    expect(sameRowRef({ ...base, identity: 'acct' }, base)).toBe(false)
    expect(
      sameRowRef({ ...base, identity: 'acct' }, { ...base, identity: 'other' }),
    ).toBe(false)
  })

  it('compares a loaded row with a ref the same way', () => {
    expect(rowHoldsRef({ id: 'a' }, { id: 'a', credentialEpoch: 1 })).toBe(true)
    expect(
      rowHoldsRef(
        { id: 'a', identity: 'acct' },
        { id: 'a', credentialEpoch: 1 },
      ),
    ).toBe(false)
  })
})

describe('rowRefKey', () => {
  it('gives every distinct ref its own key', () => {
    const keys = [
      { id: 'a', credentialEpoch: 1 },
      { id: 'a', credentialEpoch: 2 },
      { id: 'a', credentialEpoch: 1, identity: 'acct' },
      { id: 'a', credentialEpoch: 1, identity: '' },
      { id: 'a","1', credentialEpoch: 1 },
    ].map(rowRefKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(rowRefKey({ id: 'a', credentialEpoch: 1 })).toBe(
      rowRefKey({ id: 'a', credentialEpoch: 1 }),
    )
  })
})

describe('credentialFenceOf', () => {
  it('passes the epoch and the identity exactly, absence included', () => {
    expect(credentialFenceOf({ id: 'a', credentialEpoch: 4 })).toEqual({
      credentialEpoch: 4,
    })
    expect(
      'identity' in credentialFenceOf({ id: 'a', credentialEpoch: 4 }),
    ).toBe(false)
    expect(
      credentialFenceOf({ id: 'a', credentialEpoch: 4, identity: 'acct' }),
    ).toEqual({ credentialEpoch: 4, identity: 'acct' })
  })
})

describe('refMismatchReason', () => {
  const ref = { id: 'a', credentialEpoch: 2, identity: 'acct-secret-id' }

  it('is undefined while the row holds the ref', () => {
    expect(
      refMismatchReason(
        { id: 'a', credentialEpoch: 2, identity: 'acct-secret-id' },
        ref,
      ),
    ).toBeUndefined()
  })

  it('names the removal, the epoch change and the identity change', () => {
    expect(refMismatchReason(undefined, ref)).toContain('no longer in the pool')
    expect(
      refMismatchReason(
        { id: 'a', credentialEpoch: 3, identity: 'acct-secret-id' },
        ref,
      ),
    ).toContain('epoch 3')
    const changed = refMismatchReason({ id: 'a', credentialEpoch: 2 }, ref)
    expect(changed).toContain('different account identity')
    // Identities are account ids; they stay out of messages.
    expect(changed).not.toContain('acct-secret-id')
  })
})
