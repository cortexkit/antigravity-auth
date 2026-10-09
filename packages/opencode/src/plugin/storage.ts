/**
 * Host-path adapter for account storage.
 *
 * Resolves the on-disk path for the OpenCode config directory, handles
 * the legacy Windows migration, and keeps the .gitignore in sync. All
 * data operations are delegated to `@cortexkit/antigravity-auth-core`'s
 * lock-held account-storage engine.
 *
 * The split keeps this module harness-specific (it knows about
 * `OPENCODE_CONFIG_DIR`, `%APPDATA%`, and OpenCode-specific gitignore
 * entries) while the schema, migrations, and lock semantics live in
 * core.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  promises as fs,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type {
  AccountMetadataV2,
  AccountMetadataV3,
  AccountModelFamily,
  AccountStorageUnreadableReason,
  AccountStorageV2,
  AccountStorageV4,
  AnyAccountStorage,
  CooldownReason,
  HeaderStyle,
  RateLimitStateV2,
  RateLimitStateV3,
} from '@cortexkit/antigravity-auth-core'
import {
  type AccountMigrationModules,
  type AccountMigrationOutcome,
  type AccountRepository,
  AccountStorageUnreadableError,
  type AccountStoreAdmission,
  type AccountStoreAdmissionModules,
  type AccountStoreBinding,
  type AccountTokenExchange,
  assertLegacyAccountStorageWritable,
  type CreateAccountRepository,
  clearAccountStorage as coreClearAccountStorage,
  deduplicateAccountsByEmail as coreDeduplicateAccountsByEmail,
  loadAccountStorage as coreLoadAccountStorage,
  mergeAccountStorage as coreMergeAccountStorage,
  migrateV2ToV3 as coreMigrateV2ToV3,
  mutateAccountStorage as coreMutateAccountStorage,
  saveAccountStorage as coreSaveAccountStorage,
  saveAccountStorageReplace as coreSaveAccountStorageReplace,
  initializeFreshAccountStore,
  readAccountStoreAdmission,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'
import { createLogger } from './logger'

const log = createLogger('storage')

// ============================================================================
// Re-export types for backward compatibility.
// Harnesses (and existing call sites in plugin.ts / accounts.ts) import
// the metadata + storage shapes from `./storage`; keep the surface stable.
// ============================================================================

/**
 * @deprecated use `AccountModelFamily` from `@cortexkit/antigravity-auth-core`.
 * Retained under the old name so existing call sites continue to compile.
 */
export type ModelFamily = AccountModelFamily

export type {
  AccountMetadataV2,
  AccountMetadataV3,
  AccountStorageUnreadableReason,
  AccountStorageV2,
  AccountStorageV4,
  AnyAccountStorage,
  CooldownReason,
  HeaderStyle,
  RateLimitStateV2,
  RateLimitStateV3,
}

/**
 * Re-export the typed unreadable-storage error so consumers can
 * `instanceof`-check without pulling core into their own dependency
 * graph. When the on-disk accounts file exists but cannot be parsed
 * as a valid v4 (corrupt JSON, schema mismatch, unknown version, or
 * an I/O error other than ENOENT), every read/write here throws this
 * — never silently overwrites the user's data.
 */
export { AccountStorageUnreadableError }

/**
 * Backward-compat re-exports for harnesses still importing
 * `deduplicateAccountsByEmail` / `mergeAccountStorage` / `migrateV2ToV3`
 * from `./storage`. The definitions live in core; the adapter exposes
 * them so legacy test files compile without modification.
 */
export const deduplicateAccountsByEmail = coreDeduplicateAccountsByEmail
export const mergeAccountStorage = coreMergeAccountStorage
export const migrateV2ToV3 = coreMigrateV2ToV3

/**
 * The pre-store engine's mutation of the legacy pool file at `path`, run
 * while holding that file's lock; refused once the account store owns the
 * accounts (see `assertLegacyPoolInUse`).
 */
export const mutateAccountStorage: typeof coreMutateAccountStorage = async (
  path,
  mutate,
) => {
  await assertLegacyPoolInUse(path)
  return coreMutateAccountStorage(path, mutate)
}

