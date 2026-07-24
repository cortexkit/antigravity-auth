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

import { createHash } from 'node:crypto'

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
  cachedQuotaAccountId?: string
  accountIneligible?: boolean
}

type CommandDataQuotaGroup = 'gemini' | 'non-gemini'

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
  /** Privacy-safe ordinal display label (for example, `Account 1`). */
  label: string
  enabled: boolean
  /** `true` when this row matches the harness-active account. */
  current: boolean
  quota: Array<{
    key: 'gemini' | 'non-gemini'
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
  gemini: 'Gemini',
  'non-gemini': 'Non-Gemini',
}

const SUPPORTED_QUOTA_KEYS = [
  'gemini',
  'non-gemini',
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
  cachedQuotaAccountId?: string
  accountIneligible?: boolean
}

function toCommandAccountRow(entry: LiveAccountSnapshot): CommandAccountRow {
  // Stamp mismatch: the cached quota was captured for a different account
  // (the refresh token changed, or an index shift placed another account's
  // snapshot at this position). Drop the stale cache rather than rendering
  // the wrong account's quota percentages.
  const cached =
    entry.cachedQuotaAccountId &&
    entry.cachedQuotaAccountId !== quotaAccountIdentity(entry.refreshToken)
      ? undefined
      : entry.cachedQuota
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
  const label = `Account ${entry.index + 1}`
  return {
    id: `acct-${entry.index}`,
    index: entry.index,
    label,
    enabled: entry.enabled,
    current: entry.active,
    quota,
  }
}

/**
 * Opaque identity derived from a refresh token. Antigravity refresh tokens
 * are stable (they do not rotate), so this hash is a durable, prunable
 * identity to detect a stale cached quota after an account-index shift.
 */
