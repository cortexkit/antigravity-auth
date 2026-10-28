/**
 * Where the plugin's vault folder lives for one OpenCode config folder, and
 * the per-process decision about it.
 *
 * The vault folder (`antigravity-auth-vault/`: the enrollment token and
 * state, the vault roster, the vault provider state and the mode file) lives
 * in one of two places:
 * - the legacy layout: beside the account file, in OpenCode's config folder,
 *   where versions before the move kept it;
 * - the state-home layout: `<state home>/cortexkit/antigravity-auth/opencode/`
 *   for the config folder `<home>/.config/opencode`, and
 *   `<state home>/cortexkit/antigravity-auth/opencode-<hash>/` for any other
 *   one, so two config folders never share a file.
 * `runtime-layout.ts` decides which one, once per process, and moves the
 * files once; until a process has decided, the layout marker alone tells.
 *
 * The account store (`antigravity-accounts.json`, its pointer and its
 * generation folders) is anchored to a folder of its own, decided once per
 * process (`prepareRuntimeLayout` in `runtime-layout.ts`):
 * - `config`, beside the pool file in OpenCode's config folder, where every
 *   release so far kept it;
 * - `state-home`, in the state-home folder the vault moves to, which is
 *   where a release that can move the store keeps it.
 * A process that has not decided reads a forwarding pointer left in the
 * config folder (`readForwardedAccountStore`, written by the move) and
 * otherwise follows the config folder.
 *
 * So `state-home` in a heartbeat's `layouts` means "vault in the state home"
 * and says nothing about the account store; that is the `stores` record. A
 * process fences the store move on version (every live process at that
 * release or newer) and on each live process's `stores` record, never on
 * this layout value.
 */

import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  accountFileForVault,
  getConfigDir,
  resolveWindowsAccountAnchor,
} from './plugin/storage'
import { defaultStateHome } from './version-fence'

/** In the state-home folder: present once that folder is authoritative. */
export const RUNTIME_LAYOUT_MARKER_FILE = 'layout.json'
/** In every state-home runtime folder: names the config folder it belongs to. */
export const RUNTIME_CONFIG_DIR_NOTE_FILE = 'config-dir.json'
/**
 * The vault folder's name in both layouts. The same value as
 * `OPENCODE_VAULT_DIR_NAME` in `plugin/vault-custody.ts`; kept here so this
 * module does not load the vault code.
 */
export const VAULT_DIR_NAME = 'antigravity-auth-vault'
/** The account file's name, in whichever folder holds a store's anchor. */
export const ACCOUNT_FILE_NAME = 'antigravity-accounts.json'
/**
 * The suffix of the account store's pointer file. The pointer beside a pool
 * file path `P` is `P.store.pointer.json`; this module reads it to find a
 * forwarding pointer without loading the account-store code.
 */
export const ACCOUNT_STORE_POINTER_SUFFIX = '.store.pointer.json'

/**
 * A config folder's identity: its real path as the file system spells it
 * (symlinks resolved, on-disk case), or the resolved path when the folder
 * does not exist. Nothing else is normalized: case folding would merge two
 * distinct folders on a case-sensitive volume. This is the same string
 * `processConfigFolderKey()` in `process-heartbeat.ts` writes, so a key
 * recorded by 3.0.13 names the same folder.
 */