/**
 * Files/directories that should be gitignored in the config directory.
 * These contain sensitive data or machine-specific state.
 */
// NOTE: deliberately no ".gitignore" self-ignore entry — users who track their
// config dir as a git repo (with .gitignore committed) get endless working-tree
// drift from re-appending it, and for a tracked file the entry is a no-op anyway.
export const GITIGNORE_ENTRIES = [
  'antigravity-accounts.json',
  'antigravity-accounts.json.*.tmp',
  // The account store's generation directories hold credential files; its
  // pointer file names the current generation only.
  'antigravity-accounts.json.store*',
  'antigravity-signature-cache.json',
  'antigravity-logs/',
]

/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, '.gitignore')

  try {
    let content: string
    let existingLines: string[] = []

    try {
      content = await fs.readFile(gitignorePath, 'utf-8')
      existingLines = content.split('\n').map((line) => line.trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return
      }
      content = ''
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    )

    if (missingEntries.length === 0) {
      return
    }

    if (content === '') {
      await fs.writeFile(
        gitignorePath,
        `${missingEntries.join('\n')}\n`,
        'utf-8',
      )
      log.info('Created .gitignore in config directory')
    } else {
      const suffix = content.endsWith('\n') ? '' : '\n'
      await fs.appendFile(
        gitignorePath,
        `${suffix + missingEntries.join('\n')}\n`,
        'utf-8',
      )
      log.info('Updated .gitignore with missing entries', {
        added: missingEntries,
      })
    }
  } catch (error) {
    log.warn('Failed to update .gitignore with account storage entries', {
      error: String(error),
    })
  }
}

/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, '.gitignore')

  try {
    let content: string
    let existingLines: string[] = []

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8')
      existingLines = content.split('\n').map((line) => line.trim())
    } else {
      content = ''
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    )

    if (missingEntries.length === 0) {
      return
    }

    if (content === '') {
      writeFileSync(gitignorePath, `${missingEntries.join('\n')}\n`, 'utf-8')
      log.info('Created .gitignore in config directory')
    } else {
      const suffix = content.endsWith('\n') ? '' : '\n'
      appendFileSync(
        gitignorePath,
        `${suffix + missingEntries.join('\n')}\n`,
        'utf-8',
      )
      log.info('Updated .gitignore with missing entries', {
        added: missingEntries,
      })
    }
  } catch (error) {
    log.warn('Failed to update .gitignore with account storage entries', {
      error: String(error),
    })
  }
}

/**
 * Gets the legacy Windows config directory (%APPDATA%\opencode).
 * Used for migration from older plugin versions.
 */
function getLegacyWindowsConfigDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'opencode',
  )
}

/**
 * Gets the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 *
 * On Windows, also checks for legacy %APPDATA%\opencode path for migration.
 */
function getConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

/**
 * Migrates config from legacy Windows location to the new path.
 * Moves the file if legacy exists and new doesn't.
 * Returns true if migration was performed.
 */
function migrateLegacyWindowsConfig(): boolean {
  if (process.platform !== 'win32') {
    return false
  }

  const newPath = join(getConfigDir(), 'antigravity-accounts.json')
  const legacyPath = join(
    getLegacyWindowsConfigDir(),
    'antigravity-accounts.json',
  )

  if (!existsSync(legacyPath) || existsSync(newPath)) {
    return false
  }

  try {
    const newConfigDir = getConfigDir()

    mkdirSync(newConfigDir, { recursive: true })

    try {
      renameSync(legacyPath, newPath)
      log.info('Migrated Windows config via rename', {
        from: legacyPath,
        to: newPath,
      })
    } catch {
      copyFileSync(legacyPath, newPath)
      unlinkSync(legacyPath)
      log.info('Migrated Windows config via copy+delete', {
        from: legacyPath,
        to: newPath,
      })
    }

    return true
  } catch (error) {
    log.warn('Failed to migrate legacy Windows config, will use legacy path', {
      legacyPath,
      newPath,
      error: String(error),
    })
    return false
  }
}

/**
 * Gets the storage path, migrating from legacy Windows location if needed.
 * On Windows, attempts to move legacy config to new path for alignment.
 */
