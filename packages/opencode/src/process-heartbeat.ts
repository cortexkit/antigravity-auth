// Process heartbeat: which plugin versions are running on this machine.
//
// Every OpenCode 1 plugin instance, OpenCode 2 location and CLI run leaves
// one small file, `<pid>.json`, in a shared directory under the user's state
// home. A later release that moves the account, vault, cache and log files out
// of the OpenCode config folder reads these files to learn which versions are
// live before it acts; a reader treats a file whose pid is no longer running
// as absent, so a crashed process leaves nothing it has to clean up.
//
// Writing it is best-effort. A failure is logged and never fails the loader,
// and nothing here runs on the request path. There is no periodic refresh:
// the file is written when the process's first owner starts, and a failed
// write is tried again when the next owner starts.
//
// The file also carries `layouts`: for each OpenCode config folder this
// process resolved, whether it keeps that folder's vault files in the config
// folder itself (`legacy`) or in the state home (`state-home`), see
// `runtime-paths.ts`. A process that has not decided records `legacy` (or
// no layout at all when it cannot read its own package manifest, which the
// move also treats as blocking). A process that runs on the legacy layout
// keeps its file until it exits, even after its last owner released it,
// because its paths stay fixed for its whole life and the move must wait for
// it.
//
// `stores` sits beside `layouts` and records, per config folder, where the
// account store is kept: `config` (OpenCode's config folder) or `state-home`
// (`runtime-paths.ts`). A process that has not decided records `config`.
// Versions that predate the store move ignore the field, and a store move
// refuses to run while any live process still names `config`, so a process
// that keeps the old anchor is never bypassed.
//
// One write is not best-effort: `recordProcessLayout` and
// `recordProcessAnchor` record a decision while the deciding process holds
// the layout lock, and throw when that write fails, because a process on the
// old files that other processes cannot see must not start.

import { randomUUID } from 'node:crypto'
import { realpathSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getConfigDir } from './plugin/storage'
import {
  decidedAccountStoreAnchor,
  decidedRuntimeLayout,
  type HeartbeatStoreRecord,
  runtimeLayoutLocation,
} from './runtime-paths'

/** Where one process keeps one config folder's runtime files. */
export type ProcessLayout = 'legacy' | 'state-home'

export interface ProcessHeartbeat {
  pid: number
  version: string
  startedAt: number
  /** Config folder key (`processConfigFolderKey()`) to its layout. */
  layouts: Record<string, ProcessLayout>
  /**
   * Config folder key to where that folder's account store is kept, for a
   * process that decided. Absent from a heartbeat of a version that predates
   * the store move.
   */
  stores?: Record<string, HeartbeatStoreRecord>
}

/**
 * The heartbeat directory, resolved the same way as the RPC directory:
 * `$XDG_STATE_HOME/cortexkit/antigravity-auth/processes`, with
 * `~/.local/state` as the state home when XDG_STATE_HOME is unset, on every
 * operating system.
 */
export function processHeartbeatDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'antigravity-auth', 'processes')
}

export function processHeartbeatPath(
  pid: number = process.pid,
  dir: string = processHeartbeatDir(),
): string {
  return join(dir, `${pid}.json`)
}

/**
 * The key a config folder is recorded under: the OpenCode config folder the
 * account file lives in (`getConfigDir()` in `plugin/storage.ts`), as
 * `realpathSync.native` returns it, or `path.resolve` when the folder does not
 * exist yet. The string is used exactly as returned, with no lower-casing or
 * other normalisation, so it matches the identity every CortexKit auth plugin's
 * file move compares against.
 */
export function processConfigFolderKey(): string {
  const folder = getConfigDir()
  try {
    return realpathSync.native(folder)
  } catch {
    return resolve(folder)
  }
}

// The state every copy of this bundle in one process shares. One OpenCode
// process can host several plugin instances (one per project directory) and
// OpenCode 2 can load more than one copy of this bundle, all sharing one pid
// and therefore one file, so the owner count, start time and layouts live on
// the global object rather than in this module.
interface SharedHeartbeatState {
  owners: number
  startedAt: number | undefined
  layouts: Map<string, ProcessLayout>
  stores: Map<string, HeartbeatStoreRecord>
  /** An older bundle may still use config-folder stores until process exit. */
  olderGeneration: boolean
  /** The file this process last wrote and has not removed. */
  writtenPath: string | undefined
  /** `layouts` and `stores` as last written, to tell whether the file is current. */
  writtenLayouts: string | undefined
  exitHookInstalled: boolean
}

