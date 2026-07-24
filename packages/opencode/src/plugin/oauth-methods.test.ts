import { describe, expect, it, mock } from 'bun:test'
import type { AuthOAuthResult } from '@opencode-ai/plugin'
import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import type { AccountAccessService } from './account-access'
import { DEFAULT_CONFIG } from './config'
import type { PluginLifecycle } from './lifecycle'
import { createOAuthMethods, parseOAuthCallbackInput } from './oauth-methods'
import type { OAuthListener } from './server'
import type { AccountStorageV4 } from './storage'
import { AccountStorageUnreadableError } from './storage'

const EXPECTED_STATE = 'expected-state'
const AUTHORIZATION_URL = `https://accounts.google.com/o/oauth2/v2/auth?state=${EXPECTED_STATE}`

function success(
  refreshToken: string,
  email: string,
): Extract<AntigravityTokenExchangeResult, { type: 'success' }> {
  return {
    type: 'success',
    refresh: `${refreshToken}|project`,
    access: `access-${refreshToken}`,
    expires: 123,
    email,
    projectId: 'project',
  }
}

function createLifecycle(): PluginLifecycle {
  return {
    getAccountManager: () => null,
    replaceAccountRuntime: mock(async () => {}),
    register: mock(() => {}),
    dispose: mock(async () => {}),
  }
}

function createAccountAccess(initial: AccountStorageV4 | null = null): {
  service: AccountAccessService
  persistCalls: Array<{
    replaceAll: boolean
    emails: Array<string | undefined>
  }>
} {
  let storage = initial ? structuredClone(initial) : null
  const persistCalls: Array<{
    replaceAll: boolean
    emails: Array<string | undefined>
  }> = []

  const service = {
    loadAccounts: mock(async () => (storage ? structuredClone(storage) : null)),
    clearAccounts: mock(async () => {
      storage = { version: 4, accounts: [], activeIndex: 0 }
    }),
    mutateAccounts: mock(async (mutate) => {
      const current = storage ?? { version: 4, accounts: [], activeIndex: 0 }
      storage = (await mutate(structuredClone(current))) ?? current
      return structuredClone(storage)
    }),
    persistAccountPool: mock(
      async (
        results: Array<
          Extract<AntigravityTokenExchangeResult, { type: 'success' }>
        >,
        replaceAll: boolean,
      ) => {
        persistCalls.push({
          replaceAll,
          emails: results.map((result) => result.email),
        })
        const existing = replaceAll ? [] : (storage?.accounts ?? [])
        storage = {
          version: 4,
          activeIndex: 0,
          accounts: [
            ...existing,
            ...results.map((result, index) => ({
              email: result.email,
              refreshToken: result.refresh.split('|')[0]!,
              projectId: result.projectId,
              addedAt: index + 1,
              lastUsed: index + 1,
            })),
          ],
        }
      },
    ),
    applyVerificationResult: mock(async () => undefined),
    clearAccessBlocks: mock(async () => ({
      changed: false,
      wasAccessBlocked: false,
    })),
    verifyAccount: mock(async () => ({
      status: 'ok' as const,
      message: 'ok',
    })),
    selectAccount: mock(async () => undefined),
    openVerificationUrl: mock(async () => false),
  } as unknown as AccountAccessService

  return { service, persistCalls }
}

describe('parseOAuthCallbackInput', () => {
  it('rejects a callback URL whose state does not match the authorization', () => {
    expect(
      parseOAuthCallbackInput(
        'http://localhost:51121/oauth-callback?code=code&state=wrong-state',
        EXPECTED_STATE,
      ),
    ).toEqual({ error: 'OAuth state mismatch' })
  })
})