function getStoragePathWithMigration(): string {
  const newPath = join(getConfigDir(), 'antigravity-accounts.json')

  if (process.platform === 'win32') {
    migrateLegacyWindowsConfig()

    if (!existsSync(newPath)) {
      const legacyPath = join(
        getLegacyWindowsConfigDir(),
        'antigravity-accounts.json',
      )
      if (existsSync(legacyPath)) {
        log.info('Using legacy Windows config path (migration failed)', {
          legacyPath,
          newPath,
        })
        return legacyPath
      }
    }
  }

  return newPath
}

export function getStoragePath(): string {
  return getStoragePathWithMigration()
}

/**
 * Gets the config directory path. Exported for use by other modules.
 */
export { getConfigDir }

// ============================================================================
// The account store that replaces the legacy pool file
// ============================================================================

/**
 * Thrown by every pre-store reader and writer of the pool file once the
 * account store owns the accounts: a published store generation whose
 * journal is not an inactive rollback, or successor files without a
 * journal. A write then would land in a file the migration captured or
 * retired, and a read would serve accounts the store no longer agrees with.
 * The decision is the migration's own (`assertLegacyAccountStorageWritable`);
 * `cause` carries its reason, which never contains a credential.
 */
export class LegacyAccountPoolRetiredError extends Error {
  readonly legacyPath: string

  constructor(legacyPath: string, options?: { cause?: unknown }) {
    super(
      `Account pool file ${legacyPath} is owned by the account store and is no longer read or written. Use the account store, or roll it back with \`antigravity-auth rollback --offline\` before using an older build.`,
      options,
    )
    this.name = 'LegacyAccountPoolRetiredError'
    this.legacyPath = legacyPath
  }
}

/**
 * Refuses pool-file access once the account store owns the accounts. Any
 * failure of the check (an unreadable pointer or journal included) refuses
 * too: it is not proof that the store is absent.
 */
export async function assertLegacyPoolInUse(legacyPath: string): Promise<void> {
  try {
    await assertLegacyAccountStorageWritable(resolve(legacyPath))
  } catch (error) {
    throw new LegacyAccountPoolRetiredError(legacyPath, { cause: error })
  }
}

/** Offline commands the messages below name. */
const MIGRATE_COMMAND = 'antigravity-auth migrate --offline'
const ROLLBACK_COMMAND = 'antigravity-auth rollback --offline'

type NotServing = Exclude<
  AccountStoreAdmission,
  { status: 'active' } | { status: 'initialization-required' }
>

/** What opening the account store for serving found. */
export type AccountStoreOpening =
  | {
      status: 'ready'
      repository: AccountRepository
      admission: Extract<AccountStoreAdmission, { status: 'active' }>
    }
  /**
   * Neither a pool file nor a store exists. Nothing is created: a genuinely
   * fresh installation calls `initializeFreshAccountStoreFor` explicitly,
   * then opens again.
   */
  | { status: 'initialization-required' }
  /** A pool file exists and no store generation is published. */
  | { status: 'migration-required'; message: string }
  /**
   * A published generation is bound but cannot serve: repository work (a
   * clear or a pool replacement) is pending. Its owner resumes it through
   * `openAccountStoreForRecovery`; nothing is served meanwhile.
   */
  | {
      status: 'recovery-required'
      binding: Extract<AccountStoreBinding, { status: 'bound' }>
      message: string
    }
  /**
   * The store cannot serve: a migration or rollback is pending, the store
   * was rolled back (inactive), or its pointer, journal, backups or files
   * failed validation. Nothing falls back to the pool file or to an empty
   * pool.
   */
  | { status: 'refused'; admission: NotServing; message: string }

export interface OpenAccountStoreOptions {
  /** The genuine public common-auth `./store` module; admission uses only its read methods. */
  modules: AccountStoreAdmissionModules
  /**
   * Builds the repository for the verified generation's paths;
   * `createAccountRepositoryFactory(modules)`.
   */
  createRepository: CreateAccountRepository
  exchange: AccountTokenExchange
  now?: () => number
  /** Defaults to the resolved pool-file path (`getStoragePath`). */
  legacyPath?: string
}

