import {
  type AntigravityMenuSections,
  type AntigravityQuotaCheckReport,
  formatAntigravityQuota,
  quotaCheckOutcome,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import type {
  VaultAccountPool,
  VaultAccountRow,
} from './vault-request-credentials'

/** Show accounts and quotas from the same vault account pool that selects request routes. */
export function createVaultAccountMenuSections(
  pool: Pick<VaultAccountPool, 'selector'>,
  selectorOf: (row: VaultAccountRow) => string,
  checkQuota?: (signal: AbortSignal) => Promise<AntigravityQuotaCheckReport>,
): Pick<AntigravityMenuSections, 'accounts' | 'quota'> {
  return {
    accounts: {
      title: 'Accounts',
      build: () => {
        const rows = pool.selector.rows
        return {
          lines: [
            rows.length === 0
              ? VAULT_ACCOUNT_REMEDY
              : `${rows.length} ${rows.length === 1 ? 'account' : 'accounts'} served from the vault`,
          ],
          items: rows.map((row, position) => ({
            id: selectorOf(row),
            label: `Account ${position + 1}`,
            detail: 'served from the vault',
          })),
        }
      },
    },
    quota: {
      title: 'Quota',
      build: () => {
        const rows = pool.selector.rows
        return {
          lines:
            rows.length === 0
              ? []
              : rows.map(
                  (row, position) =>
                    `Account ${position + 1}: ${formatAntigravityQuota(
                      {
                        schemaVersion: 1,
                        cachedQuota: row.cachedQuota,
                        cachedQuotaUpdatedAt: row.cachedQuotaUpdatedAt,
                      },
                      { now: Date.now() },
                    )}`,
                ),
          actions:
            checkQuota && rows.length > 0
              ? [
                  {
                    id: 'refresh',
                    label: 'Check quota now',
                    run: async () =>
                      quotaCheckOutcome(
                        await checkQuota(new AbortController().signal),
                      ),
                  },
                ]
              : [],
        }
      },
    },
  }
}
