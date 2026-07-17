import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, saveAccountsReplace, type AccountStorageV4, type AccountMetadataV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import type { AccountSelectionStrategy } from "./config/schema";
import { getHealthTracker, getTokenTracker, selectHybridAccount, type AccountWithMetrics } from "./rotation";
import { generateFingerprint, updateFingerprintVersion, type Fingerprint, type FingerprintVersion, MAX_FINGERPRINT_HISTORY } from "./fingerprint";
import type { QuotaGroup, QuotaGroupSummary } from "./quota";
import { getModelFamily } from "./transform/model-resolver";
import { debugLogToFile } from "./debug";
import { formatAccountLabel } from "./logging-utils";


export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";
export type { AccountSelectionStrategy } from "./config/schema";


export type RateLimitReason = 
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED" 
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN";

export interface RateLimitBackoffResult {
  backoffMs: number;
  reason: RateLimitReason;
}

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
// Increased from 15s to 45s base + jitter to reduce retry pressure on capacity errors
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45_000;
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000; // ±15s jitter range
const SERVER_ERROR_BACKOFF = 20_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

function isStorageLockContention(error: unknown): boolean {
  const message = String(error);
  return message.includes("Lock file is already being held") || message.includes("ELOCKED");
}

/**
 * Generate a random jitter value for backoff timing.
 * Helps prevent thundering herd problem when multiple clients retry simultaneously.
 */
function generateJitter(maxJitterMs: number): number {
  return Math.random() * maxJitterMs - (maxJitterMs / 2);
}

export function parseRateLimitReason(
  reason: string | undefined, 
  message: string | undefined, 
  status?: number
): RateLimitReason {
  // 1. Status Code Checks (Rust parity)
  // 529 = Site Overloaded, 503 = Service Unavailable -> Capacity issues
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED";
  // 500 = Internal Server Error -> Treat as Server Error (soft wait)
  if (status === 500) return "SERVER_ERROR";

  // 2. Explicit Reason String
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED": return "QUOTA_EXHAUSTED";
      case "RATE_LIMIT_EXCEEDED": return "RATE_LIMIT_EXCEEDED";
      case "MODEL_CAPACITY_EXHAUSTED": return "MODEL_CAPACITY_EXHAUSTED";
    }
  }
  
  // 3. Message Text Scanning (Rust Regex parity)
  if (message) {
    const lower = message.toLowerCase();
    
    // Capacity / Overloaded (Transient) - Check FIRST before "exhausted"
    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED";
    }

    // RPM / TPM (Short Wait)
    // "per minute", "rate limit", "too many requests"
    // "presque" (French: almost) - retained for i18n parity with Rust reference
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("presque")) {
      return "RATE_LIMIT_EXCEEDED";
    }

    // Quota (Long Wait)
    if (lower.includes("exhausted") || lower.includes("quota")) {
      return "QUOTA_EXHAUSTED";
    }
  }
  
  // Default fallback for 429 without clearer info
  if (status === 429) {
    return "UNKNOWN"; 
  }
  
  return "UNKNOWN";
}

export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null
): number {
  // Respect explicit Retry-After header if reasonable
  if (retryAfterMs && retryAfterMs > 0) {
    // Rust uses 2s min buffer, we keep 2s
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }
  
  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF; // 30s
    case "MODEL_CAPACITY_EXHAUSTED":
      // Apply jitter to prevent thundering herd on capacity errors
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX);
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF; // 20s
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF; // 60s
  }
}

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  enabled: boolean;
  rateLimitResetTimes: RateLimitStateV3;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  touchedForQuota: Record<string, number>;
  consecutiveFailures?: number;
  /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
  lastFailureTime?: number;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
  /** History of previous fingerprints for this account */
  fingerprintHistory?: FingerprintVersion[];
  /** Cached quota data from last checkAccountsQuota() call */
  cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  cachedQuotaUpdatedAt?: number;
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
  accountIneligible?: boolean;
  accountIneligibleAt?: number;
  accountIneligibleReason?: string;
  eligibilityStateUpdatedAt?: number;
  /** Daily request counts per model family */
  dailyRequestCounts?: {
    date: string
    claude: number
    gemini: number
  }
}

function nowMs(): number {  return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): QuotaKey {
  if (family === "claude") {
    return "claude";
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
  if (model) {
    return `${base}:${model}`;
  }
  return base;
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }
  
  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model);
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model);
  
  return antigravityIsLimited && cliIsLimited;
}

function isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean {
  clearExpiredRateLimits(account);
  
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model);
    if (isRateLimitedForQuotaKey(account, modelKey)) {
      return true;
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle);
  return isRateLimitedForQuotaKey(account, baseKey);
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[];
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

/**
 * Resolve the quota group for soft quota checks.
 * 
 * When a model string is available, we can precisely determine the quota group.
 * When model is null/undefined, we fall back based on family:
 * - Claude → "claude" quota group
 * - Gemini → "gemini-pro" (conservative fallback; may misclassify flash models)
 * 
 * @param family - The model family ("claude" | "gemini")
 * @param model - Optional model string for precise resolution
 * @returns The QuotaGroup to use for soft quota checks
 */
export function resolveQuotaGroup(family: ModelFamily, model?: string | null): QuotaGroup {
  if (model) {
    return getModelFamily(model);
  }
  return family === "claude" ? "claude" : "gemini-pro";
}

