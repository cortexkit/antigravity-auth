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

  it('returns a friendly error when the session has no pending OAuth flow', async () => {
    const service = createAccountCommandOAuthService({
      authorize: async () => ({
        url: 'https://accounts.google.test/authorize?state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback',
        verifier: 'pkce-verifier',
        projectId: '',
      }),
      exchange: mock(async () => ({
        type: 'failed' as const,
        error: 'unused',
      })),
      persist: mock(async () => {}),
      listAccounts: mock(async () => initialRows),
    })

    const result = await service.finish('missing-session', 'callback-code')

    expect(result).toEqual({
      text: 'OAuth session expired. Please start again.',
      accounts: initialRows,
    })
  })
})