function refusalMessage(admission: NotServing): string {
  switch (admission.status) {
    case 'pending':
      return admission.operation === 'rollback'
        ? `An account-store rollback is pending; rerun \`${ROLLBACK_COMMAND}\`.`
        : `An account-store migration is pending; stop every Antigravity process and rerun \`${MIGRATE_COMMAND}\`.`
    case 'inactive':
      return 'The account store was rolled back; use the build that matches the restored pool file, or migrate again offline.'
    case 'error':
      return `The account store cannot be admitted: ${admission.reason}`
  }
}

/**
 * The published generation bound to the pool file, from the migration's
 * canonical binding read (no second pointer or journal decoder here).
 */
async function bindingOf(options: OpenAccountStoreOptions): Promise<{
  legacyPath: string
  now: () => number
  binding: AccountStoreBinding
}> {
  const now = options.now ?? (() => Date.now())
  const legacyPath = resolve(options.legacyPath ?? getStoragePath())
  return {
    legacyPath,
    now,
    binding: await readAccountStoreBinding(legacyPath, options.modules, now),
  }
}

/** The opening for a binding that is not `bound`. */
function unboundOpening(
  binding: Exclude<AccountStoreBinding, { status: 'bound' }>,
): Exclude<AccountStoreOpening, { status: 'ready' | 'recovery-required' }> {
  if (binding.status === 'initialization-required') {
    return { status: 'initialization-required' }
  }
  // Without a published generation, `pending` means the pool file exists
  // and has not been migrated.
  if (
    binding.status === 'pending' &&
    binding.phase === undefined &&
    binding.operation === undefined
  ) {
    return {
      status: 'migration-required',
      message: `Accounts must be moved to the account store; stop every Antigravity process and run \`${MIGRATE_COMMAND}\`.`,
    }
  }
  return {
    status: 'refused',
    admission: binding,
    message: refusalMessage(binding),
  }
}

/**
 * Opens the account store for serving. The generation is first bound
 * through the migration's canonical binding, then admitted for serving
 * (healthy current rows, no pending repository work) on that same
 * generation. The repository is built only for an admitted generation;
 * every other result is returned, never repaired: no implicit fresh store,
 * no reset after a corrupt or unavailable store and no fall-through to the
 * pool file.
 */
export async function openAccountStore(
  options: OpenAccountStoreOptions,
): Promise<AccountStoreOpening> {
  const { legacyPath, now, binding } = await bindingOf(options)
  if (binding.status !== 'bound') return unboundOpening(binding)
  const admission = await readAccountStoreAdmission(
    legacyPath,
    options.modules,
    now,
    binding.receipt.id,
  )
  switch (admission.status) {
    case 'active':
      return {
        status: 'ready',
        admission,
        repository: options.createRepository({
          paths: admission.paths,
          now,
          exchange: options.exchange,
        }),
      }
    case 'pending':
      return {
        status: 'recovery-required',
        binding,
        message:
          'An account clear or pool replacement was interrupted; it must be finished before the accounts are used.',
      }
    case 'initialization-required':
      // The generation was bound a moment ago; its disappearance is not a
      // fresh installation.
      return {
        status: 'refused',
        admission: {
          status: 'error',
          reason: 'the bound generation disappeared',
        },
        message: 'The account store changed while it was opened; try again.',
      }
    default:
      return {
        status: 'refused',
        admission,
        message: refusalMessage(admission),
      }
  }
}

/**
 * Opens the bound generation's repository to resume interrupted repository
 * work (`clear`, `replacePool`), which the repository finishes from its own
 * journal. The repository refuses every ordinary operation while that work
 * is pending, so this never serves accounts; use `openAccountStore` for
 * serving.
 */
export async function openAccountStoreForRecovery(
  options: OpenAccountStoreOptions,
): Promise<
  | {
      status: 'bound'
      repository: AccountRepository
      binding: Extract<AccountStoreBinding, { status: 'bound' }>
    }
  | Exclude<AccountStoreOpening, { status: 'ready' | 'recovery-required' }>
