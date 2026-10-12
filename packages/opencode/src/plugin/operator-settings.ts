/**
 * Persistent runtime operator settings.
 *
 * The /antigravity-* slash commands mutate this struct. The controller:
 *
 *   1. Loads the operator slice from the project config (if present)
 *      or the user config on first access, so a fresh plugin boot
 *      sees the user's previous choices.
 *   2. Updates the runtime settings immediately so the same plugin
 *      instance picks up the change without waiting for the file
 *      write to land.
 *   3. Serializes the change through `config/writer.ts` (fenced lock
 *      + atomic rename) so a crash mid-write cannot corrupt the
 *      persisted file.
 *   4. Exposes a single idempotent `dispose()` so it can be hooked
 *      into the plugin lifecycle without leaking timers or listeners.
 *
 * No raw OAuth refresh tokens ever live in this struct — killswitch
 * account overrides are keyed by sha256(refreshToken).slice(0,12).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

import { canonicalizeOwnedPath } from './config/loader'
import {
  emptyOperatorSettings,
  type OperatorSettings,
  OperatorSettingsSchema,
} from './config/operator-settings-schema'
import { writeOperatorConfig, writeOperatorConfigAt } from './config/writer'

// Loaded operator slices may be incomplete (older config files, partial
// user edits); the merge-with-defaults step below fills any gaps.
const PartialOperatorSettingsSchema: z.ZodType<Partial<OperatorSettings>> =
  z.object({
    routing: z
      .object({
        cli_first: z.boolean().optional(),
        quota_style_fallback: z.boolean().optional(),
      })
      .optional(),
    killswitch: z
      .object({
        enabled: z.boolean().optional(),
        minimum_remaining_percent: z.number().min(0).max(100).optional(),
        accounts: z.record(z.string(), z.number().min(0).max(100)).optional(),
      })
      .optional(),
    log_level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
  }) as z.ZodType<Partial<OperatorSettings>>

export type { OperatorSettings } from './config/operator-settings-schema'
export { emptyOperatorSettings } from './config/operator-settings-schema'

export interface OperatorSettingsControllerOptions {
  projectConfigPath: string
  userConfigPath: string
}

export interface OperatorSettingsController {
  get(): OperatorSettings
  update(mutator: (draft: OperatorSettings) => void): Promise<void>
  dispose(): Promise<void>
}

export function createOperatorSettingsController(
  options: OperatorSettingsControllerOptions,
): OperatorSettingsController {
  let cached: OperatorSettings | null = null
  let disposed = false
  let pending: Promise<void> | null = null

  const loadFromDisk = (): OperatorSettings => {
    const existing = readOperatorFile(options.projectConfigPath)
    if (existing) return existing
    const fromUser = readOperatorFile(options.userConfigPath)
    if (fromUser) return fromUser
    return emptyOperatorSettings()
  }

  const persist = async (next: OperatorSettings): Promise<void> => {
    if (pending) await pending
    pending = writeOperatorConfig({
      projectConfigPath: options.projectConfigPath,
      userConfigPath: options.userConfigPath,
      operator: next,
    })
    try {
      await pending
    } finally {
      pending = null
    }
  }

  return {
    get() {
      if (!cached) cached = loadFromDisk()
      return cached
    },
    async update(mutator) {
      if (disposed) throw new Error('OperatorSettingsController is disposed')
      const current = cached ?? loadFromDisk()
      const draft: OperatorSettings = JSON.parse(
        JSON.stringify(current),
      ) as OperatorSettings
      mutator(draft)
      const validated = OperatorSettingsSchema.parse(draft)
      cached = validated
      await persist(validated)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (pending) {
        try {
          await pending
        } catch {
          // Swallow — pending write either landed or threw; either way
          // the cached in-memory copy is authoritative for the rest of
          // this session.
        }
      }
    },
  }
}

// =============================================================================
// Location-scoped settings over process-shared per-file controllers
// =============================================================================

/**
 * The one in-process owner of a config file's operator block. Every location
 * reading or writing that file goes through it, so a write by one location
 * is what the next read by another returns, and writes to one file never
 * interleave.
 */
interface SharedOperatorFile {
  readonly path: string
  /** The file's operator block, or null when it has none that parses. */
  read(): OperatorSettings | null
  /**
   * Serialized read-modify-write. The mutator receives the current block, or
   * `seed()` when the file has none, evaluated when the update runs.
   */
  update(
    seed: () => OperatorSettings,
    mutator: (draft: OperatorSettings) => void,
  ): Promise<void>
}

interface SharedOperatorFileEntry extends SharedOperatorFile {
  refs: number
}

/**
 * Process-wide table of shared operator-file controllers keyed by canonical
 * path. An entry lives while any location holds it and is dropped at the
 * last release, so a later acquisition reads the file afresh.
 */
export interface OperatorSettingsRegistry {
  /** Canonical paths with a live controller (diagnostics and tests). */
  livePaths(): string[]
}

interface OperatorSettingsRegistryInternal extends OperatorSettingsRegistry {
  acquire(path: string): SharedOperatorFileEntry
  release(entry: SharedOperatorFileEntry): void
}

