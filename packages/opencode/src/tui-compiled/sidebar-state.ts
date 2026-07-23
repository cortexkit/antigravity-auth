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
 *
 * ## Writer surface
 *
 * The plugin-side writers live here too so the read and write halves of the
 * contract evolve together. They are imported by the plugin (auth-loader,
 * quota, fetch-interceptor, event-handler, commands) but never invoked from
 * the TUI's compiled tree — that tree only calls the readers, so the
 * heavyweight core imports below never run inside the host's render path.
 *
 * Every disk mutation follows the same recipe:
 *
 *   1. Serialize through `sidebarWriteChain` so concurrent in-process calls
 *      never interleave merges against the same file.
 *   2. Acquire Task 7's `acquireFencedFileLock` with bounded retry+jitter
 *      (≤2s). A live cross-process holder that does not release in time
 *      surfaces as `SidebarStateLockContentionError`.
 *   3. Re-read and normalize the on-disk state while holding the lock.
 *   4. Merge the new machine or routing payload against the re-read state.
 *   5. `assertOwned()` + `writeJsonAtomic` with mode 0o600, then release.
 *
 * The merge step is deterministic: machine fields adopt only when the new
 * `checkedAt` is ≥ the on-disk one, `routingAuthoritative` is sticky-true,
 * and `activeRouting` is merged independently and pruned to the freshest
 * 100 entries within 24h.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// Subpath imports (not the barrel): this file ships into the TUI's
// compiled tree, and the barrel re-exports account/OAuth/quota modules
// that must never execute inside the host's render path.
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core/atomic-write'
import {
  acquireFencedFileLock,
  type FencedFileLock,
} from '@cortexkit/antigravity-auth-core/file-lock'
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
  strategy?: 'sticky' | 'round-robin' | 'hybrid'
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

/**
 * The subset of `SidebarStateV1` that a non-routing writer may set. The
 * fetch interceptor writes `activeRouting` directly via its own entry point
 * because routing is session-scoped, not machine-scoped.
 */
export interface SidebarMachineState {
  checkedAt: number
  accounts: SidebarAccountState[]
  quotaBackoffUntil?: number
  lastError?: string
  /**
   * Optional: opt in to mark the snapshot as authoritative. When `true`,
   * the merge keeps the existing `routingAuthoritative: true` even if a
   * later non-authoritative machine write lands. Sticky-true semantics.
   */
  routingAuthoritative?: boolean
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

/** Active routing entries older than this are dropped on every merge. */
const ACTIVE_ROUTING_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Active routing map is capped at this many newest entries. */
const ACTIVE_ROUTING_MAX_ENTRIES = 100

const SIDEBAR_LOCK_NAME = 'sidebar'
const SIDEBAR_LOCK_TTL_MS = 10_000
const SIDEBAR_LOCK_TIMEOUT_MS = 2_000
const SIDEBAR_LOCK_RETRY_BASE_MS = 25
const SIDEBAR_LOCK_RETRY_CAP_MS = 75
const SIDEBAR_LOCK_JITTER_MS = 25
const SIDEBAR_STATE_DIR_MODE = 0o700
const SIDEBAR_STATE_FILE_MODE = 0o600

/**
 * Thrown by every writer when the cross-process lock cannot be acquired
 * within `SIDEBAR_LOCK_TIMEOUT_MS`. The caller decides whether to surface
 * a toast, drop the write, or retry the next tick.
 */
export class SidebarStateLockContentionError extends Error {
  readonly details: { stateFile: string; timeoutMs: number }

  constructor(stateFile: string, timeoutMs: number) {
    super(
      `Could not acquire sidebar-state lock at ${stateFile} within ${timeoutMs}ms`,
    )
    this.name = 'SidebarStateLockContentionError'
    this.details = { stateFile, timeoutMs }
  }
}

/**
 * Steps exposed to the merge hooks. Race tests pause writers here; production
 * callers leave the hooks unset (a no-op fast path).
 *
 * - `await-lock` — before invoking `acquireFencedFileLock`.
 * - `acquired-lock` — after the lock is granted and before the read.
 * - `read-state` — after the on-disk state is normalized.
 * - `merged-state` — after the merge but before `writeJsonAtomic`.
 * - `wrote-state` — after the rename but before `lock.release()`.
 */
export type SidebarMergeStep =
  | 'await-lock'
  | 'acquired-lock'
  | 'read-state'
  | 'merged-state'
  | 'wrote-state'

export interface SidebarMergeHooks {
  onStep?: (step: SidebarMergeStep) => Promise<void> | void
}

let sidebarMergeHooks: SidebarMergeHooks | null = null

/**
 * Install (or clear with `null`) the deterministic race hooks. Tests use
 * these to inject interleavings; production callers leave them unset. The
 * module-level state means a test must reset hooks in its own `afterEach`
 * to avoid bleeding into the next test.
 */
export function setSidebarMergeHooks(hooks: SidebarMergeHooks | null): void {
  sidebarMergeHooks = hooks
}

async function emitMergeStep(step: SidebarMergeStep): Promise<void> {
  await sidebarMergeHooks?.onStep?.(step)
}

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
  const version = record.version
  if (version !== SIDEBAR_STATE_VERSION) {
    return {
      ...DEFAULT_SIDEBAR_STATE,
      lastError: `unsupported-version:${stringifySafe(version)}`,
    }
  }

