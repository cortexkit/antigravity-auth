/**
 * Account pool persistence for OAuth flows.
 *
 * Merges a batch of successful OAuth token-exchange results into the
 * persisted pool. All reads + writes happen inside the core
 * `mutateAccountStorage` callback so the mutator sees the freshest
 * state read while the lock is held — without it, a concurrent add
 * would race the read-modify-write and silently disappear.
 *
 * Two upsert keys are honored, in priority order:
 *  1. email — survives refresh-token rotation for the same Google account
 *  2. refresh token — handles the no-email case and out-of-band rotations
 *
 * Destructive (`replaceAll: true`) writes start from an empty v4 inside
 * the same locked callback so a stale merge cannot resurrect a removed
 * account.
 */

import type {
  AccountMetadataV3,
  AccountStorageV4,
} from '@cortexkit/antigravity-auth-core'
import { mutateAccountStorage } from '@cortexkit/antigravity-auth-core'

import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import { parseRefreshParts } from './auth'
import { getStoragePath } from './storage'

type TokenSuccess = Extract<AntigravityTokenExchangeResult, { type: 'success' }>

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
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]
    if (!acc) continue
    if (acc.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i)
    }
    if (acc.email) {
      indexByEmail.set(acc.email, i)
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh)
    if (!parts.refreshToken) {
      continue
    }

    // Email match wins over token match — handles refresh-token rotation
    // for the same Google account.
    const existingByEmail = result.email
      ? indexByEmail.get(result.email)
      : undefined
    const existingByToken = indexByRefreshToken.get(parts.refreshToken)
    const existingIndex = existingByEmail ?? existingByToken

    if (existingIndex === undefined) {
      const newIndex = accounts.length
      indexByRefreshToken.set(parts.refreshToken, newIndex)
      if (result.email) {
        indexByEmail.set(result.email, newIndex)
      }
      accounts.push({
        email: result.email,
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

    const oldToken = existing.refreshToken
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
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
export async function persistAccountPool(
  results: TokenSuccess[],
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return
  }

  const path = getStoragePath()
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
