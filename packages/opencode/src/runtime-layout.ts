// Moves the plugin's vault files out of OpenCode's config folder, once.
//
// OpenCode 2 watches its config folder, and the plugin rewrites its vault
// files there every few seconds: the vault roster, the vault provider state
// and the enrollment files, each with lock files, eviction markers and staged
// temporary files. They move to the state home (`runtime-paths.ts` names both
// folders). The account store, `antigravity.json` and the TUI preferences stay
// in OpenCode's config folder: the account store records its own absolute
// paths and refuses to open anywhere else.
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
//   credential. The marker then records that the old files are dealt with,
//   and old vault files that reappear later also refuse the start.
// - An enrollment that keeps the host in vault mode (approved, or blocked
//   because its token is missing) keeps one old file: the enrollment state
//   file stays in the old vault folder, byte for byte the copy that moved,
//   and only the old token is removed. Every version reads such a state
//   without a token as vault mode with a missing token, never as local, so an
//   older version that still looks in the config folder refuses requests
//   instead of serving local accounts. The marker records that file's
//   SHA-256 (`keptVaultState`); later starts accept exactly those bytes
//   there, and anything else at that path is a conflict like any other
//   reappeared file. Disconnect on this version removes it
//   (`removeMovedVaultStateLeftover`). A pending or denied enrollment state
//   protects nothing and is removed like the other files.
// - The layout lock is checked again right before every destructive step:
//   each unlink attempt of an old file, the removal of `layout-moving.json`
//   and of the old vault folder. `layout-moving.json` is the last thing a
//   move removes, and one left behind is removed at the next start, under
//   the lock. A move that fails leaves the process on the legacy layout
//   (registered) and logs the error class once; the next start tries again.
//   Nothing here runs on a request.

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  type CommonAuthFsModule,
  loadCommonAuthFs,
} from '@cortexkit/antigravity-auth-core'
import { createLogger } from './plugin/logger'
import { recordProcessLayout } from './process-heartbeat'
import {
  decidedRuntimeLayout,
  legacyAccountFile,
  legacyVaultDir,
  RUNTIME_CONFIG_DIR_NOTE_FILE,
  RUNTIME_LAYOUT_MARKER_FILE,
  type RuntimeLayout,
  type RuntimeLayoutLocation,
  runtimeLayoutLocation,
  setRuntimeLayout,
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

/**
 * The vault files that move, and the only ones the move ever reads, copies,
 * compares or removes in either vault folder. Anything else there (Pi's
 * files, when Pi's account file points into OpenCode's config folder, or a
 * file a later library version adds) is left alone; a new vault file has to
 * be added here on purpose.
 */
export const VAULT_FILE_NAMES = [
  'opencode-enrollment.json',
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

function credentialConflict(stateDir: string, file: LayoutFile) {
  return new RuntimeLayoutRefusal(
    stateDir,
    'credential-conflict',
    `antigravity-auth cannot start: vault files conflict between ${file.old} and ${file.next}. Keep the newer one, delete the other, then restart OpenCode.`,
  )
}

export interface RuntimeLayoutLogger {
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
}

interface LayoutMarker {
  version: 1
  /** The identity of the config folder the files came from. */
  oldDir?: string
  /** Set once the old files were removed or knowingly left in place. */
  oldFilesRemoved?: boolean
  /**
   * SHA-256 (hex) of the approved enrollment state file the move leaves in
   * the old vault folder; absent when the move left none there.
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
    logged: Set<string>
  }
}
const processState = globalState[stateKey] ?? {
  runs: new Map<string, Promise<RuntimeLayout>>(),
  logged: new Set<string>(),
}
globalState[stateKey] = processState

/** Test seam: forget this process's runs and log lines. */
export function __resetRuntimeLayoutRunsForTest(): void {
  processState.runs.clear()
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
    await recordProcessLayout({
      key: location.key,
      layout: 'state-home',
      version: options.version,
    })
    setRuntimeLayout(location, 'state-home')
    return 'state-home'
  }

  // Read-only first: whose folder this is, and whether the move is done.
  let marker = await readMarker(markerPath, stateDir)
  await assertOwnFolder(location, marker)
  if (marker?.oldFilesRemoved) {
    await refuseReappearedFiles(location, files, marker)
    // A move that stopped right after its last marker write left its
    // `layout-moving.json`; it is removed below, under the layout lock.
    const manifestLeft = await exists(
      join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE),
    ).catch(() => true)
    if (!manifestLeft) return stateHome()
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
    marker = await readMarker(markerPath, stateDir)
    if (marker) {
      if (marker.oldFilesRemoved)
        await refuseReappearedFiles(location, files, marker)
      return stateHome()
    }
    if (error instanceof LayoutMoveError && error.code === 'lock-timeout')
      throw new RuntimeLayoutRefusal(
        stateDir,
        'lock-timeout',
        `antigravity-auth cannot start: ${error.message} Restart OpenCode once the other OpenCode has started, or after a minute if one crashed.`,
      )
    throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
  }

  const lock = layoutLock
  const legacy = async (): Promise<RuntimeLayout> => {
    try {
      await lock.assertOwned()
      await recordProcessLayout({
        key: location.key,
        layout: 'legacy',
        version: options.version,
      })
    } catch (error) {
      throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
    }
    setRuntimeLayout(location, 'legacy')
    return 'legacy'
  }

  try {
    marker = await readMarker(markerPath, stateDir)
    await assertOwnFolder(location, marker)
    if (!aliased) await writeOwnerNote(location)

    if (marker) {
      if (!marker.oldFilesRemoved && !aliased)
        await finishOldFiles(location, files, markerPath, marker, lock, {
          fence,
          log,
          steps: options.steps,
        })
      else if (marker.oldFilesRemoved) {
        await refuseReappearedFiles(location, files, marker)
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
      if (markerStarted && (await readMarker(markerPath, stateDir)))
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
    await removeOldCopies(location, files, present, layoutLock, {
      log: input.log,
      keptVaultState,
      steps: input.steps,
    })
    oldVaultEmptied = true
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
    step = 'marker'
    await layoutLock.assertOwned()
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    step = 'manifest'
    await removeManifestOwned(location.stateHomeDir, layoutLock, input.steps)
  } catch (error) {
    if (error instanceof RuntimeLayoutRefusal) throw error
    logOnce(`${location.key}\0cleanup`, () =>
      input.log.warn(
        "antigravity-auth could not finish removing its old vault files from OpenCode's config folder; it tries again at the next start",
        {
          configDir: location.configDir,
          step,
          errorClass: errorClass(error),
          ...errorFile(error),
        },
      ),
    )
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

/** True when `path` holds exactly the bytes whose SHA-256 is `hash`. */
async function isKeptVaultState(
  path: string,
  hash: string | undefined,
): Promise<boolean> {
  if (!hash) return false
  try {
    return sha256(await readFile(path)) === hash
  } catch {
    return false
  }
}

/**
 * After Disconnect, remove the enrollment state file a move left in the old
 * vault folder, so an older version no longer reads this host as enrolled.
 * Acts only for this config folder's state-home vault folder (`vaultDir`) and
 * only on exactly the bytes the marker recorded; anything else there stays.
 * The emptied old vault folder goes too. `accountFile` is the one the move
 * was given (`RuntimeLayoutOptions.accountFile`).
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
  )
  if (!marker?.keptVaultState || marker.oldDir !== location.key) return
  const leftover = vaultStateFile(files).old
  if (!(await isKeptVaultState(leftover, marker.keptVaultState))) return
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
 * cannot be read, refuses the start: it may hold the only current vault
 * credential. The vault-mode enrollment state file whose SHA-256 the marker
 * records (`keptVaultState`) stays on purpose. A file Windows will not let
 * go of stays too, and then the move is not finished: the next start
 * tries again. The caller holds the data locks.
 */
async function removeOldCopies(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  present: LayoutFile[],
  layoutLock: RefreshFileLock,
  input: {
    log: RuntimeLayoutLogger
    keptVaultState: string | undefined
    steps?: RuntimeLayoutOptions['steps']
  },
): Promise<void> {
  const kept: string[] = []
  const keptState = vaultStateFile(files).old
  for (const file of present) {
    await layoutLock.assertOwned()
    if (
      file.old === keptState &&
      (await isKeptVaultState(file.old, input.keptVaultState))
    ) {
      // Kept on purpose, but only next to a copy that is still readable.
      if (!(await readable(file.next)))
        throw credentialConflict(location.stateHomeDir, file)
      continue
    }
    if (
      !(await unlinkIfIdentical(file, location.stateHomeDir, () =>
        beforeRemove(file.old, layoutLock, input.steps),
      ))
    )
      kept.push(file.old)
  }
  if (kept.length > 0) {
    input.log.warn(
      "antigravity-auth could not remove old vault files from OpenCode's config folder; it tries again at the next start",
      { configDir: location.configDir, kept },
    )
    throw new LayoutMoveError('old-files-kept', kept.join(', '))
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * Unlink `file.old` only while its bytes equal `file.next`, retrying on
 * Windows while another process has it open. `guard` runs right before every
 * unlink attempt and throws when the removal must not happen. True when the
 * file is gone.
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
      // Unreadable on either side: which copy is current is unknown.
      throw credentialConflict(stateDir, file)
    }
    if (!same) throw credentialConflict(stateDir, file)
    await guard()
    try {
      await unlink(file.old)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      const sharing =
        process.platform === 'win32' &&
        (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
      if (!sharing || performance.now() - started >= SHARING_RETRY_BUDGET_MS)
        return false
    }
  }
  return false
}

/**
 * After a finished move, an old vault file in the config folder means an
 * older version wrote it (re-enrolled, toggled the mode, synced the roster).
 * Which copy is current is unknown, so the start is refused, naming both
 * paths. The one exception is the vault-mode enrollment state file the move
 * left there on purpose, while it still holds exactly the recorded bytes.
 */
async function refuseReappearedFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  marker: LayoutMarker,
): Promise<void> {
  const keptState = vaultStateFile(files).old
  for (const name of await vaultFiles(files.vault.old)) {
    const old = join(files.vault.old, name)
    if (
      old === keptState &&
      (await isKeptVaultState(old, marker.keptVaultState))
    )
      continue
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
    `antigravity-auth cannot start: ${path} is malformed, so it cannot tell whether its vault files were moved. If they are still in OpenCode's config folder, delete layout.json, then restart OpenCode; if they are not, keep ${stateDir} as it is.`,
  )
}

/**
 * Refuse a state-home folder whose `config-dir.json` or marker names another
 * config folder: its files belong to that folder's OpenCode.
 */
async function assertOwnFolder(
  location: RuntimeLayoutLocation,
  marker: LayoutMarker | undefined,
): Promise<void> {
  const stateDir = location.stateHomeDir
  if (marker?.oldDir !== undefined && marker.oldDir !== location.key)
    throw foreignFolder(stateDir, location.key)
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
