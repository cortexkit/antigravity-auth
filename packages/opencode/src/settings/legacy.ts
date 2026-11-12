/**
 * Readers for the settings files used before `antigravity-auth.jsonc`: the
 * user `antigravity.json` in OpenCode's config folder and a project's
 * `.opencode/antigravity.json`. They describe what the old loader would have
 * used, and map it onto the names declared in `ANTIGRAVITY_SETTINGS`.
 *
 * Nothing here takes a lock, opens the account store or throws: the one-time
 * move calls these readers while it holds the operator writer's lock.
 */

import { z } from 'zod'
import {
  type AntigravityConfig,
  AntigravityConfigSchema,
} from '../plugin/config/schema'
import { accountKeyForRefreshToken } from '../plugin/killswitch'
import { RETIRED_SETTINGS } from './core-settings'

/** The old `operator` block as the old operator reader accepted it. */
const LegacyOperatorSchema = z.object({
  killswitch: z
    .object({
      enabled: z.boolean().optional(),
      minimum_remaining_percent: z.number().min(0).max(100).optional(),
      accounts: z.record(z.string(), z.number().min(0).max(100)).optional(),
    })
    .optional(),
  log_level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
})

export type LegacyOperatorBlock = z.infer<typeof LegacyOperatorSchema>

export type LegacySettingsFile =
  | { readonly kind: 'unparseable' }
  | {
      readonly kind: 'parsed'
      /**
       * The old loader dropped the whole file when any top-level value
       * failed validation; `rejected` records that it would have done so.
       */
      readonly topLevel: Partial<AntigravityConfig> | 'rejected'
      /** Top-level keys written in the file, other than `operator`. */
      readonly presentKeys: readonly string[]
      /** The old operator reader ignored the rest of the file. */
      readonly operator: LegacyOperatorBlock | 'absent' | 'rejected'
    }

const DECLARED_KEYS = new Set(Object.keys(AntigravityConfigSchema.shape))

/** Parse one old settings file as the old readers did. Never throws. */
export function readLegacySettingsFile(text: string): LegacySettingsFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'unparseable' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { kind: 'unparseable' }
  const record = raw as Record<string, unknown>
  const parsed = AntigravityConfigSchema.partial().safeParse(record)
  let operator: LegacyOperatorBlock | 'absent' | 'rejected' = 'absent'
  if (Object.hasOwn(record, 'operator')) {
    const block = LegacyOperatorSchema.safeParse(record.operator)
    operator = block.success ? block.data : 'rejected'
  }
  return {
    kind: 'parsed',
    topLevel: parsed.success ? parsed.data : 'rejected',
    presentKeys: Object.keys(record).filter(
      (key) => key !== 'operator' && key !== '$schema',
    ),
    operator,
  }
}

/** Why an old value was not carried into the new file. */
export type LegacyUnmappedReason =
  | 'unparseable'
  | 'ignored-by-runtime'
  | 'retired'
  | 'unknown-key'
  | 'account-not-found'
  | 'account-ambiguous'
  | 'position-key'
  // Reported by the library when a mapped value fails its declaration.
  | 'invalid-value'
  | 'unknown-setting'

export interface LegacyUnmapped {
  readonly key: string
  readonly reason: LegacyUnmappedReason
}

export interface LegacyMapping {
  /** New setting name to the value the old runtime effectively used. */
  readonly values: Readonly<Record<string, unknown>>
  readonly unmapped: readonly LegacyUnmapped[]
}

/**
 * Old per-account floors were keyed by the first 12 hex characters of
 * sha256(refresh token). The table maps each such key to the ids of the
 * local account rows whose stored token has it; more than one id means one
 * token is stored twice and the floor cannot be placed.
 */
export type FloorKeyTable = ReadonlyMap<string, readonly string[]>

/** Build the floor key table from the local store's rows. */
export function floorKeyTableFromRows(
  rows: readonly {
    readonly ref: { readonly id: string }
    readonly credential?: { readonly refreshToken?: string }
  }[],
): FloorKeyTable {
  const table = new Map<string, string[]>()
  for (const row of rows) {
    const token = row.credential?.refreshToken
    if (token === undefined) continue
    const key = accountKeyForRefreshToken(token)
    table.set(key, [...(table.get(key) ?? []), row.ref.id])
  }
  return table
}

const RETIRED = new Set<string>(RETIRED_SETTINGS)
const POSITION_KEY = /^idx-\d+$/

