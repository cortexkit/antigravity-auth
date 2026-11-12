/**
 * Protection settings never widen access. `account_models` limits which
 * models an account serves and the per-account floors in
 * `killswitch.accounts` stop an account early. A value the settings file
 * can't supply must not silently fall back to "no restriction":
 *
 * - while running, the last applied value stays in force;
 * - at start, the last applied value persisted by the host (runtime state in
 *   its state folder, not a setting) is used;
 * - with nothing persisted, the most restrictive reading applies: no
 *   restricted account serves, and every account uses the global floor.
 *
 * Every host (OpenCode and Pi) applies the same rules; each keeps its own
 * state file, so the file path is always the caller's.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeJsonAtomic } from '../atomic-write.ts'
import type { ReportEntry } from '../common-auth-embedded/settings/index.js'
import { type AccountModels, compileModelAccess } from '../model-access.ts'

export const PROTECTION_STATE_FILE_NAME = 'settings-protection.json'

export type Floors = Readonly<Record<string, number>>

/**
 * Last applied protection values for one settings file. A field is absent
 * until the file supplied a usable value for it.
 */
export interface AppliedProtection {
  readonly accountModels?: AccountModels
  readonly floors?: Floors
}

interface ProtectionStateFile {
  readonly version: 1
  /** Keyed by the settings file path the values were read from. */
  readonly files: Record<string, AppliedProtection>
}

function isNumberRecord(value: unknown): value is Floors {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => typeof entry === 'number' && entry >= 0 && entry <= 100,
    )
  )
}

async function readStateFile(path: string): Promise<ProtectionStateFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as ProtectionStateFile).version === 1 &&
      typeof (parsed as ProtectionStateFile).files === 'object'
    )
      return parsed as ProtectionStateFile
  } catch {
    // Missing or damaged state means nothing was persisted.
  }
  return { version: 1, files: {} }
}

export interface ProtectionStore {
  load(settingsFile: string): Promise<AppliedProtection | undefined>
  save(settingsFile: string, applied: AppliedProtection): Promise<void>
}

/** An owner-only JSON file at `path`, in an owner-only folder. */
export function createProtectionStore(path: string): ProtectionStore {
  let writes: Promise<void> = Promise.resolve()
  return {
    async load(settingsFile) {
      const entry = (await readStateFile(path)).files[settingsFile]
      if (!entry) return undefined
      // A damaged field counts as never persisted; the other one still holds.
      return {
        ...(entry.accountModels !== undefined &&
        compileModelAccess(entry.accountModels).valid
          ? { accountModels: entry.accountModels }
          : {}),
        ...(isNumberRecord(entry.floors) ? { floors: entry.floors } : {}),
      }
    },
    save(settingsFile, applied) {
      const run = writes.then(async () => {
        const state = await readStateFile(path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeJsonAtomic(path, {
          version: 1,
          files: { ...state.files, [settingsFile]: applied },
        })
      })
      writes = run.catch(() => {})
      return run
    },
  }
}

export type ProtectionSource =
  | 'setting'
  | 'last-applied'
  | 'persisted'
  | 'most-restrictive'

export interface ResolvedProtection {
  readonly accountModels: AccountModels | 'deny-all'
  readonly floors: Floors
  readonly accountModelsSource: ProtectionSource
  readonly floorsSource: ProtectionSource
}

function userEntries(report: readonly ReportEntry[], file: string) {
  return report.filter(
    (entry) => entry.file.kind === 'user' && entry.file.path === file,
  )
}

/**
 * Whether the user file could not supply a usable value at this key path:
 * the file itself was unreadable (the handle then holds its last good values
 * or, at start, only defaults), or the value at or above the path failed its
 * declaration and was skipped whole.
 */
export function unusableAt(
  report: readonly ReportEntry[],
  file: string,
  path: readonly string[],
): boolean {
  return userEntries(report, file).some((entry) => {
    if (entry.reason === 'unparseable' || entry.reason === 'unreadable')
      return true
    if (entry.reason !== 'invalid-value' && entry.reason !== 'duplicate-key')
      return false
    const length = Math.min(entry.keyPath.length, path.length)
    return entry.keyPath.slice(0, length).every((key, i) => key === path[i])
  })
}

export interface ProtectionInputs {
  readonly accountModels: unknown
  readonly floors: unknown
  readonly accountModelsUnusable: boolean
  readonly floorsUnusable: boolean
  /** The values applied earlier in this process, if any. */
  readonly lastApplied?: AppliedProtection
  /** The values persisted by an earlier process, if any. */
  readonly persisted?: AppliedProtection
}

/** Choose the protection values to apply; never wider than the inputs allow. */
export function resolveProtection(input: ProtectionInputs): ResolvedProtection {
  const modelsUsable =
    !input.accountModelsUnusable &&
    compileModelAccess(input.accountModels).valid
  let accountModels: AccountModels | 'deny-all'
  let accountModelsSource: ProtectionSource
  if (modelsUsable) {
    accountModels = input.accountModels as AccountModels
    accountModelsSource = 'setting'
  } else if (input.lastApplied?.accountModels) {
    accountModels = input.lastApplied.accountModels
    accountModelsSource = 'last-applied'
  } else if (input.persisted?.accountModels) {
    accountModels = input.persisted.accountModels
    accountModelsSource = 'persisted'
  } else {
    accountModels = 'deny-all'
    accountModelsSource = 'most-restrictive'
  }

  const floorsUsable = !input.floorsUnusable && isNumberRecord(input.floors)
  let floors: Floors
  let floorsSource: ProtectionSource
  if (floorsUsable) {
    floors = input.floors as Floors
    floorsSource = 'setting'
  } else if (input.lastApplied?.floors) {
    floors = input.lastApplied.floors
    floorsSource = 'last-applied'
  } else if (input.persisted?.floors) {
    floors = input.persisted.floors
    floorsSource = 'persisted'
  } else {
    // The global floor then applies to every account while the killswitch
    // is on, which is the declared default for per-account floors.
    floors = {}
    floorsSource = 'most-restrictive'
  }
  return { accountModels, floors, accountModelsSource, floorsSource }
}
