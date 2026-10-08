import {
  type AccountManagerOptions,
  type AccountRepository,
  type AccountRepositoryRead,
  AccountManager as CoreAccountManager,
  type ManagedAccount as CoreManagedAccount,
  type OAuthAuthDetails as CoreOAuthAuthDetails,
  type ProjectContextResult,
} from '@cortexkit/antigravity-auth-core'

import { debugLogToFile } from './debug'
import { ensureProjectContext } from './project'
import {
  getStoragePath,
  loadAccounts,
  saveAccounts,
  saveAccountsReplace,
} from './storage'
import { isInvalidGrantFailure } from './token'
import type { OAuthAuthDetails } from './types'

export type {
  AccountModelFamily as ModelFamily,
  AccountSessionIdentity,
  CooldownReason,
  HeaderStyle,
  ManagedAccount,
  RateLimitReason,
} from '@cortexkit/antigravity-auth-core'
export {
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  parseRateLimitReason,
  resolveQuotaGroup,
} from '@cortexkit/antigravity-auth-core'

/**
 * The pre-store pool-file binding. Every function it calls first runs the
 * migration's `assertLegacyAccountStorageWritable`, which refuses
 * (`LegacyAccountPoolRetiredError`) once a canonical store pointer is
 * published and its journal is not an inactive rollback, or when store
 * files exist without a journal. A manager built on it never writes a
 * retired pool file.
 */
const openCodeStore: NonNullable<AccountManagerOptions['store']> = {
  load: async () => loadAccounts(),
  saveMerged: async (_path, next) => {
    await saveAccounts(next)
    return next
  },
  mutate: async (_path, fn) => {
    const current = (await loadAccounts()) ?? {
      version: 4,
      accounts: [],
      activeIndex: 0,
    }
    const next = (await fn(current)) ?? current
    await saveAccountsReplace(next)
    return next
  },
  clear: async () => {},
}

function defaultDiagnostic(
  message: string,
  fields?: Record<string, unknown>,
): void {
  debugLogToFile(fields ? `${message} ${JSON.stringify(fields)}` : message)
}

/**
 * Thrown when the account store cannot serve accounts: a migration or a
 * multi-row operation is pending, or a store file is unreadable. Routing
 * must stop here; nothing falls back to the pool file or to an empty pool.
 */
export class AccountStoreNotReadyError extends Error {
  readonly read: Exclude<AccountRepositoryRead, { status: 'ready' }>

  constructor(read: Exclude<AccountRepositoryRead, { status: 'ready' }>) {
    super(
      read.status === 'error'
        ? `The account store's ${read.file} file cannot be read: ${read.reason}`
        : read.status === 'management-pending'
          ? `An account ${read.management.kind} operation is pending; resume it before using the accounts`
          : 'The account store is waiting for its migration to finish; run `antigravity-auth account-store migrate --offline`',
    )
    this.name = 'AccountStoreNotReadyError'
    this.read = read
  }
}

/**
 * Builds a manager over the account repository from one read. Every account
 * the manager holds carries the `RowRef` of the row it was read from: the
 * row id, the credential epoch and the exact recorded identity (an absent
 * identity matches only an absent one). Every write the manager makes about
 * the account is fenced on that ref, so a write for a credential the row
 * has since replaced is refused; positions are never used.
 * Refreshes go through `refreshAccount`, the repository's per-account
 * refresh, so different accounts refresh concurrently while one account's
 * refreshes are serialized.
 */
export async function loadAccountManagerFromRepository(
  repository: AccountRepository,
  options: Partial<
    Omit<AccountManagerOptions, 'store' | 'storagePath' | 'repository'>
  > = {},
): Promise<CoreAccountManager> {
  const read = await repository.read()
  if (read.status !== 'ready') throw new AccountStoreNotReadyError(read)
  return CoreAccountManager.fromRepository(read, {
    repository,
    now: options.now,
    random: options.random,
    pid: options.pid ?? process.pid,
    onDiagnostic: options.onDiagnostic ?? defaultDiagnostic,
  })
}

/**
 * Token and project operations for accounts of a repository-backed manager,
 * for the shared request engine's local source: the refresh token is stored
 * locally and refreshed here. A vault-backed location never uses these; it
 * obtains a fresh token and project for every send.
 */
export interface LocalAccountCredentials {
  /**
   * Refreshes the locally stored refresh token of `account` through the
   * repository, fenced on the ref the account was loaded with, and returns
   * its updated credential. A refresh
   * the store refused, or one where Google answered for another account,
   * returns `undefined`: no bearer is handed out for it. Failures (Google's
   * error answers included, see `isInvalidGrant`) are thrown.
   */
  refresh(
    account: CoreManagedAccount,
  ): Promise<CoreOAuthAuthDetails | undefined>
  /** Resolves the Antigravity project a request is sent under, using the cached project context. */
  ensureProject(auth: CoreOAuthAuthDetails): Promise<ProjectContextResult>
  /** True when a refresh failure is `invalid_grant`: the refresh token is invalid or revoked. */
  isInvalidGrant(error: unknown): boolean
}

export function createLocalAccountCredentials(
  manager: CoreAccountManager,
  dependencies: {
    ensureProject?: (
      auth: CoreOAuthAuthDetails,
    ) => Promise<ProjectContextResult>
  } = {},
): LocalAccountCredentials {
  return {
    async refresh(account) {
      const outcome = await manager.refreshAccount(account)
      if (outcome.status !== 'rotated') return undefined
      return manager.toAuthDetails(account)
    },
    ensureProject: dependencies.ensureProject ?? ensureProjectContext,
    isInvalidGrant: isInvalidGrantFailure,
  }
}

export class AccountManager extends CoreAccountManager {
  constructor(
    authFallback?: OAuthAuthDetails,
    stored?: Awaited<ReturnType<typeof loadAccounts>>,
    options: Partial<AccountManagerOptions> = {},
  ) {
    super(authFallback, stored, {
      store: options.store ?? openCodeStore,
      storagePath: options.storagePath ?? getStoragePath(),
      now: options.now,
      random: options.random,
      pid: options.pid ?? process.pid,
      onDiagnostic: options.onDiagnostic ?? defaultDiagnostic,
    })
  }

  static async loadFromDisk(
    authFallback?: OAuthAuthDetails,
  ): Promise<AccountManager> {
    return new AccountManager(authFallback, await loadAccounts())
  }
}
