// Moves the plugin's vault files out of OpenCode's config folder, once.
//
// OpenCode 2 watches its config folder, and the plugin rewrites its vault
// files there every few seconds: the vault roster, the vault provider state
// and the enrollment files, each with lock files, eviction markers and staged
// temporary files. They move to the state home (`runtime-paths.ts` names both
// folders). `antigravity.json` and the TUI preferences stay in OpenCode's
// config folder.
//
// The account store (`antigravity-accounts.json`, its pointer and its
// generation folders) moves to the state home as well, but as a separate,
// offline operation: `prepareRuntimeLayout` decides once per process where
// this config folder keeps it (`prepareAccountStore`), moving it only while
// no other live process could still be using it in the config folder (the
// `storeMove` fence of `version-fence.ts`, which reads each process's
// heartbeat `stores` record). When that is not safe the process keeps the
// config folder for its whole life and logs why once. Setup and
// `antigravity-auth store relocate [--back] --offline` run the same move
// outside a start. The store's own operation is core's relocation
// (`createAccountRelocationFactory`); this module only decides when and
// between which two anchors.
//
// This is a port of openai-auth's `runtime-layout.ts`, with these changes:
// only the five `opencode-*` vault files below move (Pi's files can share the
// vault folder and are never touched); the move holds the vault's own locks;
// there is no state-file override and no sessions file; an existing,
// non-private destination vault folder on Windows keeps the legacy layout.
//
// The rules:
// - A process fixes its layout for a config folder once, at plugin start,
//   before it builds the vault, and never switches while it runs. A live
//   switch would race the writes the process already has in flight against
//   the old paths.
// - `layout.json` in the state-home folder makes that folder authoritative.
//   Without it, any old vault file keeps the config folder authoritative;
//   with no old file either (a fresh install) the marker is written straight
//   away. `config-dir.json` names the config folder the state-home folder
//   belongs to; a folder that names another one is refused and left alone.
// - The move, and the fresh install's marker, wait while any other live
//   process could still use the old files: one that runs an older version, or
//   one on the legacy layout (its heartbeat says so, `process-heartbeat.ts`).
//   A process that starts while one of those is alive takes the legacy layout
//   too. So the move happens at the first start after every OpenCode using
//   that config folder has been closed or restarted on this version.
// - The account store's anchor is settled after the vault layout, in the same
//   call and under the same lock, and recorded in the heartbeat before this
//   process uses it, so a store move elsewhere waits for this process too.
// - Every decision is made holding the layout lock in the state-home folder.
//   A legacy choice is allowed only once it is in this process's heartbeat,
//   written while that lock is held, so a process deciding later sees it. A
//   process that cannot take the lock or write that record refuses to start
//   (`RuntimeLayoutRefusal`) rather than run unseen on the old files.
// - The move holds the layout lock, then the vault's own locks at the old
//   files: `ceremony` at the enrollment state, `claustrum-roster-write` at
//   the roster and `antigravity-vault-state` at the provider state, the order
//   every vault writer takes them in. Under all of them it reads the
//   heartbeats again, refuses when an old file and its new place are one
//   physical file, and refuses when the state-home vault folder holds a vault
//   file that is not one of the copies an unfinished move listed in
//   `layout-moving.json`. Each file is copied owner-only and made durable,
//   read back and compared byte for byte; the marker is written once every
//   copy is verified, and only then are the old files removed, each one
//   after comparing its bytes with its copy once more. A crash before the
//   marker leaves the old files authoritative and the next start copies
//   again over the partial new ones. A crash after it leaves the new files
//   authoritative; the next
//   start takes the same locks, reads the heartbeats again under them, and
//   removes old copies identical to the new ones. A differing old file, or a
//   copy that cannot be read, refuses the start: every vault file counts as a
//   credential. An identical old file that cannot be removed (Windows may
//   hold a file open), or that Windows keeps open so it cannot be compared,
//   is logged once as a clean-up failure, not refused: the marker then does
//   not record the old files as dealt with, so the next start tries the
//   removal again. Once the marker records that the old files are dealt
//   with, old vault files that reappear later refuse the start.
// - An enrollment that keeps the host in vault mode (approved, or blocked
//   because its token is missing) keeps one old file: the enrollment state
//   file stays in the old vault folder, byte for byte the copy that moved,
//   and only the old token is removed. Every version reads such a state
//   without a token as vault mode with a missing token, never as local, so an
//   older version that still looks in the config folder refuses requests
//   instead of serving local accounts. Later starts accept vault mode there
//   whether or not an older version has since rewrote that file
//   (`isVaultShapedKeptState`); the marker's SHA-256 of it (`keptVaultState`)
//   is no longer compared. An older version's reconcile turns an approved
//   state into `blocked missing_token`, and a file at that path holds no
//   secret, so the file is re-read and accepted while it still names this
//   plugin's enrollment, has no token beside it, and is pending in neither
//   direction. Anything else at that path is a conflict like any other
//   reappeared file. Disconnect on this version removes such a leftover
//   (`removeMovedVaultStateLeftover`). A pending or denied enrollment state
//   protects nothing and is removed like the other files. Until the old
//   files are dealt with, though, a marker that records `keptVaultState`
//   says the move left that file on purpose: an old state file identical to
//   its state-home copy then stays even when the re-read rejects it, since
//   removing it would let an older version read this host as local.
// - The layout lock is checked again right before every destructive step:
//   each unlink attempt of an old file, the removal of `layout-moving.json`
//   and of the old vault folder. `layout-moving.json` is the last thing a
//   move removes, and one left behind is removed at the next start, under
//   the lock. A move that fails leaves the process on the legacy layout
//   (registered) and logs the error class once; the next start tries again.
//   Nothing here runs on a request.
// - The signature cache moved to the state home as well, but it is a cache:
//   it is recreated there, not copied. The old file in OpenCode's config
//   folder (`legacySignatureCacheFile`) is deleted once, in the same
//   clean-up step that records the old vault files as dealt with.

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  accountStorePointerPath,
  type CommonAuthClaustrumModule,
  type CommonAuthFsModule,
  createAccountRelocationFactory,
  initializeFreshAccountStore,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'
import { createLogger } from './plugin/logger'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
} from './plugin/vault-custody'
import { recordProcessAnchor, recordProcessLayout } from './process-heartbeat'
import {
  type AccountStoreAnchor,
  decidedAccountStoreAnchor,
  decidedRuntimeLayout,
  folderResolvesToItself,
  legacyAccountFile,
  legacySignatureCacheFile,
  legacyVaultDir,
  pathPresent,
  RUNTIME_CONFIG_DIR_NOTE_FILE,
  RUNTIME_LAYOUT_MARKER_FILE,
  type RuntimeLayout,
  type RuntimeLayoutLocation,
  readForwardedAccountStore,
  runtimeLayoutLocation,
  setAccountStoreAnchor,
  setRuntimeLayout,
  stateHomeAccountFile,
  stateHomeVaultDir,
} from './runtime-paths'
import { type VersionFenceResult, versionFenceOpen } from './version-fence'

export type { RuntimeLayout }

type RefreshFileLock = NonNullable<
  Awaited<ReturnType<CommonAuthFsModule['acquireRefreshFileLock']>>
>

/** Name of the lock held while a process decides or moves the layout. */
export const RUNTIME_LAYOUT_LOCK_NAME = 'runtime-layout'
/** Lists the copies an unfinished move has put in the state-home folder. */
export const RUNTIME_LAYOUT_MANIFEST_FILE = 'layout-moving.json'

/**
 * The enrollment state file. A move leaves it in the old folder when it keeps
 * the host in vault mode without its token (approved, or blocked because the
 * token is missing).
 */
export const VAULT_ENROLLMENT_STATE_FILE = 'opencode-enrollment-state.json'

/** The enrollment token file, the one vault file a kept state must not sit beside. */
const VAULT_ENROLLMENT_TOKEN_FILE = 'opencode-enrollment.json'

/**
 * The vault files that move, and the only ones the move ever reads, copies,
 * compares or removes in either vault folder. Anything else there (Pi's
 * files, when Pi's account file points into OpenCode's config folder, or a
 * file a later library version adds) is left alone; a new vault file has to
 * be added here on purpose.
 */
export const VAULT_FILE_NAMES = [
  VAULT_ENROLLMENT_TOKEN_FILE,
  VAULT_ENROLLMENT_STATE_FILE,
  'opencode-roster.json',
  'opencode-state.json',
  'opencode-mode.json',
] as const

/** Every lease this module takes lasts this long and is renewed while held. */
const LOCK_TTL_MS = 10_000

/**
 * The vault's own locks, in the order its writers take them: the enrollment
 * ceremony (`claustrum/enrollment.js`), the roster write
 * (`claustrum/roster.js`), then the provider state
 * (`vault-provider-state.ts`). Each waits for the writer's lease to run out
 * plus 5 s: a crashed writer's ceremony lease lasts 30 s, the others 10 s.
 * `opencode-mode.json` has no lock; the comparison before its unlink covers
 * it.
 */
