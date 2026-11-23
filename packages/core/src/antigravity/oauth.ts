import { createHash, randomBytes } from 'node:crypto'
import { fetchWithAgyCliTransport } from '../agy-transport.ts'
import { calculateTokenExpiry } from '../auth.ts'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
} from '../constants.ts'
import { fetchWithActiveTimeout } from '../fetch-timeout.ts'
import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityHarnessUserAgent,
  buildAntigravityLoadCodeAssistMetadata,
} from '../fingerprint.ts'
import { createLogger } from '../logger.ts'

const log = createLogger('oauth')

interface PkcePair {
  challenge: string
  verifier: string
}

function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

interface AntigravityAuthState {
  verifier: string
  projectId: string
}

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
  url: string
  verifier: string
  projectId: string
}

interface AntigravityTokenExchangeSuccess {
  type: 'success'
  refresh: string
  access: string
  expires: number
  email?: string
  label?: string
  projectId: string
}

interface AntigravityTokenExchangeFailure {
  type: 'failed'
  error: string
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailure

export interface AntigravityRefreshResult {
  access: string
  refresh: string
  expires: number
}

/**
 * Refresh an Antigravity OAuth access token using a bare refresh token.
 * Harness-agnostic: performs only the token POST and returns the new
 * credentials. Persistence/caching is the caller's responsibility.
 */
export async function refreshAntigravityToken(
  refreshToken: string,
): Promise<AntigravityRefreshResult> {
  const startTime = Date.now()
  const response = await fetchWithActiveTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `Antigravity token refresh failed (${response.status} ${response.statusText})${errorText ? ` - ${errorText}` : ''}`,
    )
  }

  const payload = (await response.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
    expires: calculateTokenExpiry(startTime, payload.expires_in),
  }
}

interface AntigravityTokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
}

interface AntigravityUserInfo {
  email?: string
  name?: string
}

/**
 * Encode an object into a URL-safe base64 string.
 */
function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode an OAuth state parameter back into its structured representation.
 */
function decodeState(state: string): AntigravityAuthState {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )
  const json = Buffer.from(padded, 'base64').toString('utf8')
  const parsed = JSON.parse(json)
  if (typeof parsed.verifier !== 'string') {
    throw new Error('Missing PKCE verifier in state')
  }
  return {
    verifier: parsed.verifier,
    projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
  }
}

/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export async function authorizeAntigravity(
  projectId = '',
): Promise<AntigravityAuthorization> {
  const pkce = generatePkcePair()

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI)
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set(
    'state',
    encodeState({ verifier: pkce.verifier, projectId: projectId || '' }),
  )
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId: projectId || '',
  }
}

type OAuthCallback = { code: string; state: string } | { error: string }

