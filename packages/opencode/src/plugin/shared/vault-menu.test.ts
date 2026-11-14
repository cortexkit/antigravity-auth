import { describe, expect, it } from 'bun:test'
import {
  ACCOUNT_MODELS_REFUSAL_TEXT,
  VAULT_ACCOUNT_REMEDY,
  type VaultAccountState,
} from '@cortexkit/antigravity-auth-core'
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
  it('issue69 Clear limits writes only vault state and refreshes the selected row', async () => {
    const route = {
      routeId: 'route',
      credentialId: 'credential',
      accountIdentity: 'identity',
    }
    const by = { ...route, recordVersion: 1 }
    const reset = 99_000_000
    let current: VaultAccountState = {
      observed: by,
      metadata: {
        addedAt: 1,
        lastUsed: 0,
        rateLimitResetTimes: { 'gemini:gemini-3.8-flash': reset },
        rateLimitWrittenAt: { 'gemini:gemini-3.8-flash': 1 },
      },
    }
    let admissions = 0
    let commits = 0
    const pool = createVaultAccountPool({
      now: () => 10_000,
      source: {
        refresh: async () => undefined,
        routes: () => [route],
        admit: async () => {
          admissions++
          return {
            ...by,
            accessToken: 'vault-access',
            projectId: 'vault-project',
          } as Awaited<ReturnType<VaultRequestSource['admit']>>
        },
        reportServedStatus: async () => false,
      },
      durable: {
        readState: async () => ({
          schemaVersion: 1,
          accounts: { identity: current },
        }),
        source: {
          attribution: () => by,
          commitState: async (_by, update) => {
            commits++
            const next = update(current)
            if (!next) return { status: 'unchanged' }
            current = { ...next, observed: by }
            return { status: 'written', state: current }
          },
        },
      },
    })
    await pool.sync()
    const sections = createVaultAccountMenuSections(pool, () => 'opaque-choice')
    const invocation = { notify: () => {} }
    const before = await sections.accounts.build(invocation)
    const action = before.items?.[0]?.actions?.find(
      (action) => action.id === 'clear-limits',
    )
    expect(action?.label).toBe('Clear limits')
    expect(await action?.run({ values: {}, invocation })).toBe(
      'Limits cleared.',
    )
    expect(current.metadata?.rateLimitResetTimes).toEqual({})
    expect(pool.selector.rows[0]?.rateLimitResetTimes).toEqual({})
    expect(admissions).toBe(1)
    expect(commits).toBe(1)
    await sections.accounts.build(invocation)
    expect(pool.selector.rows[0]?.rateLimitResetTimes).toEqual({})
  })
  it('renders committed routes while a first roster read is pending', async () => {
    const read = Promise.withResolvers<void>()
    let routes: ReturnType<VaultRequestSource['routes']> = []
    // Expire display waits without wall-clock delays while discovery stays held.
    let now = 0
    const pool = createVaultAccountPool({
      now: () => now,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(() => {
          now += delayMs
          callback()
        }, 0)
        return () => clearTimeout(timer)
      },
      source: {
        refresh: async () => {
          await read.promise
          return undefined
        },
        routes: () => routes,
        admit: async () => {
          throw new Error('rendering must not resolve a credential')
        },
        reportServedStatus: async () => false,
      },
    })
    const sections = createVaultAccountMenuSections(pool, () => 'opaque-choice')
    try {
      const empty = await sections.accounts.build({ notify: () => {} })
      expect(empty.items).toEqual([])
      expect(now).toBe(2_000)
      routes = [
        {
          routeId: 'route',
          credentialId: 'credential',
          accountIdentity: 'identity',
          label: 'Work',
        },
      ]
      const accounts = await sections.accounts.build({ notify: () => {} })
      const quota = await sections.quota.build({ notify: () => {} })
      expect(accounts.items).toHaveLength(1)
      expect(quota.lines).toEqual(['Account 1: no quota reading yet'])
      expect(now).toBe(2_000)
    } finally {
      read.resolve()
      await pool.sync()
    }
  })

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
    expect(accounts).toMatchObject({
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

describe('vault account model lists', () => {
  it("shows each vault account's list and writes it under the route id", async () => {
    const pool = fixture()
    await pool.sync()
    const writes: Array<[string, readonly string[] | null]> = []
    let lists: Record<string, readonly string[]> = {}
    const sections = createVaultAccountMenuSections(
      pool,
      () => 'opaque-choice',
      undefined,
      {
        settings: {
          accountModels: () => lists,
          updateAccountModels: async (key, models) => {
            writes.push([key, models])
            lists = models === null ? {} : { [key]: models }
          },
        },
        writable: () => true,
      },
    )
    const invocation = { notify: () => {} }
    const before = await sections.accounts.build(invocation)
    const item = before.items?.[0]
    expect(item?.detail).toBe('served from the vault · All models')
    const action = item?.actions?.find((entry) => entry.id === 'models')
    expect(action?.label).toBe('Models')
    const values = Object.fromEntries(
      (action?.knobs ?? []).map((knob) => [knob.id, false]),
    )
    const set = await action?.run({
      values: { ...values, 'gemini-4-carbon': true },
      invocation,
    })
    expect(set).toBe('Account 1 serves gemini-4-carbon')
    expect(writes).toEqual([['synthetic-route', ['gemini-4-carbon']]])
    const after = await sections.accounts.build(invocation)
    expect(after.items?.[0]?.detail).toBe(
      'served from the vault · gemini-4-carbon',
    )
    // The route id is the key, but it is never shown.
    expect(JSON.stringify(after)).not.toContain('synthetic-route')
    const cleared = await after.items?.[0]?.actions
      ?.find((entry) => entry.id === 'models')
      ?.run({ values: { ...values, 'all-models': true }, invocation })
    expect(cleared).toBe('Account 1 serves all models')
    expect(writes.at(-1)).toEqual(['synthetic-route', null])
    await pool.sync()
  })

  it('refuses an empty list with fixed text and writes nothing', async () => {
    const pool = fixture()
    await pool.sync()
    const writes: unknown[] = []
    const sections = createVaultAccountMenuSections(
      pool,
      () => 'opaque-choice',
      undefined,
      {
        settings: {
          accountModels: () => ({}),
          updateAccountModels: async (...args) => {
            writes.push(args)
          },
        },
        writable: () => true,
      },
    )
    const invocation = { notify: () => {} }
    const built = await sections.accounts.build(invocation)
    const action = built.items?.[0]?.actions?.find(
      (entry) => entry.id === 'models',
    )
    const values = Object.fromEntries(
      (action?.knobs ?? []).map((knob) => [knob.id, false]),
    )
    expect(await action?.run({ values, invocation })).toEqual({
      ok: false,
      text: ACCOUNT_MODELS_REFUSAL_TEXT['empty-list'],
      code: 'invalid-input',
    })
    expect(writes).toEqual([])
    await pool.sync()
  })
})
