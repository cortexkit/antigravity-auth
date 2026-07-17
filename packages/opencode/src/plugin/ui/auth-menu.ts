import { ANSI } from './ansi';
import { select, type MenuItem } from './select';
import { confirm } from './confirm';
import type { CooldownReason } from '../accounts';
import {
  classifyGroupStatus,
  classifyOverallQuotaHealth,
  buildCooldownStatus,
  formatQuotaStatusBadge,
  formatWaitDuration,
} from './quota-status';
import type { QuotaGroupSummary } from '../quota';
import type { FingerprintVersion } from '../fingerprint';
export type AccountStatus = 'active' | 'rate-limited' | 'expired' | 'verification-required' | 'ineligible' | 'unknown';

export interface AccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
  quotaSummary?: string;
  cooldownMs?: number;
  cooldownReason?: CooldownReason;
  cachedQuota?: Partial<Record<string, QuotaGroupSummary>>;
  cachedPerModelQuota?: { modelId: string; displayName?: string; group: string | null; remainingFraction: number; resetTime?: string }[];
  fingerprintHistory?: FingerprintVersion[];
}

export type AuthMenuAction =
  | { type: 'add' }
  | { type: 'select-account'; account: AccountInfo }
  | { type: 'delete-all' }
  | { type: 'check' }
  | { type: 'doctor' }
  | { type: 'repair' }
  | { type: 'current' }
  | { type: 'verify' }
  | { type: 'verify-all' }
  | { type: 'configure-models' }
  | { type: 'cancel' };
export type AccountAction = 'back' | 'delete' | 'refresh' | 'toggle' | 'verify' | 'restore-fingerprint' | 'switch-account' | 'cancel';

export interface FingerprintRestoreResult {
  action: 'restore-fingerprint';
  historyIndex: number;
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleDateString();
}

function getStatusBadge(status: AccountStatus | undefined, account?: AccountInfo): string {
  // Cooldown takes priority — account is temporarily unavailable
  if (account?.cooldownMs !== undefined && account.cooldownMs > 0) {
    const cooldownStatus = buildCooldownStatus(account.cooldownMs, account.cooldownReason);
    return ` ${formatQuotaStatusBadge(cooldownStatus)}`;
  }

  // For "active" accounts, check if quota data shows exhaustion
  if (status === 'active' && account?.cachedQuota) {
    const overall = classifyOverallQuotaHealth(account.cachedQuota);
    if (overall.health === 'exhausted') {
      const suffix = overall.maxResetMs
        ? ` resets in ${formatWaitDuration(overall.maxResetMs)}`
        : '';
      return ` ${ANSI.red}[exhausted${suffix}]${ANSI.reset}`;
    }
    if (overall.health === 'partial') {
      return ` ${ANSI.yellow}[limited]${ANSI.reset}`;
    }
  }

  // Then check account-level status
  switch (status) {
    case 'active': return ` ${ANSI.green}[active]${ANSI.reset}`;
    case 'rate-limited': return ` ${ANSI.yellow}[rate-limited]${ANSI.reset}`;
    case 'expired': return ` ${ANSI.red}[expired]${ANSI.reset}`;
    case 'verification-required': return ` ${ANSI.red}[needs verification]${ANSI.reset}`;
    case 'ineligible': return ` ${ANSI.red}[ineligible]${ANSI.reset}`;
    default: return '';
  }
}

function getAccountTier(acc: AccountInfo): number {
  if (acc.isCurrentAccount) return 0
  if (acc.enabled === false) return 6
  if (acc.status === 'active') {
    const overall = classifyOverallQuotaHealth(acc.cachedQuota)
    if (overall.health === 'exhausted') return 3
    if (overall.health === 'partial') return 2
    return 1
  }
  if (acc.status === 'rate-limited') return 4
  return 5 // expired, verification-required, ineligible, unknown
}