/** Give each authorization one callback claim, shared by browser and paste flows. */
export function createOAuthCallbackValidator(authorizationUrl: string) {
  const state = new URL(authorizationUrl).searchParams.get('state')
  const redirect = new URL(ANTIGRAVITY_REDIRECT_URI)
  let closed = false

  return {
    state,
    claim(input: string | URL): OAuthCallback {
      if (closed || !state)
        return { error: 'OAuth sign-in is no longer pending' }
      const value = typeof input === 'string' ? input.trim() : input.href
      const url = URL.canParse(value) ? new URL(value) : null
      let code: string
      if (url) {
        if (
          url.origin !== redirect.origin ||
          url.pathname !== redirect.pathname ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.has('error')
        ) {
          return { error: 'Invalid OAuth redirect URL' }
        }
        const states = url.searchParams.getAll('state')
        if (states.length !== 1 || states[0] !== state) {
          return { error: 'OAuth state mismatch' }
        }
        const codes = url.searchParams.getAll('code')
        if (codes.length !== 1 || !codes[0]) {
          return { error: 'Missing authorization code' }
        }
        code = codes[0]
      } else {
        // Do not treat a broken or relative redirect as a bare code.
        if (!value || value.startsWith('//') || /[\s:?#&\\]/.test(value)) {
          return { error: 'Invalid authorization code' }
        }
        code = value
      }
      // Claim synchronously, before an adapter can await the exchange.
      closed = true
      return { code, state }
    },
    close() {
      closed = true
    },
  }
}

export interface AntigravityExchangeOptions {
  readonly signal?: AbortSignal
  readonly admit?: () => Promise<void> | void
}

class ExchangeAdmissionError extends Error {}
const EXCHANGE_REFUSED = 'Antigravity sign-in is no longer authorized.'

async function admitExchange(
  options: AntigravityExchangeOptions,
): Promise<void> {
  options.signal?.throwIfAborted()
  try {
    await options.admit?.()
  } catch {
    throw new ExchangeAdmissionError(EXCHANGE_REFUSED)
  }
  options.signal?.throwIfAborted()
}

async function fetchProjectID(
  accessToken: string,
  options: AntigravityExchangeOptions,
): Promise<string> {
  const errors: string[] = []
  const loadHeaders = buildAntigravityHarnessBootstrapHeaders(accessToken)

  const loadEndpoints = Array.from(
    new Set<string>([
      ...ANTIGRAVITY_LOAD_ENDPOINTS,
      ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]),
  )

  for (const baseEndpoint of loadEndpoints) {
    await admitExchange(options)
    try {
      const url = `${baseEndpoint}/v1internal:loadCodeAssist`
      const response = await fetchWithAgyCliTransport(
        url,
        {
          method: 'POST',
          headers: loadHeaders,
          body: JSON.stringify({
            metadata: buildAntigravityLoadCodeAssistMetadata(),
          }),
        },
        { timeoutMs: 10000, signal: options.signal },
      )
      await admitExchange(options)

      if (!response.ok) {
        const message = await response.text().catch(() => '')
        await admitExchange(options)
        errors.push(
          `loadCodeAssist ${response.status} at ${baseEndpoint}${
            message ? `: ${message}` : ''
          }`,
        )
        continue
      }

      const data = await response.json()
      await admitExchange(options)
      if (
        typeof data.cloudaicompanionProject === 'string' &&
        data.cloudaicompanionProject
      ) {
        return data.cloudaicompanionProject
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject.id === 'string' &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id
      }

      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`)
    } catch (e) {
      // A discovery failure may fall back, but lost authority must stop OAuth.
      if (e instanceof ExchangeAdmissionError) throw e
      await admitExchange(options)
      errors.push(
        `loadCodeAssist error at ${baseEndpoint}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }

  if (errors.length) {
    log.warn('Failed to resolve Antigravity project via loadCodeAssist', {
      errors: errors.join('; '),
    })
  }
  return ''
}

/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export async function exchangeAntigravity(
  code: string,
  state: string,
  options: AntigravityExchangeOptions = {},
): Promise<AntigravityTokenExchangeResult> {
  try {
    const { verifier, projectId } = decodeState(state)

    await admitExchange(options)
    const startTime = Date.now()
    const tokenResponse = await fetchWithActiveTimeout(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': buildAntigravityHarnessUserAgent(),
        },
        body: new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: ANTIGRAVITY_REDIRECT_URI,
          code_verifier: verifier,
        }),
      },
    )
    await admitExchange(options)

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      await admitExchange(options)
      return { type: 'failed', error: errorText }
    }

    const tokenPayload =
      (await tokenResponse.json()) as AntigravityTokenResponse

    await admitExchange(options)
    const userInfoResponse = await fetchWithActiveTimeout(
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      {
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          'User-Agent': buildAntigravityHarnessUserAgent(),
        },
      },
    )
    await admitExchange(options)

    const userInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as AntigravityUserInfo)
      : {}
    await admitExchange(options)

    const refreshToken = tokenPayload.refresh_token
    if (!refreshToken) {
      return { type: 'failed', error: 'Missing refresh token in response' }
    }

    let effectiveProjectId = projectId
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(
        tokenPayload.access_token,
        options,
      )
      await admitExchange(options)
    }

    const storedRefresh = `${refreshToken}|${effectiveProjectId || ''}`

    return {
      type: 'success',
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: userInfo.email,
      label: userInfo.name?.trim() || undefined,
      projectId: effectiveProjectId || '',
    }
  } catch (error) {
    return {
      type: 'failed',
      error:
        error instanceof ExchangeAdmissionError || options.signal?.aborted
          ? EXCHANGE_REFUSED
          : error instanceof Error
            ? error.message
            : 'Unknown error',
    }
  }
}