function isOverSoftQuotaThreshold(
  account: ManagedAccount,
  family: ModelFamily,
  thresholdPercent: number,
  cacheTtlMs: number,
  model?: string | null
): boolean {
  if (thresholdPercent >= 100) return false;
  if (!account.cachedQuota) return false;
  
  if (account.cachedQuotaUpdatedAt == null) return false;
  const age = nowMs() - account.cachedQuotaUpdatedAt;
  if (age > cacheTtlMs) return false;
  
  const quotaGroup = resolveQuotaGroup(family, model);
  
  const groupData = account.cachedQuota[quotaGroup];
  if (groupData?.remainingFraction == null) return false;
  
  const remainingFraction = Math.max(0, Math.min(1, groupData.remainingFraction));
  const usedPercent = (1 - remainingFraction) * 100;
  const isOverThreshold = usedPercent >= thresholdPercent;
  
  if (isOverThreshold) {
    const accountLabel = formatAccountLabel(account.email, account.index);
    const resetSuffix = groupData.resetTime ? ` (resets: ${groupData.resetTime})` : "";
    const message = `[SoftQuota] Skipping ${accountLabel}: ${quotaGroup} usage ${usedPercent.toFixed(1)}% >= threshold ${thresholdPercent}%${resetSuffix}`;
    debugLogToFile(message);
  }
  
  return isOverThreshold;
}

export function computeSoftQuotaCacheTtlMs(
  ttlConfig: "auto" | number,
  refreshIntervalMinutes: number
): number {
  if (ttlConfig === "auto") {
    return Math.max(2 * refreshIntervalMinutes, 10) * 60 * 1000;
  }
  return ttlConfig * 60 * 1000;
}

export interface AccountSessionIdentity {
  id: string
  parentId?: string | null
}

interface AccountSessionState {
  parentId: string | null
  currentAccountIndexByFamily: Record<ModelFamily, number>
  cursorByFamily: Record<ModelFamily, number>
  offsetAppliedByFamily: Record<ModelFamily, boolean>
  usedAccounts: Set<number>
  lastAccessedAt: number
}

