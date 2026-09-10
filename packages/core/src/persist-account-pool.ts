/**
 * Account pool persistence for OAuth flows.
 *
 * Merges a batch of successful OAuth token-exchange results into the
 * persisted pool. All reads + writes happen inside the core
 * `mutateAccountStorage` callback so the mutator sees the freshest
 * state read while the lock is held — without it, a concurrent add
 * would race the read-modify-write and silently disappear.
 *
 * Three upsert keys are honored, in priority order:
 *  1. email — survives refresh-token rotation for the same Google account
 *  2. Google account ID — enriches a canonical login whose email was absent
 *  3. refresh token — handles the no-email case and out-of-band rotations
 *
 * Destructive (`replaceAll: true`) writes start from an empty v4 inside
 * the same locked callback so a stale merge cannot resurrect a removed
 * account.
 */

import { mutateAccountStorage } from './account-storage.ts'
import type { AccountMetadataV3, AccountStorageV4 } from './account-types.ts'
import type { AntigravityTokenExchangeResult } from './antigravity/oauth.ts'
import { parseRefreshParts } from './auth.ts'

type TokenSuccess = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

export interface ResolvedAccountIdentity {
  refreshToken: string
  email?: string
  accountId?: string
}

export class AccountIdentityAmbiguityError extends Error {
  override readonly name = 'AccountIdentityAmbiguityError'
}

function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase()
  return normalized || undefined
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function applyUpserts(
  current: AccountStorageV4,
  results: TokenSuccess[],
  replaceAll: boolean,
): AccountStorageV4 | undefined {
  const now = Date.now()

  // For fresh logins, start from empty inside the locked callback so
  // a stale merge cannot resurrect a removed account.
  const accounts: AccountMetadataV3[] = replaceAll ? [] : [...current.accounts]

  const indexByRefreshToken = new Map<string, number>()
  const indexByEmail = new Map<string, number>()
  const indexByAccountId = new Map<string, number>()
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]
    if (!acc) continue
    if (acc.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i)
    }
    if (acc.email) {
      const email = normalizeEmail(acc.email)
      if (email) indexByEmail.set(email, i)
    }
    if (acc.accountId) {
      indexByAccountId.set(acc.accountId, i)
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh)
    if (!parts.refreshToken) {
      continue
    }

    // Email match wins over token match — handles refresh-token rotation
    // for the same Google account.
    const email = normalizeEmail(result.email)
    const existingByEmail = email ? indexByEmail.get(email) : undefined
    const existingByAccountId = result.accountId
      ? indexByAccountId.get(result.accountId)
      : undefined
    const existingByToken = indexByRefreshToken.get(parts.refreshToken)
    if (
      existingByEmail !== undefined &&
      existingByAccountId !== undefined &&
      existingByEmail !== existingByAccountId
    ) {
      throw new AccountIdentityAmbiguityError(
        'OAuth email and Google account identity resolve to different stored accounts',
      )
    }
    const existingIndex =
      existingByEmail ?? existingByAccountId ?? existingByToken

    if (existingIndex === undefined) {
      const newIndex = accounts.length
      indexByRefreshToken.set(parts.refreshToken, newIndex)
      if (email) {
        indexByEmail.set(email, newIndex)
      }
      if (result.accountId) {
        indexByAccountId.set(result.accountId, newIndex)
      }
      accounts.push({
        email,
        accountId: result.accountId,
        label: result.label,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      })
      continue
    }

    const existing = accounts[existingIndex]
    if (!existing) continue
    if (
      existing.accountId &&
      result.accountId &&
      existing.accountId !== result.accountId
    ) {
      throw new AccountIdentityAmbiguityError(
        'OAuth identity conflicts with the matched stored account',
      )
    }

    const oldToken = existing.refreshToken
    accounts[existingIndex] = {
      ...existing,
      email: email ?? existing.email,
      accountId: result.accountId ?? existing.accountId,
      label: result.label ?? existing.label,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    }

    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken)
      indexByRefreshToken.set(parts.refreshToken, existingIndex)
    }
    if (email) indexByEmail.set(email, existingIndex)
    if (result.accountId) indexByAccountId.set(result.accountId, existingIndex)
  }

  if (accounts.length === 0) {
    return undefined
  }

  const activeIndex = replaceAll
    ? 0
    : typeof current.activeIndex === 'number' &&
        Number.isFinite(current.activeIndex)
      ? current.activeIndex
      : 0

  const clamped = clampInt(activeIndex, 0, accounts.length - 1)
  return {
    version: 4,
    accounts,
    activeIndex: clamped,
    activeIndexByFamily: {
      claude: clamped,
      gemini: clamped,
    },
  }
}

function maxRateLimits(
  first: AccountMetadataV3['rateLimitResetTimes'],
  second: AccountMetadataV3['rateLimitResetTimes'],
): AccountMetadataV3['rateLimitResetTimes'] {
  const merged = { ...first }
  for (const [key, value] of Object.entries(second ?? {})) {
    merged[key] = Math.max(merged[key] ?? 0, value ?? 0)
  }
  return Object.keys(merged).length ? merged : undefined
}