export function createOperatorSettingsRegistry(): OperatorSettingsRegistry {
  const entries = new Map<string, SharedOperatorFileEntry>()

  const createEntry = (path: string): SharedOperatorFileEntry => {
    // undefined = not yet read from disk; null = file has no usable block.
    let state: OperatorSettings | null | undefined
    let chain: Promise<void> = Promise.resolve()
    const read = (): OperatorSettings | null => {
      if (state === undefined) state = readOperatorFile(path)
      return state
    }
    return {
      path,
      refs: 0,
      read,
      update(seed, mutator) {
        const run = chain.then(async () => {
          const draft = cloneSettings(read() ?? seed())
          mutator(draft)
          const validated = OperatorSettingsSchema.parse(draft)
          // In-memory state is authoritative for this process even when the
          // write below fails, matching the single-location controller.
          state = validated
          await writeOperatorConfigAt(path, validated)
        })
        chain = run.catch(() => {})
        return run
      },
    }
  }

  const registry: OperatorSettingsRegistryInternal = {
    livePaths: () => [...entries.keys()],
    acquire(path) {
      const key = canonicalizeOwnedPath(path)
      let entry = entries.get(key)
      if (!entry) {
        entry = createEntry(key)
        entries.set(key, entry)
      }
      entry.refs++
      return entry
    },
    release(entry) {
      entry.refs--
      if (entry.refs <= 0 && entries.get(entry.path) === entry) {
        entries.delete(entry.path)
      }
    },
  }
  return registry
}

/** The registry every location in this process shares. */
export const processOperatorSettingsRegistry: OperatorSettingsRegistry =
  createOperatorSettingsRegistry()

export interface LocationOperatorSettingsOptions
  extends OperatorSettingsControllerOptions {
  /** Defaults to the process registry; tests pass an isolated one. */
  registry?: OperatorSettingsRegistry
}

export interface LocationOperatorSettings extends OperatorSettingsController {
  /** Canonical path of the file this location currently reads. */
  sourcePath(): string
}

/**
 * Acquire one location's operator settings.
 *
 * Reads come from the project file's operator block when it parses, else
 * the user file's block, else defaults. Writes go to the project file
 * whenever it exists (block or not), else the user file, keeping every other
 * field. Each file has one shared controller per process, so locations on
 * the same file see each other's updates and updates to one file serialize.
 * A location whose project file exists without a block reads through the
 * user file; its first mutation seeds a project block from its effective
 * values and rebinds it to the project file. Applying the values (log level,
 * routing, killswitch) is the caller's per-location concern.
 */
export function acquireLocationOperatorSettings(
  options: LocationOperatorSettingsOptions,
): LocationOperatorSettings {
  const registry = (options.registry ??
    processOperatorSettingsRegistry) as OperatorSettingsRegistryInternal
  const project = registry.acquire(options.projectConfigPath)
  const user = registry.acquire(options.userConfigPath)
  let disposed = false
  let pending: Promise<void> = Promise.resolve()

  const projectBound = (): boolean => project.read() !== null
  const effective = (): OperatorSettings =>
    project.read() ?? user.read() ?? emptyOperatorSettings()

  return {
    get: () => effective(),
    sourcePath: () => (projectBound() ? project.path : user.path),
    async update(mutator) {
      if (disposed) throw new Error('OperatorSettingsController is disposed')
      const target = existsSync(project.path) ? project : user
      const seed =
        target === project
          ? () => user.read() ?? emptyOperatorSettings()
          : emptyOperatorSettings
      const run = target.update(seed, mutator)
      pending = run.catch(() => {})
      await run
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await pending
      registry.release(project)
      registry.release(user)
    },
  }
}

function cloneSettings(settings: OperatorSettings): OperatorSettings {
  return JSON.parse(JSON.stringify(settings)) as OperatorSettings
}

function readOperatorFile(path: string): OperatorSettings | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('operator' in (parsed as Record<string, unknown>))
    ) {
      return null
    }
    const partial = PartialOperatorSettingsSchema.safeParse(
      (parsed as { operator: unknown }).operator,
    )
    if (!partial.success) return null
    // Merge loaded slice onto defaults so missing keys fill in.
    return mergeWithDefaults(partial.data)
  } catch {
    return null
  }
}

function mergeWithDefaults(
  partial: Partial<OperatorSettings>,
): OperatorSettings {
  const defaults = emptyOperatorSettings()
  return {
    routing: { ...defaults.routing, ...(partial.routing ?? {}) },
    killswitch: {
      ...defaults.killswitch,
      ...(partial.killswitch ?? {}),
      accounts: {
        ...(defaults.killswitch.accounts ?? {}),
        ...(partial.killswitch?.accounts ?? {}),
      },
    },
    log_level: partial.log_level ?? defaults.log_level,
  }
}

/**
 * Hash a refresh token into the stable 12-char account key used by
 * the killswitch accounts override map. Centralizing the hash here
 * keeps the truncation invariant in one place.
 */
export function accountKeyForRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 12)
}