const DATA_LOCKS = [
  { name: 'ceremony', file: VAULT_ENROLLMENT_STATE_FILE, waitMs: 35_000 },
  {
    name: 'claustrum-roster-write',
    file: 'opencode-roster.json',
    waitMs: 15_000,
  },
  {
    name: 'antigravity-vault-state',
    file: 'opencode-state.json',
    waitMs: 15_000,
  },
] as const

/**
 * How long a starting process waits for the layout lock: 75 seconds. A move
 * holding it may wait for each data lock in turn (35 s + 15 s + 15 s), and a
 * crashed holder's lease ends after `LOCK_TTL_MS` (10 s).
 */
const LAYOUT_LOCK_WAIT_MS =
  DATA_LOCKS.reduce((sum, lock) => sum + lock.waitMs, 0) + LOCK_TTL_MS
const LOCK_RETRY_MS = 50
/** A wait for a lock longer than this is logged once, naming the lock. */
const LOCK_WAIT_NOTICE_MS = 1_000
/** A marker read that fails for a reason other than absence is retried. */
const MARKER_READ_ATTEMPTS = 5
const MARKER_READ_RETRY_MS = 50
// The same budget common-auth's `replaceWindowsFile` gives a rename that
// Windows refuses because another process has the file open.
const SHARING_RETRY_DELAYS_MS = [0, 10, 20, 40, 80, 100]
const SHARING_RETRY_BUDGET_MS = 500

/** The message logged once by a process that keeps the legacy layout. */
export const RUNTIME_LAYOUT_DEFERRED_MESSAGE =
  "antigravity-auth keeps its vault files in OpenCode's config folder until every running OpenCode using it has restarted on this version."

/**
 * The message logged once, in plain words, by a process that keeps the
 * account store in OpenCode's config folder because another live OpenCode
 * could still be using it there.
 */
export const ACCOUNT_STORE_DEFERRED_MESSAGE =
  "antigravity-auth keeps the account store in OpenCode's config folder until every running OpenCode using it has restarted on this version."

/**
 * The message logged once by a process that keeps the account store in
 * OpenCode's config folder because the state-home folder's path goes through
 * a link, which the account store refuses to open a file through.
 */
export const ACCOUNT_STORE_LINKED_PATH_MESSAGE =
  "antigravity-auth keeps the account store in OpenCode's config folder because the path to its state folder goes through a link. Setting XDG_STATE_HOME to the real path of that folder lets it move there."

/**
 * Plugin start stops when it cannot settle a safe layout: it could not take
 * the layout lock or write its heartbeat (so other processes could not see
 * which files it uses), could not trust the marker, found conflicting vault
 * files, or found a state-home folder owned by another config folder.
 */
export class RuntimeLayoutRefusal extends Error {
  constructor(
    readonly stateDir: string,
    readonly errorClass: string,
    message = refusalMessage(stateDir, errorClass),
  ) {
    super(message)
    this.name = 'RuntimeLayoutRefusal'
  }
}

function refusalMessage(stateDir: string, errorClass: string): string {
  // The private-files check refused the folder itself: it is a link, or
  // others can reach it. Creating or writing it is not the problem.
  if (errorClass === 'ERR_PRIVATE_FILES_SECURITY')
    return `antigravity-auth cannot start: ${stateDir} is not a folder only your user can access, or it is a link, so the plugin will not use it (${errorClass}). Replace it with a plain folder of your own, then restart OpenCode.`
  return `antigravity-auth cannot start: it could not settle where its vault files live in ${stateDir} (${errorClass}). Check that this folder can be created and written by your user, then restart OpenCode.`
}

function foreignFolder(stateDir: string, identity: string) {
  return new RuntimeLayoutRefusal(
    stateDir,
    'foreign-folder',
    `antigravity-auth cannot start: ${stateDir} belongs to another OpenCode config folder, not ${identity}. It was left untouched. Move it aside, then restart OpenCode.`,
  )
}

/**
 * What to do about a `layout.json` that cannot be trusted: check whether the
 * old vault files are still in OpenCode's config folder; delete `layout.json`
 * only if they are (the next start then decides again), and otherwise keep
 * the runtime folder as it is.
 */
function markerRemedy(markerPath: string, oldVaultDir: string): string {
  return `Check that the old vault files are still in ${oldVaultDir}. If they are, delete ${markerPath}, then restart OpenCode; if they are not, keep ${dirname(markerPath)} as it is.`
}

/** A `layout.json` that records a move from another config folder. */
function foreignMarker(
  markerPath: string,
  identity: string,
  oldVaultDir: string,
) {
  return new RuntimeLayoutRefusal(
    dirname(markerPath),
    'foreign-marker',
    `antigravity-auth cannot start: ${markerPath} belongs to another OpenCode config folder, not ${identity}, so it cannot tell whether this folder's vault files were moved. ${markerRemedy(markerPath, oldVaultDir)}`,
  )
}

function credentialConflict(stateDir: string, file: LayoutFile) {
  return new RuntimeLayoutRefusal(
    stateDir,
    'credential-conflict',
    `antigravity-auth cannot start: vault files conflict between ${file.old} and ${file.next}. Keep the newer one, delete the other, then restart OpenCode.`,
  )
}

/**
 * Where this module reports what it did. `log` writes a line a user may want
 * to see (a move happened, a deferral said why once); `info` and `warn` are
 * the diagnostic stream. A logger that has no `log` reports information to
 * `info`.
 */
export interface RuntimeLayoutLogger {
  log?(message: string, meta?: Record<string, unknown>): unknown
  info(message: string, meta?: Record<string, unknown>): unknown
  warn(message: string, meta?: Record<string, unknown>): unknown
}

export interface RuntimeLayoutOptions {
  /** This build's version, for the version fence. */
  version: string
  log?: RuntimeLayoutLogger
  /**
   * The account file a legacy-layout process of this config folder uses;
   * the old vault folder is beside it. Defaults to `legacyAccountFile()`.
   */
  accountFile?: string
  /** Defaults to `versionFenceOpen` for `version`, with the layout checks. */
  fence?: () => Promise<VersionFenceResult>
  /**
   * Whether an existing destination vault folder may be written into.
   * Defaults to the private-files check on Windows (a folder this module did
   * not create is never repaired) and to true elsewhere, where the move sets
   * the folder to 0700 itself.
   */
  destinationPrivate?: (dir: string) => Promise<boolean>
  /**
   * Test seams, run at one step of the move. A step that throws stands in for
   * a crash there: nothing after it runs.
   */
  steps?: {
    afterManifest?: () => void | Promise<void>
    afterCopy?: () => void | Promise<void>
    afterMarker?: () => void | Promise<void>
    /**
     * Runs right before each removal of an old file, of the move's
     * `layout-moving.json` and of the old vault folder, ahead of the lease
     * check that guards it.
     */
    beforeRemove?: (path: string) => void | Promise<void>
  }
  /** Test seam: how long to wait for the layout lock. */
  layoutLockWaitMs?: number
  /**
   * The signature cache file older versions wrote in OpenCode's config
   * folder. Defaults to `legacySignatureCacheFile()`.
   */
  oldSignatureCacheFile?: string
  /**
   * Test seam: run the account-store move by hand instead of the genuine
   * offline relocation (`runStoreMove`). The move is the only operation that
   * runs while the layout lock is held, and replacing it keeps this module's
   * own tests about paths and decisions.
   */
  relocate?: (input: StoreMoveInput) => Promise<StoreMoveResult>
  /** Test seam: the store fence; defaults to `versionFenceOpen` with `storeMove`. */
  storeFence?: () => Promise<VersionFenceResult>
}

interface LayoutMarker {
  version: 1
  /** The identity of the config folder the files came from. */
  oldDir?: string
  /** Set once the old files were removed or knowingly left in place. */
  oldFilesRemoved?: boolean
  /**
   * SHA-256 (hex) of the vault-mode enrollment state file the move left in
   * the old vault folder; absent when the move left none there. The hash is
   * not compared: acceptance of that leftover re-reads its contents
   * (`isVaultShapedKeptState`). Whether it is set still matters to the
   * clean-up before `oldFilesRemoved` (`removeOldCopies`).
   */
  keptVaultState?: string
}

/** One vault file and where it lives in each layout. */
interface LayoutFile {
  old: string
  next: string
}

/** The vault folder of one config folder, in both layouts. */
interface LayoutFiles {
  vault: { old: string; next: string }
}

// Per-process bookkeeping, on the global object because OpenCode 2 may load
// more than one copy of this bundle into one process.
const stateKey = Symbol.for('@cortexkit/antigravity-auth/runtime-layout-runs')
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: {
    runs: Map<string, Promise<RuntimeLayout>>
    storeRuns: Map<string, Promise<AccountStoreAnchor>>
    logged: Set<string>
  }
}
const processState = globalState[stateKey] ?? {
  runs: new Map<string, Promise<RuntimeLayout>>(),
  storeRuns: new Map<string, Promise<AccountStoreAnchor>>(),
  logged: new Set<string>(),
}
globalState[stateKey] = processState