const stateKey = Symbol.for('cortexkit.antigravity-auth.process-heartbeat')
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: SharedHeartbeatState
}
const olderGeneration =
  globalState[stateKey] !== undefined && globalState[stateKey].stores == null
const shared = globalState[stateKey] ?? ({} as SharedHeartbeatState)
// Repair in place: live bundle copies still hold this object and its owners.
shared.owners ??= 0
shared.startedAt ??= undefined
shared.layouts ??= new Map()
shared.olderGeneration ??= olderGeneration
shared.stores ??= new Map()
shared.writtenPath ??= undefined
shared.writtenLayouts ??= undefined
shared.exitHookInstalled ??= false
globalState[stateKey] = shared

/** Whether account code from before the store move may still run here. */
export function processHasOlderGeneration(): boolean {
  return shared.olderGeneration
}

function layoutsRecord(): Record<string, ProcessLayout> {
  return Object.fromEntries(shared.layouts)
}

/**
 * `stores` for the heartbeat. Empty when no anchor is decided: a heartbeat
 * with no `stores` is what a version before the store move writes, and a
 * store move treats a live one as still using the config folder.
 */
function storesRecord(): Record<string, HeartbeatStoreRecord> {
  // Include layouts added by old bundles, which know nothing about stores.
  if (shared.olderGeneration)
    return Object.fromEntries(
      [...new Set([...shared.layouts.keys(), ...shared.stores.keys()])].map(
        (key) => [key, 'config'],
      ),
    )
  return Object.fromEntries(shared.stores)
}

/** What the process's file should say, to tell whether it is current. */
function recordSignature(): string {
  return JSON.stringify([layoutsRecord(), storesRecord()])
}

function holdsLegacyLayout(): boolean {
  for (const layout of shared.layouts.values())
    if (layout === 'legacy') return true
  return false
}

/**
 * A process keeps its heartbeat until it exits when its paths stay fixed for
 * its whole life: the legacy vault layout, or the config-folder account
 * store. The store move waits for it either way.
 */
function holdsFixedOldPaths(): boolean {
  if (holdsLegacyLayout()) return true
  if (shared.olderGeneration) return true
  for (const anchor of shared.stores.values())
    if (anchor === 'config') return true
  return false
}

// Remove the file when the process exits, where Node still runs exit
// handlers. A process killed outright leaves the file; its dead pid then
// counts as absent.
function installExitHook(): void {
  if (shared.exitHookInstalled) return
  shared.exitHookInstalled = true
  process.once('exit', () => {
    if (!shared.writtenPath) return
    try {
      rmSync(shared.writtenPath, { force: true })
    } catch {
      // Exit cannot report anything; a stale file names a dead pid.
    }
  })
}

export interface HeartbeatLogger {
  warn(message: string, meta?: Record<string, unknown>): unknown
}

export interface ProcessHeartbeatHandle {
  /** Where the heartbeat is, or undefined when no write has succeeded. */
  path: string | undefined
  /**
   * Drop this owner. The file is removed when no owner in the process is
   * left and the process holds no legacy layout.
   */
  release(): Promise<void>
}

/**
 * A heartbeat write that failed: the folder could not be created or kept
 * private, or the temporary file could not be written or renamed into place.
 * Raised by `recordProcessLayout` and `recordProcessAnchor` callers, which
 * must not run on the old paths unregistered; `startProcessHeartbeat` logs a
 * failed write instead. A failed attempt publishes no heartbeat file.
 */
class HeartbeatWriteFailure extends Error {
  constructor(cause: unknown) {
    super(errorText(cause))
    this.name = 'HeartbeatWriteFailure'
  }
}

