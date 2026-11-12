/**
 * One process's view of `antigravity-auth.jsonc`, shared by every OpenCode
 * location in the process that uses the same settings file.
 *
 * - **Separate install** (`location.ts`): today's readers and writers stay in
 *   force for the life of the process; the shared file is never opened.
 * - **Legacy, waiting for the move:** while the shared file is missing, the
 *   process keeps reading and writing `antigravity.json` and retries the
 *   one-time move in the background on a backoff.
 * - **Shared:** once the shared file exists (moved here, by another
 *   process, or created by hand) every location reads it through one
 *   settings handle and menu writes go through `handle.update`.
 *
 * Requests never read a file: each location holds a live
 * `AntigravityConfig` object, and the operator controller and model-access
 * policy serve values resolved in memory. They are rebuilt when the
 * handle's watcher fires, when a menu opens and after a menu write.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { AntigravityMenuRefusal } from '@cortexkit/antigravity-auth-core'
import {
  type moveSettingsOnce,
  openSettings,
  type ReportEntry,
  type SettingsEdit,
  type SettingsHandle,
  SettingsRefusal,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'

import {
  getProjectConfigPath,
  getUserConfigPath,
  loadConfig,
} from '../plugin/config/loader'
import {
  type OperatorSettings,
  OperatorSettingsSchema,
} from '../plugin/config/operator-settings-schema'
import { type AntigravityConfig, DEFAULT_CONFIG } from '../plugin/config/schema'
import type { FloorKeying } from '../plugin/killswitch'
import {
  createOperatorSettingsController,
  type OperatorSettingsController,
} from '../plugin/operator-settings'
import { pluginPackageVersion } from '../process-heartbeat'
import { versionFenceOpen } from '../version-fence'
import {
  type AccountModels,
  ANTIGRAVITY_SETTINGS,
  compileModelAccess,
  type ModelAccessPolicy,
} from './core-settings'
import {
  type FloorKeyTable,
  mapLegacySettings,
  readLegacyProjectSettings,
  readLegacySettingsFile,
} from './legacy'
import { resolveSettingsLocation } from './location'
import { runSettingsMove, type SettingsMoveResult } from './move'
import {
  type AppliedProtection,
  createProtectionStore,
  type ProtectionStore,
  type ResolvedProtection,
  resolveProtection,
  unusableAt,
} from './protection'
import {
  defaultMoveReportPath,
  describeReportEntry,
  describeUnmapped,
  dismissMoveReport,
  isFloorEntry,
  type MoveReport,
  readMoveReport,
  refusalText,
  writeMoveReport,
} from './report'

type Values = Record<string, unknown>

const SETTING_NAMES = Object.keys(ANTIGRAVITY_SETTINGS.settings)

/**
 * Values consumed once when a location starts (trackers, caches, pollers,
 * token refresh, logging, updates). A settings change does not restart
 * them, so a refresh leaves these keys as the location started with them.
 */
const START_ONLY = new Set<string>([
  'debug',
  'debug_tui',
  'log_dir',
  'keep_thinking',
  'signature_cache',
  'health_score',
  'token_bucket',
  'proactive_token_refresh',
  'proactive_refresh_buffer_seconds',
  'proactive_refresh_check_interval_seconds',
  'background_quota_refresh',
  'background_quota_refresh_interval_minutes',
  'auto_update',
])

/** Settings that do not map one-to-one onto an `AntigravityConfig` key. */
const NOT_CONFIG_KEYS = new Set([
  'killswitch',
  'log_level',
  'account_models',
  'soft_quota_cache_ttl',
  'soft_quota_cache_ttl_minutes',
  'log_dir',
])

/** Build today's configuration shape from resolved setting values. */
export function toAntigravityConfig(
  values: Values,
  operator: OperatorSettings,
): AntigravityConfig {
  const config = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>
  for (const [name, value] of Object.entries(values)) {
    if (!NOT_CONFIG_KEYS.has(name)) config[name] = structuredClone(value)
  }
  config.soft_quota_cache_ttl_minutes =
    values.soft_quota_cache_ttl === 'minutes'
      ? values.soft_quota_cache_ttl_minutes
      : 'auto'
  // An empty log_dir means the state home's default folder.
  if (typeof values.log_dir === 'string' && values.log_dir !== '')
    config.log_dir = values.log_dir
  config.operator = structuredClone(operator)
  return config as AntigravityConfig
}