/** Test seam: forget this process's runs and log lines. */
export function __resetRuntimeLayoutRunsForTest(): void {
  processState.runs.clear()
  processState.storeRuns.clear()
  processState.logged.clear()
}

function logOnce(key: string, write: () => void): void {
  if (processState.logged.has(key)) return
  processState.logged.add(key)
  write()
}

function errorClass(error: unknown): string {
  if (error instanceof RuntimeLayoutRefusal) return error.errorClass
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  return error instanceof Error ? error.name : typeof error
}

/**
 * The name of the file an error is about, without its folder, and the
 * private-file stage when there is one, for a log line.
 */
function errorFile(error: unknown): { file?: string; stage?: string } {
  const { path, stage } = (error ?? {}) as { path?: unknown; stage?: unknown }
  return {
    ...(typeof path === 'string' && path ? { file: basename(path) } : {}),
    ...(typeof stage === 'string' && stage ? { stage } : {}),
  }
}

class LayoutMoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LayoutMoveError'
  }
}

/**
 * An old vault file identical to its new copy that could not be removed, or
 * that Windows kept open so it could not be compared. Not a refusal: the
 * start goes on in the state home, and the marker is left without
 * `oldFilesRemoved` so the next start removes it. `path` is the first such
 * file, for the log line.
 */
class OldVaultFileKeptError extends LayoutMoveError {
  constructor(readonly path: string) {
    super('old-files-kept', `${path} could not be removed`)
  }
}

/** The one warning for old files a move or a later start failed to remove. */
function logCleanupFailure(
  location: RuntimeLayoutLocation,
  log: RuntimeLayoutLogger,
  step: string,
  error: unknown,
): void {
  logOnce(`${location.key}\0cleanup`, () =>
    log.warn(
      "antigravity-auth could not finish removing its old vault files from OpenCode's config folder; it tries again at the next start",
      {
        configDir: location.configDir,
        step,
        errorClass: errorClass(error),
        ...errorFile(error),
      },
    ),
  )
}

/**
 * Decide, once per process, where this config folder's vault files live,
 * moving them first when that is safe. Call at plugin start before anything
 * resolves a vault path. Resolves to the layout `getVaultDir()` in
 * `runtime-paths.ts` now uses; rejects with `RuntimeLayoutRefusal` when the
 * plugin must not start.
 */
export function prepareRuntimeLayout(
  options: RuntimeLayoutOptions,
): Promise<RuntimeLayout> {
  const location = runtimeLayoutLocation()
  const decided = decidedRuntimeLayout(location)
  if (decided) return Promise.resolve(decided)
  const runKey = `${location.stateHomeDir}\0${location.key}`
  let run = processState.runs.get(runKey)
  if (!run) {
    run = decide(location, options)
      .catch((error: unknown) => {
        // Anything not handled on the way stops the start the same way.
        if (error instanceof RuntimeLayoutRefusal) throw error
        throw new RuntimeLayoutRefusal(location.stateHomeDir, errorClass(error))
      })
      .finally(() => {
        processState.runs.delete(runKey)
      })
    processState.runs.set(runKey, run)
  }
  return run
}

async function decide(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
): Promise<RuntimeLayout> {
  const log = options.log ?? createLogger('runtime-layout')
  const stateDir = location.stateHomeDir
  const markerPath = join(stateDir, RUNTIME_LAYOUT_MARKER_FILE)
  const files = layoutFiles(location, options.accountFile)
  const fence = options.fence ?? defaultFence(options.version)

  const stateHome = async (): Promise<RuntimeLayout> => {
    await settleVault(location, options, 'state-home', log)
    return 'state-home'
  }

  // Read-only first: whose folder this is, and whether the move is done.
  let marker = await readMarker(markerPath, stateDir, files.vault.old)
  await assertOwnFolder(location, marker, files)
  if (marker?.oldFilesRemoved) {
    await refuseReappearedFiles(location, files)
    // A move that stopped right after its last marker write left its
    // `layout-moving.json`; it is removed below, under the layout lock.
    const manifestLeft = await exists(
      join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE),
    ).catch(() => true)
    if (!manifestLeft) {
      await settleVault(location, options, 'state-home', log)
      return stateHome()
    }
  }

  // A state-home folder that is OpenCode's config folder itself (a link or a
  // mount) gets no chmod or note of its own; the move then stays legacy.
  const aliased = await samePhysical(location.configDir, stateDir)
  let layoutLock: RefreshFileLock
  try {
    if (!aliased) await ensureOwnerOnlyDir(stateDir)
    layoutLock = await takeLock(
      RUNTIME_LAYOUT_LOCK_NAME,
      markerPath,
      options.layoutLockWaitMs ?? LAYOUT_LOCK_WAIT_MS,
      log,
    )
  } catch (error) {
    // Only an existing marker settles the layout without the lock.
    marker = await readMarker(markerPath, stateDir, files.vault.old)
    if (marker) {
      if (marker.oldFilesRemoved) await refuseReappearedFiles(location, files)
      return stateHome()
    }
    if (error instanceof LayoutMoveError && error.code === 'lock-timeout')
      throw new RuntimeLayoutRefusal(
        stateDir,
        'lock-timeout',
        `antigravity-auth cannot start: ${error.message} Try again, or restart OpenCode, once that OpenCode has finished the move.`,
      )
    throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
  }

  const lock = layoutLock
  const legacy = async (): Promise<RuntimeLayout> => {
    try {
      await lock.assertOwned()
      await settleVault(location, options, 'legacy', log)
    } catch (error) {
      throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
    }
    return 'legacy'
  }

  try {
    marker = await readMarker(markerPath, stateDir, files.vault.old)
    await assertOwnFolder(location, marker, files)
    if (!aliased) await writeOwnerNote(location)

    if (marker) {
      if (!marker.oldFilesRemoved && !aliased)
        await finishOldFiles(location, files, markerPath, marker, lock, {
          fence,
          log,
          steps: options.steps,
          oldSignatureCache:
            options.oldSignatureCacheFile ?? legacySignatureCacheFile(),
        })
      else if (marker.oldFilesRemoved) {
        await refuseReappearedFiles(location, files)
        await removeLeftoverManifest(location, lock, options.steps, log)
      }
      return await stateHome()
    }
    if (aliased) {
      logOnce(`${location.key}\0aliased`, () =>
        log.warn(
          "antigravity-auth keeps its vault files in OpenCode's config folder: its state folder is that same folder",
          { configDir: location.configDir, stateDir },
        ),
      )
      return await legacy()
    }
    const gate = await fence()
    if (!gate.open) {
      logDeferral(location, gate.blockers, log)
      return await legacy()
    }

    let markerStarted = false
    try {
      const outcome = await moveFiles(location, files, markerPath, lock, {
        fence,
        log,
        steps: options.steps,
        destinationPrivate:
          options.destinationPrivate ?? defaultDestinationPrivate,
        oldSignatureCache:
          options.oldSignatureCacheFile ?? legacySignatureCacheFile(),
        onMarker: () => {
          markerStarted = true
        },
      })
      if (outcome.kind === 'deferred') {
        logDeferral(location, outcome.blockers, log)
        return await legacy()
      }
      if (outcome.kind === 'refused') {
        logOnce(`${location.key}\0refused`, () =>
          log.warn(
            outcome.reason === 'destination-not-private'
              ? "antigravity-auth keeps its vault files in OpenCode's config folder: the vault folder in its state folder already exists and is not private to your user. It was left unchanged; remove it if it holds nothing you need, then restart OpenCode."
              : "antigravity-auth keeps its vault files in OpenCode's config folder: it will not move them",
            { reason: outcome.reason, paths: outcome.paths, stateDir },
          ),
        )
        return await legacy()
      }
      if (outcome.moved)
        log.info(
          "antigravity-auth moved its vault files out of OpenCode's config folder",
          { from: files.vault.old, to: files.vault.next },
        )
      return await stateHome()
    } catch (error) {
      if (error instanceof RuntimeLayoutRefusal) throw error
      // Once the marker write began, the marker on disk decides.
      if (
        markerStarted &&
        (await readMarker(markerPath, stateDir, files.vault.old))
      )
        return await stateHome()
      logOnce(`${location.key}\0failed`, () =>
        log.warn(
          "antigravity-auth's vault files stay in OpenCode's config folder: moving them failed; the move is tried again at the next start",
          {
            configDir: location.configDir,
            errorClass: errorClass(error),
            ...errorFile(error),
          },
        ),
      )
      return await legacy()
    }
  } finally {
    await lock.release().catch(() => {})
  }
}

function defaultFence(version: string) {
  return () => versionFenceOpen({ currentVersion: version, layoutMove: true })
}