const ACCOUNT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ACCOUNT_SESSION_STATES = 256

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursorByFamily: Record<ModelFamily, number> = { claude: 0, gemini: 0 };
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  };
  private sessionOffsetApplied: Record<ModelFamily, boolean> = {
    claude: false,
    gemini: false,
  };
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  private savePending = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private savePromiseResolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

  private sessionStartTime: number = Date.now()
  private sessionRequestCounts: Map<string, { claude: number, gemini: number }> = new Map()
  private sessionUsedAccounts: Set<number> = new Set()
  private requestSessionStates = new Map<string, AccountSessionState>()

  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const stored = await loadAccounts();
    return new AccountManager(authFallback, stored);
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV4 | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursorByFamily = { claude: 0, gemini: 0 };
      return;
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null;
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          );

          return {
            index,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            enabled: acc.enabled !== false,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
            touchedForQuota: {},
            fingerprint: acc.fingerprint ?? generateFingerprint(),
            fingerprintHistory: acc.fingerprintHistory ?? [],
            cachedQuota: acc.cachedQuota as Partial<Record<QuotaGroup, QuotaGroupSummary>> | undefined,
            cachedQuotaUpdatedAt: acc.cachedQuotaUpdatedAt,
            dailyRequestCounts: acc.dailyRequestCounts,
            verificationRequired: acc.verificationRequired,
            verificationRequiredAt: acc.verificationRequiredAt,
            verificationRequiredReason: acc.verificationRequiredReason,
            verificationUrl: acc.verificationUrl,
            accountIneligible: acc.accountIneligible,
            accountIneligibleAt: acc.accountIneligibleAt,
            accountIneligibleReason: acc.accountIneligibleReason,
            eligibilityStateUpdatedAt: acc.eligibilityStateUpdatedAt,
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      // Update fingerprint versions to match the current runtime version.
      // Saved fingerprints may carry an older version string; this ensures
      // they always reflect the latest fetched (or fallback) version.
      let fingerprintVersionChanged = false;
      for (const acc of this.accounts) {
        if (acc.fingerprint && updateFingerprintVersion(acc.fingerprint)) {
          fingerprintVersionChanged = true;
        }
      }

      const legacyCursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        const defaultIndex = legacyCursor % this.accounts.length;
        this.currentAccountIndexByFamily.claude = clampNonNegativeInt(
          stored.activeIndexByFamily?.claude,
          defaultIndex
        ) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(
          stored.activeIndexByFamily?.gemini,
          defaultIndex
        ) % this.accounts.length;
        this.cursorByFamily.claude = this.currentAccountIndexByFamily.claude;
        this.cursorByFamily.gemini = this.currentAccountIndexByFamily.gemini;
      }

      // Persist updated fingerprint versions to disk
      if (fingerprintVersionChanged) {
        this.requestSaveToDisk();
      }

      // If current auth isn't in the loaded accounts, add it to the pool
      if (authFallback && authParts && authParts.refreshToken) {
        const hasMatching = this.accounts.some(acc => acc.parts.refreshToken === authParts.refreshToken);
        if (!hasMatching) {
          const now = nowMs();
          const newAccount: ManagedAccount = {
            index: this.accounts.length,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts: authParts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
            fingerprint: generateFingerprint(),
            fingerprintHistory: [],
          };
          this.accounts.push(newAccount);
        }
      }

      return;
    }

    if (authFallback) {      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
          },
        ];
        this.cursorByFamily = { claude: 0, gemini: 0 };
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }

  getAccountCount(): number {
    return this.getEnabledAccounts().length;
  }

  getTotalAccountCount(): number {
    return this.accounts.length;
  }

  getEnabledAccounts(): ManagedAccount[] {
    return this.accounts.filter((account) => account.enabled !== false);
  }

  private getEffectiveSoftQuotaThreshold(thresholdPercent: number): number {
    // Soft-quota protection only has a purpose when another enabled account
    // exists to rotate to. Never block the sole usable account.
    return this.getEnabledAccounts().length > 1 ? thresholdPercent : 100;
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
  }

  private getRequestSessionState(identity: AccountSessionIdentity): AccountSessionState {
    const now = nowMs()
    this.pruneRequestSessionStates(now, identity.id)

    const existing = this.requestSessionStates.get(identity.id)
    if (existing) {
      existing.lastAccessedAt = now
      if (identity.parentId) {
        existing.parentId = identity.parentId
      }
      return existing
    }

    const state: AccountSessionState = {
      parentId: identity.parentId ?? null,
      currentAccountIndexByFamily: { claude: -1, gemini: -1 },
      cursorByFamily: { ...this.cursorByFamily },
      offsetAppliedByFamily: { claude: false, gemini: false },
      usedAccounts: new Set<number>(),
      lastAccessedAt: now,
    }
    this.requestSessionStates.set(identity.id, state)
    return state
  }

  private pruneRequestSessionStates(now: number, preservedId: string): void {
    const expiry = now - ACCOUNT_SESSION_STATE_TTL_MS
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < expiry) {
        this.requestSessionStates.delete(id)
      }
    }

    if (this.requestSessionStates.size < MAX_ACCOUNT_SESSION_STATES || this.requestSessionStates.has(preservedId)) {
      return
    }

    let oldestId: string | null = null
    let oldestAccess = Number.POSITIVE_INFINITY
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < oldestAccess) {
        oldestId = id
        oldestAccess = state.lastAccessedAt
      }
    }
    if (oldestId) {
      this.requestSessionStates.delete(oldestId)
    }
  }

  private getActiveIndex(family: ModelFamily, identity?: AccountSessionIdentity): number {
    return identity
      ? this.getRequestSessionState(identity).currentAccountIndexByFamily[family]
      : this.currentAccountIndexByFamily[family]
  }

  private setActiveIndex(family: ModelFamily, index: number, identity?: AccountSessionIdentity): void {
    if (!identity) {
      this.currentAccountIndexByFamily[family] = index
      return
    }

    const state = this.getRequestSessionState(identity)
    state.currentAccountIndexByFamily[family] = index
    if (!state.parentId) {
      // Preserve a useful persisted starting point without coupling active root sessions.
      this.currentAccountIndexByFamily[family] = index
    }
  }

  private getCursor(family: ModelFamily, identity?: AccountSessionIdentity): number {
    return identity
      ? this.getRequestSessionState(identity).cursorByFamily[family]
      : this.cursorByFamily[family]
  }

  private advanceCursor(family: ModelFamily, identity?: AccountSessionIdentity): void {
    const nextGlobalCursor = this.cursorByFamily[family] + 1
    this.cursorByFamily[family] = nextGlobalCursor
    if (identity) {
      this.getRequestSessionState(identity).cursorByFamily[family] += 1
    }
  }

  private getUsedAccounts(identity?: AccountSessionIdentity): Set<number> {
    return identity ? this.getRequestSessionState(identity).usedAccounts : this.sessionUsedAccounts
  }

  private preferAccountOutsideParent(
    accounts: ManagedAccount[],
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): ManagedAccount[] {
    if (!identity) {
      return accounts
    }
    const parentId = this.getRequestSessionState(identity).parentId
    if (!parentId) {
      return accounts
    }
    const parentState = this.requestSessionStates.get(parentId)
    const parentIndex = parentState?.currentAccountIndexByFamily[family] ?? -1
    if (parentIndex < 0) {
      return accounts
    }
    const isolated = accounts.filter((account) => account.index !== parentIndex)
    return isolated.length > 0 ? isolated : accounts
  }

  deleteSessionState(sessionId: string): void {
    this.requestSessionStates.delete(sessionId)
  }

  getCurrentAccountForFamily(
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const currentIndex = this.getActiveIndex(family, identity);
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      const account = this.accounts[currentIndex] ?? null;
      // Only return account if it's enabled - disabled accounts should not be selected
      if (account && account.enabled !== false) {
        return account;
      }
    }
    return null;
  }

  markSwitched(
    account: ManagedAccount,
    reason: "rate-limit" | "initial" | "rotation",
    family: ModelFamily,
    identity?: AccountSessionIdentity,
  ): void {
    account.lastSwitchReason = reason;
    this.setActiveIndex(family, account.index, identity);
  }

  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex !== this.lastToastAccountIndex) {
      return true;
    }
    return now - this.lastToastTime >= debounceMs;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  getCurrentOrNextForFamily(
    family: ModelFamily, 
    model?: string | null,
    strategy: AccountSelectionStrategy = 'sticky',
    headerStyle: HeaderStyle = 'antigravity',
    pidOffsetEnabled: boolean = false,
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const quotaKey = getQuotaKey(family, headerStyle, model);
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(softQuotaThresholdPercent);

    // OpenCode may run many root and child sessions concurrently in one plugin
    // process. Pin each exact session until its account becomes unavailable.
    if (identity) {
      const pinned = this.getCurrentAccountForFamily(family, identity)
      if (pinned) {
        clearExpiredRateLimits(pinned)
        const unavailable =
          isRateLimitedForHeaderStyle(pinned, family, headerStyle, model) ||
          isOverSoftQuotaThreshold(pinned, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, model) ||
          this.isAccountCoolingDown(pinned)
        if (!unavailable) {
          this.markTouchedForQuota(pinned, quotaKey)
          return pinned
        }
      }
    }

    if (strategy === 'round-robin') {
      const next = this.getNextForFamily(family, model, headerStyle, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, identity);
      if (next) {
        this.markTouchedForQuota(next, quotaKey);
        this.setActiveIndex(family, next.index, identity);
      }
      return next;
    }

    if (strategy === 'hybrid') {
      const healthTracker = getHealthTracker();
      const tokenTracker = getTokenTracker();
      
      const eligibleAccounts = this.preferAccountOutsideParent(
        this.accounts.filter(acc => acc.enabled !== false),
        family,
        identity,
      )
      const accountsWithMetrics: AccountWithMetrics[] = eligibleAccounts.map(acc => {
          clearExpiredRateLimits(acc);
          return {
            index: acc.index,
            lastUsed: acc.lastUsed,
            healthScore: healthTracker.getScore(acc.index),
            isRateLimited: isRateLimitedForFamily(acc, family, model) || 
                          isOverSoftQuotaThreshold(acc, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, model),
            isCoolingDown: this.isAccountCoolingDown(acc),
          };
        });

      // Get current account index for stickiness
      const currentIndex = this.getActiveIndex(family, identity);
      
      const selectedIndex = selectHybridAccount(accountsWithMetrics, tokenTracker, currentIndex);
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex];
        if (selected) {
          selected.lastUsed = nowMs();
          this.markTouchedForQuota(selected, quotaKey);
          this.setActiveIndex(family, selected.index, identity);
          return selected;
        }
      }
    }

    // Fallback: sticky selection (used when hybrid finds no candidates)
    // PID-based offset for multi-session distribution (opt-in)
    // Different sessions (PIDs) will prefer different starting accounts
    const offsetApplied = identity
      ? this.getRequestSessionState(identity).offsetAppliedByFamily
      : this.sessionOffsetApplied;
    if (pidOffsetEnabled && !offsetApplied[family] && this.accounts.length > 1) {
      const pidOffset = process.pid % this.accounts.length;
      const activeIndex = this.getActiveIndex(family, identity);
      const baseIndex = activeIndex >= 0 ? activeIndex : this.getCursor(family, identity);
      const newIndex = (baseIndex + pidOffset) % this.accounts.length;
      
      debugLogToFile(`[Account] Applying PID offset: pid=${process.pid} offset=${pidOffset} family=${family} index=${baseIndex}->${newIndex}`);
      
      this.setActiveIndex(family, newIndex, identity);
      offsetApplied[family] = true;
    }

    const current = this.getCurrentAccountForFamily(family, identity);
    if (current) {
      clearExpiredRateLimits(current);
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(current, family, headerStyle, model);
      const isOverThreshold = isOverSoftQuotaThreshold(current, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, model);
      if (!isLimitedForRequestedStyle && !isOverThreshold && !this.isAccountCoolingDown(current)) {
        this.markTouchedForQuota(current, quotaKey);
        return current;
      }
    }

    const next = this.getNextForFamily(
      family,
      model,
      headerStyle,
      effectiveSoftQuotaThreshold,
      softQuotaCacheTtlMs,
      identity,
    );
    if (next) {
      this.markTouchedForQuota(next, quotaKey);
      this.setActiveIndex(family, next.index, identity);
    }
    return next;
  }

  getNextForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle: HeaderStyle = "antigravity",
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(softQuotaThresholdPercent);
    const allAvailable = this.accounts.filter((account) => {
      clearExpiredRateLimits(account);
      return account.enabled !== false &&
        !isRateLimitedForHeaderStyle(account, family, headerStyle, model) &&
        !isOverSoftQuotaThreshold(account, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, model) &&
        !this.isAccountCoolingDown(account);
    });
    const available = this.preferAccountOutsideParent(allAvailable, family, identity)

    if (available.length === 0) {
      return null;
    }

    const usedAccounts = this.getUsedAccounts(identity)
    const sessionUsed = available.filter(account => usedAccounts.has(account.index));
    const candidates = sessionUsed.length > 0 ? sessionUsed : available;

    const cursor = this.getCursor(family, identity)
    const account = candidates[cursor % candidates.length];
    if (!account) {
      return null;
    }

    this.advanceCursor(family, identity)
    return account;
  }
  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
    model?: string | null
  ): void {
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex: number): void {
    const account = this.accounts.find(a => a.index === accountIndex);
    if (account) {
      account.lastUsed = nowMs();
    }
  }

  recordSessionUsage(accountIndex: number, identity?: AccountSessionIdentity): void {
    this.getUsedAccounts(identity).add(accountIndex);
  }

  wasUsedInSession(accountIndex: number, identity?: AccountSessionIdentity): boolean {
    return this.getUsedAccounts(identity).has(accountIndex);
  }

  shouldProactivelyRotate(
    family: ModelFamily,
    model: string | null | undefined,
    thresholdPercent: number,
    cacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): boolean {
    if (thresholdPercent <= 0) return false;

    const current = this.getCurrentAccountForFamily(family, identity);
    if (!current || !current.cachedQuota || current.cachedQuotaUpdatedAt == null) return false;

    const age = nowMs() - current.cachedQuotaUpdatedAt;
    if (age > cacheTtlMs) return false;

    const quotaGroup = resolveQuotaGroup(family, model);
    const groupData = current.cachedQuota[quotaGroup];
    if (groupData?.remainingFraction == null) return false;

    const remainingPercent = Math.max(0, Math.min(100, groupData.remainingFraction * 100));
    return remainingPercent < thresholdPercent;
  }

  proactivelyRotateForFamily(
    family: ModelFamily,
    model: string | null | undefined,
    headerStyle: HeaderStyle,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
    identity?: AccountSessionIdentity,
  ): ManagedAccount | null {
    const currentIndex = this.getActiveIndex(family, identity);

    const candidates = this.preferAccountOutsideParent(this.accounts.filter(acc => {
      if (acc.enabled === false) return false;
      if (acc.index === currentIndex) return false;
      clearExpiredRateLimits(acc);
      if (isRateLimitedForHeaderStyle(acc, family, headerStyle, model)) return false;
      if (isOverSoftQuotaThreshold(acc, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)) return false;
      if (this.isAccountCoolingDown(acc)) return false;
      return true;
    }), family, identity);

    if (candidates.length === 0) return null;

    const usedAccounts = this.getUsedAccounts(identity)
    const warmCandidates = candidates.filter(account => usedAccounts.has(account.index));
    const pool = warmCandidates.length > 0 ? warmCandidates : candidates;

    const quotaGroup = resolveQuotaGroup(family, model);
    pool.sort((a, b) => {
      const aRemaining = a.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0;
      const bRemaining = b.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0;
      return bRemaining - aRemaining;
    });

    const selected = pool[0];
    if (!selected) return null;

    const quotaKey = getQuotaKey(family, headerStyle, model);
    this.markTouchedForQuota(selected, quotaKey);
    this.setActiveIndex(family, selected.index, identity);

    return selected;
  }

  markRateLimitedWithReason(    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null,
    failureTtlMs: number = 3600_000, // Default 1 hour TTL
  ): number {
    const now = nowMs();
    
    // TTL-based reset: if last failure was more than failureTtlMs ago, reset count
    if (account.lastFailureTime !== undefined && (now - account.lastFailureTime) > failureTtlMs) {
      account.consecutiveFailures = 0;
    }
    
    const failures = (account.consecutiveFailures ?? 0) + 1;
    account.consecutiveFailures = failures;
    account.lastFailureTime = now;
    
    const backoffMs = calculateBackoffMs(reason, failures - 1, retryAfterMs);
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = now + backoffMs;
    
    return backoffMs;
  }

  markRequestSuccess(account: ManagedAccount): void {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0;
    }
  }

  clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void {
    for (const account of this.accounts) {
      if (family === "claude") {
        delete account.rateLimitResetTimes.claude;
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);
        delete account.rateLimitResetTimes[antigravityKey];
        delete account.rateLimitResetTimes[cliKey];
      }
      account.consecutiveFailures = 0;
    }
  }

  shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model);
    return minWaitMs > 0 && minWaitMs <= 2_000;
  }

  markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
    account.coolingDownUntil = nowMs() + cooldownMs;
    account.cooldownReason = reason;
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false;
    }
    if (nowMs() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account);
      return false;
    }
    return true;
  }

  clearAccountCooldown(account: ManagedAccount): void {
    delete account.coolingDownUntil;
    delete account.cooldownReason;
  }

  getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined;
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = nowMs();
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    const touchedAt = account.touchedForQuota[quotaKey];
    if (!touchedAt) return true;
    
    const resetTime = account.rateLimitResetTimes[quotaKey as QuotaKey];
    if (resetTime && touchedAt < resetTime) return true;
    
    return false;
  }

  getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[] {
    return this.accounts.filter(acc => {
      clearExpiredRateLimits(acc);
      return acc.enabled !== false &&
             this.isFreshForQuota(acc, quotaKey) && 
             !isRateLimitedForFamily(acc, family, model) && 
             !this.isAccountCoolingDown(acc);
    });
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null
  ): boolean {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, model);
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity") ? null : "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", model)) {
      return "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)) {
      return "gemini-cli";
    }
    return null;
  }

  /**
   * Check if any OTHER account has antigravity quota available for the given family/model.
   * 
   * Used to determine whether to switch accounts vs fall back to gemini-cli:
   * - If true: Switch to another account (preserve antigravity priority)
   * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
   * 
   * @param currentAccountIndex - Index of the current account (will be excluded from check)
   * @param family - Model family ("gemini" or "claude")
   * @param model - Optional model name for model-specific rate limits
   * @returns true if any other enabled, non-cooling-down account has antigravity available
   */
  hasOtherAccountWithAntigravityAvailable(
    currentAccountIndex: number,
    family: ModelFamily,
    model?: string | null
  ): boolean {
    // Claude has no gemini-cli fallback - always return false
    // (This method is only relevant for Gemini's dual quota pools)
    if (family === "claude") {
      return false;
    }

    return this.accounts.some(acc => {
      // Skip current account
      if (acc.index === currentAccountIndex) {
        return false;
      }
      // Skip disabled accounts
      if (acc.enabled === false) {
        return false;
      }
      // Skip cooling down accounts
      if (this.isAccountCoolingDown(acc)) {
        return false;
      }
      // Clear expired rate limits before checking
      clearExpiredRateLimits(acc);
      // Check if antigravity is available for this account
      return !isRateLimitedForHeaderStyle(acc, family, "antigravity", model);
    });
  }

  setAccountEnabled(accountIndex: number, enabled: boolean): boolean {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    if (enabled && account.accountIneligible) {
      return false;
    }
    account.enabled = enabled;

    if (!enabled) {
      for (const family of Object.keys(this.currentAccountIndexByFamily) as ModelFamily[]) {
        if (this.currentAccountIndexByFamily[family] === accountIndex) {
          const next = this.accounts.find((a, i) => i !== accountIndex && a.enabled !== false);
          this.currentAccountIndexByFamily[family] = next?.index ?? -1;
        }
      }
    }

    this.requestSaveToDisk();
    return true;
  }

  markAccountVerificationRequired(accountIndex: number, reason?: string, verifyUrl?: string): boolean {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }

    const timestamp = nowMs();
    account.verificationRequired = true;
    account.verificationRequiredAt = timestamp;
    account.verificationRequiredReason = reason?.trim() || undefined;
    if (
      account.accountIneligible === true ||
      account.accountIneligibleAt !== undefined ||
      account.accountIneligibleReason !== undefined
    ) {
      account.accountIneligible = false;
      account.accountIneligibleAt = undefined;
      account.accountIneligibleReason = undefined;
      account.eligibilityStateUpdatedAt = timestamp;
    }

    const normalizedVerifyUrl = verifyUrl?.trim();
    if (normalizedVerifyUrl) {
      account.verificationUrl = normalizedVerifyUrl;
    }

    if (account.enabled !== false) {
      this.setAccountEnabled(accountIndex, false);
    } else {
      this.requestSaveToDisk();
    }

    return true;
  }

  markAccountIneligible(accountIndex: number, reason?: string): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }

    const timestamp = nowMs()
    account.accountIneligible = true
    account.accountIneligibleAt = timestamp
    account.accountIneligibleReason = reason?.trim() || "Google marked this account as ineligible."
    account.eligibilityStateUpdatedAt = timestamp
    account.verificationRequired = false
    account.verificationRequiredAt = undefined
    account.verificationRequiredReason = undefined
    account.verificationUrl = undefined

    if (account.enabled !== false) {
      this.setAccountEnabled(accountIndex, false)
    } else {
      this.requestSaveToDisk()
    }
    return true
  }

  clearAccountAccessBlocks(accountIndex: number, enableAccount = false): boolean {
    const account = this.accounts[accountIndex]
    if (!account) {
      return false
    }

    const wasVerificationRequired = account.verificationRequired === true
    const wasIneligible = account.accountIneligible === true
    const hadMetadata = wasVerificationRequired || wasIneligible ||
      account.verificationRequiredAt !== undefined ||
      account.verificationRequiredReason !== undefined ||
      account.verificationUrl !== undefined ||
      account.accountIneligibleAt !== undefined ||
      account.accountIneligibleReason !== undefined ||
      account.eligibilityStateUpdatedAt !== undefined

    account.verificationRequired = false
    account.verificationRequiredAt = undefined
    account.verificationRequiredReason = undefined
    account.verificationUrl = undefined
    account.accountIneligible = false
    account.accountIneligibleAt = undefined
    account.accountIneligibleReason = undefined
    if (wasIneligible || account.eligibilityStateUpdatedAt !== undefined) {
      account.eligibilityStateUpdatedAt = nowMs()
    }

    if (enableAccount && (wasVerificationRequired || wasIneligible) && account.enabled === false) {
      this.setAccountEnabled(accountIndex, true)
    } else if (hadMetadata) {
      this.requestSaveToDisk()
    }
    return true
  }

  removeAccountByIndex(accountIndex: number): boolean {
    if (accountIndex < 0 || accountIndex >= this.accounts.length) {
      return false;
    }
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    return this.removeAccount(account);
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }

    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });

    if (this.accounts.length === 0) {
      this.cursorByFamily = { claude: 0, gemini: 0 };
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      this.requestSessionStates.clear();
      return true;
    }

    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.cursorByFamily[family] > idx) {
        this.cursorByFamily[family] -= 1;
      }
      this.cursorByFamily[family] = this.cursorByFamily[family] % this.accounts.length;

      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1;
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1;
      }

      for (const state of this.requestSessionStates.values()) {
        const currentIndex = state.currentAccountIndexByFamily[family]
        if (currentIndex === idx) {
          state.currentAccountIndexByFamily[family] = -1
        } else if (currentIndex > idx) {
          state.currentAccountIndexByFamily[family] -= 1
        }
        if (state.cursorByFamily[family] > idx) {
          state.cursorByFamily[family] -= 1
        }
        state.cursorByFamily[family] %= this.accounts.length
      }
    }

    for (const state of this.requestSessionStates.values()) {
      state.usedAccounts = new Set(
        [...state.usedAccounts]
          .filter((accountIndex) => accountIndex !== idx)
          .map((accountIndex) => accountIndex > idx ? accountIndex - 1 : accountIndex),
      )
    }

    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh);
    // Preserve existing projectId/managedProjectId if not in the new parts
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId: parts.managedProjectId ?? account.parts.managedProjectId,
    };
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  getMinWaitTimeForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
    strict?: boolean,
  ): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return a.enabled !== false && (strict && headerStyle
        ? !isRateLimitedForHeaderStyle(a, family, headerStyle, model)
        : !isRateLimitedForFamily(a, family, model));
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else if (strict && headerStyle) {
        const key = getQuotaKey(family, headerStyle, model);
        const t = a.rateLimitResetTimes[key];
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);

        const t1 = a.rateLimitResetTimes[antigravityKey];
        const t2 = a.rateLimitResetTimes[cliKey];
        
        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity
        );
        if (accountWait !== Infinity) waitTimes.push(accountWait);
      }
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  private buildStorageSnapshot(): AccountStorageV4 {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);

    return {
      version: 4,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
        fingerprint: a.fingerprint,
        fingerprintHistory: a.fingerprintHistory?.length ? a.fingerprintHistory : undefined,
        cachedQuota: a.cachedQuota && Object.keys(a.cachedQuota).length > 0 ? a.cachedQuota : undefined,
        cachedQuotaUpdatedAt: a.cachedQuotaUpdatedAt,
        dailyRequestCounts: a.dailyRequestCounts,
        verificationRequired: a.verificationRequired,
        verificationRequiredAt: a.verificationRequiredAt,
        verificationRequiredReason: a.verificationRequiredReason,
        verificationUrl: a.verificationUrl,
        accountIneligible: a.accountIneligible,
        accountIneligibleAt: a.accountIneligibleAt,
        accountIneligibleReason: a.accountIneligibleReason,
        eligibilityStateUpdatedAt: a.eligibilityStateUpdatedAt,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    };
  }

  async saveToDisk(): Promise<void> {
    await saveAccounts(this.buildStorageSnapshot());
  }

  /**
   * Persist via full-file replace (no merge). Required after destructive
   * operations (account removal) so a deleted account is not resurrected by
   * mergeAccountStorage re-reading it from disk.
   */
  async saveToDiskReplace(): Promise<void> {
    await saveAccountsReplace(this.buildStorageSnapshot());
  }

  requestSaveToDisk(): void {
    if (this.savePending) {
      return;
    }
    this.savePending = true;
    this.saveTimeout = setTimeout(() => {
      void this.executeSave();
    }, 1000);
  }

  async flushSaveToDisk(): Promise<void> {
    if (!this.savePending) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.savePromiseResolvers.push({ resolve, reject });
    });
  }
  private async executeSave(): Promise<void> {
    this.savePending = false;
    this.saveTimeout = null;
    
    const resolvers = this.savePromiseResolvers;
    this.savePromiseResolvers = [];

    try {
      await this.saveToDisk();
      for (const { resolve } of resolvers) {
        resolve();
      }
    } catch (error) {
      if (isStorageLockContention(error)) {
        debugLogToFile(`[Account] Skipped account-state persist because another plugin instance holds the storage lock: ${String(error)}`);
        for (const { resolve } of resolvers) {
          resolve();
        }
        return;
      }

      console.warn("[antigravity] Failed to persist account state to disk:", String(error));
      for (const { reject } of resolvers) {
        reject(error);
      }
    }
  }
  // ========== Fingerprint Management ==========

  /**
   * Regenerate fingerprint for an account, saving the old one to history.
   * @param accountIndex - Index of the account to regenerate fingerprint for
   * @returns The new fingerprint, or null if account not found
   */
  regenerateAccountFingerprint(accountIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex];
    if (!account) return null;
    
    // Save current fingerprint to history if it exists
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: 'regenerated',
      };
      
      if (!account.fingerprintHistory) {
        account.fingerprintHistory = [];
      }
      
      // Add to beginning of history (most recent first)
      account.fingerprintHistory.unshift(historyEntry);
      
      // Trim to max history size
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }

    // Generate and assign new fingerprint
    account.fingerprint = generateFingerprint();
    this.requestSaveToDisk();
    
    return account.fingerprint;
  }

  /**
   * Restore a fingerprint from history for an account.
   * @param accountIndex - Index of the account
   * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
   * @returns The restored fingerprint, or null if account/history not found
   */
  restoreAccountFingerprint(accountIndex: number, historyIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex];
    if (!account) return null;

    const history = account.fingerprintHistory;
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return null;
    }
    
    // Capture the fingerprint to restore BEFORE modifying history
    const fingerprintToRestore = history[historyIndex]!.fingerprint;
    
    // Save current fingerprint to history before restoring (if it exists)
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: 'restored',
      };
      
      account.fingerprintHistory!.unshift(historyEntry);
      
      // Trim to max history size
      if (account.fingerprintHistory!.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory!.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }

    // Restore the fingerprint
    account.fingerprint = { ...fingerprintToRestore, createdAt: nowMs() };
    
    this.requestSaveToDisk();
    
    return account.fingerprint;
  }

  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[] {
    const account = this.accounts[accountIndex];
    if (!account || !account.fingerprintHistory) {
      return [];
    }
    return [...account.fingerprintHistory];
  }

  updateQuotaCache(accountIndex: number, quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>): void {
    const account = this.accounts[accountIndex];
    if (account) {
      account.cachedQuota = quotaGroups;
      account.cachedQuotaUpdatedAt = nowMs();
    }
  }

  /**
   * Record a successful API request for an account.
   * Tracks per model family with daily reset.
   */
  recordRequest(accountIndex: number, family: ModelFamily): void {
    const account = this.accounts[accountIndex]
    if (!account) return

    const today = new Date().toISOString().slice(0, 10)

    if (!account.dailyRequestCounts || account.dailyRequestCounts.date !== today) {
      account.dailyRequestCounts = { date: today, claude: 0, gemini: 0 }
    }

    account.dailyRequestCounts[family]++
    account.lastUsed = nowMs()

    // Also track for session
    this.recordSessionRequest(accountIndex, family)
  }

  /**
   * Get request counts for an account for today.
   */
  getDailyRequestCounts(accountIndex: number): { date: string, claude: number, gemini: number } | null {
    const account = this.accounts[accountIndex]
    if (!account?.dailyRequestCounts) return null

    const today = new Date().toISOString().slice(0, 10)
    if (account.dailyRequestCounts.date !== today) return null

    return { ...account.dailyRequestCounts }
  }

  /**
   * Get total daily request counts across all accounts for a model family.
   */
  getTotalDailyRequests(family: ModelFamily): number {
    const today = new Date().toISOString().slice(0, 10)
    let total = 0
    for (const account of this.accounts) {
      if (account.dailyRequestCounts?.date === today) {
        total += account.dailyRequestCounts[family]
      }
    }
    return total
  }

  /**
   * Get a summary of daily request distribution across accounts.
   * Returns accounts sorted by request count (descending).
   */
  getDailyRequestSummary(family: ModelFamily): Array<{ index: number, email?: string, count: number }> {
    const today = new Date().toISOString().slice(0, 10)
    const result: Array<{ index: number, email?: string, count: number }> = []

    for (const account of this.accounts) {
      const count = account.dailyRequestCounts?.date === today
        ? account.dailyRequestCounts[family]
        : 0
      if (count > 0) {
        result.push({ index: account.index, email: account.email, count })
      }
    }

    return result.sort((a, b) => b.count - a.count)
  }

  /**
   * Record a request for the current session (in-memory only).
   */
  recordSessionRequest(accountIndex: number, family: ModelFamily): void {
    const key = String(accountIndex)
    const current = this.sessionRequestCounts.get(key) ?? { claude: 0, gemini: 0 }
    current[family]++
    this.sessionRequestCounts.set(key, current)
  }

  /**
   * Get a summary of the current session's request usage.
   */
  getSessionSummary(): {
    durationMinutes: number
    totalClaude: number
    totalGemini: number
    requestsPerHour: number
    accountsUsed: number
    perAccount: Array<{ index: number, email?: string, claude: number, gemini: number }>
  } {
    const durationMs = Date.now() - this.sessionStartTime
    const durationMinutes = Math.round(durationMs / 60000)
    const durationHours = durationMs / 3600000

    let totalClaude = 0
    let totalGemini = 0
    const perAccount: Array<{ index: number, email?: string, claude: number, gemini: number }> = []

    for (const [key, counts] of this.sessionRequestCounts) {
      const idx = Number(key)
      const account = this.accounts[idx]
      totalClaude += counts.claude
      totalGemini += counts.gemini
      if (counts.claude > 0 || counts.gemini > 0) {
        perAccount.push({ index: idx, email: account?.email, claude: counts.claude, gemini: counts.gemini })
      }
    }

    const totalRequests = totalClaude + totalGemini
    const requestsPerHour = durationHours > 0 ? Math.round(totalRequests / durationHours) : 0

    return {
      durationMinutes,
      totalClaude,
      totalGemini,
      requestsPerHour,
      accountsUsed: perAccount.length,
      perAccount: perAccount.sort((a, b) => (b.claude + b.gemini) - (a.claude + a.gemini)),
    }
  }

  isAccountOverSoftQuota(account: ManagedAccount, family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean {
    return isOverSoftQuotaThreshold(
      account,
      family,
      this.getEffectiveSoftQuotaThreshold(thresholdPercent),
      cacheTtlMs,
      model,
    );
  }

  getAccountsForQuotaCheck(): AccountMetadataV3[] {
    return this.accounts.map((a) => ({
      email: a.email,
      refreshToken: a.parts.refreshToken,
      projectId: a.parts.projectId,
      managedProjectId: a.parts.managedProjectId,
      addedAt: a.addedAt,
      lastUsed: a.lastUsed,
      enabled: a.enabled,
    }));
  }

  getOldestQuotaCacheAge(): number | null {
    let oldest: number | null = null;
    for (const acc of this.accounts) {
      if (acc.enabled === false) continue;
      if (acc.cachedQuotaUpdatedAt == null) return null;
      const age = nowMs() - acc.cachedQuotaUpdatedAt;
      if (oldest === null || age > oldest) oldest = age;
    }
    return oldest;
  }

  areAllAccountsOverSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean {
    if (thresholdPercent >= 100) return false;
    const enabled = this.accounts.filter(a => a.enabled !== false);
    if (enabled.length <= 1) return false;
    return enabled.every(a => isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, model));
  }

  /**
   * Get minimum wait time until any account's soft quota resets.
   * Returns 0 if any account is available (not over threshold).
   * Returns the minimum resetTime across all over-threshold accounts.
   * Returns null if no resetTime data is available.
   */
  getMinWaitTimeForSoftQuota(
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null
  ): number | null {
    if (thresholdPercent >= 100) return 0;
    
    const enabled = this.accounts.filter(a => a.enabled !== false);
    if (enabled.length === 0) return null;
    if (enabled.length === 1) return 0;
    
    // If any account is available (not over threshold), no wait needed
    const available = enabled.filter(a => !isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, model));
    if (available.length > 0) return 0;
    
    // All accounts are over threshold - find earliest reset time
    // For gemini family, we MUST have the model to distinguish pro vs flash quotas.
    // Fail-open (return null = no wait info) if model is missing to avoid blocking on wrong quota.
    if (!model && family !== "claude") return null;
    const quotaGroup = resolveQuotaGroup(family, model);
    const now = nowMs();
    const waitTimes: number[] = [];
    
    for (const acc of enabled) {
      const groupData = acc.cachedQuota?.[quotaGroup];
      if (groupData?.resetTime) {
        const resetTimestamp = Date.parse(groupData.resetTime);
        if (Number.isFinite(resetTimestamp)) {
          waitTimes.push(Math.max(0, resetTimestamp - now));
        }
      }
    }
    
    if (waitTimes.length === 0) return null;
    const minWait = Math.min(...waitTimes);
    // Treat 0 as stale cache (resetTime in the past) → fail-open to avoid spin loop
    return minWait === 0 ? null : minWait;
  }
}
