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
import { dirname, join } from 'node:path'

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
  AccountStorageUnreadableError,
  clearAccountStorage as coreClearAccountStorage,
  deduplicateAccountsByEmail as coreDeduplicateAccountsByEmail,
  loadAccountStorage as coreLoadAccountStorage,
  mergeAccountStorage as coreMergeAccountStorage,
  migrateV2ToV3 as coreMigrateV2ToV3,
  mutateAccountStorage as coreMutateAccountStorage,
  saveAccountStorage as coreSaveAccountStorage,
  saveAccountStorageReplace as coreSaveAccountStorageReplace,
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
export const mutateAccountStorage = coreMutateAccountStorage

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
// Host path delegation. Each of these resolves the on-disk path via the
// adapter above and hands it to the core lock-held engine. Callers that
// want to run their own mutator (e.g. persist-account-pool) should
// import from `@cortexkit/antigravity-auth-core` directly and pass
// `getStoragePath()` as the path argument.
// ============================================================================

export async function loadAccounts(): Promise<AccountStorageV4 | null> {
  const path = getStoragePath()
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
  const configDir = dirname(path)
  await fs.mkdir(configDir, { recursive: true })
  await ensureGitignore(configDir)
  await coreSaveAccountStorageReplace(path, storage)
}

export async function clearAccounts(): Promise<void> {
  const path = getStoragePath()
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