/**
 * Record and fix this process's vault layout, then decide where its account
 * store lives and move it there when that is safe. Runs under the layout
 * lock. The vault layout comes first because the store's new anchor is the
 * folder the state-home layout names, and because a store move must never
 * run before every other process has been told where this one's vault files
 * are.
 */
async function settleVault(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  layout: RuntimeLayout,
  log: RuntimeLayoutLogger,
): Promise<void> {
  await recordProcessLayout({
    key: location.key,
    layout,
    version: options.version,
  })
  setRuntimeLayout(location, layout)
  await settleAccountStore(location, options, log)
}

/**
 * Decides, once per process, where this config folder's account store
 * lives, and moves it into the state-home folder when that is safe. Call at
 * plugin start after `prepareRuntimeLayout`, which calls it while it holds
 * the layout lock; a process that already settled its anchor keeps it.
 * Resolves to the anchor `getStoragePath()` in `plugin/storage.ts` now uses.
 *
 * A store move runs only when every account store of this config folder is
 * at the config folder anchor, no other live process could still be using it
 * there (the `storeMove` fence, which also reads each heartbeat's `stores`),
 * the state-home folder's path resolves through no link, and the store's own
 * locks are free. Otherwise this process keeps the config folder for its
 * whole life and says why once: a deferral is never a refusal.
 */
export async function prepareAccountStore(
  options: RuntimeLayoutOptions,
): Promise<AccountStoreAnchor> {
  const location = runtimeLayoutLocation()
  const log = options.log ?? createLogger('runtime-layout')
  const runKey = `${location.stateHomeDir}\0${location.key}`
  let run = processState.storeRuns.get(runKey)
  if (!run) {
    run = settleAccountStore(location, options, log).finally(() => {
      processState.storeRuns.delete(runKey)
    })
    processState.storeRuns.set(runKey, run)
  }
  return run
}

async function settleAccountStore(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  log: RuntimeLayoutLogger,
): Promise<AccountStoreAnchor> {
  const decided = decidedAccountStoreAnchor(location)
  if (decided) return decided
  const anchor = await decideAccountStore(location, options, log)
  setAccountStoreAnchor(location, anchor)
  return anchor
}

async function decideAccountStore(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  log: RuntimeLayoutLogger,
): Promise<AccountStoreAnchor> {
  const keepConfig = () => recordAnchor(location, options, 'config', log)
  const configAnchor = legacyAccountFile(location.configDir)
  const stateAnchor = stateHomeAccountFile(location)
  const forward = readForwardedAccountStore(configAnchor)

  if (forward) {
    // A forward names where the store went. This process can use that anchor
    // only when it is the one this config folder resolves to; otherwise
    // neither store is served (an error, never an empty store).
    if (!sameSpelling(forward.legacyPath, stateAnchor)) {
      logOnce(`${location.key}\0store-forward-elsewhere`, () =>
        log.warn(
          'the account store moved to another folder than this process resolved; check XDG_STATE_HOME',
          { movedTo: forward.legacyPath, expected: stateAnchor },
        ),
      )
    }
    // A moved store is usable only once its relocation finished; the store's
    // own operation resumes or cancels an unfinished one.
    await resumeForwardedStore(
      location,
      options,
      configAnchor,
      stateAnchor,
      log,
    )
    return recordAnchor(location, options, 'state-home', log)
  }

  const configStore = await presentAccountStore(configAnchor)
  const stateStore = await presentAccountStore(stateAnchor)
  if (configStore && stateStore) {
    // Two stores and no forward saying which one is current: refuse rather
    // than pick by age and split the accounts.
    throw new RuntimeLayoutRefusal(
      location.stateHomeDir,
      'two-account-stores',
      `antigravity-auth cannot start: two account stores exist, one at ${configAnchor} and one at ${stateAnchor}, and neither is marked as moved. Keep the one you want and move the other one aside, then restart OpenCode.`,
    )
  }
  if (stateStore) return recordAnchor(location, options, 'state-home', log)
  if (configStore) {
    if (!(await storeMovePathResolves(stateAnchor, location, log)))
      return keepConfig()
    return moveStore(location, options, configAnchor, stateAnchor, false, log)
  }

  // Nothing published at either anchor: a fresh installation initializes at
  // the state-home anchor and leaves a forward at the config anchor, so a
  // version without the store move refuses instead of creating a second
  // store. A store that stopped before publishing its pointer starts over,
  // exactly as an existing one would be moved.
  if (
    (await storeArtefacts(stateAnchor)) > 0 &&
    !(await abandonUnpublishedStore(location, stateAnchor, log))
  )
    return keepConfig()
  if (!(await storeMovePathResolves(stateAnchor, location, log)))
    return keepConfig()
  return initializeStore(location, options, stateAnchor, log)
}

/** A line a user may want to see: `log`, or `info` when the logger has none. */
function showLog(
  log: RuntimeLayoutLogger,
  message: string,
  meta: Record<string, unknown>,
): void {
  if (log.log) log.log(message, meta)
  else log.info(message, meta)
}

/** Record this process's store anchor and return it. */
async function recordAnchor(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  anchor: AccountStoreAnchor,
  log: RuntimeLayoutLogger,
): Promise<AccountStoreAnchor> {
  try {
    await recordProcessAnchor({
      key: location.key,
      anchor,
      version: options.version,
    })
  } catch (error) {
    throw new RuntimeLayoutRefusal(location.stateHomeDir, errorClass(error))
  }
  if (anchor === 'state-home')
    showLog(
      log,
      'antigravity-auth keeps its account store in its state folder',
      { accountStore: anchor },
    )
  return anchor
}

/**
 * Whether the store may move into the state-home folder's path: that path
 * must resolve through no link, because the account store refuses a file
 * whose folder goes through one. Says so once when it does not.
 */
async function storeMovePathResolves(
  stateAnchor: string,
  location: RuntimeLayoutLocation,
  log: RuntimeLayoutLogger,
): Promise<boolean> {
  if (folderResolvesToItself(stateAnchor)) return true
  logOnce(`${location.key}\0store-linked-path`, () =>
    log.warn(ACCOUNT_STORE_LINKED_PATH_MESSAGE, {
      accountStore: stateAnchor,
      stateFolder: location.stateHomeDir,
    }),
  )
  return false
}

/** Whether the store fence is open, with its one deferral log line. */
async function storeFenceOpen(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  log: RuntimeLayoutLogger,
): Promise<boolean> {
  const gate = await (
    options.storeFence ?? defaultStoreFence(options.version)
  )()
  if (gate.open) return true
  logOnce(`${location.key}\0store-version-fence`, () =>
    log.info(ACCOUNT_STORE_DEFERRED_MESSAGE, {
      configDir: location.configDir,
      blockers: gate.blockers,
    }),
  )
  return false
}

function defaultStoreFence(version: string) {
  return () => versionFenceOpen({ currentVersion: version, storeMove: true })
}

