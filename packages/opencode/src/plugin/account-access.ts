import {
  type AccountRepository,
  AccountRepositoryError,
  type AccountRow,
  type RowRef,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'
import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_PROD,
} from '../constants'
import {
  type AccountAccessBlock,
  accessBlockOf,
  accessVerdictFromProbe,
  clearLegacyAccessBlocks,
  markLegacyIneligible,
  markLegacyVerificationRequired,
  type VerificationProbeResult,
} from './account-blocks'
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

export type { VerificationProbeResult }

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
  return markLegacyVerificationRequired(account, reason, verifyUrl, Date.now())
}

export function markStoredAccountIneligible(
  account: VerificationStoredAccount,
  reason: string,
): boolean {
  return markLegacyIneligible(account, reason, Date.now())
}

export function clearStoredAccountAccessBlocks(
  account: VerificationStoredAccount,
  enableIfBlocked = false,
): { changed: boolean; wasAccessBlocked: boolean } {
  return clearLegacyAccessBlocks(account, enableIfBlocked, Date.now())
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

/**
 * Sends one minimal generation request with `accessToken` for `projectId`
 * and classifies the answer. Network failures and timeouts become `error`
 * results, never an access verdict.
 */
async function probeAccountAccess(
  accessToken: string,
  projectId: string,
  transport: typeof fetchWithAgyCliTransport,
): Promise<VerificationProbeResult> {
  const fingerprintHeaders = buildFingerprintHeaders(getSessionFingerprint())
  const headers: Record<string, string> = {
    'User-Agent':
      fingerprintHeaders['User-Agent'] ?? getSessionFingerprint().userAgent,
    Authorization: `Bearer ${accessToken}`,
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
    return probeAccountAccess(refreshedAuth.access, projectId, transport)
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

// ---------------------------------------------------------------------------
// Account-store access service
// ---------------------------------------------------------------------------

/** Exact text shown when a re-authentication lost its row. */
export const ACCOUNT_CHANGED_DURING_REAUTHORIZATION_MESSAGE =
  'Account changed during reauthorization. Reopen the account dialog.'

/**
 * Thrown when a re-authentication cannot land on the row it was started
 * for: the row was removed, re-added or given another credential since the
 * dialog captured it, or the browser signed in to a different account than
 * the row holds. Nothing is written.
 */
export class AccountChangedDuringReauthorizationError extends Error {
  readonly rowId: string

  constructor(rowId: string, options?: { cause?: unknown }) {
    super(ACCOUNT_CHANGED_DURING_REAUTHORIZATION_MESSAGE, options)
    this.name = 'AccountChangedDuringReauthorizationError'
    this.rowId = rowId
  }
}

/**
 * Thrown when the account store cannot list accounts (pending migration or
 * management operation, unreadable file). Nothing falls back to the pool
 * file or to an empty list.
 */
export class AccountStoreUnavailableError extends Error {
  readonly status: 'pending-migration' | 'management-pending' | 'error'

  constructor(status: AccountStoreUnavailableError['status'], detail: string) {
    super(`The account store is not available (${status}): ${detail}`)
    this.name = 'AccountStoreUnavailableError'
    this.status = status
  }
}

/**
 * One account as an access dialog shows it. `ref` is captured when the list
 * is read; every later action on the entry uses it, never the position, so
 * an entry whose row was reordered, removed or re-authenticated meanwhile
 * is refused rather than redirected to whatever row sits there now.
 */
export interface AccountAccessView {
  ref: RowRef
  /** Roster position at read time; presentation only. */
  index: number
  email?: string
  label?: string
  enabled: boolean
  block: AccountAccessBlock
  projectId?: string
  managedProjectId?: string
}

export type VerificationOutcome =
  | {
      /** The probe ran with a bearer refreshed for exactly `ref`. */
      status: 'probed'
      ref: RowRef
      result: VerificationProbeResult
      observedAt: number
    }
  | {
      /** No bearer was obtained; nothing about access was learnt. */
      status: 'not-probed'
      ref: RowRef
      result: Extract<VerificationProbeResult, { status: 'error' }>
    }

export type AccessVerdictOutcome =
  | { status: 'applied'; ref: RowRef; declined: boolean }
  /** The probe proved nothing about access, so nothing was written. */
  | { status: 'no-verdict' }
  /** The row no longer holds the probed credential; nothing was written. */
  | { status: 'stale'; rowId: string }

export interface RepositoryAccountAccessService {
  listAccounts(): Promise<AccountAccessView[]>
  verifyAccount(
    account: Pick<AccountAccessView, 'ref'>,
  ): Promise<VerificationOutcome>
  applyVerificationResult(
    outcome: VerificationOutcome,
    options?: { enableIfBlocked?: boolean },
  ): Promise<AccessVerdictOutcome>
  reauthorizeAccount(
    expected: RowRef,
    result: Extract<AntigravityTokenExchangeResult, { type: 'success' }>,
  ): Promise<{ ref: RowRef }>
  selectAccount(
    accounts: Array<{ email?: string; index: number }>,
  ): Promise<number | undefined>
  openVerificationUrl(url: string): Promise<boolean>
}

interface CreateRepositoryAccountAccessServiceOptions {
  repository: AccountRepository
  openBrowser(url: string): Promise<boolean>
  prompt: AccountAccessPrompt
  now?: () => number
  transport?: typeof fetchWithAgyCliTransport
}

function textOf(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function accessViewOf(row: AccountRow): AccountAccessView {
  const metadata =
    row.metadata.status === 'present' ? row.metadata.metadata : undefined
  const email = textOf(metadata?.email)
  const label = textOf(metadata?.label)
  const projectId = textOf(metadata?.projectId)
  const managedProjectId = textOf(metadata?.managedProjectId)
  return {
    ref: row.ref,
    index: row.index,
    enabled: row.enabled,
    block: accessBlockOf(metadata),
    ...(email !== undefined ? { email } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(managedProjectId !== undefined ? { managedProjectId } : {}),
  }
}

/** A repository refusal meaning the ref no longer names the row's credential. */
function isStaleRefFailure(error: unknown): error is AccountRepositoryError {
  return (
    error instanceof AccountRepositoryError &&
    (error.failure.kind === 'attribution' ||
      error.failure.kind === 'unknown-row')
  )
}

/**
 * The access service over the account repository. Every operation names its
 * row by the `RowRef` captured when the account list was read:
 * - verification refreshes the bearer through `AccountRepository.refresh`
 *   on that ref (the stored credential, fenced by the store), never with a
 *   token copied out of an earlier read;
 * - the verdict is recorded with `recordAccessVerdict` on the ref the
 *   refresh confirmed, timestamped when the answer arrived, so a late
 *   verdict cannot undo newer evidence and a verdict about a replaced or
 *   re-added credential is refused;
 * - re-authentication replaces the credential of exactly that ref
 *   (`replaceCredential`), keeping a user's disabled choice.
 */
export function createRepositoryAccountAccessService({
  repository,
  openBrowser,
  prompt,
  now = () => Date.now(),
  transport = fetchWithAgyCliTransport,
}: CreateRepositoryAccountAccessServiceOptions): RepositoryAccountAccessService {
  const readRows = async (): Promise<readonly AccountRow[]> => {
    const read = await repository.read()
    switch (read.status) {
      case 'ready':
        return read.rows
      case 'pending-migration':
        throw new AccountStoreUnavailableError(
          read.status,
          'run `antigravity-auth account-store migrate --offline`',
        )
      case 'management-pending':
        throw new AccountStoreUnavailableError(
          read.status,
          `an account ${read.management.kind} operation must be resumed first`,
        )
      case 'error':
        throw new AccountStoreUnavailableError(
          read.status,
          `${read.file}: ${read.reason}`,
        )
    }
  }

  return {
    async listAccounts() {
      return (await readRows()).map(accessViewOf)
    },

    async verifyAccount({ ref }) {
      const rows = await readRows()
      const row = rows.find((candidate) => sameRowRef(candidate.ref, ref))
      if (row === undefined) {
        return {
          status: 'not-probed',
          ref,
          result: {
            status: 'error',
            message:
              'This account changed since the list was opened. Reopen the account list.',
          },
        }
      }
      const view = accessViewOf(row)
      let outcome: Awaited<ReturnType<AccountRepository['refresh']>>
      try {
        outcome = await repository.refresh(ref)
      } catch (error) {
        const message = isStaleRefFailure(error)
          ? 'This account changed since the list was opened. Reopen the account list.'
          : error instanceof AntigravityTokenRefreshError
            ? error.message
            : `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`
        return {
          status: 'not-probed',
          ref,
          result: { status: 'error', message },
        }
      }
      if (outcome.status !== 'rotated') {
        // A refused or identity-contradicted refresh never yields a bearer.
        return {
          status: 'not-probed',
          ref,
          result: {
            status: 'error',
            message:
              outcome.status === 'refused'
                ? `Token refresh was refused: ${outcome.reason}`
                : 'Google answered for a different account; re-authenticate this account.',
          },
        }
      }
      const projectId =
        view.managedProjectId ??
        view.projectId ??
        ANTIGRAVITY_DEFAULT_PROJECT_ID
      const result = await probeAccountAccess(
        outcome.accessToken,
        projectId,
        transport,
      )
      return { status: 'probed', ref: outcome.ref, result, observedAt: now() }
    },

    async applyVerificationResult(outcome, options = {}) {
      if (outcome.status !== 'probed') return { status: 'no-verdict' }
      const verdict = accessVerdictFromProbe(
        outcome.result,
        outcome.observedAt,
        options.enableIfBlocked ?? false,
      )
      if (verdict === undefined) return { status: 'no-verdict' }
      try {
        const applied = await repository.recordAccessVerdict(
          outcome.ref,
          verdict,
        )
        return {
          status: 'applied',
          ref: applied.ref,
          declined: applied.declined === true,
        }
      } catch (error) {
        if (isStaleRefFailure(error)) {
          return { status: 'stale', rowId: outcome.ref.id }
        }
        throw error
      }
    },

    async reauthorizeAccount(expected, result) {
      const parts = parseRefreshParts(result.refresh)
      if (!parts.refreshToken) {
        throw new Error('The sign-in returned no refresh token')
      }
      const row = (await readRows()).find((candidate) =>
        sameRowRef(candidate.ref, expected),
      )
      if (row === undefined) {
        throw new AccountChangedDuringReauthorizationError(expected.id)
      }
      const stored =
        row.metadata.status === 'present' ? row.metadata.metadata : undefined
      const storedEmail = textOf(stored?.email)
      // A sign-in to a different Google account is not a re-authentication
      // of this row, whatever the row's position or token.
      if (
        storedEmail !== undefined &&
        result.email !== undefined &&
        result.email !== storedEmail
      ) {
        throw new AccountChangedDuringReauthorizationError(expected.id)
      }
      const at = now()
      try {
        return await repository.replaceCredential(expected, {
          refreshToken: parts.refreshToken,
          metadata: {
            addedAt: at,
            lastUsed: at,
            ...(result.email !== undefined ? { email: result.email } : {}),
            ...(result.label !== undefined ? { label: result.label } : {}),
            ...(parts.projectId !== undefined
              ? { projectId: parts.projectId }
              : {}),
            ...(parts.managedProjectId !== undefined
              ? { managedProjectId: parts.managedProjectId }
              : {}),
          },
          // OpenCode 1.x keeps a disabled account disabled.
          disabled: 'keep',
        })
      } catch (error) {
        if (isStaleRefFailure(error)) {
          throw new AccountChangedDuringReauthorizationError(expected.id, {
            cause: error,
          })
        }
        throw error
      }
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