async function writeHeartbeatFile(
  dir: string,
  heartbeat: ProcessHeartbeat,
): Promise<string> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode does not apply to a directory that already exists.
    await chmod(dir, 0o700)
  } catch (error) {
    // One heartbeat folder serves the whole plugin. A process whose
    // heartbeat cannot be written also cannot keep its account store or
    // vault files under that path, so nothing is recorded and the decision's
    // caller learns it through its own write.
    throw new HeartbeatWriteFailure(error)
  }
  const target = processHeartbeatPath(heartbeat.pid, dir)
  // Written to a temporary name and renamed into place, so a reader never
  // sees a half-written file.
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(heartbeat)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return target
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Record this process as running `version`, with `layouts` and `stores`
 * added to what it already holds. Never throws: a failed write is logged at
 * warn and tried again at the next owner start. The file is written only
 * when this process has not written it yet or its records changed, so later
 * owners of a process whose file is current write nothing.
 */
export async function startProcessHeartbeat(input: {
  version: string
  logger: HeartbeatLogger
  layouts?: Record<string, ProcessLayout>
  stores?: Record<string, HeartbeatStoreRecord>
  now?: () => number
  pid?: number
  dir?: string
}): Promise<ProcessHeartbeatHandle> {
  let dir: string | undefined
  let path: string | undefined
  try {
    const pid = input.pid ?? process.pid
    dir = input.dir ?? processHeartbeatDir()
    shared.startedAt ??= (input.now ?? Date.now)()
    shared.owners++
    for (const [key, layout] of Object.entries(input.layouts ?? {}))
      shared.layouts.set(key, layout)
    for (const [key, anchor] of Object.entries(input.stores ?? {}))
      shared.stores.set(key, shared.olderGeneration ? 'config' : anchor)
    path = await writeCurrentRecords(dir, pid, input.version)
  } catch (error) {
    input.logger.warn('process heartbeat not written', {
      dir,
      error: errorText(error),
    })
  }
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      try {
        shared.owners = Math.max(0, shared.owners - 1)
        if (shared.owners > 0) return
        // A process whose paths stay fixed until it exits keeps using them.
        if (holdsFixedOldPaths()) return
        await removeHeartbeatFile(input.logger)
      } catch (error) {
        input.logger.warn('process heartbeat not released', {
          error: errorText(error),
        })
      }
    },
  }
}

/**
 * Write this process's heartbeat when the file is missing or its layouts and
 * store anchors changed, so later owners of a current file write nothing.
 * Returns the file's path, or undefined when it is current already.
 */
async function writeCurrentRecords(
  dir: string,
  pid: number,
  version: string,
): Promise<string> {
  const target = processHeartbeatPath(pid, dir)
  const signature = recordSignature()
  if (shared.writtenPath === target && shared.writtenLayouts === signature)
    return target
  const stores = storesRecord()
  const path = await writeHeartbeatFile(dir, {
    pid,
    version,
    startedAt: shared.startedAt as number,
    layouts: layoutsRecord(),
    ...(Object.keys(stores).length > 0 ? { stores } : {}),
  })
  shared.writtenPath = path
  shared.writtenLayouts = signature
  installExitHook()
  return path
}

async function removeHeartbeatFile(logger: HeartbeatLogger): Promise<void> {
  const path = shared.writtenPath
  if (!path) return
  shared.writtenPath = undefined
  shared.writtenLayouts = undefined
  await rm(path, { force: true }).catch((error: unknown) => {
    logger.warn('process heartbeat not removed', {
      path,
      error: errorText(error),
    })
  })
}

/**
 * Remove this process's heartbeat now, whatever its owners and layouts,
 * because the process is about to exit. The CLI calls it when its command
 * finishes. Never throws.
 */
export async function removeProcessHeartbeat(
  logger: HeartbeatLogger,
): Promise<void> {
  await removeHeartbeatFile(logger)
}

/**
 * Record which layout this process uses for one config folder and write the
 * heartbeat at once, because another process deciding whether it may move
 * the files reads it. A start makes the choice and this write while it holds
 * the layout lock, so a process deciding later sees it; a start whose vault
 * files moved long ago records it without that lock. Throws when the write
 * fails, unlike `startProcessHeartbeat`.
 */
export async function recordProcessLayout(input: {
  key: string
  layout: ProcessLayout
  version: string
  now?: () => number
  pid?: number
  dir?: string
}): Promise<void> {
  shared.layouts.set(input.key, input.layout)
  await writeRecords(markStartedAt(input))
}

