import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountAccessService } from './account-access'
import { persistAccountPool } from './persist-account-pool'
import {
  clearAccounts,
  getStoragePath,
  loadAccounts,
  mutateAccountStorage,
  saveAccountsReplace,
} from './storage'

let configDir = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'antigravity-ineligible-'))
  process.env.OPENCODE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('account ineligibility disk persistence', () => {
  it('persists service-level ineligibility mutations in the real account file', async () => {
    await saveAccountsReplace({
      version: 4,
      accounts: [
        {
          email: 'blocked@example.com',
          refreshToken: 'refresh-token',
          addedAt: 1,
          lastUsed: 2,
          enabled: true,
        },
      ],
      activeIndex: 0,
    })
    const service = createAccountAccessService({
      client: {} as never,
      providerId: 'google',
      store: {
        load: loadAccounts,
        mutate: (mutate) => mutateAccountStorage(getStoragePath(), mutate),
        clear: clearAccounts,
        persistAccountPool,
      },
      openBrowser: mock(async () => false),
      prompt: {
        selectAccount: mock(async () => undefined),
        confirmOpenVerificationUrl: mock(async () => false),
      },
    })

    await service.applyVerificationResult(
      { refreshToken: 'refresh-token', email: 'blocked@example.com' },
      { status: 'ineligible', message: 'ACCOUNT_INELIGIBLE' },
    )

    const storagePath = join(configDir, 'antigravity-accounts.json')
    const raw = JSON.parse(await readFile(storagePath, 'utf8')) as {
      accounts: Array<Record<string, unknown>>
    }
    expect(raw.accounts[0]).toMatchObject({
      enabled: false,
      accountIneligible: true,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
    })
    expect(typeof raw.accounts[0]?.accountIneligibleAt).toBe('number')
    expect(typeof raw.accounts[0]?.eligibilityStateUpdatedAt).toBe('number')
    expect((await stat(storagePath)).mode & 0o777).toBe(0o600)

    await expect(loadAccounts()).resolves.toMatchObject({
      accounts: [
        expect.objectContaining({
          enabled: false,
          accountIneligible: true,
          accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
        }),
      ],
    })
  })
})
