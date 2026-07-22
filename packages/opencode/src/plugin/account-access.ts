import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_PROD,
} from '../constants'
import {
  buildAgyAgentRequestMetadata,
  createAgyRequestSessionContext,
  orderAgyRequestPayloadInPlace,
} from './agy-request-metadata'
import { fetchWithAgyCliTransport } from './agy-transport'
import { formatRefreshParts, parseRefreshParts } from './auth'
import { buildFingerprintHeaders, getSessionFingerprint } from './fingerprint'
import type { AccountMetadataV3, AccountStorageV4 } from './storage'
import { AntigravityTokenRefreshError, refreshAccessToken } from './token'
import type { PluginClient } from './types'

export type VerificationProbeResult =
  | { status: 'ok'; message: string }
  | { status: 'ineligible'; message: string }
  | {
      status: 'verification-required'
      message: string
      verifyUrl?: string
    }
  | { status: 'error'; message: string }

export interface AccountIdentity {
  refreshToken?: string
  email?: string
}

export interface AccountAccessStore {
  load(): Promise<AccountStorageV4 | null>
  mutate(
    mutate: (
      current: AccountStorageV4,
    ) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>,
  ): Promise<AccountStorageV4>
  clear(): Promise<void>
  persistAccountPool(
    results: Array<
      Extract<AntigravityTokenExchangeResult, { type: 'success' }>
    >,
    replaceAll: boolean,
  ): Promise<void>
}

export interface AccountAccessPrompt {
  selectAccount(
    accounts: Array<{ email?: string; index: number }>,
  ): Promise<number | undefined>
  confirmOpenVerificationUrl(): Promise<boolean>
}

export interface AccountAccessService {
  loadAccounts(): Promise<AccountStorageV4 | null>
  mutateAccounts(
    mutate: (
      current: AccountStorageV4,
    ) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>,
  ): Promise<AccountStorageV4>
  clearAccounts(): Promise<void>
  persistAccountPool(
    results: Array<
      Extract<AntigravityTokenExchangeResult, { type: 'success' }>
    >,
    replaceAll: boolean,
  ): Promise<void>
  verifyAccount(account: {
    refreshToken: string
    email?: string
    projectId?: string
    managedProjectId?: string
  }): Promise<VerificationProbeResult>
  applyVerificationResult(
    identity: AccountIdentity,
    result: VerificationProbeResult,
  ): Promise<void>
  clearAccessBlocks(
    identity: AccountIdentity,
    enableIfBlocked?: boolean,
  ): Promise<{ changed: boolean; wasAccessBlocked: boolean }>
  selectAccount(
    accounts: Array<{ email?: string; index: number }>,
  ): Promise<number | undefined>
  openVerificationUrl(url: string): Promise<boolean>
}

interface AccountAccessDependencies {
  refreshAccessToken: typeof refreshAccessToken
  transport: typeof fetchWithAgyCliTransport
}

interface CreateAccountAccessServiceOptions {
  client: PluginClient
  providerId: string
  store: AccountAccessStore
  openBrowser(url: string): Promise<boolean>
  prompt: AccountAccessPrompt
  dependencies?: Partial<AccountAccessDependencies>
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

export function extractAccountAccessErrorDetails(bodyText: string): {
  validationRequired: boolean
  accountIneligible: boolean
  message?: string
  verifyUrl?: string
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

  return {
    validationRequired,
    accountIneligible,
    message,
    verifyUrl: selectBestVerificationUrl([...verificationUrls]),
  }
}

export function buildAccountAccessProbeRequest(
  projectId: string,
): Record<string, unknown> {
  const wireModel = 'gemini-3.5-flash-low'
  const request: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 1, temperature: 0 },
  }
  const requestMetadata = buildAgyAgentRequestMetadata(
    createAgyRequestSessionContext(''),
    request,
    wireModel,
  )
  request.labels = requestMetadata.labels
  request.sessionId = requestMetadata.sessionId
  orderAgyRequestPayloadInPlace(request)

  return {
    project: projectId,
    requestId: requestMetadata.requestId,
    request,
    model: wireModel,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}

export async function interpretAccountAccessProbeResponse(
  response: Response,
): Promise<VerificationProbeResult> {
  if (response.ok) {
    await response.body?.cancel().catch(() => {})
    return { status: 'ok', message: 'Account verification check passed.' }
  }

  let responseBody = ''
  try {
    responseBody = await response.text()
  } catch {}

  const extracted = extractAccountAccessErrorDetails(responseBody)
  if (response.status === 403 && extracted.accountIneligible) {
    return {
      status: 'ineligible',
      message:
        extracted.message ??
        'Google marked this account as ineligible for Antigravity.',
    }
  }
  if (response.status === 403 && extracted.validationRequired) {
    return {
      status: 'verification-required',
      message:
        extracted.message ?? 'Google requires additional account verification.',
      verifyUrl: extracted.verifyUrl,
    }
  }

  return {
    status: 'error',
    message:
      extracted.message ??
      `Request failed (${response.status} ${response.statusText}).`,
  }
}