function getHealthLabel(acc: AccountInfo): string {
  if (acc.enabled === false) return 'disabled'
  if (acc.status === 'active') {
    const overall = classifyOverallQuotaHealth(acc.cachedQuota)
    if (overall.health === 'exhausted') return 'exhausted'
    if (overall.health === 'partial') return 'limited'
    return 'active'
  }
  if (acc.status === 'rate-limited') return 'rate-limited'
  if (acc.status === 'expired') return 'expired'
  return 'other'
}

const QUOTA_KEYS: { key: string; label: string }[] = [
  { key: 'claude', label: 'Claude' },
  { key: 'gemini-pro', label: 'Gemini Pro' },
  { key: 'gemini-flash', label: 'Gemini Flash' },
]

function parseResetTimeToMs(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) return null
  const ms = timestamp - Date.now()
  return ms > 0 ? ms : null
}

function buildModelBreakdown(accounts: AccountInfo[]): string[] {
  const results: string[] = []

  for (const { key, label } of QUOTA_KEYS) {
    let availableCount = 0
    let exhaustedCount = 0
    let maxResetMs: number | undefined

    for (const acc of accounts) {
      if (acc.enabled === false) continue

      // Prefer per-model data when available for more accurate counting
      if (acc.cachedPerModelQuota && acc.cachedPerModelQuota.length > 0) {
        const modelsInGroup = acc.cachedPerModelQuota.filter(m => m.group === key)
        if (modelsInGroup.length === 0) continue
        // Account is exhausted for this group if ALL models in the group are at 0%
        const allExhausted = modelsInGroup.every(m => m.remainingFraction <= 0)
        if (allExhausted) {
          // Check staleness: skip if all reset times are in the past
          const freshExhausted = modelsInGroup.some(m => {
            const resetMs = parseResetTimeToMs(m.resetTime)
            return resetMs !== null && resetMs > 0
          })
          if (freshExhausted) {
            exhaustedCount++
            for (const m of modelsInGroup) {
              const resetMs = parseResetTimeToMs(m.resetTime)
              if (resetMs !== null && resetMs > 0 && (maxResetMs === undefined || resetMs > maxResetMs)) {
                maxResetMs = resetMs
              }
            }
          } else {
            availableCount++
          }
        } else {
          availableCount++
        }
      } else {
        // Fall back to group-level cachedQuota
        const group = acc.cachedQuota?.[key]
        if (!group || typeof group.remainingFraction !== 'number') continue
        if (group.remainingFraction <= 0) {
          // Skip stale exhaustion: if resetTime is missing or in the past,
          // Google has likely already reset the quota — count as available
          const resetMs = parseResetTimeToMs(group.resetTime)
          if (resetMs !== null && resetMs > 0) {
            exhaustedCount++
            if (maxResetMs === undefined || resetMs > maxResetMs) {
              maxResetMs = resetMs
            }
          } else {
            availableCount++
          }
        } else {
          availableCount++
        }
      }
    }

    if (exhaustedCount > 0 || availableCount > 0) {
      const parts: string[] = []
      if (availableCount > 0) parts.push(`${availableCount} available`)
      if (exhaustedCount > 0) {
        const resetSuffix = maxResetMs !== undefined
          ? ` ~${formatWaitDuration(maxResetMs)}`
          : ''
        parts.push(`${exhaustedCount} exhausted${resetSuffix}`)
      }
      results.push(`${label}: ${parts.join(', ')}`)
    }
  }

  return results
}

function buildAccountSummary(accounts: AccountInfo[]): { countsLine: string; modelLine: string } {
  const counts: Record<string, number> = {}
  for (const acc of accounts) {
    const label = getHealthLabel(acc)
    counts[label] = (counts[label] ?? 0) + 1
  }
  const order = ['active', 'limited', 'exhausted', 'rate-limited', 'expired', 'disabled', 'other']
  const parts = order
    .filter(label => (counts[label] ?? 0) > 0)
    .map(label => `${counts[label]} ${label}`)

  // Per-model exhaustion breakdown
  const modelBreakdown = buildModelBreakdown(accounts)
  const countsLine = parts.length > 0 ? `Accounts (${parts.join(', ')})` : 'Accounts'
  const modelLine = modelBreakdown.length > 0 ? modelBreakdown.join(', ') : ''
  return { countsLine, modelLine }
}

