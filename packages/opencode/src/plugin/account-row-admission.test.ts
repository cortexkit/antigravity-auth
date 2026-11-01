import { describe, expect, it } from 'bun:test'
import type { AccountRow, RowRef } from '@cortexkit/antigravity-auth-core'
import { accessBlockOf, isReconnectReadyRow } from './account-row-admission.ts'

describe('account-row-admission', () => {
  const genuineRef: RowRef = {
    id: 'row-genuine-1',
    credentialEpoch: 1,
    identity: 'user@example.test',
  }

  const baseRow: AccountRow = {
    ref: genuineRef,
    index: 0,
    enabled: true,
    usable: true,
    storeAddedAt: 100,
    stamp: 'bound',
    credential: {
      refreshToken: 'synthetic-refresh-token',
      accessToken: 'synthetic-access-token',
      expiresAt: Date.now() + 3_600_000,
    },
    metadata: {
      status: 'present',
      metadata: {
        addedAt: 100,
        lastUsed: 100,
      },
    },
    quota: { status: 'absent' },
  }

  it('accepts healthy genuine rows', () => {
    expect(accessBlockOf(baseRow)).toEqual({ kind: 'none' })
    expect(isReconnectReadyRow(baseRow)).toBe(true)
  })

  it('refuses damaged row flags', () => {
    expect(isReconnectReadyRow({ ...baseRow, enabled: false })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, usable: false })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, torn: true })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, unbound: true })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, invalid: 'entry' })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, invalid: 'roster' })).toBe(false)
    expect(isReconnectReadyRow({ ...baseRow, credential: undefined })).toBe(
      false,
    )
    expect(
      isReconnectReadyRow({ ...baseRow, metadata: { status: 'absent' } }),
    ).toBe(false)
    expect(
      isReconnectReadyRow({
        ...baseRow,
        metadata: { status: 'dropped', reason: 'uncovered' },
      }),
    ).toBe(false)
  })

  it('refuses access blocked rows and flags invalid metadata combinations', () => {
    const ineligibleRow: AccountRow = {
      ...baseRow,
      metadata: {
        status: 'present',
        metadata: {
          addedAt: 100,
          lastUsed: 100,
          accountIneligible: true,
          accountIneligibleReason: 'account-ineligible',
        },
      },
    }
    expect(accessBlockOf(ineligibleRow)).toEqual({
      kind: 'ineligible',
      reason: 'account-ineligible',
    })
    expect(isReconnectReadyRow(ineligibleRow)).toBe(false)

    const verificationRow: AccountRow = {
      ...baseRow,
      metadata: {
        status: 'present',
        metadata: {
          addedAt: 100,
          lastUsed: 100,
          verificationRequired: true,
          verificationRequiredReason: 'validation-required',
        },
      },
    }
    expect(accessBlockOf(verificationRow)).toEqual({
      kind: 'verification-required',
      reason: 'validation-required',
    })
    expect(isReconnectReadyRow(verificationRow)).toBe(false)

    // Both flags set simultaneously is invalid
    const conflictingRow: AccountRow = {
      ...baseRow,
      metadata: {
        status: 'present',
        metadata: {
          addedAt: 100,
          lastUsed: 100,
          accountIneligible: true,
          verificationRequired: true,
        },
      },
    }
    expect(accessBlockOf(conflictingRow)).toEqual({ kind: 'invalid' })
    expect(isReconnectReadyRow(conflictingRow)).toBe(false)
  })
})