/**
 * Record where this process keeps one config folder's account store (see
 * `HeartbeatStoreRecord` in `runtime-paths.ts`) and write the heartbeat at
 * once, because a process deciding whether it may move the store reads it.
 * A start makes the choice and this write while it holds the layout lock, so
 * a process deciding later sees it. Throws when the write fails, unlike
 * `startProcessHeartbeat`.
 */
export async function recordProcessAnchor(input: {
  key: string
  anchor: HeartbeatStoreRecord
  version: string
  now?: () => number
  pid?: number
  dir?: string
}): Promise<void> {
  shared.stores.set(input.key, shared.olderGeneration ? 'config' : input.anchor)
  await writeRecords(markStartedAt(input))
}

/**
 * A record write that starts the process's clock only when nothing has
 * started it yet: the first write that finds it unset is the start time a
 * caller's `now` reports.
 */
function markStartedAt(input: {
  now?: () => number
  version: string
  pid?: number
  dir?: string
}): { startedAt: number; version: string; pid?: number; dir?: string } {
  shared.startedAt ??= (input.now ?? Date.now)()
  return {
    startedAt: shared.startedAt,
    version: input.version,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.dir === undefined ? {} : { dir: input.dir }),
  }
}

/**
 * Write the process's heartbeat now, with its layouts and store anchors. The
 * caller holds the layout lock, and has already claimed the start time with
 * `markStartedAt`.
 */
async function writeRecords(input: {
  version: string
  startedAt: number
  pid?: number
  dir?: string
}): Promise<void> {
  try {
    await writeCurrentRecords(
      input.dir ?? processHeartbeatDir(),
      input.pid ?? process.pid,
      input.version,
    )
  } catch (error) {
    // A later attempt retries the write; the records themselves are kept.
    shared.writtenLayouts = undefined
    throw error instanceof HeartbeatWriteFailure
      ? error
      : new HeartbeatWriteFailure(error)
  }
}

// The plugin's own version, read from the package manifest. This module sits
// directly under `src/`, and the bundles it is built into sit directly under
// `dist/`, so `../package.json` names the manifest from both.
let packageVersion: Promise<string> | undefined
/** This plugin's version, from its package manifest. */
export function pluginPackageVersion(): Promise<string> {
  packageVersion ??= readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  )
    .then((text) => (JSON.parse(text) as { version: string }).version)
    .catch((error: unknown) => {
      // Let the next owner start read it again.
      packageVersion = undefined
      throw error
    })
  return packageVersion
}

/**
 * Start one owner of this process's heartbeat: the plugin's version and the
 * layout this process decided for its OpenCode config folder, or `legacy`
 * while it has not decided. When the package manifest cannot be read it
 * writes version `unknown` and no layout. Never throws; a failure is logged
 * at warn.
 */
export async function startRuntimeProcessHeartbeat(
  logger: HeartbeatLogger,
): Promise<ProcessHeartbeatHandle> {
  let version = 'unknown'
  let layouts: Record<string, ProcessLayout> = {}
  let stores: Record<string, HeartbeatStoreRecord> = {}
  try {
    version = await pluginPackageVersion()
    const location = runtimeLayoutLocation()
    const key = processConfigFolderKey()
    layouts = { [key]: decidedRuntimeLayout(location) ?? 'legacy' }
    // Vault-only starts open no store. Before their first local use they
    // decide under the layout lock, following any forward published meanwhile.
    stores = { [key]: decidedAccountStoreAnchor(location) ?? 'undecided' }
  } catch (error) {
    logger.warn('process heartbeat details unavailable', {
      error: errorText(error),
    })
  }
  return startProcessHeartbeat({ version, logger, layouts, stores })
}

/**
 * The standalone CLI's owner of this process's heartbeat. Commands call it only
 * once they are about to use the plugin's data: never for help, a rejected
 * command line, a setup preview or a setup that refuses before its first
 * change, which must leave the disk untouched. The CLI removes the file when
 * its command finishes.
 */
export async function holdCliProcessHeartbeat(
  logger: HeartbeatLogger,
): Promise<void> {
  await startRuntimeProcessHeartbeat(logger)
}

/** Forget the process-wide heartbeat state; for tests only. */
export function __resetProcessHeartbeatForTest(): void {
  shared.owners = 0
  shared.startedAt = undefined
  shared.layouts.clear()
  shared.stores.clear()
  shared.writtenPath = undefined
  shared.writtenLayouts = undefined
}
