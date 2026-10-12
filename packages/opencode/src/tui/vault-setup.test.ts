import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
// The core barrel does not export the vault family yet; read the frozen
// source module directly so the two names cannot drift.
import { ANTIGRAVITY_VAULT_ENROLLMENT_NAMES } from '../../../core/src/vault-family.ts'

import {
  createVaultSection,
  OPENCODE_VAULT_ENROLLMENT_NAME,
  parseVaultSetupStatus,
  type VaultActionOutcome,
  type VaultSetupEffects,
  type VaultSetupStatus,
  vaultSetupView,
} from './vault-setup'

const NOW = 1_800_000_000_000

function status(overrides: Partial<VaultSetupStatus> = {}): VaultSetupStatus {
  return {
    mode: 'local',
    enrollment: 'not-enrolled',
    checkedAt: NOW,
    ...overrides,
  }
}

function effects(
  current: unknown,
  outcomes: Partial<
    Record<keyof VaultSetupEffects, VaultActionOutcome | Error>
  > = {},
) {
  const calls: string[] = []
  const run =
    (name: Exclude<keyof VaultSetupEffects, 'status'>) =>
    async (): Promise<VaultActionOutcome> => {
      calls.push(name)
      const outcome = outcomes[name] ?? { ok: true, text: `${name} done` }
      if (outcome instanceof Error) throw outcome
      return outcome
    }
  const value: VaultSetupEffects = {
    status: async () => current as VaultSetupStatus,
    enroll: run('enroll'),
    useCustody: run('useCustody'),
    useLocal: run('useLocal'),
    disconnect: run('disconnect'),
  }
  return { value, calls }
}

describe('enrollment name', () => {
  it('is the frozen OpenCode host enrollment name', () => {
    expect(OPENCODE_VAULT_ENROLLMENT_NAME).toBe('antigravity-auth-opencode')
    expect<string>(OPENCODE_VAULT_ENROLLMENT_NAME).toBe(
      ANTIGRAVITY_VAULT_ENROLLMENT_NAMES.opencode,
    )
  })
})

describe('vaultSetupView', () => {
  const cases: Array<[string, Partial<VaultSetupStatus>, string[], string]> = [
    ['not enrolled', {}, ['enroll'], 'Not enrolled'],
    [
      'pending',
      { enrollment: 'pending' },
      ['disconnect'],
      'waiting for approval',
    ],
    [
      'enrolled on local',
      { enrollment: 'enrolled', accounts: 2 },
      ['use-custody', 'disconnect'],
      'Vault accounts for this host: 2',
    ],
    [
      'enrolled on custody',
      { enrollment: 'enrolled', mode: 'custody' },
      ['use-local', 'disconnect'],
      'vault custody',
    ],
    ['revoked', { enrollment: 'revoked' }, ['enroll'], 'revoked by the vault'],
    [
      'declined',
      { enrollment: 'declined' },
      ['enroll'],
      'declined by the vault',
    ],
    [
      'unreachable on custody',
      { enrollment: 'unavailable', mode: 'custody' },
      ['use-local'],
      'status unknown',
    ],
    [
      'unreachable on local',
      { enrollment: 'unavailable' },
      [],
      'status unknown',
    ],
    [
      'ineligible',
      { ineligible: 'host-login-present' },
      [],
      'remove it before using vault custody',
    ],
    [
      'ineligible while enrolled',
      { enrollment: 'enrolled', ineligible: 'no-vault-configured' },
      ['disconnect'],
      'No vault is configured',
    ],
  ]
  for (const [name, overrides, actions, line] of cases) {
    it(`${name}: offers ${actions.join(', ') || 'nothing'}`, () => {
      const view = vaultSetupView(status(overrides))
      expect(view.actions).toEqual(actions as typeof view.actions)
      expect(view.lines.join('\n')).toContain(line)
      expect(view.lines.join('\n')).toContain('antigravity-auth-opencode')
    })
  }

  it('offers nothing when status could not be read', () => {
    expect(vaultSetupView(undefined)).toEqual({
      lines: ['Vault status could not be read; no vault action is offered.'],
      actions: [],
    })
  })
})

describe('parseVaultSetupStatus', () => {
  it('keeps exactly the known fields', () => {
    expect(parseVaultSetupStatus(status({ accounts: 3 }))).toEqual(
      status({ accounts: 3 }),
    )
  })

  for (const [name, extra] of [
    ['a token', { token: 'ya29.secret' }],
    ['an email', { email: 'someone@example.com' }],
    ['a receipt', { receipt: { id: 'r' } }],
  ] as const) {
    it(`refuses a status carrying ${name}`, () => {
      expect(parseVaultSetupStatus({ ...status(), ...extra })).toBeUndefined()
    })
  }

  it('refuses unknown modes, states and counts', () => {
    expect(
      parseVaultSetupStatus({ ...status(), mode: 'mixed' }),
    ).toBeUndefined()
    expect(
      parseVaultSetupStatus({ ...status(), enrollment: 'maybe' }),
    ).toBeUndefined()
    expect(parseVaultSetupStatus({ ...status(), accounts: -1 })).toBeUndefined()
    expect(
      parseVaultSetupStatus({ ...status(), checkedAt: 'now' }),
    ).toBeUndefined()
  })
})

describe('createVaultSection', () => {
  it('builds from a fresh status on every call and runs the injected effect', async () => {
    let current: VaultSetupStatus = status()
    const fx = effects(undefined)
    fx.value.status = async () => current
    const section = createVaultSection(fx.value)
    expect(section.id).toBe('vault')

    const first = await section.build({})
    expect(first.actions.map((action) => action.id)).toEqual(['enroll'])
    expect(await first.actions[0]!.run({})).toEqual({
      ok: true,
      text: 'enroll done',
    })
    expect(fx.calls).toEqual(['enroll'])

    current = status({ enrollment: 'enrolled' })
    const second = await section.build({})
    expect(second.actions.map((action) => action.id)).toEqual([
      'use-custody',
      'disconnect',
    ])
  })

  it('marks disconnect irreversible with a confirmation', async () => {
    const section = createVaultSection(
      effects(status({ enrollment: 'enrolled' })).value,
    )
    const content = await section.build({})
    const disconnect = content.actions.find(
      (action) => action.id === 'disconnect',
    )
    expect(disconnect?.irreversible).toBe(true)
    expect(disconnect?.confirm).toContain('Withdraw')
  })

  it('shows no action when the server status is refused', async () => {
    const section = createVaultSection(
      effects({ ...status(), refreshToken: 'secret' }).value,
    )
    const content = await section.build({})
    expect(content.actions).toEqual([])
    expect(JSON.stringify(content)).not.toContain('secret')
  })

  it('never shows an effect error text', async () => {
    const section = createVaultSection(
      effects(status(), { enroll: new Error('bearer abc123') }).value,
    )
    const content = await section.build({})
    const outcome = await content.actions[0]!.run({})
    expect(outcome).toEqual({
      ok: false,
      text: 'The vault action did not complete.',
      code: 'vault-failed',
    })
  })
})

describe('vault-setup module graph', () => {
  it('imports nothing', () => {
    const source = readFileSync(
      new URL('./vault-setup.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(|\bimport\(/)
  })
})
