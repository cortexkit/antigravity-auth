/**
 * In-process bridge for the packed refresh string.
 *
 * pi's provider framework extracts the bearer token via `oauth.getApiKey` and
 * passes only that access token to `streamSimple` (as `options.apiKey`). The
 * packed refresh (`refreshToken|projectId|managedProjectId`) that login/refresh
 * resolved is therefore not visible to the stream. We cache it here, keyed by
 * the access token, so the stream can recover the managed-project context and
 * avoid a redundant loadCodeAssist round-trip on every turn.
 */

const packedRefreshByAccessToken = new Map<string, string>()
// Single-account extension: keep the map tiny.
const MAX_ENTRIES = 4

export function rememberPackedRefresh(
  accessToken: string,
  packedRefresh: string,
): void {
  if (!accessToken) return
  if (packedRefreshByAccessToken.has(accessToken)) {
    packedRefreshByAccessToken.delete(accessToken)
  } else if (packedRefreshByAccessToken.size >= MAX_ENTRIES) {
    const oldest = packedRefreshByAccessToken.keys().next().value
    if (oldest !== undefined) packedRefreshByAccessToken.delete(oldest)
  }
  packedRefreshByAccessToken.set(accessToken, packedRefresh)
}

export function getPackedRefresh(accessToken: string): string | undefined {
  return packedRefreshByAccessToken.get(accessToken)
}
