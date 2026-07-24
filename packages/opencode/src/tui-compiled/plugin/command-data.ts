/**
 * Privacy-safe data service for the data-first slash-command dialogs.
 *
 * `/antigravity-quota` (this task) and the future `/antigravity-account`
 * dialogs (Tasks 10-11) read from a single shared service so they
 * never touch raw account storage, never see the email PII field, and
 * never run quota network I/O during the dialog's open path — the
 * Refresh action is the only path that performs a live fetch.
 *
 * Why this is a separate module:
 *
 * - `commands.ts` owns the slash-command orchestration; mixing the row
 *   projection + quota refresh logic in there would balloon the surface
 *   for what is fundamentally a small read/refresh service.
 * - The row type (`CommandAccountRow`) is the projection that crosses
 *   the PII firewall into the dialog payload. Defining it here (next
 *   to the code that constructs it) keeps the firewall reviewable.
 * - Tests can pin the read-vs-refresh boundary, the email redaction, and
 *   the refresh-token-keyed persistence in one file rather than chasing
 *   them across the dispatcher + RPC + apply layers.
 *
 * Cache-only opening contract (Task 9 operator requirement):
 *
 *   `listAccounts()` is a pure read of the live AccountManager view
 *   the auth-loader materialized at session start. It performs
 *   ZERO quota manager calls — opening the dialog must be instant even
 *   when the network is unreachable, and quota refresh must remain an
 *   explicit user-driven action so the cached percentages never quietly
 *   rewrite themselves behind the user's back.
 *
 * Refresh-token-keyed persistence (Task 9 plan trap):
 *
 *   `refreshQuota()` runs the shared quota manager across every enabled
 *   account and folds the results back into the live AccountManager +
 *   storage. Concurrent OAuth can renumber the flat `accounts[]` array
 *   between read and write, so we re-read under the lock and key the
 *   update by `refreshToken` (the canonical identity) rather than the
 *   array index. This way a successful OAuth add that lands between
 *   the read and the write cannot cause the refresh to overwrite the
 *   wrong account.
 */

import {
  buildSidebarMachineStateFromAccounts,
  type SidebarAccountRedactionInput,
  setSidebarMachineState,
} from '../sidebar-state'

/**
 * Local copies of the few core types the data service touches.
 *
 * The shipped TUI tree cannot depend on the `@cortexkit/antigravity-auth-core`
 * barrel (only subpath imports like `./file-lock` are allowed) — the
 * compiled `command-data.ts` is copied verbatim into `tui-compiled/`,
 * and the type-import would otherwise leak the full core surface into
 * the dialog render path. Declaring the structural shape locally keeps
 * the compiled tree free of the barrel while preserving duck-typed
 * compatibility with the production quota manager.
 */
type CommandDataAccountMetadata = {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled?: boolean
  label?: string
  cachedQuota?: Partial<
    Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
  >
  cachedQuotaUpdatedAt?: number
}

type CommandDataQuotaGroup =
  | 'claude'
  | 'gemini-pro'
  | 'gemini-flash'
  | 'gpt-oss'

type CommandDataQuotaGroupSummary = {
  remainingFraction?: number
  resetTime?: string
  modelCount: number
}

type CommandDataAccountQuotaResult = {
  index: number
  status: 'ok' | 'disabled' | 'error'
  error?: string
  disabled?: boolean
  quota?: {
    groups: Partial<Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>>
    perModel?: Array<{
      modelId: string
      displayName?: string
      group: CommandDataQuotaGroup | null
      remainingFraction: number
      resetTime?: string
    }>
    modelCount: number
    error?: string
  }
  updatedAccount?: CommandDataAccountMetadata
}

export interface CommandDataAccountStorage {
  version: 4
  activeIndex: number
  activeIndexByFamily?: { claude?: number; gemini?: number }
  accounts: CommandDataAccountMetadata[]
}

/**
 * Privacy-safe per-account row shown in `/antigravity-*` data-first
 * dialogs. Carries the cached quota percentages and the labels the
 * dialog needs, but NEVER the email — the email stays in private
 * account storage and is invisible to the sidebar and the dialog.
 *
 * `index` is the position in the live account array at the time of
 * projection. It is informational only and is NOT a stable identity
 * across refreshes — concurrent OAuth can renumber the array between
 * the dialog opening and a refresh.
 */