function mergeProvenDuplicate(
  survivor: AccountMetadataV3,
  duplicate: AccountMetadataV3,
): AccountMetadataV3 {
  const duplicateQuotaIsNewer =
    (duplicate.cachedQuotaUpdatedAt ?? 0) > (survivor.cachedQuotaUpdatedAt ?? 0)
  const coolingDownUntil = Math.max(
    survivor.coolingDownUntil ?? 0,
    duplicate.coolingDownUntil ?? 0,
  )
  return {
    ...duplicate,
    ...survivor,
    email: survivor.email ?? duplicate.email,
    accountId: survivor.accountId ?? duplicate.accountId,
    label: survivor.label ?? duplicate.label,
    projectId: survivor.projectId ?? duplicate.projectId,
    managedProjectId: survivor.managedProjectId ?? duplicate.managedProjectId,
    addedAt: Math.min(survivor.addedAt, duplicate.addedAt),
    lastUsed: Math.max(survivor.lastUsed, duplicate.lastUsed),
    enabled:
      survivor.accountIneligible || duplicate.accountIneligible
        ? false
        : survivor.enabled,
    rateLimitResetTimes: maxRateLimits(
      survivor.rateLimitResetTimes,
      duplicate.rateLimitResetTimes,
    ),
    coolingDownUntil: coolingDownUntil || undefined,
    cooldownReason:
      (duplicate.coolingDownUntil ?? 0) > (survivor.coolingDownUntil ?? 0)
        ? duplicate.cooldownReason
        : survivor.cooldownReason,
    cachedQuota: duplicateQuotaIsNewer
      ? duplicate.cachedQuota
      : survivor.cachedQuota,
    cachedPerModelQuota: duplicateQuotaIsNewer
      ? duplicate.cachedPerModelQuota
      : survivor.cachedPerModelQuota,
    cachedQuotaUpdatedAt: duplicateQuotaIsNewer
      ? duplicate.cachedQuotaUpdatedAt
      : survivor.cachedQuotaUpdatedAt,
    verificationRequired:
      survivor.verificationRequired || duplicate.verificationRequired,
    accountIneligible:
      survivor.accountIneligible || duplicate.accountIneligible,
  }
}

function remapRemovedIndex(
  index: number | undefined,
  removed: number,
  survivor: number,
): number | undefined {
  if (index === undefined) return undefined
  if (index === removed) return survivor
  return index > removed ? index - 1 : index
}

/**
 * Enrich an exact token-only account with identity resolved from Google and
 * collapse only duplicates proven by that identity. The exact token is the
 * fence: if a peer has replaced it, reconciliation fails without guessing.
 */
export async function reconcileAccountIdentityAtPath(
  path: string,
  identity: ResolvedAccountIdentity,
): Promise<void> {
  const email = normalizeEmail(identity.email)
  const accountId = identity.accountId?.trim() || undefined
  if (!email && !accountId) {
    throw new AccountIdentityAmbiguityError(
      'Google account identity was unavailable; no accounts were merged',
    )
  }
  await mutateAccountStorage(path, (current) => {
    let survivorIndex = current.accounts.findIndex(
      (account) => account.refreshToken === identity.refreshToken,
    )
    if (survivorIndex < 0) {
      throw new AccountIdentityAmbiguityError(
        'The token-only account changed before identity reconciliation',
      )
    }
    const survivor = current.accounts[survivorIndex]!
    if (survivor.accountId && accountId && survivor.accountId !== accountId) {
      throw new AccountIdentityAmbiguityError(
        'The stored Google account identity conflicts with the resolved identity',
      )
    }
    survivor.email = email ?? survivor.email
    survivor.accountId = accountId ?? survivor.accountId

    for (let index = current.accounts.length - 1; index >= 0; index--) {
      if (index === survivorIndex) continue
      const candidate = current.accounts[index]!
      const candidateEmail = normalizeEmail(candidate.email)
      const emailMatch = !!email && candidateEmail === email
      const accountIdMatch = !!accountId && candidate.accountId === accountId
      if (!emailMatch && !accountIdMatch) continue
      if (
        emailMatch &&
        candidate.accountId &&
        accountId &&
        candidate.accountId !== accountId
      ) {
        throw new AccountIdentityAmbiguityError(
          'Matching email records have conflicting Google account identities',
        )
      }
      current.accounts[survivorIndex] = mergeProvenDuplicate(
        current.accounts[survivorIndex]!,
        candidate,
      )
      const survivorAfterRemoval =
        index < survivorIndex ? survivorIndex - 1 : survivorIndex
      current.accounts.splice(index, 1)
      current.activeIndex =
        remapRemovedIndex(current.activeIndex, index, survivorAfterRemoval) ?? 0
      if (current.activeIndexByFamily) {
        current.activeIndexByFamily.claude = remapRemovedIndex(
          current.activeIndexByFamily.claude,
          index,
          survivorAfterRemoval,
        )
        current.activeIndexByFamily.gemini = remapRemovedIndex(
          current.activeIndexByFamily.gemini,
          index,
          survivorAfterRemoval,
        )
      }
      survivorIndex = survivorAfterRemoval
    }
    return current
  })
}

/**
 * Merge a batch of successful OAuth results into the persisted pool.
 *
 * - `replaceAll: true`   — start from empty (fresh login)
 * - `replaceAll: false`  — preserve existing accounts, upsert by email
 *                          then refresh token, bump `lastUsed`
 *
 * Both branches run their mutator INSIDE the locked callback. The
 * `replaceAll` branch seeds the mutator from an empty v4 rather than
 * reading the disk state, but the file lock is still required so the
 * write is atomic against concurrent writers — a deleted-account merge
 * would resurrect a stale account if we wrote without the lock.
 */
export async function persistAccountPoolAtPath(
  path: string,
  results: TokenSuccess[],
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return
  }

  const emptyV4 = (): AccountStorageV4 => ({
    version: 4,
    accounts: [],
    activeIndex: 0,
  })

  if (replaceAll) {
    await mutateAccountStorage(path, () =>
      applyUpserts(emptyV4(), results, true),
    )
    return
  }

  await mutateAccountStorage(path, (current) =>
    applyUpserts(current, results, false),
  )
}
