import { describe, expect, it, mock } from 'bun:test'
import { createAccountCommandOAuthService } from './account-command-oauth'

const initialRows = [
  {
    id: 'acct-0',
    index: 0,
    label: 'Primary account',
    enabled: true,
    current: true,
    quota: [],
  },
]

describe('createAccountCommandOAuthService', () => {
  it('returns an OAuth URL and stores pending state for the session', async () => {
    const authorize = mock(async () => ({
      url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
      verifier: 'pkce-verifier',
      projectId: '',
    }))
    const exchange = mock(async () => ({
      type: 'failed' as const,
      error: 'unused',
    }))
    const service = createAccountCommandOAuthService({
      authorize,
      exchange,
      persist: mock(async () => {}),
      listAccounts: mock(async () => initialRows),
    })

    const started = await service.start('session-1')
    await service.finish('session-1', 'callback-code')

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(started.url).toContain('accounts.google.test')
    expect(started.accounts).toEqual(initialRows)
    expect(exchange).toHaveBeenCalledWith('callback-code', 'signed-state')
  })

  it('exchanges, persists, and returns updated label-only account rows', async () => {
    const persisted = mock(async () => {})
    const updatedRows = [
      ...initialRows,
      {
        id: 'acct-1',
        index: 1,
        label: 'Work account',
        enabled: true,
        current: false,
        quota: [],
      },
    ]
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => ({
        type: 'success' as const,
        refresh: 'refresh-token|project',
        access: 'access-token',
        expires: 123,
        email: 'private@example.test',
        label: 'OAuth display name',
        projectId: 'project',
      })),
      persist: persisted,
      listAccounts: mock(async () => updatedRows),
    })

    await service.start('session-1')
    const finished = await service.finish(
      'session-1',
      'callback-code',
      'Work account',
    )

    expect(persisted).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Work account' }),
    )
    expect(finished).toEqual({
      text: 'OAuth account added.',
      accounts: updatedRows,
    })
  })

  it('invokes onAfterPersist with the exchanged success result so the live runtime can reload', async () => {
    const persisted = mock(async () => {})
    const onAfterPersist = mock(async () => {})
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => ({
        type: 'success' as const,
        refresh: 'refresh-token|project',
        access: 'access-token',
        expires: 123,
        email: 'private@example.test',
        label: 'OAuth display name',
        projectId: 'project',
      })),
      persist: persisted,
      listAccounts: mock(async () => initialRows),
      onAfterPersist,
    })

    await service.start('session-1')
    await service.finish('session-1', 'callback-code', 'Work account')

    expect(persisted).toHaveBeenCalledTimes(1)
    expect(onAfterPersist).toHaveBeenCalledTimes(1)
    // The reload hook gets the same success result persist saw, so the
    // runtime reload (auth-loader path) can re-read the freshly-persisted
    // account pool without re-running the OAuth exchange.
    expect(onAfterPersist).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: 'refresh-token|project' }),
    )
  })

  it('still reports success when onAfterPersist throws — the on-disk write already landed', async () => {
    const persisted = mock(async () => {})
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => ({
        type: 'success' as const,
        refresh: 'refresh-token|project',
        access: 'access-token',
        expires: 123,
        email: 'private@example.test',
        label: 'OAuth display name',
        projectId: 'project',
      })),
      persist: persisted,
      listAccounts: mock(async () => initialRows),
      onAfterPersist: mock(async () => {
        throw new Error('runtime reload blew up')
      }),
    })

    await service.start('session-1')
    const finished = await service.finish('session-1', 'callback-code')

    expect(persisted).toHaveBeenCalledTimes(1)
    expect(finished.text).toBe('OAuth account added.')
  })

  it('consumes the pending entry inside takePending so two concurrent finish() calls do not both exchange', async () => {
    // Build a service where the exchange hangs until we resolve it
    // manually. This guarantees the first finish() is still mid-flight
    // when the second one runs — the only way a regression that
    // peeks-then-finally-dels would surface.
    let releaseExchange: (() => void) | undefined
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    const exchange = mock(async () => {
      await exchangeGate
      return {
        type: 'success' as const,
        refresh: 'refresh-token|project',
        access: 'access-token',
        expires: 123,
        email: 'private@example.test',
        label: 'OAuth display name',
        projectId: 'project',
      }
    })
    const persist = mock(async () => {})
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange,
      persist,
      listAccounts: mock(async () => initialRows),
    })

    await service.start('session-1')

    // First finish() hangs inside exchange.
    const firstFinish = service.finish('session-1', 'callback-code-1')

    // Give the first finish() a microtask tick to enter exchange.
    await Promise.resolve()

    // Second finish() before the first resolves — the pending entry
    // should already be consumed, so the second call must observe
    // "no pending entry" and short-circuit.
    const secondFinish = await service.finish('session-1', 'callback-code-2')
    expect(secondFinish.text).toBe('OAuth session expired. Please start again.')

    // Release the first call.
    releaseExchange?.()
    const first = await firstFinish
    expect(first.text).toBe('OAuth account added.')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('reports a persistence-stage error distinctly from the exchange-stage error', async () => {
    // The previous implementation collapsed every caught error into
    // "OAuth exchange failed due to a network error". When persist
    // throws AFTER a successful exchange, the operator needs to know
    // the account was NOT stored — not that the OAuth itself failed.
    const persist = mock(async () => {
      throw new Error('disk full')
    })
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => ({
        type: 'success' as const,
        refresh: 'refresh-token|project',
        access: 'access-token',
        expires: 123,
        email: 'private@example.test',
        label: 'OAuth display name',
        projectId: 'project',
      })),
      persist,
      listAccounts: mock(async () => initialRows),
    })

    await service.start('session-1')
    const finished = await service.finish('session-1', 'callback-code')

    expect(persist).toHaveBeenCalledTimes(1)
    expect(finished.text).toBe(
      'OAuth account could not be saved to disk. Please try again.',
    )
  })

  it('reports an exchange-stage error (network) without attempting persist', async () => {
    // The exchange throws before persist runs. The dialog must surface
    // the network-stage message and skip the persistence call entirely.
    const persist = mock(async () => {})
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => {
        throw new Error('network down')
      }),
      persist,
      listAccounts: mock(async () => initialRows),
    })

    await service.start('session-1')
    const finished = await service.finish('session-1', 'callback-code')

    expect(finished.text).toBe(
      'OAuth exchange failed due to a network error. Please try again.',
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('returns a friendly error when the session has no pending OAuth flow', async () => {
    const exchange = mock(async () => ({
      type: 'failed' as const,
      error: 'unused',
    }))
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange,
      persist: mock(async () => {}),
      listAccounts: mock(async () => initialRows),
    })

    const result = await service.finish('missing-session', 'callback-code')

    expect(result).toEqual({
      text: 'OAuth session expired. Please start again.',
      accounts: initialRows,
    })
    // A finish() for a session that never started must not even touch
    // the exchange network path — there is no auth code to redeem.
    expect(exchange).not.toHaveBeenCalled()
  })
})