export interface CommandAccountRow {
  /** Stable identity for dialog keying (`acct-<index>`). */
  id: string
  /** Position in the live account array at projection time. */
  index: number
  /** Display label (PII-free OAuth `name`, falling back to `Account N`). */
  label: string
  enabled: boolean
  /** `true` when this row matches the harness-active account. */
  current: boolean
  quota: Array<{
    key: 'claude' | 'gemini-pro' | 'gemini-flash'
    label: string
    remainingPercent: number | null
    resetAt?: number
  }>
}

/**
 * Quota display label for each supported quota group. Kept here so the
 * dialog and the quota manager agree on the same vocabulary.
 */
const QUOTA_GROUP_LABELS: Record<
  CommandAccountRow['quota'][number]['key'],
  string
> = {
  claude: 'Claude',
  'gemini-pro': 'Gemini Pro',
  'gemini-flash': 'Gemini Flash',
}

const SUPPORTED_QUOTA_KEYS = [
  'claude',
  'gemini-pro',
  'gemini-flash',
] as const satisfies readonly CommandAccountRow['quota'][number]['key'][]

interface LiveAccountSnapshot {
  index: number
  refreshToken: string
  label?: string
  enabled: boolean
  active: boolean
  cachedQuota?: Partial<
    Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
  >
  cachedQuotaUpdatedAt?: number
}

function toCommandAccountRow(entry: LiveAccountSnapshot): CommandAccountRow {
  const cached = entry.cachedQuota
  const quota: CommandAccountRow['quota'] = []
  for (const key of SUPPORTED_QUOTA_KEYS) {
    const cachedEntry = cached?.[key]
    if (!cachedEntry) continue
    const fraction = cachedEntry.remainingFraction
    const remainingPercent =
      typeof fraction === 'number' && Number.isFinite(fraction)
        ? Math.round(fraction * 100)
        : null
    let resetAt: number | undefined
    if (
      typeof cachedEntry.resetTime === 'string' &&
      cachedEntry.resetTime.length > 0
    ) {
      const parsed = Date.parse(cachedEntry.resetTime)
      if (Number.isFinite(parsed)) resetAt = parsed
    }
    quota.push({
      key,
      label: QUOTA_GROUP_LABELS[key],
      remainingPercent,
      resetAt,
    })
  }
  const label = entry.label ?? `Account ${entry.index + 1}`
  return {
    id: `acct-${entry.index}`,
    index: entry.index,
    label,
    enabled: entry.enabled,
    current: entry.active,
    quota,
  }
}

export function projectCommandAccountRows(
  storage: CommandDataAccountStorage | null | undefined,
): CommandAccountRow[] {
  if (!storage) return []
  const activeIndex = storage.activeIndexByFamily?.claude ?? storage.activeIndex
  return storage.accounts.map((entry, index) =>
    toCommandAccountRow({
      index,
      refreshToken: entry.refreshToken,
      label: entry.label,
      enabled: entry.enabled !== false,
      active: index === activeIndex,
      cachedQuota: entry.cachedQuota,
      cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
    }),
  )
}

/**
 * Live AccountManager view the data service needs.
 *
 * - `getAccounts()` returns the in-memory snapshot — used for cache-only
 *   reads during dialog open and for re-reading the post-mutation state.
 *   `getAccountsForQuotaCheck()` returns the freshest `AccountMetadataV3`
 *   (the canonical shape the quota manager expects).
 * - `updateQuotaCache(index, groups)` + `requestSaveToDisk()` fold the
 *   refreshed quota back into the live view and persist it. The service
 *   calls them together after the network fetch resolves.
 * - `setAccountEnabled`, `setAccountCurrent`, `removeAccountByIndex`
 *   mirror the CLI menu's mutation primitives — the dialog actions
 *   (Task 10) reuse them so the TUI never invents its own mutation
 *   logic. Each method returns `true` when the live view changed.
 * - `getRefreshTokenAt(index)` lets the service identify the canonical
 *   account identity before it reaches the locked storage mutator; a
 *   concurrent OAuth could renumber the flat array between the dialog
 *   opening and the apply, so keying by refresh token is mandatory.
 * - `flushSaveToDisk()` drains the AccountManager's debounced save so a
 *   dialog-triggered mutation lands on disk before the dialog's response
 *   returns. Without it, the dialog could toast "Account removed" while
 *   the file still carries the old pool.
 * - `activeIndex()` returns the position the harness considers active;
 *   the service uses it to mark the matching row as `current: true`.
 */
