import { describe, expect, it, mock } from 'bun:test'

import {
  type AccountRepository,
  AccountRepositoryError,
  type AccountRepositoryOperation,
  type AccountRow,
  type ProviderMetadata,
  type RowRef,
} from '@cortexkit/antigravity-auth-core'

import {
  type AccountAccessStore,
  AccountChangedDuringReauthorizationError,
  AccountStoreUnavailableError,
  createAccountAccessService,
  createRepositoryAccountAccessService,
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

// ---------------------------------------------------------------------------
// Account-store access service
//
// The repository below is an in-memory stand-in for the account repository
// that keeps the one property these tests are about: every write names a
// RowRef, and a ref whose id, credential epoch or recorded identity no
// longer matches the row is refused before anything changes (`attribution`,
// or `unknown-row` for a removed row). The real store's fencing is tested
// with the repository itself.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string
  credentialEpoch: number
  identity?: string
  refreshToken: string
  enabled: boolean
  metadata?: ProviderMetadata
}

function refOf(row: FakeRow): RowRef {
  return row.identity === undefined
    ? { id: row.id, credentialEpoch: row.credentialEpoch }
    : {
        id: row.id,
        credentialEpoch: row.credentialEpoch,
        identity: row.identity,
      }
}

function refusal(
  operation: AccountRepositoryOperation,
  kind: 'attribution' | 'unknown-row',
  rowId: string,
): AccountRepositoryError {
  return new AccountRepositoryError({
    operation,
    kind,
    retryable: kind === 'attribution',
    ambiguous: false,
    rowId,
    message: `${kind} ${rowId}`,
  })
}

function createFakeRepository(initial: FakeRow[]) {
  let rows = initial.map((row) => structuredClone(row))
  const writes: Array<{ operation: string; ref: RowRef; detail?: unknown }> = []
  let refreshImpl: (
    ref: RowRef,
  ) => Promise<Awaited<ReturnType<AccountRepository['refresh']>>> = async (
    ref,
  ) => ({
    status: 'rotated',
    ref,
    accessToken: `access-${ref.id}-${ref.credentialEpoch}`,
    expiresAt: 10_000,
  })

  const locate = (operation: AccountRepositoryOperation, ref: RowRef) => {
    const row = rows.find((candidate) => candidate.id === ref.id)
    if (row === undefined) throw refusal(operation, 'unknown-row', ref.id)
    if (
      row.credentialEpoch !== ref.credentialEpoch ||
      row.identity !== ref.identity
    ) {
      throw refusal(operation, 'attribution', ref.id)
    }
    return row
  }

  const implemented: Partial<AccountRepository> = {
    async read() {
      return {
        status: 'ready',
        rows: rows.map(
          (row, index): AccountRow => ({
            ref: refOf(row),
            index,
            enabled: row.enabled,
            credential: { refreshToken: row.refreshToken },
            usable: true,
            stamp: 'bound',
            metadata:
              row.metadata === undefined
                ? { status: 'absent' }
                : {
                    status: 'present',
                    metadata: structuredClone(row.metadata),
                  },
            quota: { status: 'absent' },
          }),
        ),
      }
    },
    refresh(ref) {
      return refreshImpl(ref)
    },
    async recordAccessVerdict(ref, verdict) {
      const row = locate('recordAccessVerdict', ref)
      writes.push({ operation: 'recordAccessVerdict', ref, detail: verdict })
      if (verdict.kind !== 'cleared') row.enabled = false
      return { ref }
    },
    async replaceCredential(expected, input) {
      const row = locate('replaceCredential', expected)
      writes.push({
        operation: 'replaceCredential',
        ref: expected,
        detail: input,
      })
      row.credentialEpoch += 1
      row.refreshToken = input.refreshToken
      delete row.identity
      return { ref: refOf(row) }
    },
  }

  const repository = new Proxy(implemented, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (value !== undefined) return value
      return () => {
        throw new Error(`unexpected repository call: ${String(key)}`)
      }
    },
  }) as AccountRepository

  return {
    repository,
    writes,
    rows: () => rows,
    /** Gives a row a new credential, as another process re-authenticating it would. */
    replaceOutOfBand(id: string, refreshToken: string) {
      const row = rows.find((candidate) => candidate.id === id)
      if (row === undefined) throw new Error(`no row ${id}`)
      row.credentialEpoch += 1
      row.refreshToken = refreshToken
    },
    remove(id: string) {
      rows = rows.filter((row) => row.id !== id)
    },
    reverse() {
      rows = [...rows].reverse()
    },
    onRefresh(impl: typeof refreshImpl) {
      refreshImpl = impl
    },
  }
}

const prompt = {
  selectAccount: mock(async () => undefined),
  confirmOpenVerificationUrl: mock(async () => false),
}

function probeAnswer(status: number, body: string) {
  const bearers: string[] = []
  const transport = mock(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      bearers.push(headers.Authorization ?? '')
      return new Response(body, { status })
    },
  )
  return { transport, bearers }
}