function rekeyFloors(
  accounts: Readonly<Record<string, number>>,
  table: FloorKeyTable,
  unmapped: LegacyUnmapped[],
): Record<string, number> {
  const rekeyed: Record<string, number> = {}
  let ordinal = 0
  for (const [oldKey, value] of Object.entries(accounts)) {
    ordinal++
    if (POSITION_KEY.test(oldKey)) {
      // A roster position is not an account identity.
      unmapped.push({
        key: `killswitch.accounts.${oldKey}`,
        reason: 'position-key',
      })
      continue
    }
    const ids = table.get(oldKey) ?? []
    if (ids.length !== 1) {
      // The token-derived key never leaves this process; the report names
      // the entry by its position in the old file instead.
      unmapped.push({
        key: `killswitch.accounts.entry-${ordinal}`,
        reason: ids.length === 0 ? 'account-not-found' : 'account-ambiguous',
      })
      continue
    }
    rekeyed[ids[0] as string] = value
  }
  return rekeyed
}

/**
 * Map one old file onto new setting names, keeping only what the old
 * runtime used and only keys the file actually wrote. `floors` re-keys the
 * per-account floors of a user file; a project file passes `as-is`, because
 * the new project level skips the whole user-only `killswitch` setting.
 */
export function mapLegacySettings(
  file: LegacySettingsFile,
  floors: FloorKeyTable | 'as-is',
): LegacyMapping {
  const values: Record<string, unknown> = {}
  const unmapped: LegacyUnmapped[] = []
  if (file.kind === 'unparseable') {
    unmapped.push({ key: '', reason: 'unparseable' })
    return { values, unmapped }
  }
  for (const key of file.presentKeys) {
    if (RETIRED.has(key)) {
      unmapped.push({ key, reason: 'retired' })
    } else if (!DECLARED_KEYS.has(key)) {
      unmapped.push({ key, reason: 'unknown-key' })
    } else if (file.topLevel === 'rejected') {
      unmapped.push({ key, reason: 'ignored-by-runtime' })
    } else {
      const value = (file.topLevel as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (key === 'soft_quota_cache_ttl_minutes') {
        if (value === 'auto') values.soft_quota_cache_ttl = 'auto'
        else {
          values.soft_quota_cache_ttl = 'minutes'
          values.soft_quota_cache_ttl_minutes = value
        }
      } else {
        values[key] = value
      }
    }
  }
  if (file.operator === 'rejected') {
    unmapped.push({ key: 'operator', reason: 'ignored-by-runtime' })
  } else if (file.operator !== 'absent') {
    const { killswitch, log_level } = file.operator
    if (log_level !== undefined) values.log_level = log_level
    if (killswitch !== undefined) {
      const next: Record<string, unknown> = {}
      if (killswitch.enabled !== undefined) next.enabled = killswitch.enabled
      if (killswitch.minimum_remaining_percent !== undefined)
        next.minimum_remaining_percent = killswitch.minimum_remaining_percent
      if (killswitch.accounts !== undefined) {
        const accounts =
          floors === 'as-is'
            ? killswitch.accounts
            : rekeyFloors(killswitch.accounts, floors, unmapped)
        if (Object.keys(accounts).length > 0) next.accounts = accounts
      }
      if (Object.keys(next).length > 0) values.killswitch = next
    }
  }
  return { values, unmapped }
}

/** Whether an old user file holds per-account floors keyed by a token hash. */
export function hasTokenKeyedFloors(file: LegacySettingsFile): boolean {
  if (file.kind !== 'parsed' || typeof file.operator !== 'object') return false
  return Object.keys(file.operator.killswitch?.accounts ?? {}).some(
    (key) => !POSITION_KEY.test(key),
  )
}

/**
 * The reader the settings handle uses for a project that has no
 * `.cortexkit/antigravity-auth.jsonc` yet. It returns setting names, and the
 * handle applies only project-allowed ones, naming every user-only one it
 * skips. Retired keys are returned under their old names so the handle's
 * report names them too.
 */
export function readLegacyProjectSettings(text: string): unknown {
  const file = readLegacySettingsFile(text)
  if (file.kind === 'unparseable') {
    // The handle reports a reader that throws as unreadable.
    throw new Error('The old project settings file is not valid JSON')
  }
  const mapped = mapLegacySettings(file, 'as-is')
  const values: Record<string, unknown> = { ...mapped.values }
  for (const entry of mapped.unmapped)
    if (entry.reason === 'retired') values[entry.key] = true
  return values
}