export interface CommandDataAccountManagerView {
  getAccounts(): LiveAccountSnapshot[]
  getAccountsForQuotaCheck(): CommandDataAccountMetadata[]
  updateQuotaCache(
    index: number,
    groups: Partial<
      Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
    >,
  ): void
  requestSaveToDisk(): void
  flushSaveToDisk(): Promise<void>
  activeIndex(): number
  /** Enable/disable the account at `index`. Returns true when it changed. */
  setAccountEnabled(index: number, enabled: boolean): boolean
  /** Pin `index` as the active account for every family the dialog cares about. */
  setAccountCurrent(index: number): boolean
  /** Remove the account at `index` from the live view. Returns true when it changed. */
  removeAccountByIndex(index: number): boolean
  /** Canonical refresh token for the account at `index`, or undefined. */
  getRefreshTokenAt(index: number): string | undefined
}

/**
 * Storage adapter the data service uses for re-read-under-lock writes.
 * `mutate` runs the supplied callback against the latest snapshot under
 * the file lock — the callback receives the current storage and may
 * return a replacement; returning the input unchanged is a no-op.
 *
 * The promise resolves with the (possibly mutated) storage snapshot so
 * the data service can await it. A rejected promise signals a failed
 * write — `AccountStorageUnreadableError`, lock contention, or any
 * other I/O failure — which the data service surfaces to the dialog
 * as a friendly error toast.
 */
export interface CommandDataStorage {
  mutate(
    mutator: (
      current: CommandDataAccountStorage,
    ) =>
      | CommandDataAccountStorage
      | undefined
      | Promise<CommandDataAccountStorage | undefined>,
  ): Promise<CommandDataAccountStorage | undefined> | undefined
}

/**
 * Options for `createCommandDataService`. Each field is required so
 * production wiring is explicit — a missing dependency is a startup
 * error, not a silent no-op at dialog-open time.
 */
export interface CommandDataServiceOptions {
  accountManagerView: CommandDataAccountManagerView
  quotaManager: {
    refreshAccounts(
      accounts: CommandDataAccountMetadata[],
      options: {
        indexFor?: (account: CommandDataAccountMetadata) => number
        force?: boolean
      },
    ): Promise<CommandDataAccountQuotaResult[]>
  }
  /** Path to the label-only sidebar state file. */
  sidebarStateFile: string
  /**
   * Optional storage adapter. When provided, the service persists the
   * refreshed quota to disk via the lock-held mutator (best-effort —
   * a lock contention never breaks the dialog response). When omitted,
   * the service still folds results into the live AccountManager view;
   * the auth-loader is responsible for the on-disk write.
   */
  storage?: CommandDataStorage
  /** Clock for `cachedQuotaUpdatedAt`. Tests inject a fixed clock. */
  now?: () => number
}

/**
 * Public surface of the command-data service. Each method is the
 * smallest possible projection so the dialog layer never has to know
 * how the underlying quota manager or storage adapter is wired.
 */
