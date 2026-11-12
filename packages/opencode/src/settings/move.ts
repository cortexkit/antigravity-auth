/**
 * The one-time move of the old user `antigravity.json` into
 * `antigravity-auth.jsonc`, run in the background and never on the request
 * path. The library takes the move lock, then the operator writer's lock on
 * the old file, re-checks the target and the version fence, and publishes
 * the new file without changing the old one.
 */

import { readFile } from 'node:fs/promises'
import {
  type MoveOutcome,
  moveSettingsOnce,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'
import { OPERATOR_LOCK_NAME } from '../plugin/config/writer'
import { ANTIGRAVITY_SETTINGS } from './core-settings'
import {
  type FloorKeyTable,
  hasTokenKeyedFloors,
  type LegacyUnmapped,
  mapLegacySettings,
  readLegacySettingsFile,
} from './legacy'

export interface SettingsMoveInput {
  readonly target: string
  readonly separateInstall: boolean
  /** The old user settings file, `<OpenCode config folder>/antigravity.json`. */
  readonly legacyUserFile: string
  /**
   * The local account rows' floor keys, read before the move takes any lock.
   * It is asked for only when the old file holds token-keyed floors. Null
   * means no local account store, so every such floor stays unmapped.
   */
  readonly floorKeys: () => Promise<FloorKeyTable | null>
  /** Open only when no older plugin version is running. */
  readonly fence: () => Promise<boolean>
  readonly log: {
    warn(message: string, data?: unknown): void
    info(message: string, data?: unknown): void
  }
  /** Replaces the library call in tests. */
  readonly move?: typeof moveSettingsOnce
}

export interface SettingsMoveResult {
  readonly outcome: MoveOutcome
  readonly unmapped: readonly LegacyUnmapped[]
  /** Whether the old user file existed when the move read it. */
  readonly sourcePresent: boolean
  readonly cause?: unknown
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function runSettingsMove(
  input: SettingsMoveInput,
): Promise<SettingsMoveResult> {
  if (input.separateInstall)
    return { outcome: 'separate-install', unmapped: [], sourcePresent: false }
  // The floor table is built before the move runs, because the mapping runs
  // under the operator lock and must not wait on the account store, whose
  // writers can hold a row lock while they wait for that same operator lock.
  // A table that is stale by the time the mapping runs can only miss a row,
  // which leaves that floor unmapped and reported, never wrongly placed.
  const preview = await readIfPresent(input.legacyUserFile)
  let table: FloorKeyTable = new Map()
  if (
    preview !== undefined &&
    hasTokenKeyedFloors(readLegacySettingsFile(preview))
  ) {
    table = (await input.floorKeys()) ?? new Map()
  }
  const move = input.move ?? moveSettingsOnce
  let sourcePresent = false
  const result = await move({
    definition: ANTIGRAVITY_SETTINGS,
    target: input.target,
    separateInstall: false,
    sources: [
      {
        host: 'opencode',
        path: input.legacyUserFile,
        locks: [{ name: OPERATOR_LOCK_NAME, path: input.legacyUserFile }],
        read: readLegacySettingsFile,
      },
    ],
    map(legacy) {
      const source = legacy[0]
      if (!source?.present) return { entries: [], unmapped: [] }
      sourcePresent = true
      const mapped = mapLegacySettings(
        source.value as ReturnType<typeof readLegacySettingsFile>,
        table,
      )
      return {
        entries: Object.entries(mapped.values).map(([setting, value]) => ({
          source: 0,
          setting,
          value,
        })),
        unmapped: mapped.unmapped.map((entry) => ({ source: 0, ...entry })),
      }
    },
    fence: input.fence,
    log: input.log,
  })
  return {
    outcome: result.outcome,
    unmapped: result.unmapped.map((entry) => ({
      key: entry.key,
      reason: entry.reason as LegacyUnmapped['reason'],
    })),
    sourcePresent,
    ...(result.cause !== undefined ? { cause: result.cause } : {}),
  }
}