function quotaAccountIdentity(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
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
      cachedQuotaAccountId: entry.cachedQuotaAccountId,
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
    expectedRefreshToken?: string,
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
      const gemini = row.quota.find((q) => q.key === 'gemini')
      const nonGemini = row.quota.find((q) => q.key === 'non-gemini')
      const toFraction = (
        q: { remainingPercent: number | null; resetAt?: number } | undefined,
      ): { remainingFraction?: number; resetTime?: string } | undefined => {
        if (!q || q.remainingPercent == null) return undefined
        return {
          remainingFraction: q.remainingPercent / 100,
          // Preserve resetTime so the sidebar can render reset countdowns
          // for each pool. Without this the TUI loses the freshest reset
          // deadline every time the dialog re-renders.
          resetTime:
            typeof q.resetAt === 'number' && Number.isFinite(q.resetAt)
              ? new Date(q.resetAt).toISOString()
              : undefined,
        }
      }
      return {
        index: row.index,
        label: row.label,
        enabled: row.enabled,
        current: row.current,
        cachedQuota: {
          gemini: toFraction(gemini),
          'non-gemini': toFraction(nonGemini),
        },
        // The stamp check has already been done by `toCommandAccountRow`
        // before the rows reach this writer; nothing further for the
        // sidebar projection to validate here.
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

      const refreshedAt = now()
      const updates: Array<{
        refreshToken: string
        groups?: Partial<
          Record<CommandDataQuotaGroup, CommandDataQuotaGroupSummary>
        >
      }> = []
      for (const result of results) {
        const refreshToken =
          result.updatedAccount?.refreshToken ??
          accountsForQuota[result.index]?.refreshToken
        if (!refreshToken) continue
        const groups =
          result.status === 'ok' && result.quota?.groups
            ? result.quota.groups
            : undefined
        updates.push({ refreshToken, groups })
      }

      // Resolve live indexes only after the network request. Numeric indexes
      // from the quota result refer to the original input array and may now
      // identify a different account after a concurrent add/remove.
      const liveIndexByRefreshToken = new Map<string, number>()
      for (const entry of accountManagerView.getAccounts()) {
        liveIndexByRefreshToken.set(entry.refreshToken, entry.index)
      }
      let liveQuotaChanged = false
      for (const update of updates) {
        const liveIndex = liveIndexByRefreshToken.get(update.refreshToken)
        if (liveIndex === undefined || !update.groups) continue
        accountManagerView.updateQuotaCache(
          liveIndex,
          update.groups,
          update.refreshToken,
        )
        liveQuotaChanged = true
      }
      if (liveQuotaChanged) accountManagerView.requestSaveToDisk()

      // Persist by canonical refresh token against the latest locked snapshot.
      // A removed account is skipped rather than falling back to its old index.
      if (storage) {
        const updateByRefreshToken = new Map(
          updates.map((update) => [update.refreshToken, update]),
        )
        const writeResult = storage.mutate((current) => ({
          ...current,
          accounts: current.accounts.map((entry) => {
            const update = updateByRefreshToken.get(entry.refreshToken)
            if (!update) return entry
            if (update.groups) {
              return {
                ...entry,
                cachedQuota: update.groups,
                // Stamp the persisted quota with an opaque identity derived
                // from the refresh token so a later projection can detect
                // a stale snapshot after an account-index shift.
                cachedQuotaAccountId: quotaAccountIdentity(entry.refreshToken),
                cachedQuotaUpdatedAt: refreshedAt,
              }
            }
            // Error result keeps the previous cached percentage and only
            // records that a refresh was attempted.
            return {
              ...entry,
              cachedQuotaUpdatedAt: refreshedAt,
            }
          }),
        }))
        await Promise.resolve(writeResult).catch(() => {
          // The live AccountManager already carries successful refreshes; its
          // next save can reconcile a transient storage-lock failure.
        })
      }

      // Re-read the live view post-mutate so the rows reflect the
      // freshly persisted percentages.
      const rows = projectRows()
      writeSidebar(rows)
      return rows
    },

    async setCurrentAccount(index) {
      return mutateLiveAndStorage({ action: 'setCurrent', index })
    },

    async toggleAccountEnabled(index) {
      return mutateLiveAndStorage({ action: 'toggleEnabled', index })
    },

    async removeAccount(index) {
      return mutateLiveAndStorage({ action: 'remove', index })
    },
  }

  async function mutateLiveAndStorage(args: {
    action: 'setCurrent' | 'toggleEnabled' | 'remove'
    index: number
  }): Promise<CommandAccountRow[] | null> {
    const { index, action } = args
    const target = accountManagerView.getAccounts()[index]
    if (!target) return null
    const refreshToken =
      accountManagerView.getRefreshTokenAt(index) ?? target.refreshToken
    if (!refreshToken) return null
    if (
      action === 'toggleEnabled' &&
      target.enabled === false &&
      target.accountIneligible === true
    ) {
      throw new Error(
        'This account is ineligible and cannot be enabled until eligibility is rechecked.',
      )
    }

    if (!storage) {
      throw new Error(
        'CommandDataService is missing a locked-storage adapter; account mutations are disabled.',
      )
    }

    // Capture the live view's current-account identity per family BEFORE
    // the storage mutation. The remove action must persist the index that
    // the same account will occupy AFTER the removal — unconditionally
    // resetting to 0 made a non-current removal promote whichever account
    // shifted into slot 0 to "active" on the next restart.
    const liveCurrentTokens: { claude?: string; gemini?: string } = {}
    if (action === 'remove') {
      const liveAccounts = accountManagerView.getAccounts()
      const liveCurrentIndex = accountManagerView.activeIndex()
      const liveCurrentToken =
        liveAccounts[liveCurrentIndex]?.refreshToken ?? undefined
      liveCurrentTokens.claude = liveCurrentToken
      liveCurrentTokens.gemini = liveCurrentToken
    }

    let foundInStorage = false
    let desiredEnabled: boolean | undefined
    let previousEnabled: boolean | undefined
    let nextActiveIndex = 0
    let nextActiveIndexByFamily: { claude?: number; gemini?: number } = {
      claude: 0,
      gemini: 0,
    }
    await storage.mutate((current) => {
      const tokenIdx = current.accounts.findIndex(
        (entry) => entry.refreshToken === refreshToken,
      )
      if (tokenIdx === -1) return current
      foundInStorage = true

      if (action === 'setCurrent') {
        return {
          ...current,
          activeIndex: tokenIdx,
          activeIndexByFamily: { claude: tokenIdx, gemini: tokenIdx },
        }
      }

      if (action === 'toggleEnabled') {
        const entry = current.accounts[tokenIdx]
        if (!entry) return current
        previousEnabled = entry.enabled !== false
        desiredEnabled = entry.enabled === false
        if (desiredEnabled && entry.accountIneligible === true) {
          throw new Error(
            'This account is ineligible and cannot be enabled until eligibility is rechecked.',
          )
        }
        return {
          ...current,
          accounts: current.accounts.map((account) =>
            account.refreshToken === refreshToken
              ? { ...account, enabled: desiredEnabled }
              : account,
          ),
        }
      }

      // remove: build the post-removal account list, then resolve the
      // current-account's NEW index in that list. If the removed
      // account was the live current, the current token falls out of
      // the list entirely and we fall back to index 0 — matching the
      // live AccountManager.removeAccount() behavior (which leaves the
      // current index pointing at the same numeric slot, now occupied
      // by whichever account shifted in).
      const nextAccounts = current.accounts.filter(
        (account) => account.refreshToken !== refreshToken,
      )
      const resolveNextIndex = (
        liveToken: string | undefined,
        legacyIndex: number,
      ): number => {
        if (!liveToken)
          return Math.max(0, Math.min(legacyIndex, nextAccounts.length - 1))
        const found = nextAccounts.findIndex(
          (account) => account.refreshToken === liveToken,
        )
        if (found === -1) return 0
        return found
      }
      const legacyClaude =
        current.activeIndexByFamily?.claude ?? current.activeIndex
      const legacyGemini =
        current.activeIndexByFamily?.gemini ?? current.activeIndex
      nextActiveIndex = resolveNextIndex(liveCurrentTokens.claude, legacyClaude)
      nextActiveIndexByFamily = {
        claude: resolveNextIndex(liveCurrentTokens.claude, legacyClaude),
        gemini: resolveNextIndex(liveCurrentTokens.gemini, legacyGemini),
      }
      return {
        ...current,
        accounts: nextAccounts,
        activeIndex: nextActiveIndex,
        activeIndexByFamily: nextActiveIndexByFamily,
      }
    })

    if (!foundInStorage) return null

    // Re-resolve the live index by canonical identity after the awaited disk
    // transaction. A concurrent OAuth add/remove may have shifted every index.
    const liveIndex = accountManagerView
      .getAccounts()
      .findIndex((account) => account.refreshToken === refreshToken)
    let applied = action === 'remove' && liveIndex === -1
    if (liveIndex !== -1) {
      if (action === 'setCurrent') {
        applied = accountManagerView.setAccountCurrent(liveIndex)
      } else if (action === 'toggleEnabled') {
        applied = accountManagerView.setAccountEnabled(
          liveIndex,
          desiredEnabled === true,
        )
        if (!applied) {
          applied =
            accountManagerView.getAccounts()[liveIndex]?.enabled ===
            desiredEnabled
        }
      } else {
        applied = accountManagerView.removeAccountByIndex(liveIndex)
      }
    }

    if (!applied && action !== 'remove') {
      if (action === 'toggleEnabled' && previousEnabled !== undefined) {
        await storage.mutate((current) => ({
          ...current,
          accounts: current.accounts.map((account) =>
            account.refreshToken === refreshToken
              ? { ...account, enabled: previousEnabled }
              : account,
          ),
        }))
      }
      throw new Error(
        'The account changed while the operation was being applied; reopen the dialog and try again.',
      )
    }

    await accountManagerView.flushSaveToDisk().catch(() => {
      // The locked storage mutation already committed; a later periodic flush
      // can reconcile transient AccountManager lock contention.
    })

    const rows = projectRows()
    writeSidebar(rows)
    return rows
  }
}
