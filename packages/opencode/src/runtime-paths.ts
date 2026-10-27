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
 * generation folders) stays in OpenCode's config folder in both layouts: it
 * records its own absolute paths and refuses to open anywhere else.
 *
 * So `state-home` in a heartbeat's `layouts` means "vault in the state home,
 * account store in the config folder". A later release that moves the account
 * store must not read a `state-home` heartbeat as "this process no longer
 * uses the config folder": it has to fence on version (every live process at
 * that release or newer), not on this layout value.
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getConfigDir } from './plugin/storage'
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
/** The account file's name in OpenCode's config folder. */
export const ACCOUNT_FILE_NAME = 'antigravity-accounts.json'

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

// The layout each config folder got in this process, once decided, and the
// locations computed so far. Kept on the global object because OpenCode 2 may
// load more than one copy of this bundle into one process, and every copy
// must resolve the same files.
const decisionsKey = Symbol.for('@cortexkit/antigravity-auth/runtime-layouts')
const decisionState = globalThis as typeof globalThis & {
  [decisionsKey]?: {
    decisions: Map<string, RuntimeLayout>
    locations: Map<string, RuntimeLayoutLocation>
  }
}
const shared = decisionState[decisionsKey] ?? {
  decisions: new Map<string, RuntimeLayout>(),
  locations: new Map<string, RuntimeLayoutLocation>(),
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

/** Test seam: forget every decided layout and cached location. */
export function __resetRuntimeLayoutsForTest(): void {
  shared.decisions.clear()
  shared.locations.clear()
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
 * `%APPDATA%\opencode`. This is the choice `getStoragePath()` in
 * `plugin/storage.ts` makes, minus its attempt to move the Windows file.
 */
export function legacyAccountFile(configDir: string = getConfigDir()): string {
  const standard = join(configDir, ACCOUNT_FILE_NAME)
  if (process.platform !== 'win32' || existsSync(standard)) return standard
  const windows = join(legacyWindowsConfigDir(), ACCOUNT_FILE_NAME)
  return existsSync(windows) ? windows : standard
}

/** The vault folder of the legacy layout: beside the account file. */
export function legacyVaultDir(accountFile: string): string {
  return join(dirname(accountFile), VAULT_DIR_NAME)
}

/** The vault folder of the state-home layout for one config folder. */
export function stateHomeVaultDir(location: RuntimeLayoutLocation): string {
  return join(location.stateHomeDir, VAULT_DIR_NAME)
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
    : legacyVaultDir(accountFile ?? legacyAccountFile(configDir))
}
