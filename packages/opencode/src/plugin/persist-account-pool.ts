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
 *
 * `persistAccountPool` writes the pre-store pool file and is refused once
 * the account store has replaced it. `commitLogins` and `replacePoolLogins`
 * are the account-store equivalents.
 */

import { randomUUID } from 'node:crypto'
import {
  type AccountLoginInput,
  type AccountMetadataV3,
  type AccountRepository,
  AccountRepositoryError,
  type AccountRepositoryFailureKind,
  type AccountStorageV4,
  type ManagementReceipt,
  type ProviderMetadata,
  type RowRef,
} from '@cortexkit/antigravity-auth-core'

import type { AntigravityTokenExchangeResult } from '../antigravity/oauth'
import { parseRefreshParts } from './auth'
import { getStoragePath, mutateAccountStorage } from './storage'

export type TokenSuccess = Extract<
  AntigravityTokenExchangeResult,
  { type: 'success' }
>

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

// ---------------------------------------------------------------------------
// Account store logins
// ---------------------------------------------------------------------------

/**
 * The repository login input for one OAuth result: a fresh row id, the bare
 * refresh token (project ids live in metadata, never packed into the stored
 * secret) and the account fields the login established. No identity is
 * asserted: the OAuth email is display metadata, not the provider identity
 * a credential is fenced on. Returns `undefined`
 * for a result without a refresh token.
 */
export function loginInputOf(
  result: TokenSuccess,
  now: number,
  newId: () => string = randomUUID,
): AccountLoginInput | undefined {
  const parts = parseRefreshParts(result.refresh)
  if (!parts.refreshToken) return undefined
  const metadata: ProviderMetadata = {
    addedAt: now,
    lastUsed: now,
    enabled: true,
  }
  if (result.email !== undefined) metadata.email = result.email
  if (result.label !== undefined) metadata.label = result.label
  if (parts.projectId !== undefined) metadata.projectId = parts.projectId
  if (parts.managedProjectId !== undefined) {
    metadata.managedProjectId = parts.managedProjectId
  }
  return { id: newId(), refreshToken: parts.refreshToken, metadata }
}

/**
 * Login refusals that concern only the one result: the pool already holds
 * this account under another credential, or holds this credential for
 * another account. A login never moves a credential onto another row;
 * only re-authentication of the exact captured row and epoch replaces one.
 */
const PER_LOGIN_REFUSALS = new Set<AccountRepositoryFailureKind>([
  'duplicate-identity',
  'duplicate-secret',
])

export type CommittedLogin =
  | {
      status: 'committed'
      /** The authoritative ref of the row that now holds the login. */
      ref: RowRef
      outcome: 'added' | 'added-disabled' | 'completed' | 'rotated'
    }
  | {
      status: 'refused'
      kind: 'duplicate-identity' | 'duplicate-secret'
      rowId?: string
      message: string
    }
  | { status: 'skipped'; reason: 'no-refresh-token' }

/**
 * Admits OAuth results into the account store one login at a time, in
 * order, through `AccountRepository.login`: each is matched by exact email,
 * then by secret, and committed under the repository's topology lease, the
 * same lease that orders `clear` and pool replacement. Unlike the
 * pre-store upsert, a login never overwrites the credential of an existing
 * row: an email already held under another credential is refused and must
 * go through re-authentication with that row's captured ref. Any other
 * failure (pending migration, contention, I/O) stops the batch and is
 * thrown; logins committed before it stay committed and their refs are on
 * the error's `committed` list.
 */
export async function commitLogins(
  repository: AccountRepository,
  results: readonly TokenSuccess[],
  options: { now?: () => number; newId?: () => string } = {},
): Promise<CommittedLogin[]> {
  const now = options.now ?? (() => Date.now())
  const committed: CommittedLogin[] = []
  for (const result of results) {
    const input = loginInputOf(result, now(), options.newId)
    if (input === undefined) {
      committed.push({ status: 'skipped', reason: 'no-refresh-token' })
      continue
    }
    try {
      const login = await repository.login(input)
      committed.push({
        status: 'committed',
        ref: login.ref,
        outcome: login.outcome,
      })
    } catch (error) {
      if (
        error instanceof AccountRepositoryError &&
        PER_LOGIN_REFUSALS.has(error.failure.kind)
      ) {
        committed.push({
          status: 'refused',
          kind: error.failure.kind as 'duplicate-identity' | 'duplicate-secret',
          ...(error.failure.rowId !== undefined
            ? { rowId: error.failure.rowId }
            : {}),
          message: error.failure.message,
        })
        continue
      }
      throw new LoginBatchError(committed, error)
    }
  }
  return committed
}

/** A login batch that stopped early; `committed` lists what landed first. */
export class LoginBatchError extends Error {
  readonly committed: readonly CommittedLogin[]

  constructor(committed: readonly CommittedLogin[], cause: unknown) {
    super(
      cause instanceof Error
        ? `Account login stopped: ${cause.message}`
        : 'Account login stopped',
      { cause },
    )
    this.name = 'LoginBatchError'
    this.committed = committed
  }
}

/**
 * Replaces the whole pool with fresh logins as one journaled repository
 * operation. The inputs stay in the repository's
 * private transfer file until the new rows are verified, so an interrupted
 * replacement resumes rather than losing them. `pending` means the journal
 * is waiting to be resumed; the caller must not serve the pool until a
 * later `replacePool`/resume completes. Results without a refresh token are
 * left out; a batch with none is refused rather than clearing the pool.
 */
export async function replacePoolLogins(
  repository: AccountRepository,
  results: readonly TokenSuccess[],
  options: { now?: () => number; newId?: () => string } = {},
): Promise<ManagementReceipt> {
  const at = (options.now ?? (() => Date.now()))()
  const inputs = results
    .map((result) => loginInputOf(result, at, options.newId))
    .filter((input): input is AccountLoginInput => input !== undefined)
  if (inputs.length === 0) {
    throw new Error(
      'Refusing to replace the account pool with no usable logins',
    )
  }
  return repository.replacePool(inputs)
}