export interface CommandDataService {
  /**
   * Cache-only snapshot. Performs zero quota manager calls — safe to
   * call as part of the dialog's open path.
   */
  listAccounts(): Promise<CommandAccountRow[]>
  /**
   * Force-refresh quota through the shared quota manager, persist by
   * refresh token, bump `cachedQuotaUpdatedAt`, and push a label-only
   * sidebar snapshot. Returns the freshly persisted rows so the
   * dialog can re-render in place.
   */
  refreshQuota(): Promise<CommandAccountRow[]>
  /**
   * Pin `index` as the active account for every family the dialog
   * tracks (claude + gemini). Mutates the live AccountManager AND the
   * locked storage so the new active index survives a restart. Returns
   * the freshly projected rows so the dialog can re-render in place.
   * Returns `null` when the index is out of range or the account has
   * no refresh token — the dialog surfaces the null as a toast.
   */
  setCurrentAccount(index: number): Promise<CommandAccountRow[] | null>
  /**
   * Flip the `enabled` flag on the account at `index`. Mirrors the CLI
   * menu's "manage" toggle so the on-disk state matches what the CLI
   * would produce. Returns the freshly projected rows (or `null` when
   * the index is invalid or the account is ineligible).
   */
  toggleAccountEnabled(index: number): Promise<CommandAccountRow[] | null>
  /**
   * Remove the account at `index` from both the live view and the
   * locked storage. Removal renumbers the flat `accounts[]` array so
   * the returned rows use the freshest indices; callers MUST re-key
   * their transient dialog IDs (`acct-${index}`) by the row's `id`
   * field after this method returns.
   *
   * Returns `null` when the index is out of range — the dialog
   * surfaces the null as a toast.
   */
  removeAccount(index: number): Promise<CommandAccountRow[] | null>
}

/**
 * Build the data service.
 *
 * The factory form (instead of a module-level singleton) keeps the
 * service unit-testable: each test constructs its own dependencies
 * (storage stub, quota manager stub, fixed clock) without touching
 * the production quota path.
 */