const threeRows = (): FakeRow[] => [
  {
    id: 'row-a',
    credentialEpoch: 1,
    refreshToken: 'token-a',
    enabled: true,
    metadata: { email: 'a@example.test', addedAt: 1, lastUsed: 1 },
  },
  {
    id: 'row-b',
    credentialEpoch: 3,
    identity: 'google-b',
    refreshToken: 'token-b',
    enabled: true,
    metadata: {
      email: 'b@example.test',
      managedProjectId: 'managed-b',
      addedAt: 1,
      lastUsed: 1,
    },
  },
  {
    id: 'row-c',
    credentialEpoch: 1,
    refreshToken: 'token-c',
    enabled: false,
    metadata: { email: 'c@example.test', addedAt: 1, lastUsed: 1 },
  },
]

describe('repository access service', () => {
  it('lists accounts with the refs they were read under and their blocks', async () => {
    const fake = createFakeRepository(threeRows())
    fake.rows()[2]!.metadata = {
      ...fake.rows()[2]!.metadata!,
      accountIneligible: true,
      accountIneligibleReason: 'No',
    }
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
    })

    const accounts = await service.listAccounts()
    expect(accounts.map((account) => account.ref)).toEqual([
      { id: 'row-a', credentialEpoch: 1 },
      { id: 'row-b', credentialEpoch: 3, identity: 'google-b' },
      { id: 'row-c', credentialEpoch: 1 },
    ])
    expect(accounts[1]).toMatchObject({
      index: 1,
      email: 'b@example.test',
      managedProjectId: 'managed-b',
      block: { kind: 'none' },
    })
    expect(accounts[2]?.block).toEqual({ kind: 'ineligible', reason: 'No' })
  })

  it('probes with the bearer refreshed for the captured ref and records the verdict on that ref', async () => {
    const fake = createFakeRepository(threeRows())
    const { transport, bearers } = probeAnswer(
      403,
      JSON.stringify({ error: { message: 'ACCOUNT_INELIGIBLE here' } }),
    )
    let clock = 500
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
      now: () => clock++,
      transport,
    })
    const [, accountB] = await service.listAccounts()

    const outcome = await service.verifyAccount(accountB!)
    expect(outcome).toMatchObject({
      status: 'probed',
      ref: { id: 'row-b', credentialEpoch: 3, identity: 'google-b' },
      result: { status: 'ineligible' },
      observedAt: 500,
    })
    expect(bearers).toEqual(['Bearer access-row-b-3'])
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body)) as {
      project: string
    }
    expect(body.project).toBe('managed-b')

    await expect(service.applyVerificationResult(outcome)).resolves.toEqual({
      status: 'applied',
      ref: accountB!.ref,
      declined: false,
    })
    expect(fake.writes).toEqual([
      {
        operation: 'recordAccessVerdict',
        ref: accountB!.ref,
        detail: {
          kind: 'ineligible',
          observedAt: 500,
          reason: 'ACCOUNT_INELIGIBLE here',
        },
      },
    ])
  })

  it('drops a verdict whose row was re-authenticated while the probe ran', async () => {
    const fake = createFakeRepository(threeRows())
    const { transport } = probeAnswer(
      403,
      JSON.stringify({ error: { message: 'validation_required' } }),
    )
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
      transport,
    })
    const [accountA] = await service.listAccounts()
    const outcome = await service.verifyAccount(accountA!)
    fake.replaceOutOfBand('row-a', 'token-a2')

    await expect(service.applyVerificationResult(outcome)).resolves.toEqual({
      status: 'stale',
      rowId: 'row-a',
    })
    expect(fake.writes).toEqual([])
    expect(fake.rows()[0]?.enabled).toBe(true)
  })

  it('acts on the captured row after the roster is reordered and an earlier row removed', async () => {
    const fake = createFakeRepository(threeRows())
    const refreshed: RowRef[] = []
    fake.onRefresh(async (ref) => {
      refreshed.push(ref)
      return {
        status: 'rotated',
        ref,
        accessToken: `access-${ref.id}`,
        expiresAt: 1,
      }
    })
    const { transport } = probeAnswer(200, '')
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
      transport,
    })
    const accounts = await service.listAccounts()
    fake.remove('row-a')
    fake.reverse()

    // The dialog's second entry still names row-b, now at another position.
    const outcome = await service.verifyAccount(accounts[1]!)
    expect(refreshed).toEqual([accounts[1]!.ref])
    await service.applyVerificationResult(outcome, { enableIfBlocked: true })
    expect(fake.writes.map((write) => write.ref.id)).toEqual(['row-b'])

    // The removed first entry is not redirected to whatever row sits there.
    const removed = await service.verifyAccount(accounts[0]!)
    expect(removed.status).toBe('not-probed')
    expect(refreshed).toHaveLength(1)
  })

  it('never probes without a bearer from a refused or contradicted refresh', async () => {
    const fake = createFakeRepository(threeRows())
    const { transport } = probeAnswer(200, '')
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
      transport,
    })
    const [accountA, accountB] = await service.listAccounts()

    fake.onRefresh(async (ref) => ({
      status: 'identity-contradicted',
      ref,
      expectedIdentity: 'google-b',
      returnedIdentity: 'google-x',
    }))
    const contradicted = await service.verifyAccount(accountB!)
    fake.onRefresh(async (ref) => ({ status: 'refused', ref, reason: 'torn' }))
    const refused = await service.verifyAccount(accountA!)
    fake.onRefresh(async (ref) => {
      throw refusal('refresh', 'attribution', ref.id)
    })
    const stale = await service.verifyAccount(accountA!)

    for (const outcome of [contradicted, refused, stale]) {
      expect(outcome.status).toBe('not-probed')
      await expect(service.applyVerificationResult(outcome)).resolves.toEqual({
        status: 'no-verdict',
      })
    }
    expect(transport).not.toHaveBeenCalled()
    expect(fake.writes).toEqual([])
  })

  it('re-authenticates exactly the captured row and keeps a disabled row disabled', async () => {
    const fake = createFakeRepository(threeRows())
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
      now: () => 900,
    })
    const accounts = await service.listAccounts()

    const result = await service.reauthorizeAccount(accounts[2]!.ref, {
      type: 'success',
      refresh: 'new-token-c|project-c',
      access: 'ignored-access',
      expires: 1,
      email: 'c@example.test',
      projectId: 'project-c',
    })

    expect(result.ref).toEqual({ id: 'row-c', credentialEpoch: 2 })
    expect(fake.writes).toEqual([
      {
        operation: 'replaceCredential',
        ref: accounts[2]!.ref,
        detail: {
          refreshToken: 'new-token-c',
          metadata: {
            addedAt: 900,
            lastUsed: 900,
            email: 'c@example.test',
            projectId: 'project-c',
          },
          disabled: 'keep',
        },
      },
    ])
    expect(fake.rows()[2]?.enabled).toBe(false)
  })

  it('refuses a re-authentication whose row changed, with the exact dialog text and no write', async () => {
    const fake = createFakeRepository(threeRows())
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
    })
    const accounts = await service.listAccounts()
    const success = (email: string) => ({
      type: 'success' as const,
      refresh: 'replacement-token',
      access: 'x',
      expires: 1,
      email,
      projectId: '',
    })

    fake.replaceOutOfBand('row-a', 'token-a2')
    const changed = await service
      .reauthorizeAccount(accounts[0]!.ref, success('a@example.test'))
      .catch((error: unknown) => error)
    expect(changed).toBeInstanceOf(AccountChangedDuringReauthorizationError)
    expect((changed as Error).message).toBe(
      'Account changed during reauthorization. Reopen the account dialog.',
    )

    // Another Google account is not a re-authentication of row-b, even
    // though the ref still matches.
    await expect(
      service.reauthorizeAccount(accounts[1]!.ref, success('x@example.test')),
    ).rejects.toBeInstanceOf(AccountChangedDuringReauthorizationError)

    fake.remove('row-c')
    await expect(
      service.reauthorizeAccount(accounts[2]!.ref, success('c@example.test')),
    ).rejects.toBeInstanceOf(AccountChangedDuringReauthorizationError)

    expect(fake.writes).toEqual([])
  })

  it('maps a ref that goes stale between the read and the write to the same refusal', async () => {
    const fake = createFakeRepository(threeRows())
    const service = createRepositoryAccountAccessService({
      repository: fake.repository,
      openBrowser: mock(async () => false),
      prompt,
    })
    const [accountA] = await service.listAccounts()
    const realRead = fake.repository.read.bind(fake.repository)
    // The row changes after the service's own read, as a concurrent
    // re-authentication in another process would; the fenced write refuses.
    ;(fake.repository as { read: AccountRepository['read'] }).read =
      async () => {
        const read = await realRead()
        fake.replaceOutOfBand('row-a', 'token-a2')
        return read
      }

    await expect(
      service.reauthorizeAccount(accountA!.ref, {
        type: 'success',
        refresh: 'replacement-token',
        access: 'x',
        expires: 1,
        email: 'a@example.test',
        projectId: '',
      }),
    ).rejects.toMatchObject({
      name: 'AccountChangedDuringReauthorizationError',
      cause: expect.objectContaining({ name: 'AccountRepositoryError' }),
    })
    expect(fake.writes).toEqual([])
  })

  it('refuses to list accounts while the store is not ready instead of showing an empty pool', async () => {
    const service = createRepositoryAccountAccessService({
      repository: {
        read: async () => ({ status: 'pending-migration' }),
      } as unknown as AccountRepository,
      openBrowser: mock(async () => false),
      prompt,
    })
    await expect(service.listAccounts()).rejects.toBeInstanceOf(
      AccountStoreUnavailableError,
    )
  })
})
