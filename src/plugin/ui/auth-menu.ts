import { ANSI } from './ansi';
import { select, type MenuItem } from './select';
import { confirm } from './confirm';
import type { CooldownReason } from '../accounts';
import {
  classifyGroupStatus,
  buildCooldownStatus,
  formatQuotaStatusBadge,
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

export type AccountAction = 'back' | 'delete' | 'refresh' | 'toggle' | 'verify' | 'restore-fingerprint' | 'cancel';

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

  // Then check account-level status
  switch (status) {
    case 'active': return ` ${ANSI.green}[active]${ANSI.reset}`;
    case 'rate-limited': return ` ${ANSI.yellow}[rate-limited]${ANSI.reset}`;
    case 'expired': return ` ${ANSI.red}[expired]${ANSI.reset}`;
    case 'verification-required': return ` ${ANSI.red}[needs verification]${ANSI.reset}`;
    default: return '';
  }
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

    { label: 'Accounts', value: { type: 'cancel' }, kind: 'heading' },

    ...accounts.map(account => {
      const statusBadge = getStatusBadge(account.status, account);
      const currentBadge = account.isCurrentAccount ? ` ${ANSI.cyan}[current]${ANSI.reset}` : '';
      const disabledBadge = account.enabled === false ? ` ${ANSI.red}[disabled]${ANSI.reset}` : '';
      const baseLabel = account.email || `Account ${account.index + 1}`;
      const numbered = `${account.index + 1}. ${baseLabel}`;
      const fullLabel = `${numbered}${currentBadge}${statusBadge}${disabledBadge}`;
      return {
        label: fullLabel,
        hint: account.quotaSummary ?? (account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : ''),
        value: { type: 'select-account' as const, account },
      };
    }),

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
      { label: 'Verify account access', value: 'verify' as const, color: 'cyan' },
      { label: account.enabled === false ? 'Enable account' : 'Disable account', value: 'toggle' as const, color: account.enabled === false ? 'green' : 'yellow' },
      { label: 'Refresh token', value: 'refresh' as const, color: 'cyan' },
    ];

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