function sameSpelling(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * Whether anything is published at one anchor: a pointer of either schema, a
 * pool file, or a store folder. A pointer that does not read as a forward
 * still counts: its own reader refuses it, and no move starts over it.
 */
async function presentAccountStore(anchor: string): Promise<boolean> {
  return (
    (await pathPresent(accountStorePointerPath(anchor))) ||
    (await pathPresent(anchor))
  )
}

/** The account store's folder beside one anchor. */
function storeFolder(anchor: string): string {
  return `${anchor}.store`
}

/**
 * How many leftovers an unpublished store left beside an anchor: its logical
 * store folder, a generation folder, or one of its pointer stages.
 */
async function storeArtefacts(anchor: string): Promise<number> {
  const names = await readdir(dirname(anchor)).catch(() => [] as string[])
  const store = basename(storeFolder(anchor))
  const pool = basename(anchor)
  return names.filter(
    (name) =>
      name === store ||
      name.startsWith(`${pool}.store.`) ||
      (name.startsWith(pool) && name.endsWith('.tmp')),
  ).length
}

/**
 * Moves an unfinished store at the state-home anchor out of the way, so the
 * move can start again from scratch. Only a store that publishes nothing
 * (leftovers of an interrupted move, or of a fresh installation that never
 * published) is touched; anything else is left for its own operation.
 */
async function abandonUnpublishedStore(
  location: RuntimeLayoutLocation,
  stateAnchor: string,
  log: RuntimeLayoutLogger,
): Promise<boolean> {
  const store = await loadCommonAuthStoreModules()
  const binding = await readAccountStoreBinding(stateAnchor, store, Date.now)
  if (binding.status === 'bound') return false
  const folder = storeFolder(stateAnchor)
  const archived = `${folder}.abandoned-${Date.now()}`
  await rename(folder, archived).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await unlink(accountStorePointerPath(stateAnchor)).catch(() => {})
  log.info(
    'antigravity-auth set an unfinished account store aside before starting its move again',
    { configDir: location.configDir, archived },
  )
  return true
}

/** One offline store move between the two anchors of a config folder. */
export interface StoreMoveInput {
  source: string
  target: string
  /** Restore the store at the config anchor, for a downgrade. */
  back: boolean
}

export type StoreMoveResult =
  | { status: 'completed'; id: string }
  | { status: 'pending'; reason: string }
  | { status: 'cancelled' }

/**
 * One offline store move with the stopped-process confirmation `migrate`
 * takes: the start-time move, setup, and `antigravity-auth store relocate`
 * all use it, and the caller holds the layout lock.
 */
export async function runStoreMove(
  input: StoreMoveInput,
): Promise<StoreMoveResult> {
  const outcome = await createAccountRelocationFactory(
    await loadCommonAuthStoreModules(),
  )({
    legacyPath: input.source,
    targetPath: input.target,
    ...(input.back ? { back: true } : {}),
    offline: { processesStopped: true },
    now: Date.now,
  })
  if (outcome.status === 'completed')
    return { status: 'completed', id: outcome.receipt.id }
  if (outcome.status === 'pending')
    return { status: 'pending', reason: outcome.reason }
  return { status: 'cancelled' }
}

/**
 * Runs one store move while the caller holds the layout lock. The fence is
 * read once more right before it, so a process that started meanwhile and
 * kept the config folder stops this one. A move that cannot finish (another
 * process holds a store lock, an unfinished move of another source) keeps
 * this process at the config folder for its life; the next start with an
 * open fence finishes it.
 */
async function moveStore(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  source: string,
  target: string,
  back: boolean,
  log: RuntimeLayoutLogger,
): Promise<AccountStoreAnchor> {
  const keepConfig = () => recordAnchor(location, options, 'config', log)
  if (!(await storeFenceOpen(location, options, log))) return keepConfig()
  try {
    const result = await (options.relocate ?? runStoreMove)({
      source,
      target,
      back,
    })
    if (result.status !== 'completed') {
      logOnce(`${location.key}\0store-move-unfinished`, () =>
        log.info(ACCOUNT_STORE_DEFERRED_MESSAGE, {
          configDir: location.configDir,
          reason: result.status === 'pending' ? result.reason : result.status,
        }),
      )
      return keepConfig()
    }
    showLog(
      log,
      "antigravity-auth moved the account store out of OpenCode's config folder",
      { from: source, to: target, generation: result.id },
    )
  } catch (error) {
    logOnce(`${location.key}\0store-move-failed`, () =>
      log.warn(
        "antigravity-auth's account store stays in OpenCode's config folder: moving it failed; the move is tried again at the next start",
        {
          configDir: location.configDir,
          errorClass: errorClass(error),
          ...errorFile(error),
        },
      ),
    )
    return keepConfig()
  }
  return recordAnchor(location, options, 'state-home', log)
}

/**
 * Finishes or repeats the move an existing forward names. A move that
 * stopped after its forward leaves a store no reader can bind; the store's
 * own operation resumes it, or cancels it and captures again. A failure here
 * is logged, and the anchor stays the state-home one the forward names, so
 * every reader reports the store as unusable instead of serving the old one.
 */
async function resumeForwardedStore(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  configAnchor: string,
  stateAnchor: string,
  log: RuntimeLayoutLogger,
): Promise<void> {
  try {
    await moveStore(location, options, configAnchor, stateAnchor, false, log)
  } catch (error) {
    logOnce(`${location.key}\0store-resume-failed`, () =>
      log.warn(
        "antigravity-auth's account store is still moving; it could not be finished at this start",
        {
          configDir: location.configDir,
          errorClass: errorClass(error),
          ...errorFile(error),
        },
      ),
    )
  }
}

/**
 * Creates an empty store at the state-home anchor for a genuinely fresh
 * installation and leaves a forward at the config anchor, so a version
 * without the store move refuses instead of creating a second, empty store.
 * When the store cannot be created there, this process keeps the config
 * folder and the next start tries again.
 */
async function initializeStore(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
  stateAnchor: string,
  log: RuntimeLayoutLogger,
): Promise<AccountStoreAnchor> {
  const keepConfig = () => recordAnchor(location, options, 'config', log)
  if (!(await storeFenceOpen(location, options, log))) return keepConfig()
  try {
    const store = await loadCommonAuthStoreModules()
    const created = await initializeFreshAccountStore(store, {
      legacyPath: stateAnchor,
      now: Date.now,
    })
    if (created.status !== 'completed')
      throw new LayoutMoveError('fresh-store', `the store is ${created.status}`)
    await writeStateHomeStoreForward(created.receipt.id, stateAnchor)
  } catch (error) {
    logOnce(`${location.key}\0store-init-failed`, () =>
      log.warn(
        "antigravity-auth's account store stays in OpenCode's config folder: creating it in its state folder failed; it is tried again at the next start",
        {
          configDir: location.configDir,
          errorClass: errorClass(error),
          ...errorFile(error),
        },
      ),
    )
    return keepConfig()
  }
  showLog(
    log,
    'antigravity-auth created its account store in its state folder',
    {
      accountStore: stateAnchor,
    },
  )
  return recordAnchor(location, options, 'state-home', log)
}

/**
 * Leaves a forwarding pointer at the config anchor for a store that now
 * lives at the state-home anchor: the same schema-2 pointer a store move
 * writes, so a version without the store move refuses it instead of reading
 * "no accounts". Written atomically and durably through the account store's
 * own writer.
 */
export async function writeStateHomeStoreForward(
  id: string,
  stateAnchor: string,
  configAnchor: string = legacyAccountFile(runtimeLayoutLocation().configDir),
): Promise<void> {
  const forward = {
    schemaVersion: 2,
    id,
    directoryBasename: basename(storeFolder(stateAnchor)),
    relocatedTo: { legacyPath: stateAnchor, id },
  }
  const fs = await loadCommonAuthFs()
  await fs.writeJsonAtomic(accountStorePointerPath(configAnchor), forward, {
    durable: true,
    durability: 'file-only-on-windows',
  })
}

function logDeferral(
  location: RuntimeLayoutLocation,
  blockers: unknown,
  log: RuntimeLayoutLogger,
): void {
  logOnce(`${location.key}\0deferred`, () =>
    log.info(RUNTIME_LAYOUT_DEFERRED_MESSAGE, {
      configDir: location.configDir,
      blockers,
    }),
  )
}

/**
 * On Windows, an existing destination vault folder must already be private
 * to this user: the enrollment token writer refuses to rewrite a token in a
 * folder that is not, and this module never changes the DACL of a folder it
 * did not create. A missing folder is created private by the writer.
 */
async function defaultDestinationPrivate(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') return true
  if (!(await exists(dir))) return true
  try {
    const { verifyPrivatePath } = await import('@cortexkit/private-files')
    await verifyPrivatePath(dir, 'directory')
    return true
  } catch {
    return false
  }
}

type MoveOutcome =
  | { kind: 'deferred'; blockers: unknown }
  | { kind: 'refused'; reason: string; paths: string[] }
  | { kind: 'moved'; moved: boolean }

/**
 * Copy every old vault file, then write the marker, then remove the old
 * files. Holds the data locks throughout; the caller holds the layout lock.
 */
async function moveFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  layoutLock: RefreshFileLock,
  input: {
    fence: () => Promise<VersionFenceResult>
    log: RuntimeLayoutLogger
    steps?: RuntimeLayoutOptions['steps']
    destinationPrivate: (dir: string) => Promise<boolean>
    oldSignatureCache: string
    onMarker: () => void
  },
): Promise<MoveOutcome> {
  const stateDir = location.stateHomeDir
  const locks = await takeDataLocks(files, input.log)
  let oldVaultEmptied = false
  try {
    // Heartbeats read again under every lock, right before the copy: a
    // process that started since the first check and kept the legacy layout
    // has recorded it by now.
    const gate = await input.fence()
    if (!gate.open) return { kind: 'deferred', blockers: gate.blockers }

    const aliases = await physicalAliases(location, files)
    if (aliases.length > 0)
      return { kind: 'refused', reason: 'same-physical-file', paths: aliases }

    // A vault file in the state-home vault folder that no unfinished move of
    // ours listed was put there by someone else: leave it.
    const listed = await readManifest(stateDir)
    const foreign = (await destinationFiles(files)).filter(
      (path) => !listed.has(path),
    )
    if (foreign.length > 0)
      return { kind: 'refused', reason: 'destination-in-use', paths: foreign }

    if (!(await input.destinationPrivate(files.vault.next)))
      return {
        kind: 'refused',
        reason: 'destination-not-private',
        paths: [files.vault.next],
      }

    const present = await presentOldFiles(files)
    await layoutLock.assertOwned()
    await writeManifest(stateDir, [
      ...new Set([...listed, ...present.map((file) => file.next)]),
    ])
    await input.steps?.afterManifest?.()
    // Copies an earlier, interrupted move left whose source has since gone.
    const wanted = new Set(present.map((file) => file.next))
    for (const path of listed) {
      if (wanted.has(path)) continue
      await layoutLock.assertOwned()
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    for (const file of present) {
      await layoutLock.assertOwned()
      await copyVerified(file)
    }
    await input.steps?.afterCopy?.()

    await layoutLock.assertOwned()
    for (const lock of locks) await lock.assertOwned()
    const keptVaultState = await keepableVaultState(files, present)
    const marker: LayoutMarker = {
      version: 1,
      oldDir: location.key,
      ...(keptVaultState ? { keptVaultState } : {}),
    }
    input.onMarker()
    await writeMarker(markerPath, marker)
    await input.steps?.afterMarker?.()

    await layoutLock.assertOwned()
    try {
      await removeOldCopies(location, files, present, layoutLock, {
        log: input.log,
        keptVaultState,
        steps: input.steps,
      })
    } catch (error) {
      if (!(error instanceof OldVaultFileKeptError)) throw error
      // The copies are verified and the marker is written, so this process
      // runs on the new files; the marker stays without `oldFilesRemoved` and
      // the next start removes what is left.
      logCleanupFailure(location, input.log, 'remove-old-copies', error)
      return { kind: 'moved', moved: present.length > 0 }
    }
    oldVaultEmptied = true
    await removeOldSignatureCache(
      location,
      input.oldSignatureCache,
      layoutLock,
      input.steps,
      input.log,
    )
    await layoutLock.assertOwned()
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    await removeManifestOwned(stateDir, layoutLock, input.steps)
    return { kind: 'moved', moved: present.length > 0 }
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    // The vault locks are released now, so their lock files are gone and
    // the emptied old vault folder can go; rmdir leaves a folder that still
    // holds anything.
    if (oldVaultEmptied)
      await removeOldVaultFolder(files, layoutLock, input.steps)
  }
}

/**
 * A start after a crash that came after the marker: under the same locks as
 * the move, remove identical old copies and refuse differing ones. Waits,
 * like the move, while a process that could still use the old files is
 * alive, and reads the heartbeats again once it holds the data locks.
 */
async function finishOldFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  marker: LayoutMarker,
  layoutLock: RefreshFileLock,
  input: {
    fence: () => Promise<VersionFenceResult>
    log: RuntimeLayoutLogger
    steps?: RuntimeLayoutOptions['steps']
    oldSignatureCache: string
  },
): Promise<void> {
  let locks: RefreshFileLock[] = []
  let done = false
  // Which step failed, for the warning below.
  let step = 'fence'
  try {
    // Read first so a closed fence does not wait for the data locks, and
    // again under them, as the move does: a process that started meanwhile
    // and kept the legacy layout has recorded it by then.
    if (!(await input.fence()).open) return
    step = 'data-locks'
    locks = await takeDataLocks(files, input.log)
    step = 'fence'
    if (!(await input.fence()).open) return
    step = 'same-file-check'
    const aliases = await physicalAliases(location, files)
    if (aliases.length > 0) {
      logOnce(`${location.key}\0cleanup-aliased`, () =>
        input.log.warn(
          "antigravity-auth leaves its old vault files in OpenCode's config folder: they are the same files as its new ones",
          { paths: aliases },
        ),
      )
      return
    }
    step = 'remove-old-copies'
    await layoutLock.assertOwned()
    await removeOldCopies(
      location,
      files,
      await presentOldFiles(files),
      layoutLock,
      {
        log: input.log,
        keptVaultState: marker.keptVaultState,
        steps: input.steps,
      },
    )
    done = true
    step = 'signature-cache'
    await removeOldSignatureCache(
      location,
      input.oldSignatureCache,
      layoutLock,
      input.steps,
      input.log,
    )
    step = 'marker'
    await layoutLock.assertOwned()
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    step = 'manifest'
    await removeManifestOwned(location.stateHomeDir, layoutLock, input.steps)
  } catch (error) {
    if (error instanceof RuntimeLayoutRefusal) throw error
    logCleanupFailure(location, input.log, step, error)
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    if (done) await removeOldVaultFolder(files, layoutLock, input.steps)
  }
}

