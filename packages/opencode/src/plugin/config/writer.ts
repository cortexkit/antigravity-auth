/**
 * Lock-held config writer for operator-controlled settings.
 *
 * The /antigravity menu persists operator settings, including the
 * quota floor configured in its Limits section, in a small slice of
 * `antigravity.json`. This writer:
 *
 *   1. Selects the existing project config (if present) — never the
 *      user one — so a multi-workspace OpenCode install gets per-project
 *      overrides. When no project config exists, the user config is the
 *      fallback.
 *   2. Holds the `antigravity-operator` lock beside the target file, so
 *      two menu actions fired in quick succession cannot race and the
 *      one-time settings move never copies a half-applied change. The
 *      lock is common-auth's `withLock`, whose lock file record
 *      (`{ ownerId, expiresAt }`, exclusive create) is the one older
 *      versions' fenced lock writes, so each waits for the other and
 *      neither evicts a live holder.
 *   3. Serializes through `writeJsonAtomic` — staged tmp + rename —
 *      so a crash mid-write leaves the previous file intact.
 *   4. Preserves every other top-level field the user may have set
 *      (the operator slice is one slot in the schema, not the whole
 *      file).
 *
 * No raw OAuth refresh tokens ever pass through this writer — the
 * killswitch accounts map is keyed by sha256(refreshToken).slice(0,12)
 * and `OperatorSettings` carries only that hash.
 */

import { existsSync, readFileSync } from 'node:fs'

import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core'
import {
  LockContentionError,
  withLock,
} from '@cortexkit/antigravity-auth-core/common-auth/fs'
import type { OperatorSettings } from './operator-settings-schema'
import { OperatorSettingsSchema } from './operator-settings-schema'

export type { OperatorSettings } from './operator-settings-schema'

/** Shared with older versions and with the settings move; never rename it. */
export const OPERATOR_LOCK_NAME = 'antigravity-operator'
/** The lease older versions used; a holder that stops renewing expires after it. */
const OPERATOR_LOCK_TTL_MS = 5_000
/** How long a write waits for another writer or the settings move. */
const OPERATOR_LOCK_WAIT_MS = 5_000

export interface WriteOperatorConfigOptions {
  projectConfigPath: string
  userConfigPath: string
  operator: OperatorSettings
}

export async function writeOperatorConfig(
  options: WriteOperatorConfigOptions,
): Promise<void> {
  const target = existsSync(options.projectConfigPath)
    ? options.projectConfigPath
    : options.userConfigPath
  await writeOperatorConfigAt(target, options.operator)
}

/**
 * Replace the operator block of one explicit config file under the same
 * fenced lock and atomic rename, keeping every other top-level field. A
 * process-shared settings controller owns exactly one file and writes it
 * through this, so it never re-derives the target from file existence.
 */
export async function writeOperatorConfigAt(
  target: string,
  settings: OperatorSettings,
): Promise<void> {
  const operator = OperatorSettingsSchema.parse(settings)

  try {
    await withLock(
      target,
      {
        name: OPERATOR_LOCK_NAME,
        ttlMs: OPERATOR_LOCK_TTL_MS,
        timeoutMs: OPERATOR_LOCK_WAIT_MS,
        renew: true,
      },
      async () => {
        const existing = readExistingConfig(target)
        const merged = mergeOperator(existing, operator)
        await writeJsonAtomic(target, merged)
      },
    )
  } catch (error) {
    if (error instanceof LockContentionError)
      throw new Error(
        `Could not acquire operator-config lock at ${target} (already held by another writer).`,
      )
    throw error
  }
}

function readExistingConfig(target: string): Record<string, unknown> {
  if (!existsSync(target)) return {}
  try {
    const raw = readFileSync(target, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function mergeOperator(
  existing: Record<string, unknown>,
  operator: OperatorSettings,
): Record<string, unknown> {
  // Carry every other top-level field forward — only the operator slice is
  // replaced by this writer. Anything else the user sets in their
  // antigravity.json (debug flags, model registry, etc.) is preserved.
  const next: Record<string, unknown> = { ...existing }
  next.operator = operator
  return next
}
