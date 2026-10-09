/**
 * Host-neutral projection of the redacted Antigravity sidebar data into the
 * rows both TUIs draw.
 *
 * Input is the already-redacted account shape: the OpenCode 1 sidebar
 * snapshot (`SidebarAccountState`) and the GA `state` answer's accounts carry
 * the same fields (ordinal id and label, enabled/current, health, cooldown,
 * per-pool remaining percentages, plan tier). Output is plain text and a
 * tone name per row; each host maps tones onto its own theme, so nothing
 * here chooses a color or assumes a dark background.
 *
 * This module imports nothing: no sidebar file, RPC, account store, OAuth or
 * credential code, so the GA build can use it without the OpenCode 1
 * filesystem primitives.
 */

export type ProjectionTone = 'ok' | 'warn' | 'err' | 'muted' | 'text'

export type ProjectionQuotaKey = 'gemini' | 'non-gemini'

export interface ProjectionQuotaWindow {
  readonly window: 'weekly' | '5h'
  readonly remainingPercent: number
  readonly resetAt?: number
}

export interface ProjectionQuotaEntry {
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly windows?: readonly ProjectionQuotaWindow[]
}

/** The redacted account fields the sidebar may show, and nothing else. */
export interface ProjectionAccount {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly health: number
  readonly current: boolean
  readonly cooldownUntil?: number
  readonly quota: {
    readonly gemini?: ProjectionQuotaEntry
    readonly 'non-gemini'?: ProjectionQuotaEntry
  }
  readonly tier?: { readonly id: string; readonly paidId?: string }
}

export interface ProjectionRoute {
  readonly accountId: string
  readonly modelFamily: 'claude' | 'gemini'
  readonly headerStyle: 'antigravity' | 'gemini-cli'
  readonly strategy?: 'sticky' | 'round-robin' | 'hybrid' | null
}

export interface ProjectionStatus {
  readonly checkedAt: number | null
  readonly quotaBackoffUntil: number | null
}

export interface ProjectedQuotaRow {
  readonly label: string
  /** Remaining percent 0–100, or null when no reading is cached. */
  readonly remaining: number | null
  readonly tone: ProjectionTone
  /** "reset in" text, empty without a cached reset time. */
  readonly reset: string
}

export type AccountStatusWord = 'active' | 'idle' | 'cooling' | 'off'

export interface ProjectedAccount {
  readonly id: string
  readonly label: string
  readonly status: AccountStatusWord
  readonly statusTone: ProjectionTone
  readonly quota: readonly ProjectedQuotaRow[]
  /** Health and, while cooling, the remaining wait. */
  readonly health: string
}

export interface ProjectedSidebar {
  readonly accounts: readonly ProjectedAccount[]
  /** `Account N · gemini · antigravity`, or null without a route. */
  readonly route: string | null
  /** Lines describing a degraded state (backoff, no reading yet). */
  readonly notices: readonly string[]
}

export const QUOTA_POOL_LABELS: Readonly<Record<ProjectionQuotaKey, string>> = {
  gemini: 'Gm',
  'non-gemini': 'NG',
}

const POOL_ORDER: readonly ProjectionQuotaKey[] = ['gemini', 'non-gemini']

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  weekly: 'wk',
  '5h': '5h',
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Remaining-percent tone: low remaining is a warning, near-empty an error. */
export function remainingTone(remaining: number | null): ProjectionTone {
  if (remaining === null) return 'muted'
  if (remaining <= 10) return 'err'
  if (remaining <= 30) return 'warn'
  return 'ok'
}

/** `12m`, `3h20m`, `2d4h`; `now` once passed; empty without a reset time. */
export function formatResetIn(
  resetAt: number | undefined,
  now: number,
): string {
  if (!resetAt) return ''
  const ms = resetAt - now
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rm = mins % 60
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24
  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

/** `45s`, `3m`, `3m 20s`. */
export function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
}

function quotaRows(
  account: ProjectionAccount,
  now: number,
): ProjectedQuotaRow[] {
  const rows: ProjectedQuotaRow[] = []
  for (const key of POOL_ORDER) {
    const entry = account.quota[key]
    const label = QUOTA_POOL_LABELS[key]
    if (!entry) {
      rows.push({ label, remaining: null, tone: 'muted', reset: '' })
      continue
    }
    const windows = entry.windows ?? []
    if (windows.length === 0) {
      const remaining = clamp(entry.remainingPercent)
      rows.push({
        label,
        remaining,
        tone: remainingTone(remaining),
        reset: formatResetIn(entry.resetAt, now),
      })
      continue
    }
    for (const window of windows) {
      const remaining = clamp(window.remainingPercent)
      rows.push({
        label: `${label} ${WINDOW_LABELS[window.window] ?? window.window}`,
        remaining,
        tone: remainingTone(remaining),
        reset: formatResetIn(window.resetAt, now),
      })
    }
  }
  return rows
}

/**
 * Status word, first match wins: `off` when disabled, `cooling` while a
 * cooldown runs, `active` for the current account, `idle` otherwise.
 */
export function projectAccount(
  account: ProjectionAccount,
  now: number,
): ProjectedAccount {
  const cooling =
    typeof account.cooldownUntil === 'number' && account.cooldownUntil > now
  const status: AccountStatusWord = !account.enabled
    ? 'off'
    : cooling
      ? 'cooling'
      : account.current
        ? 'active'
        : 'idle'
  const statusTone: ProjectionTone =
    status === 'off'
      ? 'muted'
      : status === 'cooling'
        ? 'warn'
        : status === 'active'
          ? 'ok'
          : 'muted'
  const base = `health ${Math.round(clamp(account.health))}`
  const health = cooling
    ? `${base} · cooling ${formatWait((account.cooldownUntil as number) - now)}`
    : base
  return {
    id: account.id,
    label: account.label,
    status,
    statusTone,
    quota: quotaRows(account, now),
    health,
  }
}

/** The whole sidebar body for one state reading. */
export function projectSidebar(input: {
  readonly accounts: readonly ProjectionAccount[]
  readonly route: ProjectionRoute | null
  readonly status: ProjectionStatus
  readonly now: number
}): ProjectedSidebar {
  const accounts = input.accounts.map((account) =>
    projectAccount(account, input.now),
  )
  let route: string | null = null
  if (input.route) {
    const target = input.accounts.find(
      (account) => account.id === input.route?.accountId,
    )
    route = [
      target?.label ?? 'unknown account',
      input.route.modelFamily,
      input.route.headerStyle,
    ].join(' · ')
  }
  const notices: string[] = []
  if (
    input.status.quotaBackoffUntil !== null &&
    input.status.quotaBackoffUntil > input.now
  ) {
    notices.push(
      `quota checks paused ${formatWait(input.status.quotaBackoffUntil - input.now)}`,
    )
  }
  if (input.status.checkedAt === null) notices.push('quota not checked yet')
  if (accounts.length === 0) notices.push('no accounts')
  return { accounts, route, notices }
}
