import { describe, expect, it } from 'bun:test'

import {
  accessBlockOf,
  accessVerdictFromProbe,
  clearLegacyAccessBlocks,
  isAccessBlocked,
  type LegacyAccessBlockRecord,
  markLegacyIneligible,
  markLegacyVerificationRequired,
} from './account-blocks'

describe('accessBlockOf', () => {
  it('reads null fields of repository metadata as absent', () => {
    expect(
      accessBlockOf({
        verificationRequired: null,
        accountIneligible: null,
        verificationUrl: null,
      }),
    ).toEqual({ kind: 'none' })
    expect(accessBlockOf(undefined)).toEqual({ kind: 'none' })
  })

  it('reports a verification block with its reason, url and time', () => {
    expect(
      accessBlockOf({
        verificationRequired: true,
        verificationRequiredAt: 7,
        verificationRequiredReason: 'Verify',
        verificationUrl: 'https://accounts.google.com/x',
        accountIneligibleReason: null,
      }),
    ).toEqual({
      kind: 'verification-required',
      reason: 'Verify',
      verificationUrl: 'https://accounts.google.com/x',
      at: 7,
    })
  })

  it('reports ineligibility first when an old record carries both flags', () => {
    const block = accessBlockOf({
      verificationRequired: true,
      accountIneligible: true,
      accountIneligibleReason: 'No',
    })
    expect(block).toEqual({ kind: 'ineligible', reason: 'No' })
    expect(isAccessBlocked({ accountIneligible: true })).toBe(true)
    expect(isAccessBlocked({ accountIneligible: false })).toBe(false)
  })
})

describe('accessVerdictFromProbe', () => {
  it('maps each probe status to its verdict at the observation time', () => {
    expect(
      accessVerdictFromProbe(
        {
          status: 'verification-required',
          message: ' Verify ',
          verifyUrl: ' https://accounts.google.com/v ',
        },
        42,
        false,
      ),
    ).toEqual({
      kind: 'verification-required',
      observedAt: 42,
      reason: 'Verify',
      verificationUrl: 'https://accounts.google.com/v',
    })
    expect(
      accessVerdictFromProbe({ status: 'ineligible', message: 'X' }, 43, false),
    ).toEqual({ kind: 'ineligible', observedAt: 43, reason: 'X' })
    expect(
      accessVerdictFromProbe({ status: 'ok', message: 'fine' }, 44, true),
    ).toEqual({ kind: 'cleared', observedAt: 44, enable: true })
  })

  it('gives no verdict for a probe that proved nothing about access', () => {
    expect(
      accessVerdictFromProbe({ status: 'error', message: 'down' }, 45, true),
    ).toBeUndefined()
  })
})

describe('legacy access-block helpers', () => {
  it('keeps verification and ineligibility mutually exclusive', () => {
    const record: LegacyAccessBlockRecord = { enabled: true }
    expect(markLegacyIneligible(record, 'No', 10)).toBe(true)
    expect(record).toMatchObject({
      enabled: false,
      accountIneligible: true,
      accountIneligibleAt: 10,
      verificationRequired: false,
    })

    expect(
      markLegacyVerificationRequired(
        record,
        'Verify',
        'https://accounts.google.com/v',
        20,
      ),
    ).toBe(true)
    expect(record).toMatchObject({
      enabled: false,
      verificationRequired: true,
      verificationRequiredAt: 20,
      accountIneligible: false,
      eligibilityStateUpdatedAt: 20,
    })
    expect(record.accountIneligibleReason).toBeUndefined()
  })

  it('re-enables only a record a block had disabled', () => {
    const blocked: LegacyAccessBlockRecord = {
      enabled: false,
      verificationRequired: true,
    }
    expect(clearLegacyAccessBlocks(blocked, true, 30)).toEqual({
      changed: true,
      wasAccessBlocked: true,
    })
    expect(blocked.enabled).toBe(true)

    const userDisabled: LegacyAccessBlockRecord = {
      enabled: false,
      verificationRequired: false,
      accountIneligible: false,
    }
    expect(clearLegacyAccessBlocks(userDisabled, true, 31)).toEqual({
      changed: false,
      wasAccessBlocked: false,
    })
    expect(userDisabled.enabled).toBe(false)
  })
})