type VerificationStoredAccount = AccountMetadataV3

export function markStoredAccountVerificationRequired(
  account: VerificationStoredAccount,
  reason: string,
  verifyUrl?: string,
): boolean {
  let changed = false
  const wasVerificationRequired = account.verificationRequired === true
  const timestamp = Date.now()

  if (!wasVerificationRequired) {
    account.verificationRequired = true
    changed = true
  }
  if (
    !wasVerificationRequired ||
    account.verificationRequiredAt === undefined
  ) {
    account.verificationRequiredAt = timestamp
    changed = true
  }
  if (
    account.accountIneligible === true ||
    account.accountIneligibleAt !== undefined ||
    account.accountIneligibleReason !== undefined
  ) {
    account.accountIneligible = false
    account.accountIneligibleAt = undefined
    account.accountIneligibleReason = undefined
    account.eligibilityStateUpdatedAt = timestamp
    changed = true
  }

  if (account.accountIneligible === undefined) {
    account.accountIneligible = false
    changed = true
  }

  const normalizedReason = reason.trim()
  if (account.verificationRequiredReason !== normalizedReason) {
    account.verificationRequiredReason = normalizedReason
    changed = true
  }

  const normalizedUrl = verifyUrl?.trim()
  if (normalizedUrl && account.verificationUrl !== normalizedUrl) {
    account.verificationUrl = normalizedUrl
    changed = true
  }
  if (account.enabled !== false) {
    account.enabled = false
    changed = true
  }
  return changed
}

export function markStoredAccountIneligible(
  account: VerificationStoredAccount,
  reason: string,
): boolean {
  const timestamp = Date.now()
  const normalizedReason =
    reason.trim() || 'Google marked this account as ineligible.'
  const changed =
    account.accountIneligible !== true ||
    account.accountIneligibleReason !== normalizedReason ||
    account.verificationRequired === true ||
    account.verificationRequiredAt !== undefined ||
    account.verificationRequiredReason !== undefined ||
    account.verificationUrl !== undefined ||
    account.enabled !== false

  account.accountIneligible = true
  account.accountIneligibleAt = timestamp
  account.accountIneligibleReason = normalizedReason
  account.eligibilityStateUpdatedAt = timestamp
  account.verificationRequired = false
  account.verificationRequiredAt = undefined
  account.verificationRequiredReason = undefined
  account.verificationUrl = undefined
  account.enabled = false
  return changed
}

export function clearStoredAccountAccessBlocks(
  account: VerificationStoredAccount,
  enableIfBlocked = false,
): { changed: boolean; wasAccessBlocked: boolean } {
  const wasVerificationRequired = account.verificationRequired === true
  const wasIneligible = account.accountIneligible === true
  const wasAccessBlocked = wasVerificationRequired || wasIneligible
  let changed = false

  if (account.verificationRequired !== false) {
    account.verificationRequired = false
    changed = true
  }
  if (account.verificationRequiredAt !== undefined) {
    account.verificationRequiredAt = undefined
    changed = true
  }
  if (account.verificationRequiredReason !== undefined) {
    account.verificationRequiredReason = undefined
    changed = true
  }
  if (account.verificationUrl !== undefined) {
    account.verificationUrl = undefined
    changed = true
  }
  if (account.accountIneligible !== false) {
    account.accountIneligible = false
    changed = true
  }
  if (account.accountIneligibleAt !== undefined) {
    account.accountIneligibleAt = undefined
    changed = true
  }
  if (account.accountIneligibleReason !== undefined) {
    account.accountIneligibleReason = undefined
    changed = true
  }
  if (wasIneligible || account.eligibilityStateUpdatedAt !== undefined) {
    account.eligibilityStateUpdatedAt = Date.now()
    changed = true
  }
  if (enableIfBlocked && wasAccessBlocked && account.enabled === false) {
    account.enabled = true
    changed = true
  }

  return { changed, wasAccessBlocked }
}

function findAccountIndex(
  storage: AccountStorageV4,
  identity: AccountIdentity,
): number {
  if (identity.refreshToken) {
    const tokenIndex = storage.accounts.findIndex(
      (account) => account.refreshToken === identity.refreshToken,
    )
    if (tokenIndex !== -1) return tokenIndex
  }
  if (identity.email) {
    return storage.accounts.findIndex(
      (account) => account.email === identity.email,
    )
  }
  return -1
}

