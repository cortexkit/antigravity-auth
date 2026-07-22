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
import { readFileSync } from 'node:fs'
import { z } from 'zod'

import {
  emptyOperatorSettings,
  type OperatorSettings,
  OperatorSettingsSchema,
} from './config/operator-settings-schema'
import { writeOperatorConfig } from './config/writer'

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