/** Replace a live configuration's hot values in place. */
function applyHotValues(
  target: AntigravityConfig,
  next: AntigravityConfig,
): void {
  const live = target as Record<string, unknown>
  for (const [key, value] of Object.entries(next)) {
    if (!START_ONLY.has(key)) live[key] = value
  }
}

export interface SettingsLog {
  warn(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
}

export interface SettingsRuntimeOptions {
  /** The shared settings file and whether this install keeps the old files. */
  readonly file: string
  readonly separateInstall: boolean
  /** `<OpenCode config folder>/antigravity.json`. */
  readonly legacyUserFile: string
  readonly log: SettingsLog
  /** Open only when no older plugin version runs; defaults to the version fence. */
  readonly fence?: () => Promise<boolean>
  /** Floor keys of the local account rows, for re-keying old floors. */
  readonly floorKeys?: () => Promise<FloorKeyTable | null>
  /** Test seams: the library calls and the state files. */
  readonly open?: typeof openSettings
  readonly move?: typeof moveSettingsOnce
  readonly protection?: ProtectionStore
  readonly moveReportPath?: string
  /** Delays between move attempts; the last one repeats. */
  readonly retryDelaysMs?: readonly number[]
}

/** Today's readers for one project, used while the shared file is not in force. */
export interface LegacyProjectReaders {
  config(): AntigravityConfig
  operator(): OperatorSettingsController & { sourcePath?(): string }
}

export interface SettingsOperatorController extends OperatorSettingsController {
  floorKeying(): FloorKeying
  /** The file this location's operator values come from. */
  sourcePath(): string
}

/** One location's settings. */
export interface ProjectSettings {
  /** Live configuration; hot values are replaced in place on refresh. */
  readonly config: AntigravityConfig
  readonly operator: SettingsOperatorController
  mode(): 'legacy' | 'shared'
  /** The file the user edits: `antigravity-auth.jsonc` or `antigravity.json`. */
  configuredIn(): string
  /** The per-account model policy in force, resolved in memory. */
  modelAccess(): ModelAccessPolicy
  /** Lines for the Limits section. */
  limitsNotices(): readonly string[]
  /** Lines for the Diagnostics section; reads files, so call it from menus only. */
  diagnosticsNotices(): Promise<readonly string[]>
  readonly moveReport: {
    present(): Promise<boolean>
    dismiss(): Promise<void>
  }
  /** On menu open: switch to the shared file if it appeared and re-read files. */
  refresh(): Promise<void>
  /** Called after each refresh that may have changed values. */
  onChange(listener: () => void): () => void
  release(): Promise<void>
}

export interface AntigravitySettingsRuntime {
  mode(): 'legacy' | 'shared'
  openProject(
    project: string,
    legacy: LegacyProjectReaders,
  ): Promise<ProjectSettings>
  /** Start the background move; does nothing once it has started or finished. */
  startMove(): void
  /** Settle once the current move attempt and refresh have finished (tests). */
  settled(): Promise<void>
  dispose(): Promise<void>
}

interface ProjectEntry {
  readonly project: string
  readonly config: AntigravityConfig
  readonly legacy: LegacyProjectReaders
  legacyOperator?: ReturnType<LegacyProjectReaders['operator']>
  readonly listeners: Set<() => void>
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000]

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function defaultFence(): Promise<boolean> {
  const currentVersion = await pluginPackageVersion()
  return (await versionFenceOpen({ currentVersion })).open
}

export function createSettingsRuntime(
  options: SettingsRuntimeOptions,
): AntigravitySettingsRuntime {
  const { file, legacyUserFile, log } = options
  const open = options.open ?? openSettings
  const store = options.protection ?? createProtectionStore()
  const reportPath = options.moveReportPath ?? defaultMoveReportPath()
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const fileName = basename(file)

  let mode: 'legacy' | 'shared' = 'legacy'
  let handle: SettingsHandle<typeof ANTIGRAVITY_SETTINGS.settings> | undefined
  let stopWatch: (() => void) | undefined
  const entries = new Set<ProjectEntry>()
  let disposed = false
  // Every switch, refresh and move attempt runs one at a time.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const run = queue.then(step)
    queue = run.catch((error) =>
      log.warn('Settings refresh failed', {
        error: error instanceof Error ? error.name : 'unknown',
      }),
    )
    return run
  }