function buildAccountHint(account: AccountInfo): string {
  if (account.quotaSummary) {
    // For [limited] accounts, strip per-account "resets in Xh Ym" since the
    // summary header already shows aggregate reset times — avoids 22 identical
    // "Claude exhausted resets in 120h 33m" lines
    const overall = classifyOverallQuotaHealth(account.cachedQuota)
    if (overall.health === 'partial') {
      return account.quotaSummary.replace(/\s*resets in \S+/g, '')
    }
    return account.quotaSummary
  }
  if (account.lastUsed) {
    return `used ${formatRelativeTime(account.lastUsed)}`
  }
  return ''
}

function buildAccountMenuItems(accounts: AccountInfo[]): MenuItem<AuthMenuAction>[] {
  const sorted = accounts.slice().sort((a, b) => getAccountTier(a) - getAccountTier(b))

  const items: MenuItem<AuthMenuAction>[] = []
  let prevTier = -1

  for (let i = 0; i < sorted.length; i++) {
    const account = sorted[i]!
    const tier = getAccountTier(account)

    // Insert separator between tiers (but not before the first account)
    if (prevTier !== -1 && tier !== prevTier) {
      items.push({ label: '', value: { type: 'cancel' }, separator: true })
    }
    prevTier = tier

    const displayNum = i + 1
    // Current account shows only [current] — no status badge to avoid double-badge noise
    const statusBadge = account.isCurrentAccount ? '' : getStatusBadge(account.status, account)
    const currentBadge = account.isCurrentAccount ? ` ${ANSI.cyan}[current]${ANSI.reset}` : ''
    const disabledBadge = account.enabled === false ? ` ${ANSI.red}[disabled]${ANSI.reset}` : ''
    const baseLabel = account.email || `Account ${displayNum}`
    const numbered = `${displayNum}. ${baseLabel}`
    const fullLabel = `${numbered}${currentBadge}${statusBadge}${disabledBadge}`

    items.push({
      label: fullLabel,
      hint: buildAccountHint(account),
      value: { type: 'select-account' as const, account },
    })
  }

  return items
}

export async function showAuthMenu(accounts: AccountInfo[]): Promise<AuthMenuAction> {
  const items: MenuItem<AuthMenuAction>[] = [
    { label: 'Actions', value: { type: 'cancel' }, kind: 'heading' },
    { label: 'Add account', value: { type: 'add' }, color: 'cyan' },
    { label: 'Auth current', value: { type: 'current' }, color: 'cyan' },
    { label: 'Check quotas', value: { type: 'check' }, color: 'cyan' },
    { label: 'Repair auth', value: { type: 'repair' }, color: 'yellow' },
    { label: 'Auth doctor', value: { type: 'doctor' }, color: 'cyan' },
    { label: 'Verify one account', value: { type: 'verify' }, color: 'cyan' },
    { label: 'Verify all accounts', value: { type: 'verify-all' }, color: 'cyan' },
    { label: 'Configure models in opencode.json', value: { type: 'configure-models' }, color: 'cyan' },
    { label: '', value: { type: 'cancel' }, separator: true },

    ...((): MenuItem<AuthMenuAction>[] => {
      const { countsLine, modelLine } = buildAccountSummary(accounts)
      const lines: MenuItem<AuthMenuAction>[] = [
        { label: countsLine, value: { type: 'cancel' }, kind: 'heading' },
      ]
      if (modelLine) {
        lines.push({ label: modelLine, value: { type: 'cancel' }, kind: 'heading' })
      }
      return lines
    })(),

    ...buildAccountMenuItems(accounts),

    { label: '', value: { type: 'cancel' }, separator: true },
    { label: 'Danger zone', value: { type: 'cancel' }, kind: 'heading' },
    { label: 'Delete all accounts', value: { type: 'delete-all' }, color: 'red' as const },
  ];

  while (true) {
    const result = await select(items, { 
      message: 'Google accounts (Antigravity)',
      subtitle: 'Select an action or account',
      clearScreen: true,
    });

    if (!result) return { type: 'cancel' };

    if (result.type === 'delete-all') {
      const confirmed = await confirm('Delete ALL accounts? This cannot be undone.');
      if (!confirmed) continue;
    }

    return result;
  }
}

