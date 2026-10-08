import { beforeEach, describe, expect, it, mock } from 'bun:test'

import { ANTIGRAVITY_PROVIDER_ID } from '../constants'
import {
  AntigravityTokenRefreshError,
  createAntigravityTokenExchange,
  isInvalidGrantFailure,
  refreshAccessToken,
} from './token'
import type { OAuthAuthDetails, PluginClient } from './types'

const baseAuth: OAuthAuthDetails = {
  type: 'oauth',
  refresh: 'refresh-token|project-123',
  access: 'old-access',
  expires: Date.now() - 1000,
}

function createClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof mock> }
  }
}

describe('refreshAccessToken', () => {
  beforeEach(() => {
    mock.restore()
  })

  it('updates the caller when refresh token is unchanged', async () => {
    const client = createClient()
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await refreshAccessToken(
      baseAuth,
      client,
      ANTIGRAVITY_PROVIDER_ID,
    )

    expect(result?.access).toBe('new-access')
    expect(client.auth.set.mock.calls.length).toBe(0)
  })

  it('handles Google refresh token rotation', async () => {
    const client = createClient()
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'next-access',
          expires_in: 3600,
          refresh_token: 'rotated-token',
        }),
        { status: 200 },
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await refreshAccessToken(
      baseAuth,
      client,
      ANTIGRAVITY_PROVIDER_ID,
    )

    expect(result?.access).toBe('next-access')
    expect(result?.refresh).toContain('rotated-token')
    expect(client.auth.set.mock.calls.length).toBe(0)
  })

  it('throws a typed error on invalid_grant', async () => {
    const client = createClient()
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token revoked',
        }),
        { status: 400, statusText: 'Bad Request' },
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(
      refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID),
    ).rejects.toMatchObject({
      name: 'AntigravityTokenRefreshError',
      code: 'invalid_grant',
    })
  })
})

describe('createAntigravityTokenExchange', () => {
  beforeEach(() => {
    mock.restore()
  })

  it('sends the bare refresh token and keeps it when Google does not rotate it', async () => {
    const bodies: string[] = []
    global.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(
        JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const exchange = createAntigravityTokenExchange({ now: () => 1_000 })
    const result = await exchange({
      refreshToken: 'bare-token',
      row: {} as never,
    })

    expect(new URLSearchParams(bodies[0]).get('refresh_token')).toBe(
      'bare-token',
    )
    expect(result).toEqual({
      accessToken: 'fresh-access',
      refreshToken: 'bare-token',
      expiresAt: 1_000 + 3_600_000,
    })
  })

  it('returns the rotated refresh token Google issues', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'fresh-access',
            expires_in: 3600,
            refresh_token: 'rotated',
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch

    const result = await createAntigravityTokenExchange()({
      refreshToken: 'bare-token',
      row: {} as never,
    })
    expect(result.refreshToken).toBe('rotated')
  })

  it('throws instead of answering with a bearer when Google returns none', async () => {
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch

    await expect(
      createAntigravityTokenExchange()({
        refreshToken: 'bare-token',
        row: {} as never,
      }),
    ).rejects.toThrow('returned no access token')
  })

  it('throws invalid_grant so a wrapping repository failure still names it', async () => {
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          statusText: 'Bad Request',
        }),
    ) as unknown as typeof fetch

    const failure = await createAntigravityTokenExchange()({
      refreshToken: 'bare-token',
      row: {} as never,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AntigravityTokenRefreshError)
    const wrapped = new Error('store refresh failed', {
      cause: new Error('provider', { cause: failure }),
    })
    expect(isInvalidGrantFailure(wrapped)).toBe(true)
    expect(
      isInvalidGrantFailure(
        new AntigravityTokenRefreshError({
          message: 'x',
          code: 'invalid_request',
          status: 400,
          statusText: 'Bad Request',
        }),
      ),
    ).toBe(false)
    expect(isInvalidGrantFailure('invalid_grant')).toBe(false)
  })
})
