import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test'
import { createHash } from 'node:crypto'
import type { AgyTransportOptions } from '../agy-transport.ts'

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
} from '../constants.ts'
import {
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAntigravityToken,
} from './oauth.ts'

// Project discovery, token requests and userinfo requests all use the same mocked fetch.
mock.module('../agy-transport.ts', () => ({
  fetchWithAgyCliTransport: (
    url: string,
    init?: RequestInit,
    options?: AgyTransportOptions,
  ) => fetch(url, { ...init, signal: options?.signal }),
}))

/**
 * Build a minimal token-exchange response body. Google issues access_token /
 * refresh_token / expires_in and OpenCode derives expires via Date.now() offset.
 */
function tokenResponseBody(
  overrides: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    skipRefresh?: boolean
  } = {},
): string {
  const body: Record<string, unknown> = {
    access_token: overrides.access_token ?? 'access-1',
    expires_in: overrides.expires_in ?? 3600,
  }
  if (!overrides.skipRefresh) {
    body.refresh_token = overrides.refresh_token ?? 'refresh-1'
  }
  return JSON.stringify(body)
}

function userInfoBody(
  email = 'user@example.com',
  name = 'Alice Example',
): string {
  return JSON.stringify({ email, name })
}

describe('Antigravity OAuth', () => {
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    mock.restore()
    jest.useRealTimers()
  })

  describe('authorizeAntigravity', () => {
    it('builds the Google authorization URL with PKCE + state + scopes + redirect', async () => {
      const result = await authorizeAntigravity('project-1')

      expect(result.projectId).toBe('project-1')
      expect(result.verifier).toBeTruthy()

      const url = new URL(result.url)
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(url.searchParams.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID)
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('redirect_uri')).toBe(
        ANTIGRAVITY_REDIRECT_URI,
      )
      expect(result.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(result.verifier).digest('base64url'),
      )
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('access_type')).toBe('offline')
      expect(url.searchParams.get('prompt')).toBe('consent')

      const state = url.searchParams.get('state')
      expect(state).toBeTruthy()
      if (!state) throw new Error('authorize URL is missing the state param')

      // State round-trips: state encodes the verifier + projectId so
      // exchangeAntigravity can recover them without a side channel.
      const padded = state
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(state.length + ((4 - (state.length % 4)) % 4), '=')
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      expect(decoded.verifier).toBe(result.verifier)
      expect(decoded.projectId).toBe('project-1')

      const requestedScopes = (url.searchParams.get('scope') ?? '').split(' ')
      expect(requestedScopes.sort()).toEqual(
        [
          'https://www.googleapis.com/auth/cloud-platform',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/cclog',
          'https://www.googleapis.com/auth/experimentsandconfigs',
        ].sort(),
      )
    })

    it('encodes an empty projectId when none is provided', async () => {
      const result = await authorizeAntigravity()
      const url = new URL(result.url)
      const state = url.searchParams.get('state')
      if (!state) throw new Error('authorize URL is missing the state param')
      const padded = state
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(state.length + ((4 - (state.length % 4)) % 4), '=')
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      expect(decoded.projectId).toBe('')
      expect(decoded.verifier).toBe(result.verifier)
    })
  })

  describe('exchangeAntigravity', () => {
    function queueFetchResponses(responses: Response[]): void {
      fetchSpy.mockImplementation(async () => {
        const next = responses.shift()
        if (!next) throw new Error('fetch called more times than queued')
        return next
      })
    }

    it('exchanges the auth code for tokens, fetches userinfo, and returns stored refresh', async () => {
      queueFetchResponses([
        new Response(tokenResponseBody({ expires_in: 1800 }), { status: 200 }),
        new Response(userInfoBody('alice@example.com'), { status: 200 }),
      ])

      const { url, verifier } = await authorizeAntigravity('project-1')
      const state = new URL(url).searchParams.get('state') ?? ''
      expect(verifier).toBeTruthy()

      const result = await exchangeAntigravity('auth-code', state)

      expect(result.type).toBe('success')
      if (result.type !== 'success') throw new Error('expected success')

      expect(result.refresh).toBe('refresh-1|project-1')
      expect(result.access).toBe('access-1')
      expect(result.email).toBe('alice@example.com')
      expect(result.label).toBe('Alice Example')
      expect(result.projectId).toBe('project-1')

      // Expires must be relative to the request wall clock, not 0 or +expires_in.
      const expectedExpires = Date.now() + 1800 * 1000
      expect(Math.abs(result.expires - expectedExpires)).toBeLessThan(5_000)

      // Token POST sent the right verifier + code; userinfo used Bearer auth.
      const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>
      expect(calls.length).toBe(2)
      const [tokenUrl, tokenInit] = calls[0]!
      const [userinfoUrl, userinfoInit] = calls[1]!
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token')
      const tokenBody = new URLSearchParams(tokenInit.body as string)
      expect(tokenBody.get('code')).toBe('auth-code')
      expect(tokenBody.get('code_verifier')).toBe(verifier)
      expect(tokenBody.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID)
      expect(tokenBody.get('redirect_uri')).toBe(ANTIGRAVITY_REDIRECT_URI)
      expect(userinfoUrl).toBe(
        'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      )
      const userinfoHeaders = userinfoInit.headers as Record<string, string>
      expect(userinfoHeaders.Authorization).toBe('Bearer access-1')
    })

    it('returns failed when the token exchange responds non-OK with the response body', async () => {
      queueFetchResponses([
        new Response('invalid_grant: bad code', { status: 400 }),
      ])

      const { url } = await authorizeAntigravity('')
      const state = new URL(url).searchParams.get('state') ?? ''
      const result = await exchangeAntigravity('bad-code', state)

      expect(result.type).toBe('failed')
      if (result.type !== 'failed') throw new Error('expected failure')
      expect(result.error).toBe('invalid_grant: bad code')
    })

    it('returns failed when refresh_token is missing from the token response', async () => {
      queueFetchResponses([
        new Response(tokenResponseBody({ skipRefresh: true }), { status: 200 }),
        new Response(userInfoBody('alice@example.com'), { status: 200 }),
      ])

      const { url } = await authorizeAntigravity('project-1')
      const state = new URL(url).searchParams.get('state') ?? ''
      const result = await exchangeAntigravity('auth-code', state)

      expect(result.type).toBe('failed')
      if (result.type !== 'failed') throw new Error('expected failure')
      expect(result.error).toBe('Missing refresh token in response')
    })

    it('returns failed when userinfo is non-OK but token exchange succeeded', async () => {
      queueFetchResponses([
        new Response(tokenResponseBody({ expires_in: 3600 }), { status: 200 }),
        new Response('forbidden', { status: 403 }),
      ])

      const { url } = await authorizeAntigravity('project-1')
      const state = new URL(url).searchParams.get('state') ?? ''
      const result = await exchangeAntigravity('auth-code', state)

      // Missing email is OK — failure must be success-without-email, not failure.
      expect(result.type).toBe('success')
      if (result.type !== 'success') throw new Error('expected success')
      expect(result.refresh).toBe('refresh-1|project-1')
      expect(result.email).toBeUndefined()
      expect(result.label).toBeUndefined()
    })

    it('uses empty projectId segment when no projectId is provided and discovery fails', async () => {
      // Only the token endpoint succeeds; every loadCodeAssist endpoint fails
      // so `fetchProjectID` returns ''.
      queueFetchResponses([
        new Response(tokenResponseBody({ expires_in: 3600 }), { status: 200 }),
        new Response(userInfoBody('bob@example.com'), { status: 200 }),
        // loadCodeAssist probes
        new Response('server error', { status: 503 }),
        new Response('server error', { status: 503 }),
        new Response('server error', { status: 503 }),
        new Response('server error', { status: 503 }),
      ])

      const { url } = await authorizeAntigravity('')
      const state = new URL(url).searchParams.get('state') ?? ''
      const result = await exchangeAntigravity('auth-code', state)

      expect(result.type).toBe('success')
      if (result.type !== 'success') throw new Error('expected success')
      expect(result.refresh).toBe('refresh-1|')
      expect(result.projectId).toBe('')
    })

    for (const stage of ['token', 'userinfo'] as const) {
      it(`refuses authority revoked while the ${stage} response is pending without a project call`, async () => {
        const entered = Promise.withResolvers<void>()
        const response = Promise.withResolvers<Response>()
        let calls = 0
        let allowed = true
        fetchSpy.mockImplementation(async () => {
          calls++
          if (calls === (stage === 'token' ? 1 : 2)) {
            entered.resolve()
            return response.promise
          }
          if (calls === 1) return new Response(tokenResponseBody())
          throw new Error('No later provider call is admitted')
        })
        const { url } = await authorizeAntigravity()
        const pending = exchangeAntigravity(
          'code',
          new URL(url).searchParams.get('state')!,
          {
            admit: async () => {
              if (!allowed) throw new Error('secret must not escape')
            },
          },
        )
        await entered.promise
        allowed = false
        response.resolve(
          new Response(
            stage === 'token' ? tokenResponseBody() : userInfoBody(),
          ),
        )
        expect(await pending).toEqual({
          type: 'failed',
          error: 'Antigravity sign-in is no longer authorized.',
        })
        expect(calls).toBe(stage === 'token' ? 1 : 2)
      })
    }

    for (const refusal of ['admit', 'abort'] as const) {
      it(`propagates ${refusal} from project discovery instead of succeeding with an empty project`, async () => {
        const controller = new AbortController()
        let calls = 0
        let refuse = false
        fetchSpy.mockImplementation(async () => {
          calls++
          if (calls === 1) return new Response(tokenResponseBody())
          if (calls === 2) return new Response(userInfoBody())
          if (calls === 3) {
            refuse = true
            if (refusal === 'abort')
              controller.abort(new Error('secret abort reason'))
            return new Response('transient error', { status: 503 })
          }
          throw new Error('Project fallback must not run after revocation')
        })
        const { url } = await authorizeAntigravity()
        const result = await exchangeAntigravity(
          'code',
          new URL(url).searchParams.get('state')!,
          {
            signal: controller.signal,
            admit: async () => {
              // Refuse admission once so project discovery cannot retry after suppressing the error.
              if (refuse && refusal === 'admit') {
                refuse = false
                throw new Error('secret admission detail')
              }
            },
          },
        )
        expect(result).toEqual({
          type: 'failed',
          error: 'Antigravity sign-in is no longer authorized.',
        })
        expect(calls).toBe(3)
      })
    }

    it('checks admission before each project fallback and aborts its physical fetch', async () => {
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const checked: number[] = []
      let calls = 0
      fetchSpy.mockImplementation(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          expect(checked.length).toBeGreaterThan(0)
          expect(checked.at(-1)).toBe(calls)
          calls++
          if (calls === 1) return new Response(tokenResponseBody())
          if (calls === 2) return new Response(userInfoBody())
          if (calls === 3) return new Response('transient', { status: 503 })
          const signal = init?.signal
          if (!signal) throw new Error('Missing physical request signal')
          entered.resolve()
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          })
        },
      )
      const { url } = await authorizeAntigravity()
      const pending = exchangeAntigravity(
        'code',
        new URL(url).searchParams.get('state')!,
        {
          signal: controller.signal,
          admit: async () => {
            checked.push(calls)
          },
        },
      )
      await entered.promise
      controller.abort()
      expect((await pending).type).toBe('failed')
      expect(calls).toBe(4)
    })
  })

  describe('refreshAntigravityToken', () => {
    it('preserves the old refresh token when Google omits a replacement', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
          { status: 200 },
        ),
      )

      const result = await refreshAntigravityToken('original-refresh')

      expect(result.access).toBe('new-access')
      expect(result.refresh).toBe('original-refresh')
      expect(
        Math.abs(result.expires - (Date.now() + 3600 * 1000)),
      ).toBeLessThan(5_000)

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = new URLSearchParams(init.body as string)
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('original-refresh')
      expect(body.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID)
    })

    it('uses the new refresh token when Google issues a replacement', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 3600,
            refresh_token: 'rotated-refresh',
          }),
          { status: 200 },
        ),
      )

      const result = await refreshAntigravityToken('original-refresh')

      expect(result.refresh).toBe('rotated-refresh')
    })

    it('throws a status-bearing error on non-OK responses', async () => {
      fetchSpy.mockResolvedValue(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          statusText: 'Bad Request',
        }),
      )

      await expect(refreshAntigravityToken('expired')).rejects.toThrow(
        /Antigravity token refresh failed \(400 Bad Request\)/,
      )
    })
  })
})
