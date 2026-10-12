import { describe, expect, it } from 'bun:test'
import { VAULT_ACCOUNT_REMEDY } from '@cortexkit/antigravity-auth-core'
import { createVaultAccountMenuSections } from './vault-menu'
import {
  createVaultAccountPool,
  type VaultRequestSource,
} from './vault-request-credentials'

function fixture(empty = false) {
  const source: VaultRequestSource = {
    refresh: async () => undefined,
    routes: () =>
      empty
        ? []
        : [
            {
              routeId: 'synthetic-route',
              credentialId: 'synthetic-credential',
              accountIdentity: 'synthetic-account',
              label: 'not a public label',
              email: 'private@example.test',
            },
          ],
    admit: async () => {
      throw new Error('rendering must not resolve a credential')
    },
    reportServedStatus: async () => false,
  }
  return createVaultAccountPool({ source })
}

describe('vault menu projection', () => {
  it('renders only the actual vault selector, with opaque choices and no local credential resolution', async () => {
    const pool = fixture()
    await pool.sync()
    const sections = createVaultAccountMenuSections(pool, () => 'opaque-choice')
    const accounts = await sections.accounts.build({
      notify: () => {
        throw new Error('rendering must not notify')
      },
    })
    const quota = await sections.quota.build({
      notify: () => {
        throw new Error('rendering must not notify')
      },
    })
    expect(accounts).toEqual({
      lines: ['1 account served from the vault'],
      items: [
        {
          id: 'opaque-choice',
          label: 'Account 1',
          detail: 'served from the vault',
        },
      ],
    })
    expect(JSON.stringify(accounts)).not.toContain('private@example.test')
    expect(JSON.stringify(accounts)).not.toContain('synthetic-credential')
    expect(quota).toEqual({
      lines: ['Account 1: no quota reading yet'],
      actions: [],
    })
  })

  it('shows one remedy for an empty vault and offers no quota check without accounts', async () => {
    const pool = fixture(true)
    await pool.sync()
    let checks = 0
    const sections = createVaultAccountMenuSections(
      pool,
      () => 'unused',
      async () => {
        checks += 1
        return { checked: 0, notChecked: 0 }
      },
    )
    const accounts = await sections.accounts.build({
      notify: () => {
        throw new Error('rendering must not notify')
      },
    })
    const quota = await sections.quota.build({
      notify: () => {
        throw new Error('rendering must not notify')
      },
    })
    expect(accounts.lines).toEqual([VAULT_ACCOUNT_REMEDY])
    expect(accounts.items).toEqual([])
    expect(quota.lines).toEqual([])
    expect(quota.actions).toEqual([])
    expect(checks).toBe(0)
  })
})