export function createCommandDataService(
  options: CommandDataServiceOptions,
): CommandDataService {
  const {
    accountManagerView,
    quotaManager,
    sidebarStateFile,
    storage,
    now = () => Date.now(),
  } = options

  const projectRows = (): CommandAccountRow[] =>
    accountManagerView.getAccounts().map(toCommandAccountRow)

  const writeSidebar = (rows: CommandAccountRow[]): void => {
    const accounts: SidebarAccountRedactionInput[] = rows.map((row) => {
      const claude = row.quota.find((q) => q.key === 'claude')
      const geminiPro = row.quota.find((q) => q.key === 'gemini-pro')
      const geminiFlash = row.quota.find((q) => q.key === 'gemini-flash')
      const toFraction = (
        q: { remainingPercent: number | null } | undefined,
      ): { remainingFraction?: number; resetTime?: string } | undefined => {
        if (!q || q.remainingPercent == null) return undefined
        return { remainingFraction: q.remainingPercent / 100 }
      }
      return {
        index: row.index,
        label: row.label,
        enabled: row.enabled,
        current: row.current,
        cachedQuota: {
          claude: toFraction(claude),
          'gemini-pro': toFraction(geminiPro),
          'gemini-flash': toFraction(geminiFlash),
        },
      }
    })
    // Fire-and-forget — the sidebar writer is fenced by its own queue,
    // so a transient lock contention cannot block the dialog response.
    void setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(accounts, { checkedAt: now() }),
      { stateFile: sidebarStateFile },
    ).catch(() => {
      // Sidebar writes are best-effort; the next command or quota refresh
      // will publish the current snapshot.
    })
  }

  return {
    async listAccounts() {
      return projectRows()
    },

    async refreshQuota() {
      const accountsForQuota = accountManagerView.getAccountsForQuotaCheck()
      if (accountsForQuota.length === 0) {
        // Empty pool: still push a clean sidebar so the TUI drops any
        // stale snapshot left over from a previous session.
        writeSidebar([])
        return []
      }

      const results = await quotaManager.refreshAccounts(accountsForQuota, {
        indexFor: (account) => accountsForQuota.indexOf(account),
        force: true,
      })

      // Index the live account manager view BEFORE we mutate so we can
      // key each result by refresh token (canonical identity) rather
      // than by the array index, which a concurrent OAuth could shift
      // between the quota fetch and the persist.
      const liveSnapshot = accountManagerView.getAccounts()
      const indexByRefreshToken = new Map<string, number>()
      for (const entry of liveSnapshot) {
        if (entry.refreshToken) {
          indexByRefreshToken.set(entry.refreshToken, entry.index)
        }
      }

      // Map each result to the live-view index by refresh token.
      const refreshedAt = now()
      const persisted: Array<{
        index: number
        groups?: Partial<
          Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
        >
      }> = []
      for (const result of results) {
        const matchToken = result.updatedAccount?.refreshToken
        const matchIndex =
          matchToken !== undefined
            ? indexByRefreshToken.get(matchToken)
            : undefined
        const index = matchIndex ?? result.index
        const groups =
          result.status === 'ok' && result.quota?.groups
            ? result.quota.groups
            : undefined
        persisted.push({ index, groups })
      }

      // Apply updates to the live view keyed by refresh token. We do
      // this BEFORE the storage write so any subsequent listAccounts
      // call sees the freshly refreshed percentages even if the storage
      // lock contention has not resolved yet.
      for (const update of persisted) {
        if (update.groups) {
          accountManagerView.updateQuotaCache(update.index, update.groups)
        }
      }
      // Ask the live AccountManager to schedule a save. The
      // AccountManager is already wired with `requestSaveToDisk` and
      // dedupes the underlying disk write; calling it is cheap.
      accountManagerView.requestSaveToDisk()

      // Best-effort storage write keyed by refresh token (re-read under
      // the lock so a concurrent OAuth add cannot have shifted indexes).
      if (storage) {
        const writeResult = storage.mutate((current) => {
          const tokenByIndex = new Map<number, string>()
          for (const [token, idx] of indexByRefreshToken) {
            tokenByIndex.set(idx, token)
          }
          const persistedByToken = new Map<string, (typeof persisted)[number]>()
          for (const update of persisted) {
            const token = tokenByIndex.get(update.index)
            if (token) persistedByToken.set(token, update)
          }
          const next: CommandDataAccountStorage = {
            ...current,
            accounts: current.accounts.map((entry) => {
              const update = persistedByToken.get(entry.refreshToken)
              if (!update) return entry
              if (update.groups) {
                return {
                  ...entry,
                  cachedQuota: update.groups,
                  cachedQuotaUpdatedAt: refreshedAt,
                }
              }
              // Error result keeps the previous cached percentage
              // (freshness matters more than a clean slate) and only
              // bumps the timestamp so the dialog knows we tried.
              return {
                ...entry,
                cachedQuotaUpdatedAt: refreshedAt,
              }
            }),
          }
          return next
        })
        await Promise.resolve(writeResult).catch(() => {
          // Storage write is best-effort — the live AccountManager
          // already carries the freshly refreshed percentages, and the
          // auth-loader's next requestSaveToDisk call will reconcile.
        })
      }

      // Re-read the live view post-mutate so the rows reflect the
      // freshly persisted percentages.
      const rows = projectRows()
      writeSidebar(rows)
      return rows
    },

    async setCurrentAccount(index) {
      return mutateLiveAndStorage({
        action: 'setCurrent',
        index,
        applyLive: (idx) => accountManagerView.setAccountCurrent(idx),
      })
    },

    async toggleAccountEnabled(index) {
      return mutateLiveAndStorage({
        action: 'toggleEnabled',
        index,
        applyLive: (idx) => {
          const snapshot = accountManagerView.getAccounts()[idx]
          if (!snapshot) return false
          // Flip the current `enabled` flag. Disabled → enabled is
          // blocked at the AccountManager layer for ineligible
          // accounts, but the data service cannot see `ineligible`
          // directly — we still forward the request and let the
          // AccountManager enforce it.
          return accountManagerView.setAccountEnabled(idx, !snapshot.enabled)
        },
      })
    },

    async removeAccount(index) {
      return mutateLiveAndStorage({
        action: 'remove',
        index,
        applyLive: (idx) => accountManagerView.removeAccountByIndex(idx),
      })
    },
  }

  /**
   * Shared mutation helper for the three dialog actions. Each one
   * follows the same write-then-live ordering the CLI menu uses at
   * `plugin/oauth-methods.ts:1064-1083`:
   *
   *   1. Read the live view, capture the refresh token at `index`, and
   *      reject out-of-range indices BEFORE reaching the lock so a
   *      no-op index returns `null` without paying the disk cost.
   *   2. Run the locked storage mutator. We key the write by refresh
   *      token (canonical identity) so a concurrent OAuth add cannot
   *      have shifted our `index` between the read and the write.
   *      Removal uses a `filter` so the deleted account cannot be
   *      resurrected by a merge; toggling updates the flag in place.
   *      For `setCurrent`, the on-disk `activeIndex` is computed from
   *      the storage-lookup position (`tokenIdx`), NOT the caller's
   *      live `index` — the flat array can have shifted between the
   *      dialog open and the apply.
   *   3. ONLY apply the matching live AccountManager mutation after
   *      the locked write resolves. A failed write must leave the
   *      runtime consistent with the still-on-disk file — the dialog
   *      surfaces the error text instead of toasting success.
   *   4. Flush the AccountManager's debounced save so the on-disk file
   *      matches the runtime when the apply response returns. (Most
   *      of the dialog's mutations do not schedule a save themselves,
   *      so this flush is the only persistence guarantee.)
   *   5. Re-read the live view, push a fresh sidebar snapshot, and
   *      return the freshly projected rows so the dialog can re-render
   *      in place.
   */
  async function mutateLiveAndStorage(args: {
    action: 'setCurrent' | 'toggleEnabled' | 'remove'
    index: number
    applyLive: (index: number) => boolean
  }): Promise<CommandAccountRow[] | null> {
    const { index, applyLive, action } = args
    const liveBefore = accountManagerView.getAccounts()
    const target = liveBefore[index]
    if (!target) return null
    const refreshToken =
      accountManagerView.getRefreshTokenAt(index) ?? target.refreshToken
    if (!refreshToken) return null

    if (!storage) {
      // Without a storage adapter the mutation cannot survive a restart —
      // bail out so the dialog surfaces a clear error rather than
      // leaving the runtime and disk permanently out of sync.
      throw new Error(
        'CommandDataService is missing a locked-storage adapter; account mutations are disabled.',
      )
    }

    // AWAIT the locked-storage write FIRST. The CLI menu does the same
    // (oauth-methods.ts:1064-1078 then :1083) so a failed write keeps
    // the runtime consistent with disk. Any rejection — lock contention,
    // AccountStorageUnreadableError, I/O — propagates to the apply layer
    // which toasts the message and leaves the dialog alive.
    await storage.mutate((current) => {
      const tokenIdx = current.accounts.findIndex(
        (entry) => entry.refreshToken === refreshToken,
      )
      if (tokenIdx === -1) return current

      if (action === 'setCurrent') {
        // Use the STORAGE-side position (`tokenIdx`), not the caller's
        // live `index`. A concurrent OAuth add can shift the flat array
        // between the dialog open and the apply, so writing `index`
        // here would target the wrong account after restart.
        const last = current.accounts.length - 1
        const clamped = Math.min(Math.max(tokenIdx, 0), last < 0 ? 0 : last)
        return {
          ...current,
          activeIndex: clamped,
          activeIndexByFamily: {
            claude: clamped,
            gemini: clamped,
          },
        }
      }

      if (action === 'toggleEnabled') {
        const entry = current.accounts[tokenIdx]
        if (!entry) return current
        const nextEnabled = entry.enabled === false
        return {
          ...current,
          accounts: current.accounts.map((acc) =>
            acc.refreshToken === refreshToken
              ? { ...acc, enabled: nextEnabled }
              : acc,
          ),
        }
      }

      // 'remove' — filter out the target and reset the active index
      // the same way the CLI menu does it (lines 1064-1078 of
      // plugin/oauth-methods.ts): cursor clamps to 0 so the next
      // selection lands on a still-present account.
      const remaining = current.accounts.filter(
        (acc) => acc.refreshToken !== refreshToken,
      )
      return {
        ...current,
        accounts: remaining,
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }
    })

    // Live in-memory mutation. We do this AFTER the storage write
    // resolves so the disk is authoritative for restart recovery; the
    // live view catching up afterwards keeps the next `listAccounts`
    // consistent. A rejection above would have already exited this
    // function — the live mutation never runs on a failed write.
    applyLive(index)
    // Drain the AccountManager's debounced save so the on-disk file
    // matches the dialog's mutation by the time the apply response
    // returns. Without this, `setCurrent` and `remove` (whose AccountManager
    // methods do not schedule saves) would leave disk stale after the
    // locked mutator above already landed.
    await accountManagerView.flushSaveToDisk().catch(() => {
      // Lock contention is the only realistic failure — the locked
      // storage write above already persisted the mutation, so the
      // next periodic flush will reconcile.
    })

    const rows = projectRows()
    writeSidebar(rows)
    return rows
  }
}