/**
 * Remove the `layout-moving.json` a move left behind when it stopped after
 * marking its old files dealt with; the caller holds the layout lock. A
 * failure is logged and retried at the next start.
 */
async function removeLeftoverManifest(
  location: RuntimeLayoutLocation,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
  log: RuntimeLayoutLogger,
): Promise<void> {
  try {
    await removeManifestOwned(location.stateHomeDir, layoutLock, steps)
  } catch (error) {
    logOnce(`${location.key}\0manifest`, () =>
      log.warn(
        `antigravity-auth could not remove ${RUNTIME_LAYOUT_MANIFEST_FILE} from its state folder; it tries again at the next start`,
        { stateDir: location.stateHomeDir, errorClass: errorClass(error) },
      ),
    )
  }
}

/** Remove the move's manifest once the layout lock is confirmed still held. */
async function removeManifestOwned(
  stateDir: string,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  const path = join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE)
  if (!(await exists(path))) return
  await beforeRemove(path, layoutLock, steps)
  await removeManifest(stateDir)
}

/**
 * Remove the old vault folder if it is empty, once the layout lock is
 * confirmed still held. Best effort: rmdir leaves a folder that still holds
 * anything, such as the enrollment state file a vault-mode move keeps or
 * Pi's files.
 */
async function removeOldVaultFolder(
  files: LayoutFiles,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  try {
    await beforeRemove(files.vault.old, layoutLock, steps)
    await rmdir(files.vault.old)
  } catch {}
}

/**
 * Remove the signature cache older versions kept in OpenCode's config folder
 * (`legacySignatureCacheFile`), once: the move calls this right before it
 * records its old files as dealt with, and never again after. It is a cache
 * that rebuilds itself, so it is deleted, never copied or compared. Best
 * effort: a failure is logged once and the move goes on.
 */
async function removeOldSignatureCache(
  location: RuntimeLayoutLocation,
  path: string,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
  log: RuntimeLayoutLogger,
): Promise<void> {
  try {
    if (!(await exists(path))) return
    await beforeRemove(path, layoutLock, steps)
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    logOnce(`${location.key}\0signature-cache`, () =>
      log.warn(
        "antigravity-auth could not remove its old signature cache from OpenCode's config folder; it is no longer used and can be deleted",
        { path, errorClass: errorClass(error) },
      ),
    )
  }
}

/** The test seam, then the lease check that must come right before a removal. */
async function beforeRemove(
  path: string,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  await steps?.beforeRemove?.(path)
  await layoutLock.assertOwned()
}

/**
 * The vault's own locks at the old vault folder (`DATA_LOCKS`). Taken only
 * when that folder exists, because taking a lock creates missing parent
 * folders; taken whether or not each file exists yet, so a writer about to
 * create one waits too.
 */
async function takeDataLocks(
  files: LayoutFiles,
  log: RuntimeLayoutLogger,
): Promise<RefreshFileLock[]> {
  const locks: RefreshFileLock[] = []
  try {
    if (await exists(files.vault.old))
      for (const lock of DATA_LOCKS)
        locks.push(
          await takeLock(
            lock.name,
            join(files.vault.old, lock.file),
            lock.waitMs,
            log,
          ),
        )
    return locks
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    throw error
  }
}