  const accountsRaw = record.accounts
  const accounts = Array.isArray(accountsRaw)
    ? accountsRaw
        .map((entry) => normalizeAccount(entry))
        .filter((entry): entry is SidebarAccountState => entry !== null)
    : []

  const routingRaw = record.activeRouting
  const activeRouting: Record<string, SidebarRoutingEntry> = {}
  if (isObject(routingRaw)) {
    for (const [sessionId, entry] of Object.entries(
      routingRaw as Record<string, unknown>,
    )) {
      const normalized = normalizeRouting(entry)
      if (normalized) activeRouting[sessionId] = normalized
    }
  }

  const checkedAt = toFiniteNumber(record.checkedAt)
  const routingAuthoritative = record.routingAuthoritative === true
  const quotaBackoffUntil = toFiniteNumber(record.quotaBackoffUntil)
  const lastError =
    typeof record.lastError === 'string' ? record.lastError : undefined

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
  const id = typeof record.id === 'string' ? record.id : null
  const label = typeof record.label === 'string' ? record.label : null
  if (!id || !label) return null
  const enabled = record.enabled !== false
  const health = clampNumber(toFiniteNumber(record.health), 0, 100)
  const current = record.current === true
  const cooldownUntil = toFiniteNumber(record.cooldownUntil) ?? undefined
  const quotaRaw = record.quota
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
  const remaining = toFiniteNumber(record.remainingPercent)
  if (remaining === null) return null
  const resetAt = toFiniteNumber(record.resetAt) ?? undefined
  return {
    remainingPercent: clampNumber(remaining, 0, 100),
    resetAt,
  }
}

function normalizeRouting(input: unknown): SidebarRoutingEntry | null {
  if (!isObject(input)) return null
  const record = input as Record<string, unknown>
  const accountId =
    typeof record.accountId === 'string' ? record.accountId : null
  const modelFamily = record.modelFamily
  const headerStyle = record.headerStyle
  const strategy = record.strategy
  const updatedAt = toFiniteNumber(record.updatedAt) ?? 0
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
    strategy:
      strategy === 'sticky' ||
      strategy === 'round-robin' ||
      strategy === 'hybrid'
        ? strategy
        : undefined,
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
  mkdirSync(dirname(path), { recursive: true, mode: SIDEBAR_STATE_DIR_MODE })
}

/**
 * Drop active-routing entries older than 24h and cap the map at the freshest
 * 100. Pure helper exposed for unit testing; the writers call it on every
 * merge so the on-disk map never grows without bound.
 */
export function pruneActiveRouting(
  map: Record<string, SidebarRoutingEntry>,
  now: number,
): Record<string, SidebarRoutingEntry> {
  const cutoff = now - ACTIVE_ROUTING_MAX_AGE_MS
  const filtered: Array<[string, SidebarRoutingEntry]> = []
  for (const [sessionId, entry] of Object.entries(map)) {
    if (entry.updatedAt >= cutoff) {
      filtered.push([sessionId, entry])
    }
  }
  filtered.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  if (filtered.length <= ACTIVE_ROUTING_MAX_ENTRIES) {
    return Object.fromEntries(filtered)
  }
  return Object.fromEntries(filtered.slice(0, ACTIVE_ROUTING_MAX_ENTRIES))
}

/**
 * Structural input for `redactAccountForSidebar`. Decoupled from the core
 * `ManagedAccount` type so this module never forces a type-level import
 * shape on callers (and so the TUI's compiled tree does not see the core
 * ManagedAccount shape beyond what's actually used).
 *
 * Deliberately excludes `email`: the sidebar/redaction boundary is a PII
 * firewall. Adding `email` here would re-introduce the leak this boundary
 * exists to prevent; producers must pass `label` instead.
 */
