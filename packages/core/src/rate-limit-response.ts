/** Reads `retry-after-ms` / `retry-after` headers, in that order. */
export function retryAfterMsFromResponse(
  response: Response,
  defaultRetryMs: number = 60_000,
): number {
  const retryAfterMsHeader = response.headers.get('retry-after-ms')
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  const retryAfterHeader = response.headers.get('retry-after')
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000
    }
  }

  return defaultRetryMs
}

export interface RateLimitBodyInfo {
  retryDelayMs: number | null
  message?: string
  quotaResetTime?: string
  reason?: string
}

export function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== 'object') return { retryDelayMs: null }

  const error = (body as { error?: unknown }).error
  const message =
    error && typeof error === 'object'
      ? (error as { message?: string }).message
      : undefined

  const details =
    error && typeof error === 'object'
      ? (error as { details?: unknown[] }).details
      : undefined

  let reason: string | undefined
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const type = (detail as { '@type'?: string })['@type']
      if (typeof type === 'string' && type.includes('google.rpc.ErrorInfo')) {
        const detailReason = (detail as { reason?: string }).reason
        if (typeof detailReason === 'string') {
          reason = detailReason
          break
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const type = (detail as { '@type'?: string })['@type']
      if (typeof type === 'string' && type.includes('google.rpc.RetryInfo')) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay
        if (typeof retryDelay === 'string') {
          const retryDelayMs = parseDurationToMs(retryDelay)
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason }
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const metadata = (detail as { metadata?: Record<string, string> })
        .metadata
      if (metadata && typeof metadata === 'object') {
        const quotaResetDelay = metadata.quotaResetDelay
        const quotaResetTime = metadata.quotaResetTimeStamp
        if (typeof quotaResetDelay === 'string') {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay)
          if (quotaResetDelayMs !== null) {
            return {
              retryDelayMs: quotaResetDelayMs,
              message,
              quotaResetTime,
              reason,
            }
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i)
    const rawDuration = afterMatch?.[1]
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration)
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason }
      }
    }
  }

  return { retryDelayMs: null, message, reason }
}

function parseDurationToMs(duration: string): number | null {
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!)
    const unit = (simpleMatch[2] || 's').toLowerCase()
    switch (unit) {
      case 'h':
        return value * 3600 * 1000
      case 'm':
        return value * 60 * 1000
      case 's':
        return value * 1000
      case 'ms':
        return value
      default:
        return value * 1000
    }
  }

  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi
  let totalMs = 0
  let matchFound = false
  let match: RegExpExecArray | null = null

  while (true) {
    match = compoundRegex.exec(duration)
    if (match === null) break
    matchFound = true
    const value = parseFloat(match[1]!)
    const unit = match[2]?.toLowerCase()
    switch (unit) {
      case 'h':
        totalMs += value * 3600 * 1000
        break
      case 'm':
        totalMs += value * 60 * 1000
        break
      case 's':
        totalMs += value * 1000
        break
      case 'ms':
        totalMs += value
        break
    }
  }

  return matchFound ? totalMs : null
}