function formatFingerprintReason(reason: FingerprintVersion['reason']): string {
  switch (reason) {
    case 'initial': return 'initial';
    case 'regenerated': return 'regenerated';
    case 'restored': return 'restored';
  }
}

export async function showFingerprintHistory(
  history: FingerprintVersion[],
  accountLabel: string,
): Promise<number | null> {
  const items: MenuItem<number | null>[] = [
    { label: 'Back', value: null },
    { label: '', value: null, separator: true },
    { label: 'Fingerprint history', value: null, kind: 'heading' },
    ...history.map((entry, index) => {
      const deviceShort = entry.fingerprint.deviceId.slice(0, 8);
      const reasonBadge = `${ANSI.dim}[${formatFingerprintReason(entry.reason)}]${ANSI.reset}`;
      const label = `${index + 1}. ${deviceShort}... ${reasonBadge}`;
      const hint = formatRelativeTime(entry.timestamp);
      return {
        label,
        hint,
        value: index,
        color: 'cyan' as const,
      };
    }),
  ];

  const result = await select(items, {
    message: `Restore fingerprint — ${accountLabel}`,
    subtitle: 'Select a previous fingerprint to restore',
    clearScreen: true,
  });

  return result ?? null;
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
  const label = account.email || `Account ${account.index + 1}`;
  const badge = getStatusBadge(account.status, account);
  const disabledBadge = account.enabled === false ? ` ${ANSI.red}[disabled]${ANSI.reset}` : '';
  const header = `${label}${badge}${disabledBadge}`;
  const subtitleParts = [
    `Added: ${formatDate(account.addedAt)}`,
    `Last used: ${formatRelativeTime(account.lastUsed)}`,
  ];

  const hasHistory = (account.fingerprintHistory?.length ?? 0) > 0;

  while (true) {
    const menuItems: MenuItem<AccountAction>[] = [
      { label: 'Back', value: 'back' as const },
    ];

    if (!account.isCurrentAccount) {
      menuItems.push({
        label: 'Switch to this account',
        value: 'switch-account' as const,
        color: 'green',
      });
    }

    menuItems.push(
      { label: 'Verify account access', value: 'verify' as const, color: 'cyan' },
      { label: account.enabled === false ? 'Enable account' : 'Disable account', value: 'toggle' as const, color: account.enabled === false ? 'green' : 'yellow' },
      { label: 'Refresh token', value: 'refresh' as const, color: 'cyan' },
    );

    if (hasHistory) {
      menuItems.push({
        label: `Restore fingerprint (${account.fingerprintHistory!.length} saved)`,
        value: 'restore-fingerprint' as const,
        color: 'cyan',
      });
    }

    menuItems.push(
      { label: 'Delete this account', value: 'delete' as const, color: 'red' },
    );

    const result = await select(menuItems, {
      message: header,
      subtitle: subtitleParts.join(' | '),
      clearScreen: true,
    });

    if (result === 'delete') {
      const confirmed = await confirm(`Delete ${label}?`);
      if (!confirmed) continue;
    }

    if (result === 'refresh') {
      const confirmed = await confirm(`Re-authenticate ${label}?`);
      if (!confirmed) continue;
    }

    return result ?? 'cancel';
  }
}
export { isTTY } from './ansi';