describe('createOAuthMethods', () => {
  it('persists each CLI account and replaces storage only for the first fresh account', async () => {
    const { service, persistCalls } = createAccountAccess()
    const callbackInputs = ['code-a', 'code-b']
    const addAnother = [true, false]
    const methods = createOAuthMethods({
      client: {
        tui: { showToast: mock(async () => {}) },
      } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async (code: string) =>
          code === 'code-a'
            ? success('refresh-a', 'a@example.com')
            : success('refresh-b', 'b@example.com'),
        ),
        promptProjectId: mock(async () => ''),
        promptCallback: mock(async () => callbackInputs.shift() ?? ''),
        promptAddAnotherAccount: mock(async () => addAnother.shift() ?? false),
        openBrowser: mock(async () => false),
        shouldSkipLocalServer: () => true,
        isHeadless: () => false,
      },
    })

    const result = await methods[0]?.authorize?.({ noBrowser: 'true' })
    const oauthResult = result as
      | Extract<AuthOAuthResult, { method: 'code' }>
      | undefined

    expect(await oauthResult?.callback('')).toMatchObject({
      type: 'success',
      email: 'a@example.com',
    })
    expect(persistCalls).toEqual([
      { replaceAll: true, emails: ['a@example.com'] },
      { replaceAll: false, emails: ['b@example.com'] },
    ])
  })

  it('adds a TUI-authenticated account without replacing existing storage', async () => {
    const { service, persistCalls } = createAccountAccess({
      version: 4,
      activeIndex: 0,
      accounts: [
        {
          email: 'existing@example.com',
          refreshToken: 'existing-refresh',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
    })
    const methods = createOAuthMethods({
      client: { tui: { showToast: mock(async () => {}) } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    expect(result).toMatchObject({ type: 'success' })
    expect(persistCalls).toEqual([
      { replaceAll: false, emails: ['new@example.com'] },
    ])
  })

  it('closes the local listener after callback success and state failure', async () => {
    for (const state of [EXPECTED_STATE, 'wrong-state']) {
      const close = mock(async () => {})
      const listener: OAuthListener = {
        waitForCallback: mock(
          async () =>
            new URL(
              `http://localhost:51121/oauth-callback?code=code&state=${state}`,
            ),
        ),
        close,
      }
      const { service } = createAccountAccess()
      const methods = createOAuthMethods({
        client: { tui: { showToast: mock(async () => {}) } } as never,
        providerId: 'google',
        config: DEFAULT_CONFIG,
        lifecycle: createLifecycle(),
        accountAccess: service,
        dependencies: {
          authorize: mock(async () => ({
            url: AUTHORIZATION_URL,
            verifier: 'verifier',
            projectId: '',
          })),
          exchange: mock(async () => success('new-refresh', 'new@example.com')),
          startListener: mock(async () => listener),
          openBrowser: mock(async () => true),
          isHeadless: () => false,
          shouldSkipLocalServer: () => false,
        },
      })

      const authorization = await methods[0]?.authorize?.()
      const result = await (
        authorization as
          | Extract<AuthOAuthResult, { method: 'auto' }>
          | undefined
      )?.callback()

      expect(close).toHaveBeenCalledTimes(1)
      expect(result?.type).toBe(state === EXPECTED_STATE ? 'success' : 'failed')
    }
  })
})

describe('createOAuthMethods persistence failure handling', () => {
  function buildUnreadableError(): AccountStorageUnreadableError {
    return new AccountStorageUnreadableError(
      'Account storage at /tmp/x.json is unreadable (invalid-shape: accounts[1].refreshToken is missing or not a non-empty string). A backup was written to /tmp/x.json.corrupt-2026-07-23T12-00-00-000Z and the on-disk file has been left untouched.',
      {
        path: '/tmp/x.json',
        reason: 'invalid-shape',
        detail: 'accounts[1].refreshToken is missing or not a non-empty string',
        backupPath: '/tmp/x.json.corrupt-2026-07-23T12-00-00-000Z',
      },
    )
  }

  function findToastBody(
    showToast: ReturnType<typeof mock>,
    variant: 'success' | 'error',
  ): { message: string; variant: string } | undefined {
    for (const call of showToast.mock.calls) {
      const body = (
        call[0] as { body?: { message?: string; variant?: string } } | undefined
      )?.body
      if (body?.variant === variant) {
        return body as { message: string; variant: string }
      }
    }
    return undefined
  }

  it('returns a failed result (not a success toast) when TUI-code callback persistence throws AccountStorageUnreadableError', async () => {
    const unreadable = buildUnreadableError()
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      unreadable,
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    // A failed persistence MUST surface as a `failed` result — never a
    // `success` toast with nothing saved to disk. The original maintainer
    // bug had the callback swallow the throw and return `type: 'success'`.
    expect(result?.type).toBe('failed')
    expect(findToastBody(showToast, 'success')).toBeUndefined()
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toContain('unreadable')
    expect(errorToast?.message).toContain('/tmp/x.json')
    expect(errorToast?.message).toContain(
      '/tmp/x.json.corrupt-2026-07-23T12-00-00-000Z',
    )
  })

  it('returns a failed result when TUI-listener callback persistence throws AccountStorageUnreadableError', async () => {
    const unreadable = buildUnreadableError()
    const close = mock(async () => {})
    const listener: OAuthListener = {
      waitForCallback: mock(
        async () =>
          new URL(
            `http://localhost:51121/oauth-callback?code=code&state=${EXPECTED_STATE}`,
          ),
      ),
      close,
    }
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      unreadable,
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        startListener: mock(async () => listener),
        openBrowser: mock(async () => true),
        isHeadless: () => false,
        shouldSkipLocalServer: () => false,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'auto' }> | undefined
    )?.callback()

    expect(result?.type).toBe('failed')
    expect(findToastBody(showToast, 'success')).toBeUndefined()
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast?.message).toContain('unreadable')
    expect(errorToast?.message).toContain('/tmp/x.json')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns a failed result when persistence throws a generic lock-contention error', async () => {
    const { service } = createAccountAccess()
    ;(service.persistAccountPool as ReturnType<typeof mock>).mockRejectedValue(
      new Error('lock contention: another writer holds the file lock'),
    )
    const showToast = mock(async () => {})
    const methods = createOAuthMethods({
      client: { tui: { showToast } } as never,
      providerId: 'google',
      config: DEFAULT_CONFIG,
      lifecycle: createLifecycle(),
      accountAccess: service,
      dependencies: {
        authorize: mock(async () => ({
          url: AUTHORIZATION_URL,
          verifier: 'verifier',
          projectId: '',
        })),
        exchange: mock(async () => success('new-refresh', 'new@example.com')),
        isHeadless: () => true,
        shouldSkipLocalServer: () => true,
      },
    })

    const authorization = await methods[0]?.authorize?.()
    const result = await (
      authorization as Extract<AuthOAuthResult, { method: 'code' }> | undefined
    )?.callback('code')

    expect(result?.type).toBe('failed')
    const errorToast = findToastBody(showToast, 'error')
    expect(errorToast?.message).toContain('lock contention')
  })
})
