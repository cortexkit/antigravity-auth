import { extractAntigravityError } from './retry-metadata.ts'

/** Provider prose is diagnostic, not evidence of suspension or a need to reauthorize. */
export function googleForbiddenRefusal(bodyText: string | undefined) {
  if (bodyText === undefined) return 'upstream_http' as const
  let requiresReauthorization = false
  for (const payload of [
    bodyText,
    ...bodyText.split('\n').flatMap((raw) => {
      const line = raw.trimStart()
      return line.startsWith('data:') ? [line.slice(5)] : []
    }),
  ]) {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    const details = extractAntigravityError(parsed)?.details
    if (!Array.isArray(details)) continue
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue
      const { '@type': type, reason } = detail as Record<string, unknown>
      if (
        type === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        reason === 'TOS_VIOLATION'
      )
        return 'account_suspended' as const
      if (
        typeof reason === 'string' &&
        /^(?:VALIDATION_REQUIRED|ACCOUNT_INELIGIBLE)$/i.test(reason)
      )
        requiresReauthorization = true
    }
  }
  return requiresReauthorization ? 'account_reauthorize' : 'upstream_http'
}

function decodeEscapedText(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
}

export function normalizeGoogleVerificationUrl(
  rawUrl: string,
): string | undefined {
  const normalized = decodeEscapedText(rawUrl).trim()
  if (!normalized) return undefined

  try {
    const parsed = new URL(normalized)
    if (parsed.hostname !== 'accounts.google.com') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

export function selectBestVerificationUrl(urls: string[]): string | undefined {
  const unique = Array.from(
    new Set(
      urls
        .map((url) => normalizeGoogleVerificationUrl(url))
        .filter(Boolean) as string[],
    ),
  )
  if (unique.length === 0) return undefined

  const score = (value: string): number => {
    let total = 0
    if (value.includes('plt=')) total += 4
    if (value.includes('/signin/continue')) total += 3
    if (value.includes('continue=')) total += 2
    if (value.includes('service=cloudcode')) total += 1
    return total
  }
  unique.sort((a, b) => score(b) - score(a))
  return unique[0]
}

function structuredVerificationUrl(bodyText: string): string | undefined {
  const urls = new Set<string>()
  const collect = (payload: string) => {
    try {
      // Parse before unescaping individual values so message text cannot turn
      // into a structured URL field.
      JSON.parse(payload, (key, value: unknown) => {
        if (
          typeof value === 'string' &&
          /^(?:validation_url|verify_url|verification_url|url)$/i.test(key) &&
          /^https:\/\//i.test(decodeEscapedText(value).trim())
        )
          urls.add(value)
        return value
      })
    } catch {
      // Plain text is not a source of vault action URLs.
    }
  }
  collect(bodyText)
  for (const rawLine of bodyText.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('data:')) collect(line.slice(5))
  }
  return selectBestVerificationUrl([...urls])
}

export function extractAccountAccessErrorDetails(bodyText: string): {
  validationRequired: boolean
  accountIneligible: boolean
  message?: string
  verifyUrl?: string
  structuredVerifyUrl?: string
} {
  const decodedBody = decodeEscapedText(bodyText)
  const lowerBody = decodedBody.toLowerCase()
  let validationRequired = lowerBody.includes('validation_required')
  const ineligiblePattern = /(^|[^a-z0-9_])account_ineligible([^a-z0-9_]|$)/i
  let accountIneligible = ineligiblePattern.test(decodedBody)
  let message: string | undefined
  const verificationUrls = new Set<string>()

  const collectUrlsFromText = (text: string): void => {
    for (const match of text.matchAll(
      /https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi,
    )) {
      if (match[0]) verificationUrls.add(match[0])
    }
  }

  collectUrlsFromText(decodedBody)

  const payloads: unknown[] = []
  const trimmed = decodedBody.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      payloads.push(JSON.parse(trimmed))
    } catch {}
  }

  for (const rawLine of decodedBody.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue

    const payloadText = line.slice(5).trim()
    if (!payloadText || payloadText === '[DONE]') continue

    try {
      payloads.push(JSON.parse(payloadText))
    } catch {
      collectUrlsFromText(payloadText)
    }
  }

  const visited = new Set<unknown>()
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      const normalizedValue = decodeEscapedText(value)
      const lowerValue = normalizedValue.toLowerCase()
      const lowerKey = key?.toLowerCase() ?? ''

      if (lowerValue.includes('validation_required')) {
        validationRequired = true
      }
      if (ineligiblePattern.test(normalizedValue)) {
        accountIneligible = true
      }
      if (
        !message &&
        (lowerKey.includes('message') ||
          lowerKey.includes('detail') ||
          lowerKey.includes('description'))
      ) {
        message = normalizedValue
      }
      if (
        lowerKey.includes('validation_url') ||
        lowerKey.includes('verify_url') ||
        lowerKey.includes('verification_url') ||
        lowerKey === 'url'
      ) {
        verificationUrls.add(normalizedValue)
      }
      collectUrlsFromText(normalizedValue)
      return
    }

    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)

    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }

    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      walk(childValue, childKey)
    }
  }

  for (const payload of payloads) walk(payload)

  if (!validationRequired) {
    validationRequired =
      lowerBody.includes('verification required') ||
      lowerBody.includes('verify your account') ||
      lowerBody.includes('account verification')
  }

  if (!message) {
    message = decodedBody
      .split('\n')
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith('data:') &&
          /(verify|validation|required|ineligible)/i.test(line),
      )
  }

  const structuredVerifyUrl = structuredVerificationUrl(bodyText)
  return {
    validationRequired,
    accountIneligible,
    message,
    verifyUrl: selectBestVerificationUrl([...verificationUrls]),
    ...(structuredVerifyUrl && { structuredVerifyUrl }),
  }
}
