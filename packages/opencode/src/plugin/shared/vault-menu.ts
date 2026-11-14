import {
  type AntigravityMenuSections,
  type AntigravityQuotaCheckReport,
  accountModelsAction,
  accountModelsText,
  clearLimitsAction,
  formatAntigravityQuota,
  quotaCheckOutcome,
  VAULT_ACCOUNT_REMEDY,
} from '@cortexkit/antigravity-auth-core'
import { knownModelIds } from '../../settings/core-settings'
import { type AccountModelSettings, accountModelList } from '../command-apply'
import type {
  VaultAccountPool,
  VaultAccountRow,
} from './vault-request-credentials'

/**
 * The vault accounts' model lists (`account_models`), keyed by each roster
 * row's route id. The id is written by the Models action and never shown.
 */
export interface VaultAccountModels {
  readonly settings: AccountModelSettings
  /** Whether the shared settings file is in use, so lists can be written. */
  readonly writable: () => boolean
}

/** Show accounts and quotas from the same vault account pool that selects request routes. */
export function createVaultAccountMenuSections(
  pool: Pick<VaultAccountPool, 'selector' | 'syncForDisplay'> &
    Partial<Pick<VaultAccountPool, 'clearLimits'>>,
  selectorOf: (row: VaultAccountRow) => string,
  checkQuota?: (signal: AbortSignal) => Promise<AntigravityQuotaCheckReport>,
  models?: VaultAccountModels,
): Pick<AntigravityMenuSections, 'accounts' | 'quota'> {
  return {
    accounts: {
      title: 'Accounts',
      build: async () => {
        await pool.syncForDisplay()
        const rows = pool.selector.rows
        return {
          lines: [
            rows.length === 0
              ? VAULT_ACCOUNT_REMEDY
              : `${rows.length} ${rows.length === 1 ? 'account' : 'accounts'} served from the vault`,
          ],
          items: rows.map((row, position) => {
            const clear = pool.clearLimits
              ? [clearLimitsAction(() => pool.clearLimits!(row))]
              : []
            if (!models)
              return {
                id: selectorOf(row),
                label: `Account ${position + 1}`,
                detail: 'served from the vault',
                actions: clear,
              }
            const routeId = row.route.routeId
            const list = accountModelList(models.settings, routeId)
            return {
              id: selectorOf(row),
              label: `Account ${position + 1}`,
              detail: `served from the vault · ${accountModelsText(list)}`,
              facts: { models: accountModelsText(list) },
              actions: [
                ...clear,
                ...(models.writable()
                  ? [
                      accountModelsAction({
                        catalog: knownModelIds(),
                        current: list,
                        label: `Account ${position + 1}`,
                        write: async (next) => {
                          await models.settings.updateAccountModels(
                            routeId,
                            next,
                          )
                          return 'applied'
                        },
                      }),
                    ]
                  : []),
              ],
            }
          }),
        }
      },
    },
    quota: {
      title: 'Quota',
      build: async () => {
        await pool.syncForDisplay()
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