export function configDirIdentity(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** Both places a config folder's vault folder can live in. */
export interface RuntimeLayoutLocation {
  /** The config folder's identity (`configDirIdentity`). */
  key: string
  /** OpenCode's config folder, as `getConfigDir()` returns it. */
  configDir: string
  /** The state-home runtime folder for this config folder. */
  stateHomeDir: string
  /** True when the config folder is `<home>/.config/opencode`. */
  isDefaultConfigDir: boolean
}

export type RuntimeLayout = 'legacy' | 'state-home'

/**
 * Where a process keeps one config folder's account store: beside the pool
 * file in OpenCode's config folder (`config`), or in the state-home folder
 * the vault moves to (`state-home`). It is recorded for each config folder
 * in the process heartbeat (`stores` in `process-heartbeat.ts`), because a
 * store move waits while any live process still uses the config folder.
 */
export type AccountStoreAnchor = 'config' | 'state-home'

/** A vault-only process has not opened or chosen a local account store. */
export type HeartbeatStoreRecord = AccountStoreAnchor | 'undecided'

// The layout each config folder got in this process, once decided, and the
// locations computed so far. Kept on the global object because OpenCode 2 may
// load more than one copy of this bundle into one process, and every copy
// must resolve the same files.
const decisionsKey = Symbol.for('@cortexkit/antigravity-auth/runtime-layouts')
const decisionState = globalThis as typeof globalThis & {
  [decisionsKey]?: {
    decisions: Map<string, RuntimeLayout>
    locations: Map<string, RuntimeLayoutLocation>
    storeAnchors: Map<string, AccountStoreAnchor>
  }
}
const shared = decisionState[decisionsKey] ?? {
  decisions: new Map<string, RuntimeLayout>(),
  locations: new Map<string, RuntimeLayoutLocation>(),
  storeAnchors: new Map<string, AccountStoreAnchor>(),
}
decisionState[decisionsKey] = shared

function decisionKey(location: RuntimeLayoutLocation): string {
  return `${location.stateHomeDir}\0${location.key}`
}

/**
 * Where this config folder's vault folder lives in the state home. Only the
 * folder `<home>/.config/opencode` gets the plain `opencode/` folder; that is
 * decided from the home directory, not from XDG_CONFIG_HOME, so two
 * processes with different XDG_CONFIG_HOME values never share one. Every
 * other config folder gets `opencode-<first 16 hex of sha256(identity)>/`.
 *
 * `configDir` defaults to `getConfigDir()` from `plugin/storage.ts`, used
 * untrimmed, exactly as the account file and the 3.0.13 heartbeat use it.
 */
export function runtimeLayoutLocation(
  configDir: string = getConfigDir(),
): RuntimeLayoutLocation {
  const stateHome = defaultStateHome()
  const homeConfig = join(homedir(), '.config', 'opencode')
  const cacheKey = `${configDir}\0${homeConfig}\0${stateHome}`
  const cached = shared.locations.get(cacheKey)
  // Once this process has decided its layout the location is fixed for its
  // life; before that it is recomputed, since the folder may appear or turn
  // out to be a link.
  if (cached && shared.decisions.has(decisionKey(cached))) return cached
  const key = configDirIdentity(configDir)
  if (cached && cached.key === key) return cached
  const isDefaultConfigDir = key === configDirIdentity(homeConfig)
  const root = join(stateHome, 'cortexkit', 'antigravity-auth')
  const location: RuntimeLayoutLocation = {
    key,
    configDir,
    stateHomeDir: isDefaultConfigDir
      ? join(root, 'opencode')
      : join(
          root,
          `opencode-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        ),
    isDefaultConfigDir,
  }
  shared.locations.set(cacheKey, location)
  return location
}

/**
 * Fix this process's layout for a config folder. Only `runtime-layout.ts`
 * calls this, once per folder, while it holds the layout lock.
 */
export function setRuntimeLayout(
  location: RuntimeLayoutLocation,
  layout: RuntimeLayout,
): void {
  shared.decisions.set(decisionKey(location), layout)
}

/** The layout this process fixed for a config folder, if any. */
export function decidedRuntimeLayout(
  location: RuntimeLayoutLocation,
): RuntimeLayout | undefined {
  return shared.decisions.get(decisionKey(location))
}

/**
 * Fix the account store's anchor for a config folder. Only
 * `runtime-layout.ts` calls this, once per folder, while it holds the layout
 * lock.
 */
export function setAccountStoreAnchor(
  location: RuntimeLayoutLocation,
  anchor: AccountStoreAnchor,
): void {
  shared.storeAnchors.set(`${location.stateHomeDir}\0${location.key}`, anchor)
}

/**
 * The account store's anchor for a config folder, or undefined while this
 * process has not decided. OpenCode 1 and 2 locations of one process share
 * it: the decision is made once per config folder.
 */
export function decidedAccountStoreAnchor(
  location: RuntimeLayoutLocation,
): AccountStoreAnchor | undefined {
  return shared.storeAnchors.get(`${location.stateHomeDir}\0${location.key}`)
}

/** Test seam: forget every decided layout and cached location. */
export function __resetRuntimeLayoutsForTest(): void {
  shared.decisions.clear()
  shared.locations.clear()
  shared.storeAnchors.clear()
}

/**
 * The layout a config folder's vault folder is in for this process: the one
 * it decided, or, for a process that never decided (a tool that never
 * started the plugin), the marker read without taking any lock: the
 * state-home layout once the state-home folder holds the marker, the legacy
 * layout until then.
 */
export function currentRuntimeLayout(
  location: RuntimeLayoutLocation = runtimeLayoutLocation(),
): RuntimeLayout {
  return (
    decidedRuntimeLayout(location) ??
    (existsSync(join(location.stateHomeDir, RUNTIME_LAYOUT_MARKER_FILE))
      ? 'state-home'
      : 'legacy')
  )
}

/** The legacy Windows config folder, `%APPDATA%\opencode`. */
function legacyWindowsConfigDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'opencode',
  )
}

/**
 * The plugin's own folder in the state home,
 * `<state home>/cortexkit/antigravity-auth`, on every OS. It holds the
 * per-config-folder runtime folders, the signature cache and the default
 * debug log folder.
 */
export function pluginStateDir(): string {
  return join(defaultStateHome(), 'cortexkit', 'antigravity-auth')
}

/** The signature cache file's name, in both its old and its new folder. */
export const SIGNATURE_CACHE_FILE_NAME = 'antigravity-signature-cache.json'

/**
 * Where the signature cache lives by default: one file in the plugin's state
 * folder, shared by every config folder OpenCode uses.
 */
export function stateHomeSignatureCacheFile(): string {
  return join(pluginStateDir(), SIGNATURE_CACHE_FILE_NAME)
}

/**
 * Where versions before the move kept the signature cache: `%APPDATA%\opencode`
 * on Windows, `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` elsewhere.
 * That folder never followed OPENCODE_CONFIG_DIR. Nothing writes this file
 * any more; the move removes it once (`runtime-layout.ts`).
 */
export function legacySignatureCacheFile(): string {
  const configHome =
    process.platform === 'win32'
      ? legacyWindowsConfigDir()
      : join(
          process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
          'opencode',
        )
  return join(configHome, SIGNATURE_CACHE_FILE_NAME)
}

/**
 * The default debug log folder, used when neither OPENCODE_ANTIGRAVITY_LOG_DIR
 * nor the `log_dir` setting names one.
 */
export function stateHomeLogsDir(): string {
  return join(pluginStateDir(), 'logs')
}

/**
 * The account file a legacy-layout process uses for this config folder,
 * without changing anything on disk: `<config>/antigravity-accounts.json`,
 * except on Windows when that file is missing and one exists in
 * `%APPDATA%\opencode`. A store migrated at the `%APPDATA%\opencode` anchor
 * is found by its pointer there, the same choice `getStoragePath()` in
 * `plugin/storage.ts` makes, minus its attempt to move the Windows file.
 *
 * A forwarding pointer at that anchor names the store's new anchor, so this
 * is also where a process that has not decided discovers where the store is.
 */
export function legacyAccountFile(configDir: string = getConfigDir()): string {
  const standard = join(configDir, ACCOUNT_FILE_NAME)
  if (process.platform !== 'win32') return standard
  return resolveWindowsAccountAnchor(
    standard,
    join(legacyWindowsConfigDir(), ACCOUNT_FILE_NAME),
  )
}

/** The vault folder of the legacy layout: beside the account file. */
export function legacyVaultDir(accountFile: string): string {
  return join(dirname(accountFile), VAULT_DIR_NAME)
}

/** The vault folder of the state-home layout for one config folder. */
export function stateHomeVaultDir(location: RuntimeLayoutLocation): string {
  return join(location.stateHomeDir, VAULT_DIR_NAME)
}

/** The account file's path when the store stays in OpenCode's config folder. */
export function accountStorePointerPath(accountFile: string): string {
  return `${accountFile}${ACCOUNT_STORE_POINTER_SUFFIX}`
}

/**
 * The account file's path when the store lives in the state-home folder: the
 * same file name, in the folder the vault moves to. It is spelled with the
 * real path of that folder wherever it exists, because the account store
 * refuses a path whose folder goes through a link, and the state home often
 * does (`/var` on macOS, a linked `~/.local/state`).
 */
export function stateHomeAccountFile(location: RuntimeLayoutLocation): string {
  return join(realPathOrSelf(location.stateHomeDir), ACCOUNT_FILE_NAME)
}

/** `realpath` of `path`, or `path` when it does not exist yet. */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * True when `path` is spelled with every folder it sits in resolved through
 * any link. An account file must be: the store refuses one whose folder goes
 * through a link, so a store move waits until the user sets XDG_STATE_HOME to
 * the real path.
 */
export function folderResolvesToItself(path: string): boolean {
  let current = dirname(path)
  for (;;) {
    if (!existsSync(current)) {
      const parent = dirname(current)
      // Above the root, nothing is left to check: the missing part sits
      // below the real root and no link above it exists.
      if (parent === current) return true
      current = parent
      continue
    }
    if (realPathOrSelf(current) !== current) return false
    // An existing folder is enough: the parts below it do not exist yet.
    return true
  }
}

/** What a forwarding pointer at one anchor says. */
export interface ForwardedAccountStore {
  /** The anchor the store moved to, as the forward spells it. */
  legacyPath: string
  /** The generation id published at that anchor. */
  id: string
}

/**
 * The forwarding pointer at `anchor`, or undefined when there is none. A
 * pointer that cannot be read or parsed is not a forward: every account-store
 * reader decodes it again and refuses with its own reason, which is where a
 * damaged pointer must fail. A pointer of schema 1 (an unmoved store) is not a
 * forward either.
 */
export function readForwardedAccountStore(
  anchor: string,
): ForwardedAccountStore | undefined {
  let text: string
  try {
    text = readFileSync(accountStorePointerPath(anchor), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text) as {
      schemaVersion?: unknown
      relocatedTo?: { legacyPath?: unknown; id?: unknown } | null
    } | null
    if (value?.schemaVersion !== 2) return undefined
    const target = value.relocatedTo
    if (!target || typeof target.legacyPath !== 'string') return undefined
    if (typeof target.id !== 'string') return undefined
    return { legacyPath: target.legacyPath, id: target.id }
  } catch {
    return undefined
  }
}

/**
 * The anchor one folder's store is read at by a process that has not decided
 * its own: the forward left beside the pool file in the config folder names
 * the anchor the store moved to, and otherwise the store is where every
 * release before the move kept it (the config folder, or the legacy Windows
 * folder its pointer lives in).
 */
export function discoveredAccountFile(
  location: RuntimeLayoutLocation = runtimeLayoutLocation(),
): string {
  const configAnchor = legacyAccountFile(location.configDir)
  return readForwardedAccountStore(configAnchor)?.legacyPath ?? configAnchor
}

/**
 * Whether the file or folder `path` exists, following no link: a broken link
 * counts as present, so a caller never treats one as a fresh install.
 */
export async function pathPresent(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * The folder holding this config folder's vault files, for this process:
 * the state-home vault folder in the state-home layout, and the folder beside
 * `accountFile` in the legacy layout.
 */
export function getVaultDir(
  accountFile?: string,
  configDir: string = getConfigDir(),
): string {
  const location = runtimeLayoutLocation(configDir)
  return currentRuntimeLayout(location) === 'state-home'
    ? stateHomeVaultDir(location)
    : legacyVaultDir(accountFile ?? accountFileForVault(configDir))
}
