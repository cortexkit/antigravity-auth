import {
  type AccountTokenExchange,
  fetchWithActiveTimeout,
} from '@cortexkit/antigravity-auth-core'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '../constants'
import {
  calculateTokenExpiry,
  formatRefreshParts,
  parseRefreshParts,
} from './auth'
import { createLogger } from './logger'
import { invalidateProjectContextCache } from './project'
import type { OAuthAuthDetails, PluginClient, RefreshParts } from './types'

const log = createLogger('token')

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string
        status?: string
        message?: string
      }
  error_description?: string
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): {
  code?: string
  description?: string
} {
  if (!text) {
    return {}
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload
    if (!payload || typeof payload !== 'object') {
      return { description: text }
    }

    let code: string | undefined
    if (typeof payload.error === 'string') {
      code = payload.error
    } else if (payload.error && typeof payload.error === 'object') {
      code = payload.error.status ?? payload.error.code
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message }
      }
    }

    const description = payload.error_description
    if (description) {
      return { code, description }
    }

    if (
      payload.error &&
      typeof payload.error === 'object' &&
      payload.error.message
    ) {
      return { code, description: payload.error.message }
    }

    return { code }
  } catch {
    return { description: text }
  }
}

export class AntigravityTokenRefreshError extends Error {
  code?: string
  description?: string
  status: number
  statusText: string

  constructor(options: {
    message: string
    code?: string
    description?: string
    status: number
    statusText: string
  }) {
    super(options.message)
    this.name = 'AntigravityTokenRefreshError'
    this.code = options.code
    this.description = options.description
    this.status = options.status
    this.statusText = options.statusText
  }
}

/**
 * Whether `error`, or an error it was caused by, is Google's `invalid_grant`
 * answer: the refresh token is revoked and the account needs signing in
 * again. Repository refresh failures wrap the exchange's error as their
 * cause, so the chain is followed (a bounded number of steps).
 */
export function isInvalidGrantFailure(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (
      current instanceof AntigravityTokenRefreshError &&
      current.code === 'invalid_grant'
    ) {
      return true
    }
    current = current.cause
  }
  return false
}

/** The provider's answer to one refresh-token grant. */
interface RefreshGrant {
  accessToken: string
  /** The refresh token to keep: Google's rotated one, else the one sent. */
  refreshToken: string
  expiresAt: number
}

/**
 * Exchanges a bare refresh token for a new access token. Throws
 * `AntigravityTokenRefreshError` when Google answers with an error status;
 * on `invalid_grant` the project-context cache entry of that token is
 * dropped first, since the token can no longer reach its project. Any other
 * failure (network, malformed body) is thrown as it arrived.
 */
async function exchangeRefreshToken(
  refreshToken: string,
  now: () => number,
): Promise<RefreshGrant> {
  const startTime = now()
  const response = await fetchWithActiveTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    },
  )

  if (!response.ok) {
    let errorText: string | undefined
    try {
      errorText = await response.text()
    } catch {
      errorText = undefined
    }

    const { code, description } = parseOAuthErrorPayload(errorText)
    const details = [code, description ?? errorText].filter(Boolean).join(': ')
    const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`
    const message = details ? `${baseMessage} - ${details}` : baseMessage
    log.warn('Token refresh failed', {
      status: response.status,
      code,
      details,
    })

    if (code === 'invalid_grant') {
      log.warn(
        'Google revoked the stored refresh token - reauthentication required',
      )
      invalidateProjectContextCache(refreshToken)
    }

    throw new AntigravityTokenRefreshError({
      message,
      code,
      description: description ?? errorText,
      status: response.status,
      statusText: response.statusText,
    })
  }

  const payload = (await response.json()) as {
    access_token?: unknown
    expires_in?: unknown
    refresh_token?: unknown
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Antigravity token refresh returned no access token')
  }
  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === 'string' && payload.refresh_token
        ? payload.refresh_token
        : refreshToken,
    expiresAt: calculateTokenExpiry(startTime, payload.expires_in),
  }
}

/**
 * The token exchange an account repository refreshes rows with. It is
 * handed the row's bare refresh token and performs only the HTTP grant;
 * the repository commits the result under the row's credential fence, so
 * this function never writes anything. Project ids are not touched here: a
 * refresh keeps the row's stored projects.
 */
export function createAntigravityTokenExchange(
  options: { now?: () => number } = {},
): AccountTokenExchange {
  const now = options.now ?? (() => Date.now())
  return async ({ refreshToken }) => {
    const grant = await exchangeRefreshToken(refreshToken, now)
    return {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
    }
  }
}

/**
 * Refreshes a host OAuth credential (refresh token packed with its project
 * ids) and returns the updated credential without persisting it. Returns
 * `undefined` for a credential without a refresh token and for failures
 * other than an error answer from Google, which is thrown as
 * `AntigravityTokenRefreshError`.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  _client: PluginClient,
  _providerId: string,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh)
  if (!parts.refreshToken) {
    return undefined
  }

  try {
    const grant = await exchangeRefreshToken(parts.refreshToken, Date.now)
    const refreshedParts: RefreshParts = {
      refreshToken: grant.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    }

    // Project context cache is intentionally not invalidated on successful token
    // refresh: managedProjectId survives access-token rotation. Invalid grants
    // still invalidate (in the exchange) because the refresh key is no longer
    // usable.
    return {
      ...auth,
      access: grant.accessToken,
      expires: grant.expiresAt,
      refresh: formatRefreshParts(refreshedParts),
    }
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      throw error
    }
    log.error('Unexpected token refresh error', { error: String(error) })
    return undefined
  }
}
