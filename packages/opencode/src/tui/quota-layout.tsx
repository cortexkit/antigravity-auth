/** Pure account-window inputs shared by the two sidebar hosts. */
import type {
  SidebarAppearance,
  Tone,
} from '../common-auth-embedded/quota-sidebar/index'
import {
  type QuotaReading,
  type QuotaWindowText,
  quotaWindowText,
} from '../quota-presentation'

export type QuotaAppearance = SidebarAppearance

/**
 * The OpenCode 1 preference defaults for the quota bar, for a renderer that
 * has no preferences file. A test keeps it equal to `DEFAULT_PREFS.appearance`.
 */
export const DEFAULT_QUOTA_APPEARANCE: QuotaAppearance = {
  barWidth: 10,
  barFilledChar: '█',
  barEmptyChar: '░',
  warnThreshold: 50,
  errorThreshold: 80,
}

export type QuotaGroupKey = 'gemini' | 'non-gemini' | 'gemini-argon'

export interface QuotaLayoutWindow {
  readonly window: 'weekly' | '5h'
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly checkedAt?: number
}

export interface QuotaLayoutEntry {
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly checkedAt?: number
  readonly windows?: readonly QuotaLayoutWindow[]
}

/** The account fields the quota layout reads, and nothing else. */
export interface QuotaLayoutAccount {
  readonly label: string
  readonly quota: {
    readonly gemini?: QuotaLayoutEntry
    readonly 'non-gemini'?: QuotaLayoutEntry
    /** Present only on accounts whose reading reports the Argon pool. */
    readonly 'gemini-argon'?: QuotaLayoutEntry
  }
}

// Group headers name each quota pool in plain words.
export const GROUP_NAMES: Record<QuotaGroupKey, string> = {
  gemini: 'Gemini',
  'non-gemini': 'Other models',
  'gemini-argon': 'Argon',
}

export const QUOTA_ORDER: readonly QuotaGroupKey[] = [
  'gemini',
  'non-gemini',
  'gemini-argon',
]

export function quotaTone(usedPct: number, appearance: QuotaAppearance): Tone {
  if (usedPct < appearance.warnThreshold) return 'success'
  if (usedPct < appearance.errorThreshold) return 'warning'
  return 'error'
}

export interface AccountWindow {
  key: QuotaGroupKey
  reading: QuotaReading
  text: QuotaWindowText
}

// One entry per stored window, in group order. A pool stored before
// per-window readings existed contributes one window without a name.
export function accountWindows(
  account: QuotaLayoutAccount,
  now: number,
): AccountWindow[] {
  const result: AccountWindow[] = []
  for (const key of QUOTA_ORDER) {
    const entry = account.quota[key]
    if (!entry) continue
    const readings: QuotaReading[] =
      entry.windows && entry.windows.length > 0
        ? entry.windows.map((window) => ({
            window: window.window,
            remainingPercent: window.remainingPercent,
            resetAt: window.resetAt,
            checkedAt: window.checkedAt,
          }))
        : [
            {
              remainingPercent: entry.remainingPercent,
              resetAt: entry.resetAt,
              checkedAt: entry.checkedAt,
            },
          ]
    for (const reading of readings)
      result.push({ key, reading, text: quotaWindowText(reading, now) })
  }
  return result
}
