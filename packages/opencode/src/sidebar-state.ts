/**
 * Sidebar state contract for the OpenTUI sidebar.
 *
 * This module is the read-only seam between the long-running plugin and the
 * Solid/OpenTUI sidebar tree. It deliberately does NOT import account storage,
 * the account manager, OAuth code, or any other privileged host-side module:
 * the TUI is rendered inside the host's terminal and a single stray import
 * could leak credentials or pull a heavy manager into the render path.
 *
 * The plugin writes a redacted snapshot to the file resolved by
 * `getSidebarStateFile()` and the TUI polls it. The contract version is `1`:
 * any future field that the TUI cannot understand must be ignored, and any
 * broken/missing file must collapse to `DEFAULT_SIDEBAR_STATE`.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { xdgState } from 'xdg-basedir'

export const SIDEBAR_STATE_VERSION = 1 as const

export type SidebarQuotaKey = 'claude' | 'gemini-pro' | 'gemini-flash'

export interface SidebarQuotaEntry {
  remainingPercent: number
  resetAt?: number
}

export interface SidebarAccountState {
  id: string
  label: string
  enabled: boolean
  health: number
  current: boolean
  cooldownUntil?: number
  quota: Partial<Record<SidebarQuotaKey, SidebarQuotaEntry>>
}

export interface SidebarRoutingEntry {
  accountId: string
  modelFamily: 'claude' | 'gemini'
  headerStyle: 'antigravity' | 'gemini-cli'
  updatedAt: number
}

export interface SidebarStateV1 {
  version: typeof SIDEBAR_STATE_VERSION
  checkedAt: number
  accounts: SidebarAccountState[]
  activeRouting: Record<string, SidebarRoutingEntry>
  routingAuthoritative: boolean
  quotaBackoffUntil?: number
  lastError?: string
}

export const DEFAULT_SIDEBAR_STATE: SidebarStateV1 = {
  version: SIDEBAR_STATE_VERSION,
  checkedAt: 0,
  accounts: [],
  activeRouting: {},
  routingAuthoritative: false,
}

export const SIDEBAR_STATE_ENV = 'ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE'

const SIDEBAR_STATE_DIR = 'cortexkit/antigravity-auth'
const SIDEBAR_STATE_FILENAME = 'sidebar-state.json'

/**
 * Resolve the on-disk path the plugin writes to and the TUI reads from.
 *
 * - `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE` wins when set (tests, packaged
 *   installers, and any user override).
 * - Otherwise fall back to the XDG state directory, mirroring the path
 *   conventions used elsewhere in the project.
 */
export function getSidebarStateFile(): string {
  const override = process.env[SIDEBAR_STATE_ENV]
  if (override && override.trim().length > 0) return override
  const base = xdgState ?? join(homedir(), '.local', 'state')
  return join(base, SIDEBAR_STATE_DIR, SIDEBAR_STATE_FILENAME)
}

/**
 * Read and normalize the sidebar state file. Returns the default state when
 * the file is missing, unreadable, malformed, or schema-incompatible — the TUI
 * must never throw out of `readSidebarState()`, the panel just shows
 * "Awaiting Antigravity state" and the next poll retries.
 *
 * The read is sync on purpose: the TUI polls on a 2-second timer and the file
 * is tiny (a handful of accounts); an async read here would just add race
 * surface area against Solid's reactive render cycle.
 */
export function readSidebarState(
  path: string = getSidebarStateFile(),
): SidebarStateV1 {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { ...DEFAULT_SIDEBAR_STATE }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SIDEBAR_STATE, lastError: 'malformed-json' }
  }
  return normalizeSidebarState(parsed)
}