export function createAccountAccessService({
  client,
  providerId,
  store,
  openBrowser,
  prompt,
  dependencies,
}: CreateAccountAccessServiceOptions): AccountAccessService {
  const refresh = dependencies?.refreshAccessToken ?? refreshAccessToken
  const transport = dependencies?.transport ?? fetchWithAgyCliTransport

  const verifyAccount: AccountAccessService['verifyAccount'] = async (
    account,
  ) => {
    const parsed = parseRefreshParts(account.refreshToken)
    if (!parsed.refreshToken) {
      return {
        status: 'error',
        message: 'Missing refresh token for selected account.',
      }
    }

    const auth = {
      type: 'oauth' as const,
      refresh: formatRefreshParts({
        refreshToken: parsed.refreshToken,
        projectId: parsed.projectId ?? account.projectId,
        managedProjectId: parsed.managedProjectId ?? account.managedProjectId,
      }),
      access: '',
      expires: 0,
    }

    let refreshedAuth: Awaited<ReturnType<typeof refresh>>
    try {
      refreshedAuth = await refresh(auth, client, providerId)
    } catch (error) {
      if (error instanceof AntigravityTokenRefreshError) {
        return { status: 'error', message: error.message }
      }
      return {
        status: 'error',
        message: `Token refresh failed: ${String(error)}`,
      }
    }

    if (!refreshedAuth?.access) {
      return {
        status: 'error',
        message: 'Could not refresh access token for this account.',
      }
    }

    const projectId =
      parsed.managedProjectId ??
      parsed.projectId ??
      account.managedProjectId ??
      account.projectId ??
      ANTIGRAVITY_DEFAULT_PROJECT_ID
    const fingerprintHeaders = buildFingerprintHeaders(getSessionFingerprint())
    const headers: Record<string, string> = {
      'User-Agent':
        fingerprintHeaders['User-Agent'] ?? getSessionFingerprint().userAgent,
      Authorization: `Bearer ${refreshedAuth.access}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 20_000)

    try {
      const response = await transport(
        `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(buildAccountAccessProbeRequest(projectId)),
        },
        { signal: controller.signal },
      )
      return interpretAccountAccessProbeResponse(response)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { status: 'error', message: 'Verification check timed out.' }
      }
      return {
        status: 'error',
        message: `Verification check failed: ${String(error)}`,
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return {
    loadAccounts: () => store.load(),
    mutateAccounts: (mutate) => store.mutate(mutate),
    clearAccounts: () => store.clear(),
    persistAccountPool: (results, replaceAll) =>
      store.persistAccountPool(results, replaceAll),
    verifyAccount,
    async applyVerificationResult(identity, result) {
      if (
        result.status !== 'verification-required' &&
        result.status !== 'ineligible'
      ) {
        return
      }
      await store.mutate((current) => {
        const index = findAccountIndex(current, identity)
        const account = current.accounts[index]
        if (!account) return current

        if (result.status === 'verification-required') {
          markStoredAccountVerificationRequired(
            account,
            result.message,
            result.verifyUrl,
          )
        } else {
          markStoredAccountIneligible(account, result.message)
        }
        return current
      })
    },
    async clearAccessBlocks(identity, enableIfBlocked = false) {
      let outcome = { changed: false, wasAccessBlocked: false }
      await store.mutate((current) => {
        const index = findAccountIndex(current, identity)
        const account = current.accounts[index]
        if (!account) return current
        outcome = clearStoredAccountAccessBlocks(account, enableIfBlocked)
        return current
      })
      return outcome
    },
    selectAccount: (accounts) => prompt.selectAccount(accounts),
    async openVerificationUrl(url) {
      if (!(await prompt.confirmOpenVerificationUrl())) return false
      return openBrowser(url)
    },
  }
}

export async function promptAccountIndexForVerification(
  accounts: Array<{ email?: string; index: number }>,
): Promise<number | undefined> {
  const { createInterface } = await import('node:readline/promises')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    console.log('\nSelect an account to verify:')
    for (const account of accounts) {
      const label = account.email || `Account ${account.index + 1}`
      console.log(`  ${account.index + 1}. ${label}`)
    }
    console.log('')

    while (true) {
      const answer = (
        await rl.question('Account number (leave blank to cancel): ')
      ).trim()
      if (!answer) return undefined

      const parsedIndex = Number(answer)
      if (!Number.isInteger(parsedIndex)) {
        console.log('Please enter a valid account number.')
        continue
      }
      const normalizedIndex = parsedIndex - 1
      const selected = accounts.find(
        (account) => account.index === normalizedIndex,
      )
      if (!selected) {
        console.log('Please enter a number from the list above.')
        continue
      }
      return selected.index
    }
  } finally {
    rl.close()
  }
}

export async function promptOpenVerificationUrl(): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (
      await rl.question('Open verification URL in your browser now? [Y/n]: ')
    )
      .trim()
      .toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