function layoutFiles(
  location: RuntimeLayoutLocation,
  accountFile?: string,
): LayoutFiles {
  return {
    vault: {
      old: legacyVaultDir(accountFile ?? legacyAccountFile(location.configDir)),
      next: stateHomeVaultDir(location),
    },
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The vault enrollment state file, in both layouts. */
function vaultStateFile(files: LayoutFiles): LayoutFile {
  return {
    old: join(files.vault.old, VAULT_ENROLLMENT_STATE_FILE),
    next: join(files.vault.next, VAULT_ENROLLMENT_STATE_FILE),
  }
}

/**
 * The SHA-256 of the enrollment state file this move copied, when that state
 * keeps a host in vault mode without its token: approved, or blocked because
 * the token is missing. common-auth's `enrollmentAuthority` reads either one
 * as 'vault' when no token is next to it, so leaving it in the old vault
 * folder keeps an older version in vault mode. Any other state (pending,
 * denied, unreadable) protects nothing, and the old copy is removed as usual.
 */
async function keepableVaultState(
  files: LayoutFiles,
  present: LayoutFile[],
): Promise<string | undefined> {
  const state = vaultStateFile(files)
  if (!present.some((file) => file.old === state.old)) return undefined
  // The copy, verified byte for byte against the old file.
  const bytes = await readFile(state.next)
  let value: { phase?: unknown; errorCode?: unknown } | null
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  const vaultMode =
    value?.phase === 'approved' ||
    (value?.phase === 'blocked' && value.errorCode === 'missing_token')
  return vaultMode ? sha256(bytes) : undefined
}

/**
 * True when the enrollment state file of the old vault folder is the leftover
 * a move may have left there, after an older version rewrote it.
 *
 * The file is re-read through common-auth's
 * `readClaustrumEnrollmentStatus` with the enrollment name this plugin
 * proposes, so it is judged the way every version of the plugin reads it. It
 * counts as the expected leftover when the library reads it as vault mode
 * (approved, or blocked with `missing_token`: what a reconcile writes when it
 * finds the token gone), names this plugin's enrollment, and no token file
 * sits beside it. A token back in the old folder means it is enrolled again,
 * so which copy is current is unknown. Wrong name, pending, denied,
 * unparseable or unsafe to read is a conflict, not the leftover.
 *
 * The library reports the name of the state for an approved file, and of
 * this plugin's proposal for a state that has none (an approved token file
 * alone); both are this plugin's when the comparison passes.
 */
async function isVaultShapedKeptState(files: LayoutFiles): Promise<boolean> {
  const vault = files.vault.old
  const present = await vaultFiles(vault)
  // A token file counts even when the library would refuse to read it: the
  // old folder is enrolled again either way.
  if (present.includes(VAULT_ENROLLMENT_TOKEN_FILE)) return false
  const claustrum = await loadCommonAuthClaustrum()
  let status: Awaited<
    ReturnType<CommonAuthClaustrumModule['readClaustrumEnrollmentStatus']>
  >
  try {
    status = await claustrum.readClaustrumEnrollmentStatus(
      claustrum.hostEnrollmentPaths({
        stateDir: vault,
        host: OPENCODE_VAULT_HOST,
      }),
      OPENCODE_VAULT_ENROLLMENT_NAME,
    )
  } catch {
    // Unreadable, unsafe or unparseable: not the leftover this rule accepts.
    return false
  }
  const vaultShape =
    status.state === 'approved' ||
    (status.state === 'blocked' && status.code === 'missing_token')
  const proposedName =
    'proposedName' in status ? status.proposedName : undefined
  return vaultShape && proposedName === OPENCODE_VAULT_ENROLLMENT_NAME
}

/**
 * After Disconnect, remove the enrollment state file a move left in the old
 * vault folder, so an older version no longer reads this host as enrolled.
 * Acts only for this config folder's state-home vault folder (`vaultDir`), and
 * only on a vault-shaped leftover of this plugin's enrollment
 * (`isVaultShapedKeptState`); any other file there stays. The emptied old
 * vault folder goes too. `accountFile` is the one the move was given
 * (`RuntimeLayoutOptions.accountFile`).
 */
export async function removeMovedVaultStateLeftover(
  vaultDir: string,
  accountFile?: string,
): Promise<void> {
  const location = runtimeLayoutLocation()
  const files = layoutFiles(location, accountFile)
  if (resolve(vaultDir) !== resolve(files.vault.next)) return
  const stateDir = location.stateHomeDir
  const marker = await readMarker(
    join(stateDir, RUNTIME_LAYOUT_MARKER_FILE),
    stateDir,
    files.vault.old,
  )
  // The marker must still name this config folder's finished move; its
  // recorded hash is not what decides.
  if (!marker?.oldDir || marker.oldDir !== location.key) return
  const leftover = vaultStateFile(files).old
  if (!(await isVaultShapedKeptState(files))) return
  await unlink(leftover).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await rmdir(files.vault.old).catch(() => {})
}

/** The allow-listed vault files that are regular files directly in a folder. */
async function vaultFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  const allowed = new Set<string>(VAULT_FILE_NAMES)
  return entries
    .filter((entry) => entry.isFile() && allowed.has(entry.name))
    .map((entry) => entry.name)
    .sort(
      (a, b) =>
        VAULT_FILE_NAMES.indexOf(a as (typeof VAULT_FILE_NAMES)[number]) -
        VAULT_FILE_NAMES.indexOf(b as (typeof VAULT_FILE_NAMES)[number]),
    )
}

/** Every vault file that exists in the old layout, paired with its target. */
async function presentOldFiles(files: LayoutFiles): Promise<LayoutFile[]> {
  return (await vaultFiles(files.vault.old)).map((name) => ({
    old: join(files.vault.old, name),
    next: join(files.vault.next, name),
  }))
}

/** Every vault file that exists in the state-home layout. */
async function destinationFiles(files: LayoutFiles): Promise<string[]> {
  return (await vaultFiles(files.vault.next)).map((name) =>
    join(files.vault.next, name),
  )
}

/**
 * Old paths that are the same physical file or folder as their new place (a
 * link, a hard link or a mount): moving those would copy a file onto itself
 * and then delete it.
 */
async function physicalAliases(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
): Promise<string[]> {
  const pairs: [string, string][] = [
    [location.configDir, location.stateHomeDir],
    [files.vault.old, files.vault.next],
  ]
  for (const name of VAULT_FILE_NAMES)
    pairs.push([join(files.vault.old, name), join(files.vault.next, name)])
  const aliased: string[] = []
  for (const [old, next] of pairs)
    if (await samePhysical(old, next)) aliased.push(old)
  return aliased
}

/** True when both paths exist and are one file or folder (device and inode). */
async function samePhysical(a: string, b: string): Promise<boolean> {
  const id = async (path: string) => {
    try {
      const info = await stat(path, { bigint: true })
      // A file system without inode numbers cannot prove anything here.
      return info.ino === 0n ? undefined : `${info.dev}:${info.ino}`
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }
  const left = await id(a)
  return left !== undefined && left === (await id(b))
}

async function copyVerified(file: LayoutFile): Promise<void> {
  const bytes = await readFile(file.old)
  const text = bytes.toString('utf8')
  // The private writer takes text; a file that is not valid UTF-8 would not
  // survive the round trip, so it is not copied at all.
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new LayoutMoveError('not-utf8', `${file.old} is not UTF-8 text`)
  await writePrivateText(file.next, text)
  if (!(await readFile(file.next)).equals(bytes))
    throw new LayoutMoveError(
      'copy-mismatch',
      `${file.next} does not match ${file.old}`,
    )
}

/**
 * Remove each old file whose bytes equal its new copy, comparing again right
 * before every unlink attempt. A differing old file, or one whose copy
 * cannot be read for a reason other than Windows holding it open, refuses
 * the start: it may hold the only current vault credential. The vault-shaped
 * enrollment state file the move left there (`isVaultShapedKeptState`) stays
 * on purpose. An identical file that cannot be removed, or one Windows keeps
 * open so it cannot be compared, throws `OldVaultFileKeptError` once every
 * other file was tried: the caller logs it once and leaves the marker without
 * `oldFilesRemoved`, so the next start tries again. When the marker records a
 * kept enrollment state (`keptVaultState`), an old state file whose bytes
 * equal its state-home copy stays too, even when the leftover check rejects
 * it. The caller holds the data locks.
 */
async function removeOldCopies(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  present: LayoutFile[],
  layoutLock: RefreshFileLock,
  input: {
    log: RuntimeLayoutLogger
    /** The marker's `keptVaultState`: set when the move left the state file. */
    keptVaultState: string | undefined
    steps?: RuntimeLayoutOptions['steps']
  },
): Promise<void> {
  const kept: string[] = []
  const keptState = vaultStateFile(files).old
  // The enrollment state file comes last: whether it may stay depends on the
  // old token being gone, and the token is one of the files removed here.
  const ordered = [
    ...present.filter((file) => file.old !== keptState),
    ...present.filter((file) => file.old === keptState),
  ]
  for (const file of ordered) {
    await layoutLock.assertOwned()
    if (file.old === keptState) {
      if (await isVaultShapedKeptState(files)) {
        // Kept on purpose, but only next to a copy that is still readable.
        if (!(await readable(file.next)))
          throw credentialConflict(location.stateHomeDir, file)
        continue
      }
      // An old vault file still in place (the token, say) means another try
      // at the next start; the state file is judged then, beside whatever is
      // left by then.
      if (kept.length > 0) continue
      // The move left a state file here on purpose. Whenever the leftover
      // check above rejects it (a read that failed for a moment is enough),
      // a copy identical to the state-home one must still stay: removing it
      // would make an older version read this host as local. Differing bytes
      // are judged below.
      if (input.keptVaultState && (await sameBytes(file.old, file.next)))
        continue
    }
    if (
      !(await unlinkIfIdentical(file, location.stateHomeDir, () =>
        beforeRemove(file.old, layoutLock, input.steps),
      ))
    )
      kept.push(file.old)
  }
  const [first] = kept
  if (first !== undefined) throw new OldVaultFileKeptError(first)
}

async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** True when both files can be read and hold the same bytes. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    return (await readFile(a)).equals(await readFile(b))
  } catch {
    return false
  }
}

/**
 * On Windows, a file another process has open (an antivirus scan, an indexer,
 * a writer that has not closed it yet) can refuse to be read or removed for a
 * moment. These codes do not say whether the file exists or what it holds.
 */
function isWindowsSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    process.platform === 'win32' &&
    (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
  )
}

