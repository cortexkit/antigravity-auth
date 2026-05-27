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
export type AccountStatus = 'active' | 'rate-limited' | 'expired' | 'verification-required' | 'unknown';

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
  fingerprintHistory?: FingerprintHistoryEntry[];
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
export interface FingerprintHistoryEntry {
  deviceId: string;
  userAgent: string;
  timestamp: number;
  reason: 'initial' | 'regenerated' | 'restored';
}

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
  return 5 // expired, verification-required, unknown
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

function buildAccountSummary(accounts: AccountInfo[]): string {
  const counts: Record<string, number> = {}
  for (const acc of accounts) {
    const label = getHealthLabel(acc)
    counts[label] = (counts[label] ?? 0) + 1
  }
  const order = ['active', 'limited', 'exhausted', 'rate-limited', 'expired', 'disabled', 'other']
  const parts = order
    .filter(label => (counts[label] ?? 0) > 0)
    .map(label => `${counts[label]} ${label}`)
  return parts.length > 0 ? `Accounts (${parts.join(', ')})` : 'Accounts'
}

function buildAccountHint(account: AccountInfo): string {
  // For [limited] accounts, the quota summary may contain "resets in X" which
  // is redundant since the badge already distinguishes them from [active]
  if (account.quotaSummary) {
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
    const statusBadge = getStatusBadge(account.status, account)
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

    { label: buildAccountSummary(accounts), value: { type: 'cancel' }, kind: 'heading' },

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

function formatFingerprintReason(reason: FingerprintHistoryEntry['reason']): string {
  switch (reason) {
    case 'initial': return 'initial';
    case 'regenerated': return 'regenerated';
    case 'restored': return 'restored';
  }
}

export async function showFingerprintHistory(
  history: FingerprintHistoryEntry[],
  accountLabel: string,
): Promise<number | null> {
  const items: MenuItem<number | null>[] = [
    { label: 'Back', value: null },
    { label: '', value: null, separator: true },
    { label: 'Fingerprint history', value: null, kind: 'heading' },
    ...history.map((entry, index) => {
      const deviceShort = entry.deviceId.slice(0, 8);
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
