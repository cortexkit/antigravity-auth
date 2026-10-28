// Where this process keeps its vault files, settled once by each entry point
// (the OpenCode 1 plugin, an OpenCode 2 activation, the CLI and setup) before
// it reads or writes any of them.
//
// `prepareVaultFolder` runs the one-time move of the vault files out of
// OpenCode's config folder (`runtime-layout.ts`) and returns the vault folder
// the decided layout names. When the move cannot settle a layout (vault files
// that conflict between the two folders, a damaged marker, a state folder that
// belongs to another config folder, a layout lock it could not take), it
// returns the refusal instead. The caller must then serve neither vault nor
// local accounts: which folder holds this host's vault enrollment is unknown,
// and serving local accounts could bypass a vault the user chose.
//
// A refusal is kept for the life of the process, like a decided layout: its
// message tells the user to restart OpenCode once it is resolved, and later
// plugin instances or OpenCode 2 locations in the same process get the same
// answer at once instead of waiting for the layout lock again.
//
// Only locally authorized starts also prepare the account store. A vault-only
// start leaves it undecided until its first local use after a disconnect.

import { createLogger } from './plugin/logger'
import { pluginPackageVersion } from './process-heartbeat'
import {
  prepareAccountStore,
  prepareRuntimeLayout,
  type RuntimeLayoutLogger,
  RuntimeLayoutRefusal,
} from './runtime-layout'
import { getVaultDir, runtimeLayoutLocation } from './runtime-paths'

/** The vault folder an entry point uses, or why it has none. */
export interface VaultFolder {
  /** The account file the folder was settled against (`getStoragePath()`). */
  readonly accountFile: string
  /**
   * The folder holding the vault files for this process. With a refusal it
   * is only where the files would be read from without a decision; nothing
   * may read or write it.
   */
  readonly vaultDir: string
  /** Set when the start could not settle where the vault files live. */
  readonly refusal?: RuntimeLayoutRefusal
}

// Refusals by config folder, on the global object because OpenCode 2 may load
// more than one copy of this bundle into one process.
const refusalsKey = Symbol.for(
  '@cortexkit/antigravity-auth/vault-folder-refusals',
)
const globalState = globalThis as typeof globalThis & {
  [refusalsKey]?: Map<string, RuntimeLayoutRefusal>
}
const refusals =
  globalState[refusalsKey] ?? new Map<string, RuntimeLayoutRefusal>()
globalState[refusalsKey] = refusals

function locationKey(): string {
  const location = runtimeLayoutLocation()
  return `${location.stateHomeDir}\0${location.key}`
}

/** Test seam: forget every refusal this process kept. */
export function __resetVaultFoldersForTest(): void {
  refusals.clear()
}

/**
 * Settle this process's vault folder for the config folder `accountFile`
 * belongs to, moving the vault files first when that is safe. Resolves with
 * the refusal rather than rejecting when the layout cannot be settled.
 * `version` defaults to this package's own version (`unknown` when its
 * manifest cannot be read, which other processes' version checks treat as
 * blocking).
 */
export async function prepareVaultFolder(options: {
  accountFile: string
  version?: string
  log?: RuntimeLayoutLogger
  /** Test seam: how long to wait for the layout lock. */
  layoutLockWaitMs?: number
  /** Setup may inspect/migrate an existing store before preparing its anchor. */
  accountStore?: boolean
}): Promise<VaultFolder> {
  const { accountFile } = options
  const key = locationKey()
  const kept = refusals.get(key)
  if (kept) return refused(accountFile, kept)
  const log = options.log ?? createLogger('runtime-layout')
  const version =
    options.version ?? (await pluginPackageVersion().catch(() => 'unknown'))
  try {
    await prepareRuntimeLayout({
      version,
      accountFile,
      log,
      ...(options.layoutLockWaitMs === undefined
        ? {}
        : { layoutLockWaitMs: options.layoutLockWaitMs }),
    })
    // Preparation re-reads authority before inspecting any store path, and
    // serializes the local decision with other starts under the layout lock.
    if (options.accountStore !== false)
      await prepareAccountStore({ version, log })
  } catch (error) {
    const refusal =
      error instanceof RuntimeLayoutRefusal
        ? error
        : new RuntimeLayoutRefusal(
            runtimeLayoutLocation().stateHomeDir,
            error instanceof Error ? error.name : typeof error,
          )
    if (!refusals.has(key)) {
      refusals.set(key, refusal)
      log.warn(refusal.message, {
        stateDir: refusal.stateDir,
        errorClass: refusal.errorClass,
      })
    }
    return refused(accountFile, refusals.get(key) ?? refusal)
  }
  return { accountFile, vaultDir: getVaultDir(accountFile) }
}

/**
 * The vault folder for code that runs after its entry point prepared: the
 * kept refusal, or the folder of the decided layout. A process that never
 * prepared follows the layout marker without taking a lock.
 */
export function currentVaultFolder(accountFile: string): VaultFolder {
  const kept = refusals.get(locationKey())
  return kept
    ? refused(accountFile, kept)
    : { accountFile, vaultDir: getVaultDir(accountFile) }
}

function refused(
  accountFile: string,
  refusal: RuntimeLayoutRefusal,
): VaultFolder {
  return { accountFile, vaultDir: getVaultDir(accountFile), refusal }
}
