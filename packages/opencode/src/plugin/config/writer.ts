/**
 * Lock-held config writer for operator-controlled settings.
 *
 * The /antigravity-quota, /antigravity-account, /antigravity-routing,
 * /antigravity-killswitch, /antigravity-dump, and /antigravity-logging
 * slash commands all mutate a small slice of the persisted
 * `antigravity.json`. This writer:
 *
 *   1. Selects the existing project config (if present) — never the
 *      user one — so a multi-workspace OpenCode install gets per-project
 *      overrides. When no project config exists, the user config is the
 *      fallback.
 *   2. Holds the same fenced file lock Task 7's core uses for the
 *      account pool so two slash commands fired in quick succession
 *      cannot race.
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
import { dirname } from 'node:path'

import {
  acquireFencedFileLock,
  writeJsonAtomic,
} from '@cortexkit/antigravity-auth-core'
import { z } from 'zod'
import type { OperatorSettings } from './operator-settings-schema'
import { OperatorSettingsSchema } from './operator-settings-schema'

export type { OperatorSettings } from './operator-settings-schema'

export interface WriteOperatorConfigOptions {
  projectConfigPath: string
  userConfigPath: string
  operator: OperatorSettings
}

export async function writeOperatorConfig(
  options: WriteOperatorConfigOptions,
): Promise<void> {
  const operator = OperatorSettingsSchema.parse(options.operator)

  const target = existsSync(options.projectConfigPath)
    ? options.projectConfigPath
    : options.userConfigPath

  const lock = await acquireFencedFileLock({
    path: target,
    name: 'antigravity-operator',
    ttlMs: 5_000,
    renew: false,
  })
  if (!lock) {
    throw new Error(
      `Could not acquire operator-config lock at ${target} (already held by another writer).`,
    )
  }

  try {
    const existing = readExistingConfig(target)
    const merged = mergeOperator(existing, operator)
    await writeJsonAtomic(target, merged)
  } finally {
    await lock.release().catch(() => {})
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

void z
void dirname