> {
  const { now, binding } = await bindingOf(options)
  if (binding.status !== 'bound') return unboundOpening(binding)
  return {
    status: 'bound',
    binding,
    repository: options.createRepository({
      paths: binding.paths,
      now,
      exchange: options.exchange,
    }),
  }
}

/**
 * Creates an empty account store for a genuinely fresh installation (no
 * pool file), as an explicit step the caller takes after `openAccountStore`
 * answered `initialization-required`. The migration's
 * `initializeFreshAccountStore` refuses
 * when a pool file exists or appears, or when unrelated store files exist.
 */
export function initializeFreshAccountStoreFor(
  modules: AccountMigrationModules,
  options: { legacyPath?: string; now?: () => number } = {},
): Promise<AccountMigrationOutcome> {
  return initializeFreshAccountStore(modules, {
    legacyPath: resolve(options.legacyPath ?? getStoragePath()),
    now: options.now ?? (() => Date.now()),
  })
}

// ============================================================================
// Host path delegation. Each of these resolves the on-disk path via the
// adapter above and hands it to the core lock-held engine. Callers that
// want to run their own mutator (e.g. persist-account-pool) should
// import from `@cortexkit/antigravity-auth-core` directly and pass
// `getStoragePath()` as the path argument.
// ============================================================================

export async function loadAccounts(): Promise<AccountStorageV4 | null> {
  const path = getStoragePath()
  await assertLegacyPoolInUse(path)
  await ensureGitignore(dirname(path))
  return coreLoadAccountStorage(path)
}

/**
 * Merge `storage` into the persisted pool. Use this for non-destructive
 * writes (quota cache, eligibility, last-used) so concurrent writers
 * do not silently drop each other's data.
 */
export async function saveAccounts(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath()
  await assertLegacyPoolInUse(path)
  const configDir = dirname(path)
  await fs.mkdir(configDir, { recursive: true })
  await ensureGitignore(configDir)
  await coreSaveAccountStorage(path, storage)
}

/**
 * Save accounts storage by replacing the entire file (no merge).
 * Required for destructive operations like delete where the next-state
 * must replace — never be merged with — what is on disk.
 */
export async function saveAccountsReplace(
  storage: AccountStorageV4,
): Promise<void> {
  const path = getStoragePath()
  await assertLegacyPoolInUse(path)
  const configDir = dirname(path)
  await fs.mkdir(configDir, { recursive: true })
  await ensureGitignore(configDir)
  await coreSaveAccountStorageReplace(path, storage)
}

export async function clearAccounts(): Promise<void> {
  const path = getStoragePath()
  // Outside the try below: a refusal must reach the caller, not be logged
  // as a failed unlink.
  await assertLegacyPoolInUse(path)
  try {
    await coreClearAccountStorage(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.error('Failed to clear account storage', { error: String(error) })
    }
  }
}

/**
 * Locate a stored account by its refresh token under the lock-held
 * mutator and apply `mutate(account)`. Returns the (possibly mutated)
 * account, or `undefined` when the token no longer matches any stored
 * account. Concurrent writers that add/remove accounts will not
 * disturb the lookup — the read happens while the lock is held.
 *
 * `mutate` may mutate `account` in place and return `true` to commit
 * the change; returning `false` is treated as "no change" and skips
 * the write.
 */
export async function mutateAccountByRefreshToken(
  refreshToken: string,
  mutate: (account: AccountMetadataV3) => boolean,
): Promise<AccountMetadataV3 | undefined> {
  const path = getStoragePath()
  await assertLegacyPoolInUse(path)
  const configDir = dirname(path)
  await fs.mkdir(configDir, { recursive: true })
  await ensureGitignore(configDir)

  let result: AccountMetadataV3 | undefined
  await coreMutateAccountStorage(path, (current) => {
    const idx = current.accounts.findIndex(
      (acc) => acc.refreshToken === refreshToken,
    )
    if (idx === -1) return current
    const target = current.accounts[idx]
    if (!target) return current
    const changed = mutate(target)
    if (!changed) return current
    result = target
    current.accounts[idx] = target
    return current
  })
  return result
}