export interface SidebarAccountRedactionInput {
  /** Position in the harness-visible account array. */
  index: number
  label?: string
  enabled?: boolean
  current?: boolean
  coolingDownUntil?: number
  /** Health score in `[0, 100]`. Defaults to 100 when missing. */
  healthScore?: number
  cachedQuota?: {
    claude?: { remainingFraction?: number; resetTime?: string }
    'gemini-pro'?: { remainingFraction?: number; resetTime?: string }
    'gemini-flash'?: { remainingFraction?: number; resetTime?: string }
  }
}

/**
 * Convert a live account snapshot into the redacted shape the TUI renders.
 * The redacted `SidebarAccountState` carries NO refresh token, access token,
 * project ID, fingerprint, or other credential-shaped fields; only the
 * `id`/`label`/`enabled`/`health`/`current`/`cooldownUntil`/`quota` set the
 * sidebar renders.
 */
export function redactAccountForSidebar(
  source: SidebarAccountRedactionInput,
): SidebarAccountState {
  const id = `acct-${source.index}`
  const label = source.label ?? `Account ${source.index + 1}`
  const enabled = source.enabled !== false
  const current = source.current === true
  const cooldownUntil =
    typeof source.coolingDownUntil === 'number' &&
    Number.isFinite(source.coolingDownUntil)
      ? source.coolingDownUntil
      : undefined
  const health = clampNumber(
    typeof source.healthScore === 'number' ? source.healthScore : null,
    0,
    100,
  )

  const quota: SidebarAccountState['quota'] = {}
  const cached = source.cachedQuota
  if (cached) {
    for (const key of ['claude', 'gemini-pro', 'gemini-flash'] as const) {
      const entry = cached[key]
      if (!entry) continue
      const fraction = entry.remainingFraction
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue
      const remainingPercent = clampNumber(Math.round(fraction * 100), 0, 100)
      let resetAt: number | undefined
      if (typeof entry.resetTime === 'string' && entry.resetTime.length > 0) {
        const parsed = Date.parse(entry.resetTime)
        if (Number.isFinite(parsed)) resetAt = parsed
      }
      quota[key] = { remainingPercent, resetAt }
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

/**
 * Build a `SidebarMachineState` from a list of live account snapshots.
 * Convenience for the auth-loader / quota writer call sites that already
 * hold an array of accounts and want to push a single snapshot.
 */
export function buildSidebarMachineStateFromAccounts(
  accounts: SidebarAccountRedactionInput[],
  options: {
    checkedAt?: number
    quotaBackoffUntil?: number
    lastError?: string
    routingAuthoritative?: boolean
  } = {},
): SidebarMachineState {
  return {
    checkedAt: options.checkedAt ?? Date.now(),
    accounts: accounts.map((entry) => redactAccountForSidebar(entry)),
    quotaBackoffUntil: options.quotaBackoffUntil,
    lastError: options.lastError,
    routingAuthoritative: options.routingAuthoritative,
  }
}

interface SidebarStateWriteOptions {
  stateFile?: string
}

let sidebarWriteChain: Promise<void> = Promise.resolve()

function enqueueSidebarWrite<T>(work: () => Promise<T>): Promise<T> {
  // Always run `work` regardless of whether the prior link resolved or
  // rejected — a failed write must not poison the chain for the next caller.
  const next = sidebarWriteChain.then(work, work)
  sidebarWriteChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Wait for any in-flight sidebar state write to drain. The plugin lifecycle
 * calls this during `dispose()` so the file logger and RPC server are torn
 * down only after every queued write has either landed or thrown.
 */
export function drainSidebarWrites(): Promise<void> {
  return sidebarWriteChain
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSidebarLockWithRetry(
  stateFile: string,
): Promise<FencedFileLock> {
  const start = Date.now()
  let attempt = 0
  while (true) {
    await emitMergeStep('await-lock')
    const lock = await acquireFencedFileLock({
      path: stateFile,
      name: SIDEBAR_LOCK_NAME,
      ttlMs: SIDEBAR_LOCK_TTL_MS,
      renew: true,
    })
    if (lock) {
      await emitMergeStep('acquired-lock')
      return lock
    }
    const elapsed = Date.now() - start
    if (elapsed >= SIDEBAR_LOCK_TIMEOUT_MS) {
      throw new SidebarStateLockContentionError(
        stateFile,
        SIDEBAR_LOCK_TIMEOUT_MS,
      )
    }
    const backoff = Math.min(
      SIDEBAR_LOCK_RETRY_CAP_MS,
      SIDEBAR_LOCK_RETRY_BASE_MS + attempt * 10,
    )
    const jitter = Math.floor(Math.random() * SIDEBAR_LOCK_JITTER_MS)
    await sleep(backoff + jitter)
    attempt++
  }
}

async function performSidebarWrite(
  stateFile: string,
  merge: (existing: SidebarStateV1) => SidebarStateV1,
): Promise<void> {
  await enqueueSidebarWrite(async () => {
    ensureSidebarStateDir(stateFile)
    const lock = await acquireSidebarLockWithRetry(stateFile)
    try {
      await lock.assertOwned()
      const existing = readSidebarState(stateFile)
      await emitMergeStep('read-state')
      const merged = merge(existing)
      await emitMergeStep('merged-state')
      await writeJsonAtomic(stateFile, merged)
      // `writeJsonAtomic` stages a tmp file with mode 0o600 and renames onto
      // the target; POSIX rename replaces the inode so the new file inherits
      // the staged mode bits. Windows ignores POSIX modes so the assertion
      // in tests is best-effort there.
      await emitMergeStep('wrote-state')
    } finally {
      await lock.release().catch(() => {})
    }
  })
}

/**
 * Merge a new machine-state payload against the on-disk state.
 *
 * Stale writes (new `checkedAt` < existing) are dropped — only newer/equal
 * `checkedAt` may replace machine fields. The merge preserves
 * `routingAuthoritative: true` once it is true (sticky-true), keeps the
 * existing `activeRouting` intact (routing is merged via its own writer),
 * and prunes any expired routing entries as a side effect.
 */
function mergeMachineState(
  existing: SidebarStateV1,
  next: SidebarMachineState,
): SidebarStateV1 {
  if (next.checkedAt < existing.checkedAt) {
    return {
      ...existing,
      activeRouting: pruneActiveRouting(existing.activeRouting, Date.now()),
    }
  }
  return {
    version: SIDEBAR_STATE_VERSION,
    checkedAt: next.checkedAt,
    accounts: next.accounts,
    quotaBackoffUntil: next.quotaBackoffUntil,
    lastError: next.lastError,
    routingAuthoritative:
      existing.routingAuthoritative === true ||
      next.routingAuthoritative === true,
    // Symmetric with the stale-write branch: every machine-write merge
    // re-prunes activeRouting so a long-running TUI session eventually
    // drops dead routes even when no fresh routing upsert lands. Cheap
    // (a single Object.entries + sort over ≤100 entries) and bounded.
    activeRouting: pruneActiveRouting(existing.activeRouting, Date.now()),
  }
}

/**
 * Upsert a single session's active routing entry. The fetch interceptor calls
 * this with `authoritative: true` after every final route selection; the
 * `accountId`/`modelFamily`/`headerStyle` fields are already redacted by the
 * caller (the writer never sees token or project fields).
 */
export async function upsertSidebarActiveRouting(
  sessionId: string,
  entry: SidebarRoutingEntry,
  options: SidebarStateWriteOptions & { authoritative?: boolean } = {},
): Promise<void> {
  const stateFile = options.stateFile ?? getSidebarStateFile()
  await performSidebarWrite(stateFile, (existing) => {
    const activeRouting = { ...existing.activeRouting, [sessionId]: entry }
    return {
      ...existing,
      routingAuthoritative:
        options.authoritative === true ? true : existing.routingAuthoritative,
      activeRouting: pruneActiveRouting(activeRouting, Date.now()),
    }
  })
}

/**
 * Remove one session's active routing entry. The event handler calls this
 * when a session is deleted so the sidebar does not retain dead routes.
 */
export async function removeSidebarActiveRouting(
  sessionId: string,
  options: SidebarStateWriteOptions = {},
): Promise<void> {
  const stateFile = options.stateFile ?? getSidebarStateFile()
  await performSidebarWrite(stateFile, (existing) => {
    if (!(sessionId in existing.activeRouting)) {
      return existing
    }
    const activeRouting = { ...existing.activeRouting }
    delete activeRouting[sessionId]
    return {
      ...existing,
      activeRouting,
    }
  })
}

/**
 * Write a new machine-state snapshot. The fetch interceptor and quota
 * manager call this after each refresh; auth-loader calls it after the
 * account pool is materialized.
 */
export async function setSidebarMachineState(
  next: SidebarMachineState,
  options: SidebarStateWriteOptions = {},
): Promise<void> {
  const stateFile = options.stateFile ?? getSidebarStateFile()
  await performSidebarWrite(stateFile, (existing) =>
    mergeMachineState(existing, next),
  )
}

void SIDEBAR_STATE_FILE_MODE
