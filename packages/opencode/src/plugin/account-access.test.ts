import { describe, expect, it, mock } from 'bun:test'

import {
  type AccountAccessStore,
  createAccountAccessService,
  normalizeGoogleVerificationUrl,
  selectBestVerificationUrl,
} from './account-access'
import type { AccountStorageV4 } from './storage'

function createStore(initial: AccountStorageV4): {
  store: AccountAccessStore
  getStorage: () => AccountStorageV4
} {
  let storage = structuredClone(initial)
  const store: AccountAccessStore = {
    load: mock(async () => structuredClone(storage)),
    mutate: mock(async (mutate) => {
      const current = structuredClone(storage)
      storage = (await mutate(current)) ?? current
      return structuredClone(storage)
    }),
    clear: mock(async () => {
      storage = { version: 4, accounts: [], activeIndex: 0 }
    }),
    persistAccountPool: mock(async () => {}),
  }
  return { store, getStorage: () => structuredClone(storage) }
}

function accountStorage(): AccountStorageV4 {
  return {
    version: 4,
    activeIndex: 0,
    accounts: [
      {
        email: 'target@example.com',
        refreshToken: 'current-token',
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
      },
    ],
  }
}

describe('verification URL selection', () => {
  it('normalizes escaped Google URLs and rejects other hosts', () => {
    expect(
      normalizeGoogleVerificationUrl(
        ' https://accounts.google.com/signin/continue?service=cloudcode&amp;plt=abc ',
      ),
    ).toBe(
      'https://accounts.google.com/signin/continue?service=cloudcode&plt=abc',
    )
    expect(
      normalizeGoogleVerificationUrl('https://example.com/signin/continue'),
    ).toBeUndefined()
  })

  it('selects the most actionable verification URL', () => {
    expect(
      selectBestVerificationUrl([
        'https://accounts.google.com/o/oauth2/auth?service=cloudcode',
        'https://accounts.google.com/signin/continue?continue=next&amp;plt=token',
      ]),
    ).toBe(
      'https://accounts.google.com/signin/continue?continue=next&plt=token',
    )
  })
})

describe('AccountAccessService storage mutations', () => {
  it('marks verification-required and ineligible outcomes distinctly by stable identity', async () => {
    const { store, getStorage } = createStore(accountStorage())
    const service = createAccountAccessService({
      client: {} as never,
      providerId: 'google',
      store,
      openBrowser: mock(async () => true),
      prompt: {
        selectAccount: mock(async () => undefined),
        confirmOpenVerificationUrl: mock(async () => false),
      },
    })

    await service.applyVerificationResult(
      { refreshToken: 'stale-token', email: 'target@example.com' },
      {
        status: 'verification-required',
        message: 'Verify this account',
        verifyUrl: 'https://accounts.google.com/signin/continue?plt=token',
      },
    )

    expect(getStorage().accounts[0]).toMatchObject({
      enabled: false,
      verificationRequired: true,
      verificationRequiredReason: 'Verify this account',
      accountIneligible: false,
    })

    await service.applyVerificationResult(
      { refreshToken: 'current-token', email: 'target@example.com' },
      { status: 'ineligible', message: 'ACCOUNT_INELIGIBLE' },
    )

    expect(getStorage().accounts[0]).toMatchObject({
      enabled: false,
      verificationRequired: false,
      accountIneligible: true,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
    })
    expect(getStorage().accounts[0]?.verificationUrl).toBeUndefined()
  })

  it('clears access blocks and re-enables only an account that was blocked', async () => {
    const initial = accountStorage()
    initial.accounts[0] = {
      ...initial.accounts[0]!,
      enabled: false,
      verificationRequired: true,
      verificationRequiredReason: 'Verify',
      verificationUrl: 'https://accounts.google.com/signin/continue',
    }
    const { store, getStorage } = createStore(initial)
    const service = createAccountAccessService({
      client: {} as never,
      providerId: 'google',
      store,
      openBrowser: mock(async () => true),
      prompt: {
        selectAccount: mock(async () => undefined),
        confirmOpenVerificationUrl: mock(async () => false),
      },
    })

    const result = await service.clearAccessBlocks(
      { refreshToken: 'current-token' },
      true,
    )

    expect(result).toEqual({ changed: true, wasAccessBlocked: true })
    expect(getStorage().accounts[0]).toMatchObject({
      enabled: true,
      verificationRequired: false,
      accountIneligible: false,
    })
    expect(getStorage().accounts[0]?.verificationRequiredReason).toBeUndefined()
  })
})