/**
 * Unlink `file.old` only while its bytes equal `file.next`, retrying on
 * Windows while another process has either file open. `guard` runs right
 * before every unlink attempt and throws when the removal must not happen.
 * True when the file is gone. False when it stays because Windows kept it
 * open past the retry budget, whether for the comparison or for the removal,
 * or because the removal failed for another reason. Differing files, or
 * files unreadable for any other reason, throw `credentialConflict`.
 */
async function unlinkIfIdentical(
  file: LayoutFile,
  stateDir: string,
  guard: () => Promise<void>,
): Promise<boolean> {
  const started = performance.now()
  for (const delay of SHARING_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((done) => setTimeout(done, delay))
    let same: boolean
    try {
      same = (await readFile(file.old)).equals(await readFile(file.next))
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !(await exists(file.old))
      )
        return true
      // A file Windows holds open is not evidence that the two copies differ:
      // compare again shortly, and past the budget leave the old file for the
      // next start, as when the unlink itself is refused.
      if (isWindowsSharingError(error)) {
        if (performance.now() - started >= SHARING_RETRY_BUDGET_MS) return false
        continue
      }
      // Unreadable on either side for another reason: which copy is current
      // is unknown.
      throw credentialConflict(stateDir, file)
    }
    if (!same) throw credentialConflict(stateDir, file)
    await guard()
    try {
      await unlink(file.old)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      if (
        !isWindowsSharingError(error) ||
        performance.now() - started >= SHARING_RETRY_BUDGET_MS
      )
        return false
    }
  }
  return false
}

/**
 * After a finished move, an old vault file in the config folder means an
 * older version wrote it (re-enrolled, toggled the mode, synced the roster).
 * Which copy is current is unknown, so the start is refused, naming both
 * paths. The one exception is the vault-shaped enrollment state file the move
 * left there on purpose (`isVaultShapedKeptState`), which an older version may
 * have rewritten since.
 */
async function refuseReappearedFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
): Promise<void> {
  const keptState = vaultStateFile(files).old
  for (const name of await vaultFiles(files.vault.old)) {
    const old = join(files.vault.old, name)
    if (old === keptState && (await isVaultShapedKeptState(files))) continue
    throw credentialConflict(location.stateHomeDir, {
      old,
      next: join(files.vault.next, name),
    })
  }
}

/**
 * The marker, or undefined when it does not exist. It is written atomically
 * after all copies are verified, so malformed contents mean outside damage,
 * not evidence that the move completed. Other read failures are retried
 * briefly, then refuse the start: they prove neither presence nor absence.
 */
async function readMarker(
  path: string,
  stateDir: string,
  oldVaultDir: string,
): Promise<LayoutMarker | undefined> {
  let text: string | undefined
  let failure: unknown
  for (let attempt = 0; attempt < MARKER_READ_ATTEMPTS; attempt++) {
    if (attempt > 0)
      await new Promise((done) => setTimeout(done, MARKER_READ_RETRY_MS))
    try {
      text = await readFile(path, 'utf8')
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      failure = error
    }
  }
  if (text === undefined)
    throw new RuntimeLayoutRefusal(stateDir, errorClass(failure))
  try {
    const value = JSON.parse(text) as Partial<LayoutMarker> | null
    if (value && typeof value === 'object' && !Array.isArray(value))
      return {
        version: 1,
        ...(typeof value.oldDir === 'string' ? { oldDir: value.oldDir } : {}),
        ...(value.oldFilesRemoved === true ? { oldFilesRemoved: true } : {}),
        ...(typeof value.keptVaultState === 'string' &&
        SHA256_HEX.test(value.keptVaultState)
          ? { keptVaultState: value.keptVaultState }
          : {}),
      }
  } catch {}
  throw new RuntimeLayoutRefusal(
    stateDir,
    'malformed-marker',
    `antigravity-auth cannot start: ${path} is malformed, so it cannot tell whether its vault files were moved. ${markerRemedy(path, oldVaultDir)}`,
  )
}

/**
 * Refuse a state-home folder whose `config-dir.json` or marker names another
 * config folder: its files belong to that folder's OpenCode.
 */
async function assertOwnFolder(
  location: RuntimeLayoutLocation,
  marker: LayoutMarker | undefined,
  files: LayoutFiles,
): Promise<void> {
  const stateDir = location.stateHomeDir
  if (marker?.oldDir !== undefined && marker.oldDir !== location.key)
    throw foreignMarker(
      join(stateDir, RUNTIME_LAYOUT_MARKER_FILE),
      location.key,
      files.vault.old,
    )
  let text: string
  try {
    text = await readFile(join(stateDir, RUNTIME_CONFIG_DIR_NOTE_FILE), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
  }
  let owner: unknown
  try {
    owner = (JSON.parse(text) as { configDir?: unknown } | null)?.configDir
  } catch {}
  if (owner !== location.key) throw foreignFolder(stateDir, location.key)
}

/** Name this folder's config folder, once; the caller holds the layout lock. */
async function writeOwnerNote(location: RuntimeLayoutLocation): Promise<void> {
  const path = join(location.stateHomeDir, RUNTIME_CONFIG_DIR_NOTE_FILE)
  if (await exists(path)) return
  await writePrivateText(
    path,
    `${JSON.stringify({ version: 1, configDir: location.key }, null, 2)}\n`,
  )
}

/** The copies an unfinished move listed; empty when there is none. */
async function readManifest(stateDir: string): Promise<Set<string>> {
  let text: string
  try {
    text = await readFile(join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  // A manifest that does not parse proves nothing about whose files these
  // are; the destination check then treats them as someone else's.
  try {
    const value = JSON.parse(text) as { files?: unknown } | null
    if (Array.isArray(value?.files))
      return new Set(
        value.files.filter((path): path is string => typeof path === 'string'),
      )
  } catch {}
  return new Set()
}

async function writeManifest(stateDir: string, paths: string[]): Promise<void> {
  await writePrivateText(
    join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE),
    `${JSON.stringify({ version: 1, files: paths }, null, 2)}\n`,
  )
}

async function removeManifest(stateDir: string): Promise<void> {
  await unlink(join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
}

async function writeMarker(path: string, marker: LayoutMarker): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(marker, null, 2)}\n`)
}

/**
 * Owner-only, durable write through common-auth's atomic writer: mode 0600,
 * the file and then its folder synced on POSIX; the private-files ACL and a
 * file flush on Windows, where folder sync is not available. On Windows the
 * writer creates every missing folder with an owner-only ACL itself; this
 * module never calls mkdir there.
 */
async function writePrivateText(path: string, text: string): Promise<void> {
  await ensureOwnerOnlyDir(dirname(path))
  const fs = await loadCommonAuthFs()
  await fs.writeJsonAtomic(path, null, {
    serialize: () => text,
    durable: true,
    durability: 'file-only-on-windows',
  })
}

/**
 * On POSIX, create the folder as 0700 and tighten it if it exists (as the
 * heartbeat folder does). On Windows the private-files writer and the lock
 * create every missing folder with an owner-only ACL themselves.
 */
async function ensureOwnerOnlyDir(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/**
 * Take one lease, waiting up to `waitMs` while another process holds it. A
 * wait longer than a second is logged once, naming the lock, so a slow start
 * says what it is waiting for; a wait that runs out fails with a message
 * that names it too.
 */
async function takeLock(
  name: string,
  path: string,
  waitMs: number,
  log: RuntimeLayoutLogger,
): Promise<RefreshFileLock> {
  const fs = await loadCommonAuthFs()
  const started = performance.now()
  let announced = false
  for (;;) {
    let lock: RefreshFileLock | null = null
    try {
      lock = await fs.acquireRefreshFileLock({
        name,
        path,
        ttlMs: LOCK_TTL_MS,
        renew: true,
      })
    } catch (error) {
      // On Windows a holder that releases while this attempt reads its lock
      // file makes the attempt fail with ENOENT: the lock is free, so try
      // again rather than fail.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (lock) return lock
    const waited = performance.now() - started
    if (waited >= waitMs)
      throw new LayoutMoveError(
        'lock-timeout',
        `it waited ${Math.round(waitMs / 1000)} s for the ${name} lock at ${path}.${lockHolderText(name)}`,
      )
    if (!announced && waited >= LOCK_WAIT_NOTICE_MS) {
      announced = true
      log.info(
        `antigravity-auth is waiting up to ${Math.round(waitMs / 1000)} s for the ${name} lock at ${path}.${lockHolderText(name)}`,
        { lock: name, path },
      )
    }
    await new Promise((done) => setTimeout(done, LOCK_RETRY_MS))
  }
}

function lockHolderText(name: string): string {
  return name === RUNTIME_LAYOUT_LOCK_NAME
    ? ' Another OpenCode holds it while it decides where the vault files live or moves them; a lock left by one that crashed expires by itself.'
    : ' Another OpenCode holds it while it writes that vault file; a lock left by one that crashed expires by itself.'
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}