function normalizeSidebarState(input: unknown): SidebarStateV1 {
  if (!isObject(input)) {
    return { ...DEFAULT_SIDEBAR_STATE, lastError: 'shape' }
  }
  const record = input as Record<string, unknown>
  const version = record['version']
  if (version !== SIDEBAR_STATE_VERSION) {
    return {
      ...DEFAULT_SIDEBAR_STATE,
      lastError: `unsupported-version:${stringifySafe(version)}`,
    }
  }

  const accountsRaw = record['accounts']
  const accounts = Array.isArray(accountsRaw)
    ? accountsRaw
        .map((entry) => normalizeAccount(entry))
        .filter((entry): entry is SidebarAccountState => entry !== null)
    : []

  const routingRaw = record['activeRouting']
  const activeRouting: Record<string, SidebarRoutingEntry> = {}
  if (isObject(routingRaw)) {
    for (const [sessionId, entry] of Object.entries(
      routingRaw as Record<string, unknown>,
    )) {
      const normalized = normalizeRouting(entry)
      if (normalized) activeRouting[sessionId] = normalized
    }
  }

  const checkedAt = toFiniteNumber(record['checkedAt'])
  const routingAuthoritative = record['routingAuthoritative'] === true
  const quotaBackoffUntil = toFiniteNumber(record['quotaBackoffUntil'])
  const lastError =
    typeof record['lastError'] === 'string' ? record['lastError'] : undefined

  return {
    version: SIDEBAR_STATE_VERSION,
    checkedAt: checkedAt ?? 0,
    accounts,
    activeRouting,
    routingAuthoritative,
    quotaBackoffUntil: quotaBackoffUntil ?? undefined,
    lastError,
  }
}

function normalizeAccount(input: unknown): SidebarAccountState | null {
  if (!isObject(input)) return null
  const record = input as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : null
  const label = typeof record['label'] === 'string' ? record['label'] : null
  if (!id || !label) return null
  const enabled = record['enabled'] !== false
  const health = clampNumber(toFiniteNumber(record['health']), 0, 100)
  const current = record['current'] === true
  const cooldownUntil = toFiniteNumber(record['cooldownUntil']) ?? undefined
  const quotaRaw = record['quota']
  const quota: SidebarAccountState['quota'] = {}
  if (isObject(quotaRaw)) {
    for (const key of ['claude', 'gemini-pro', 'gemini-flash'] as const) {
      const entry = (quotaRaw as Record<string, unknown>)[key]
      const normalized = normalizeQuota(entry)
      if (normalized) quota[key] = normalized
    }
  }
  return {
    id,
    label,
    enabled,
    health,
    current,
    cooldownUntil,
    quota,
  }
}

function normalizeQuota(input: unknown): SidebarQuotaEntry | null {
  if (!isObject(input)) return null
  const record = input as Record<string, unknown>
  const remaining = toFiniteNumber(record['remainingPercent'])
  if (remaining === null) return null
  const resetAt = toFiniteNumber(record['resetAt']) ?? undefined
  return {
    remainingPercent: clampNumber(remaining, 0, 100),
    resetAt,
  }
}

function normalizeRouting(input: unknown): SidebarRoutingEntry | null {
  if (!isObject(input)) return null
  const record = input as Record<string, unknown>
  const accountId =
    typeof record['accountId'] === 'string' ? record['accountId'] : null
  const modelFamily = record['modelFamily']
  const headerStyle = record['headerStyle']
  const updatedAt = toFiniteNumber(record['updatedAt']) ?? 0
  if (
    !accountId ||
    (modelFamily !== 'claude' && modelFamily !== 'gemini') ||
    (headerStyle !== 'antigravity' && headerStyle !== 'gemini-cli')
  ) {
    return null
  }
  return {
    accountId,
    modelFamily,
    headerStyle,
    updatedAt,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampNumber(value: number | null, min: number, max: number): number {
  if (value === null) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function stringifySafe(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Ensure the parent directory for the sidebar state file exists. Convenience
 * helper used by writers (tests, plugins) — the TUI itself does not write.
 */
export function ensureSidebarStateDir(
  path: string = getSidebarStateFile(),
): void {
  mkdirSync(dirname(path), { recursive: true })
}
