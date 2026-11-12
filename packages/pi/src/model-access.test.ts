import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_MODELS_REFUSAL_TEXT,
  AntigravityMenuRefusal,
  type VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'

import { createPiAntigravityAccountSections } from './commands.ts'
import {
  createPiModelAccess,
  PI_ACCOUNT_MODELS_NO_FILE,
  PI_ACCOUNT_MODELS_REFUSAL,
} from './model-access.ts'
import type {
  PiVaultAccountsPort,
  PiVaultSetup,
  PiVaultSetupStatus,
} from './vault-setup.ts'
import {
  createPiVaultSend,
  type PiVaultAccountSource,
  PiVaultSendError,
} from './vault-source.ts'

const ROUTE: VaultRouteRef = Object.freeze({
  routeId: 'vault:a',
  credentialId: 'cred-a',
  accountIdentity: 'account-a',
  label: 'Account A',
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(text?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-model-access-')))
  roots.push(root)
  const file = join(root, 'cortexkit', 'antigravity-auth.jsonc')
  if (text !== undefined) {
    mkdirSync(join(root, 'cortexkit'), { recursive: true })
    writeFileSync(file, text)
  }
  const statePath = join(root, 'vault', 'settings-protection.json')
  return {
    file,
    statePath,
    access: () => createPiModelAccess({ file, statePath }),
  }
}

/** A vault source with one route; `sends` counts what reached the vault. */
function vaultSend(access: ReturnType<typeof createPiModelAccess>) {
  const sends: string[] = []
  const source = {
    routes: () => [ROUTE],
    refresh: async () => undefined,
    emptyRosterCause: () => 'none',
    send: async (
      ref: VaultRouteRef,
      dispatch: (credential: {
        accessToken: string
        projectId: string
      }) => Promise<Response>,
    ) => {
      sends.push(ref.routeId)
      return dispatch({ accessToken: 'vault-token', projectId: 'project' })
    },
  } as unknown as PiVaultAccountSource
  const send = createPiVaultSend({
    readMode: () => ({ ok: true, record: { version: 1, mode: 'custody' } }),
    source: async () => source,
    accountModels: access,
  })
  return { send, sends }
}

const ok = async () => new Response('ok')

describe('Pi vault sends and account_models', () => {
  it('refuses a model the vault account does not list before anything is sent, and serves a listed one', async () => {
    const f = fixture(
      '// lists\n{ "schema_version": 1, "account_models": { "vault:a": ["claude-sonnet-5-5"] } }\n',
    )
    const { send, sends } = vaultSend(f.access())
    const dispatched: string[] = []
    const refused = send(
      async () => {
        dispatched.push('carbon')
        return ok()
      },
      new AbortController().signal,
      'antigravity-gemini-4-carbon',
    )
    await expect(refused).rejects.toBeInstanceOf(PiVaultSendError)
    await expect(refused).rejects.toThrow(PI_ACCOUNT_MODELS_REFUSAL)
    expect(sends).toEqual([])
    expect(dispatched).toEqual([])

    const served = await send(
      async () => {
        dispatched.push('sonnet')
        return ok()
      },
      new AbortController().signal,
      'antigravity-claude-sonnet-5-5',
    )
    expect(served.status).toBe(200)
    expect(sends).toEqual(['vault:a'])
    expect(dispatched).toEqual(['sonnet'])
  })

  it('serves every model when the vault account has no entry or there is no settings file', async () => {
    for (const text of [
      '{ "schema_version": 1, "account_models": { "vault:other": ["claude-sonnet-5-5"] } }\n',
      undefined,
    ]) {
      const f = fixture(text)
      const { send, sends } = vaultSend(f.access())
      const response = await send(
        ok,
        new AbortController().signal,
        'antigravity-gemini-4-carbon',
      )
      expect(response.status).toBe(200)
      expect(sends).toEqual(['vault:a'])
    }
  })

  it('serves nothing when the list is unusable at start and nothing was saved, then keeps the saved value', async () => {
    const unusable =
      '{ "schema_version": 1, "account_models": { "vault:a": "gemini-4-carbon" } }\n'
    const f = fixture(unusable)
    const first = vaultSend(f.access())
    await expect(
      first.send(
        ok,
        new AbortController().signal,
        'antigravity-gemini-4-carbon',
      ),
    ).rejects.toThrow(PI_ACCOUNT_MODELS_REFUSAL)
    expect(first.sends).toEqual([])

    // A usable list is applied and saved for the next start.
    writeFileSync(
      f.file,
      '{ "schema_version": 1, "account_models": { "vault:a": ["gemini-4-carbon"] } }\n',
    )
    const applied = vaultSend(f.access())
    expect(
      (
        await applied.send(
          ok,
          new AbortController().signal,
          'antigravity-gemini-4-carbon',
        )
      ).status,
    ).toBe(200)
    expect(existsSync(f.statePath)).toBe(true)

    writeFileSync(f.file, unusable)
    const restarted = vaultSend(f.access())
    expect(
      (
        await restarted.send(
          ok,
          new AbortController().signal,
          'antigravity-gemini-4-carbon-high',
        )
      ).status,
    ).toBe(200)
    await expect(
      restarted.send(
        ok,
        new AbortController().signal,
        'antigravity-claude-sonnet-5-5',
      ),
    ).rejects.toThrow(PI_ACCOUNT_MODELS_REFUSAL)
  })
})

describe('Pi /antigravity account model lists', () => {
  function sections(access: ReturnType<typeof createPiModelAccess>) {
    const status = {
      mode: 'custody',
      hosted: true,
      hostSlot: 'dormant',
      enrollment: { state: 'approved' },
      selectedRouteId: 'vault:a',
    } as unknown as PiVaultSetupStatus
    return createPiAntigravityAccountSections({
      setup: async () =>
        ({ status: async () => status }) as unknown as PiVaultSetup,
      accounts: () =>
        ({
          list: async () => [
            { routeId: 'vault:a', label: 'Account A', declined: false },
          ],
          grantReach: () => undefined,
        }) as unknown as PiVaultAccountsPort,
      models: access,
    })
  }
  const invocation = { notify: () => {} }

  async function modelsAction(access: ReturnType<typeof createPiModelAccess>) {
    const built = await sections(access).accounts.build(invocation)
    const item = built.items?.[0]
    const action = item?.actions?.find((entry) => entry.id === 'models')
    if (!item || !action) throw new Error('no Models action')
    const off = Object.fromEntries(
      (action.knobs ?? []).map((knob) => [knob.id, false]),
    )
    return { item, action, off }
  }

  it('shows, sets and clears a vault account list by route id, keeping comments', async () => {
    const f = fixture('// pi lists\n{\n  "schema_version": 1\n}\n')
    const access = f.access()
    const before = await modelsAction(access)
    expect(before.item.detail).toBe('in use by Pi · All models')

    const set = await before.action.run({
      values: { ...before.off, 'gemini-4-carbon': true },
      invocation,
    })
    expect(set).toBe('Vault account 1 serves gemini-4-carbon')
    const written = readFileSync(f.file, 'utf8')
    expect(written).toContain('// pi lists')
    expect(written).toContain('"vault:a"')
    const after = await modelsAction(access)
    expect(after.item.detail).toBe('in use by Pi · gemini-4-carbon')
    // The route id is the key, but it is never shown.
    expect(JSON.stringify(after.item)).not.toContain('vault:a')

    const cleared = await after.action.run({
      values: { ...after.off, 'all-models': true },
      invocation,
    })
    expect(cleared).toBe('Vault account 1 serves all models')
    expect(readFileSync(f.file, 'utf8')).toContain('// pi lists')
    expect((await modelsAction(access)).item.detail).toBe(
      'in use by Pi · All models',
    )
  })

  it('refuses an empty list, an unknown-only list and a missing settings file with fixed text', async () => {
    const original = '{ "schema_version": 1 }\n'
    const f = fixture(original)
    const access = f.access()
    const { action, off } = await modelsAction(access)
    expect(await action.run({ values: off, invocation })).toEqual({
      ok: false,
      text: ACCOUNT_MODELS_REFUSAL_TEXT['empty-list'],
      code: 'invalid-input',
    })
    const unknown = await access.update('vault:a', ['not-a-model']).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(unknown).toBeInstanceOf(AntigravityMenuRefusal)
    expect((unknown as AntigravityMenuRefusal).text).toBe(
      ACCOUNT_MODELS_REFUSAL_TEXT['unknown-only'],
    )
    expect(readFileSync(f.file, 'utf8')).toBe(original)

    const missing = fixture()
    const noFile = missing.access()
    await noFile.refresh()
    const refused = await noFile.update('vault:a', ['gemini-4-carbon']).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((refused as AntigravityMenuRefusal).text).toBe(
      PI_ACCOUNT_MODELS_NO_FILE,
    )
    expect(existsSync(missing.file)).toBe(false)
  })
})