  // User-level values, which every location shares.
  let operator: OperatorSettings = {
    killswitch: { enabled: false, minimum_remaining_percent: 5, accounts: {} },
    log_level: 'info',
  }
  let protection: ResolvedProtection | undefined
  let policy: ModelAccessPolicy = compileModelAccess({})
  let lastApplied: AppliedProtection = {}
  let persisted: AppliedProtection | undefined
  let moveReport: MoveReport | undefined
  let movedHere = false
  let lastMove: SettingsMoveResult['outcome'] | undefined
  let moveStarted = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let reportedFence = false
  let reportedFailure = false

  const persistProtection = async (): Promise<void> => {
    if (!protection) return
    const next: AppliedProtection = {
      ...(lastApplied.accountModels !== undefined
        ? { accountModels: lastApplied.accountModels }
        : persisted?.accountModels !== undefined
          ? { accountModels: persisted.accountModels }
          : {}),
      ...(lastApplied.floors !== undefined
        ? { floors: lastApplied.floors }
        : persisted?.floors !== undefined
          ? { floors: persisted.floors }
          : {}),
    }
    if (JSON.stringify(next) === JSON.stringify(persisted ?? {})) return
    try {
      await store.save(file, next)
      persisted = next
    } catch (error) {
      log.warn('Could not save the last applied protection settings', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  /** Re-read the user file's values that every location shares. */
  const refreshUserLevel = async (): Promise<void> => {
    if (!handle) return
    await handle.read()
    const killswitch = await handle.get('killswitch', { host: 'opencode' })
    const logLevel = await handle.get('log_level', { host: 'opencode' })
    const accountModels = await handle.get('account_models', {
      host: 'opencode',
    })
    const report = handle.report()
    protection = resolveProtection({
      accountModels,
      floors: killswitch.accounts,
      accountModelsUnusable: unusableAt(report, file, ['account_models']),
      floorsUnusable: unusableAt(report, file, ['killswitch', 'accounts']),
      lastApplied,
      ...(persisted ? { persisted } : {}),
    })
    if (protection.accountModelsSource === 'setting')
      lastApplied = {
        ...lastApplied,
        accountModels: protection.accountModels as AccountModels,
      }
    if (protection.floorsSource === 'setting')
      lastApplied = { ...lastApplied, floors: protection.floors }
    await persistProtection()
    policy =
      protection.accountModels === 'deny-all'
        ? compileModelAccess(undefined, { unusable: true })
        : compileModelAccess(protection.accountModels)
    operator = {
      killswitch: {
        enabled: killswitch.enabled,
        minimum_remaining_percent: killswitch.minimum_remaining_percent,
        accounts: { ...protection.floors },
      },
      log_level: logLevel,
    }
  }

  const resolveProjectConfig = async (
    project: string,
  ): Promise<AntigravityConfig> => {
    if (!handle) throw new Error('The settings handle is not open')
    const values: Values = {}
    for (const name of SETTING_NAMES)
      values[name] = await handle.get(
        name as keyof typeof ANTIGRAVITY_SETTINGS.settings & string,
        { host: 'opencode', project },
      )
    return toAntigravityConfig(values, operator)
  }

  const notify = (entry: ProjectEntry): void => {
    for (const listener of entry.listeners) {
      try {
        listener()
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }

  const refreshAll = async (): Promise<void> => {
    if (mode !== 'shared' || disposed) return
    await refreshUserLevel()
    for (const entry of entries) {
      applyHotValues(entry.config, await resolveProjectConfig(entry.project))
      notify(entry)
    }
  }

  const switchToShared = async (): Promise<void> => {
    if (mode === 'shared' || disposed) return
    handle = open(ANTIGRAVITY_SETTINGS, {
      file,
      log,
      separateInstall: false,
      createMissing: true,
      legacyProject: (project) => ({
        path: getProjectConfigPath(project),
        read: readLegacyProjectSettings,
      }),
    })
    persisted = await store.load(file)
    moveReport = await readMoveReport(reportPath)
    if (moveReport && moveReport.target !== file) moveReport = undefined
    mode = 'shared'
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    await refreshAll()
    stopWatch = handle.watch(() => {
      void enqueue(refreshAll)
    })
  }

  const scheduleAttempt = (delay: number): void => {
    if (disposed) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void enqueue(attemptMove)
    }, delay)
    retryTimer.unref?.()
  }

  const attemptMove = async (): Promise<void> => {
    if (disposed || mode === 'shared') return
    if (await exists(file)) return switchToShared()
    let result: SettingsMoveResult
    try {
      result = await runSettingsMove({
        target: file,
        separateInstall: false,
        legacyUserFile,
        floorKeys: options.floorKeys ?? (async () => null),
        fence: options.fence ?? defaultFence,
        log,
        ...(options.move ? { move: options.move } : {}),
      })
    } catch (cause) {
      result = { outcome: 'failed', unmapped: [], sourcePresent: false, cause }
    }
    lastMove = result.outcome
    switch (result.outcome) {
      case 'moved':
        movedHere = true
        if (result.sourcePresent) {
          try {
            await writeMoveReport(reportPath, {
              movedAt: new Date().toISOString(),
              source: legacyUserFile,
              target: file,
              unmapped: result.unmapped,
            })
          } catch (error) {
            log.warn('Could not save the settings move report', {
              error: error instanceof Error ? error.name : 'unknown',
            })
          }
        }
        return switchToShared()
      case 'done-already':
      case 'aborted-target-appeared':
        return switchToShared()
      case 'separate-install':
        return
      case 'fence-closed':
        if (!reportedFence)
          log.info(
            'Settings stay in antigravity.json while an older antigravity-auth runs',
          )
        reportedFence = true
        break
      case 'failed':
        if (!reportedFailure)
          log.warn('The settings move failed; it is retried', {
            error:
              result.cause instanceof Error ? result.cause.name : 'unknown',
          })
        reportedFailure = true
        break
      case 'busy':
        break
    }
    scheduleAttempt(delays[Math.min(attempt++, delays.length - 1)] ?? 300_000)
  }

  const updateShared = async (
    mutator: (draft: OperatorSettings) => void,
  ): Promise<void> => {
    if (!handle) throw new Error('The settings handle is not open')
    const current = operator
    const draft = structuredClone(current)
    mutator(draft)
    const next = OperatorSettingsSchema.parse(draft)
    const edits: SettingsEdit[] = []
    if (next.killswitch.enabled !== current.killswitch.enabled)
      edits.push({
        setting: 'killswitch',
        path: ['enabled'],
        value: next.killswitch.enabled,
      })
    if (
      next.killswitch.minimum_remaining_percent !==
      current.killswitch.minimum_remaining_percent
    )
      edits.push({
        setting: 'killswitch',
        path: ['minimum_remaining_percent'],
        value: next.killswitch.minimum_remaining_percent,
      })
    const before = current.killswitch.accounts ?? {}
    const after = next.killswitch.accounts ?? {}
    for (const [key, value] of Object.entries(after))
      if (before[key] !== value)
        edits.push({ setting: 'killswitch', path: ['accounts', key], value })
    for (const key of Object.keys(before))
      if (!Object.hasOwn(after, key))
        edits.push({
          setting: 'killswitch',
          path: ['accounts', key],
          remove: true,
        })
    if (next.log_level !== current.log_level)
      edits.push({ setting: 'log_level', value: next.log_level })
    if (edits.length === 0) return
    try {
      await handle.update(edits, { host: 'opencode' })
    } catch (error) {
      if (error instanceof SettingsRefusal)
        throw new AntigravityMenuRefusal(
          refusalText(error.code, file),
          error.code,
        )
      throw error
    }
    await enqueue(refreshAll)
  }

  const legacyOperator = (entry: ProjectEntry) =>
    (entry.legacyOperator ??= entry.legacy.operator())

  /** Old user-file settings left behind by a target that already existed. */
  const strandedLegacyKeys = async (): Promise<string[]> => {
    if (movedHere || moveReport) return []
    let text: string
    try {
      text = await readFile(legacyUserFile, 'utf8')
    } catch {
      return []
    }
    try {
      const note = await readFile(`${legacyUserFile}.MOVED_READPLEASE`, 'utf8')
      if (note.includes(file)) return []
    } catch {
      // No note names the target, so nothing moved these settings.
    }
    const mapped = mapLegacySettings(readLegacySettingsFile(text), 'as-is')
    return Object.keys(mapped.values)
  }

  const protectionNotices = (): { floors?: string; models?: string } => {
    if (!protection) return {}
    const notices: { floors?: string; models?: string } = {}
    if (protection.accountModelsSource !== 'setting')
      notices.models =
        protection.accountModelsSource === 'most-restrictive'
          ? `account_models in ${fileName} can't be used and no earlier value is known, so no account serves until it is fixed.`
          : `account_models in ${fileName} can't be used; the last applied value stays in force until it is fixed.`
    if (protection.floorsSource !== 'setting')
      notices.floors =
        protection.floorsSource === 'most-restrictive'
          ? `The per-account quota floors in ${fileName} can't be used; every account uses the global floor until they are fixed.`
          : `The per-account quota floors in ${fileName} can't be used; the last applied floors stay in force until they are fixed.`
    return notices
  }

  const entryReport = (entry: ProjectEntry): ReportEntry[] => {
    if (!handle) return []
    const projectFiles = new Set([
      getProjectConfigPath(entry.project),
      join(entry.project, '.cortexkit', 'antigravity-auth.jsonc'),
    ])
    return handle
      .report()
      .filter(
        (item) =>
          (item.file.kind === 'user' && item.file.path === file) ||
          projectFiles.has(item.file.path),
      )
  }

  const diagnostics = async (entry: ProjectEntry): Promise<string[]> => {
    if (options.separateInstall) return []
    if (mode === 'legacy') {
      const reason =
        lastMove === 'fence-closed'
          ? 'an older antigravity-auth is still running. Restart OpenCode after updating to finish the move'
          : lastMove === 'failed'
            ? 'the move failed and is retried'
            : 'the move has not finished yet'
      return [
        `Settings are still read from antigravity.json: ${reason}. They move to ${file}.`,
      ]
    }
    const lines = [`Settings file: ${file}`]
    const stranded = await strandedLegacyKeys()
    if (stranded.length > 0)
      lines.push(
        `${legacyUserFile} was not moved, because ${file} already existed. These settings are only in the old file and are not in effect: ${stranded.join(', ')}.`,
      )
    if (moveReport) {
      lines.push(
        `Settings were moved from antigravity.json on ${moveReport.movedAt.slice(0, 10)}.`,
      )
      for (const item of moveReport.unmapped) lines.push(describeUnmapped(item))
    }
    for (const item of entryReport(entry)) lines.push(describeReportEntry(item))
    const notices = protectionNotices()
    if (notices.models) lines.push(notices.models)
    if (notices.floors) lines.push(notices.floors)
    return [...new Set(lines)]
  }

  const limits = (): string[] => {
    if (mode !== 'shared') return []
    const lines = (moveReport?.unmapped ?? [])
      .filter(isFloorEntry)
      .map(describeUnmapped)
    const floors = protectionNotices().floors
    if (floors) lines.push(floors)
    return lines
  }

  const initial = options.separateInstall
    ? Promise.resolve()
    : enqueue(async () => {
        if (await exists(file)) await switchToShared()
      })

  return {
    mode: () => mode,
    async openProject(project, legacy) {
      await initial.catch(() => {})
      let config: AntigravityConfig | undefined
      await enqueue(async () => {
        if (mode === 'shared') config = await resolveProjectConfig(project)
      })
      const entry: ProjectEntry = {
        project,
        config: config ?? legacy.config(),
        legacy,
        listeners: new Set(),
      }
      if (mode === 'legacy') legacyOperator(entry)
      entries.add(entry)
      const controller: SettingsOperatorController = {
        get: () =>
          mode === 'shared'
            ? structuredClone(operator)
            : legacyOperator(entry).get(),
        update: (mutator) =>
          mode === 'shared'
            ? updateShared(mutator)
            : legacyOperator(entry).update(mutator),
        floorKeying: () =>
          mode === 'shared' ? 'stable' : 'refresh-token-hash',
        sourcePath: () =>
          mode === 'shared'
            ? file
            : (legacyOperator(entry).sourcePath?.() ?? legacyUserFile),
        dispose: () => release(),
      }
      let released: Promise<void> | undefined
      const release = (): Promise<void> => {
        released ??= (async () => {
          entries.delete(entry)
          entry.listeners.clear()
          await entry.legacyOperator?.dispose()
        })()
        return released
      }
      return {
        config: entry.config,
        operator: controller,
        mode: () => mode,
        configuredIn: () =>
          mode === 'shared' ? fileName : basename(legacyUserFile),
        modelAccess: () => policy,
        limitsNotices: limits,
        diagnosticsNotices: () => diagnostics(entry),
        moveReport: {
          present: async () => mode === 'shared' && moveReport !== undefined,
          async dismiss() {
            await dismissMoveReport(reportPath)
            moveReport = undefined
          },
        },
        refresh: () =>
          enqueue(async () => {
            if (options.separateInstall || disposed) return
            if (mode === 'legacy') {
              if (await exists(file)) await switchToShared()
              return
            }
            await refreshAll()
          }),
        onChange(listener) {
          entry.listeners.add(listener)
          return () => entry.listeners.delete(listener)
        },
        release,
      }
    },
    startMove() {
      if (options.separateInstall || moveStarted || disposed) return
      moveStarted = true
      void enqueue(attemptMove)
    },
    async settled() {
      await initial.catch(() => {})
      for (;;) {
        const current = queue
        await current
        if (current === queue) return
      }
    },
    async dispose() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      stopWatch?.()
      stopWatch = undefined
      await queue
    },
  }
}

// =============================================================================
// Process registry
// =============================================================================

export interface SettingsRuntimeLease {
  readonly runtime: AntigravitySettingsRuntime
  release(): Promise<void>
}

export interface SettingsRuntimeRegistry {
  acquire(options: SettingsRuntimeOptions): SettingsRuntimeLease
}

/**
 * One runtime per settings file in a process, so every OpenCode location
 * on that file shares one handle, one watcher and one move. Options other
 * than the paths come from the first caller.
 */
export function createSettingsRuntimeRegistry(): SettingsRuntimeRegistry {
  const runtimes = new Map<
    string,
    { runtime: AntigravitySettingsRuntime; refs: number }
  >()
  return {
    acquire(options) {
      const key = JSON.stringify([
        options.file,
        options.separateInstall,
        options.legacyUserFile,
      ])
      let held = runtimes.get(key)
      if (!held) {
        held = { runtime: createSettingsRuntime(options), refs: 0 }
        runtimes.set(key, held)
      }
      const entry = held
      entry.refs++
      let released = false
      return {
        runtime: entry.runtime,
        async release() {
          if (released) return
          released = true
          entry.refs--
          if (entry.refs > 0) return
          if (runtimes.get(key) === entry) runtimes.delete(key)
          await entry.runtime.dispose()
        },
      }
    },
  }
}

export const processSettingsRuntimes: SettingsRuntimeRegistry =
  createSettingsRuntimeRegistry()

/** The settings file and separate-install decision for this OpenCode process. */
export async function openCodeSettingsPaths(project: string): Promise<{
  readonly file: string
  readonly separateInstall: boolean
  readonly legacyUserFile: string
}> {
  const location = await resolveSettingsLocation({
    host: 'opencode',
    project,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
  })
  return {
    file: location.file,
    separateInstall: location.separateInstall,
    legacyUserFile: getUserConfigPath(),
  }
}

/**
 * Resolve one project's configuration once, the way a starting OpenCode
 * process would, without moving anything or watching the file. Tools and
 * test harnesses use it to check which values a location would get.
 */
export async function loadSettingsSnapshot(directory: string): Promise<{
  readonly config: AntigravityConfig
  readonly mode: 'legacy' | 'shared'
  readonly file: string
}> {
  const paths = await openCodeSettingsPaths(directory)
  const runtime = createSettingsRuntime({
    ...paths,
    log: { warn() {}, info() {} },
  })
  try {
    const project = await runtime.openProject(directory, {
      config: () => loadConfig(directory),
      operator: () =>
        createOperatorSettingsController({
          projectConfigPath: getProjectConfigPath(directory),
          userConfigPath: paths.legacyUserFile,
        }),
    })
    const snapshot = {
      config: structuredClone(project.config),
      mode: project.mode(),
      file: paths.file,
    }
    await project.release()
    return snapshot
  } finally {
    await runtime.dispose()
  }
}
