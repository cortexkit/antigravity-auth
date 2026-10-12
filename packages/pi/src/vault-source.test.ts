import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  VaultRoster,
  VaultRouteRef,
  VaultSendAdmission,
} from '@cortexkit/antigravity-auth-core'
import type { PiVaultModeRead } from './vault-setup.ts'

import {
  createPiVaultAccountsPort,
  createPiVaultRuntime,
  createPiVaultSend,
  type PiVaultAccountSource,
  type PiVaultRequestPathOptions,
  PiVaultSendError,
} from './vault-source.ts'

const ROUTE_A: VaultRouteRef = Object.freeze({
  routeId: 'vault:a',
  credentialId: 'cred-a',
  accountIdentity: 'account-a',
  label: 'Account A',
})
const ROUTE_B: VaultRouteRef = Object.freeze({
  routeId: 'vault:b',
  credentialId: 'cred-b',
  accountIdentity: 'account-b',
  label: 'Account B',
})

function admission(ref: VaultRouteRef, version: number): VaultSendAdmission {
  const value = {
    routeId: ref.routeId,
    credentialId: ref.credentialId,
    accountIdentity: ref.accountIdentity,
    recordVersion: version,
    projectId: `project-${ref.routeId}-v${version}`,
    expiresAtMs: null,
  }
  Object.defineProperty(value, 'accessToken', {
    value: `token-${ref.routeId}-v${version}`,
    enumerable: false,
  })
  return Object.freeze(value) as VaultSendAdmission
}

interface Harness {
  options: PiVaultRequestPathOptions
  events: string[]
  routes: VaultRouteRef[]
  roster: VaultRoster | undefined
  issued: VaultSendAdmission[]
  sendRefs: VaultRouteRef[]
  mode: PiVaultModeRead
  refuseAdmission?: Error
}

function harness(): Harness {
  const h: Harness = {
    events: [],
    routes: [ROUTE_A],
    roster: undefined,
    issued: [],
    sendRefs: [],
    mode: { ok: true, record: { version: 1, mode: 'custody' } },
    options: undefined as unknown as PiVaultRequestPathOptions,
  }
  const source: PiVaultAccountSource = {
    refresh: async () => {
      h.events.push('refresh')
      return h.roster
    },
    routes: () => h.routes,
    send: async (ref, dispatch, options) => {
      h.events.push(`send:${ref.routeId}:${options.site}`)
      h.sendRefs.push(ref)
      if (h.refuseAdmission) throw h.refuseAdmission
      const issued = admission(ref, h.issued.length + 1)
      h.issued.push(issued)
      return dispatch(issued, options.signal)
    },
    decline: async (ref) => {
      h.events.push(`decline:${ref.routeId}:${ref.accountIdentity}`)
    },
    accept: async (ref) => {
      h.events.push(`accept:${ref.routeId}:${ref.accountIdentity}`)
    },
  }
  h.options = {
    readMode: () => {
      h.events.push('mode')
      return h.mode
    },
    source: async () => {
      h.events.push('source')
      return source
    },
  }
  return h
}

const ok = () => new Response('ok', { status: 200 })

describe('Pi vault request path', () => {
  it('checks mode before reaching the source, then sends on the captured route', async () => {
    const h = harness()
    const seen: VaultSendAdmission[] = []
    const send = createPiVaultSend(h.options)
    const response = await send(async (credential) => {
      seen.push(credential as VaultSendAdmission)
      return ok()
    }, new AbortController().signal)

    expect(response.status).toBe(200)
    expect(h.events).toEqual(['mode', 'source', 'send:vault:a:model'])
    expect(h.sendRefs[0]).toBe(ROUTE_A)
    // The admission the source issued reaches the request builder as the same
    // object, so the source can report a 401 against that exact receipt.
    expect(seen[0]).toBe(h.issued[0])
  })

  it('gets a new admission for every physical send, never reusing a token or project', async () => {
    const h = harness()
    const send = createPiVaultSend(h.options)
    const credentials: { token: string; project: string }[] = []
    for (let i = 0; i < 2; i++)
      await send(async (credential) => {
        credentials.push({
          token: credential.accessToken,
          project: credential.projectId,
        })
        return ok()
      }, new AbortController().signal)

    expect(credentials).toEqual([
      { token: 'token-vault:a-v1', project: 'project-vault:a-v1' },
      { token: 'token-vault:a-v2', project: 'project-vault:a-v2' },
    ])
    expect(h.events.filter((event) => event === 'mode')).toHaveLength(2)
  })

  it('refuses to send outside custody or with an unreadable mode file', async () => {
    const h = harness()
    const send = createPiVaultSend(h.options)
    h.mode = { ok: true, record: { version: 1, mode: 'local' } }
    await expect(
      send(async () => ok(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PiVaultSendError)
    h.mode = { ok: false, reason: 'the vault mode file is not valid JSON' }
    await expect(
      send(async () => ok(), new AbortController().signal),
    ).rejects.toThrow(/not valid JSON/)
    expect(h.events).not.toContain('source')
  })

  it('the production request binding leaves a saved Google login unread during vault sends and account operations', async () => {
    const root = mkdtempSync(
      join(
        process.platform === 'win32' ? tmpdir() : '/tmp',
        'pi-vault-dormancy-',
      ),
    )
    const authFile = join(root, 'auth.json')
    const modeFile = join(root, 'vault-mode.json')
    const dormant = JSON.stringify({
      google: {
        type: 'oauth',
        refresh: 'dormant-refresh',
        access: 'dormant-access',
        expires: 1,
      },
    })
    writeFileSync(authFile, dormant, { mode: 0o600 })
    writeFileSync(modeFile, JSON.stringify({ version: 1, mode: 'custody' }), {
      mode: 0o600,
    })
    let nativeReads = 0
    const runtime = createPiVaultRuntime(
      () => {
        nativeReads++
        return JSON.parse(readFileSync(authFile, 'utf8')).google
      },
      {
        vaultDir: root,
        modeFile,
        rosterFile: join(root, 'roster.json'),
        connectEnrollment: async () => ({
          enrollPropose: async () => ({ requestId: 'privacy-witness' }),
          enrollPoll: async () => ({
            status: 'approved',
            name: 'antigravity-auth-pi',
            token: 'b'.repeat(64),
            tokenGeneration: 1,
          }),
          close: () => {},
        }),
      },
    )
    const h = harness()
    h.roster = {
      version: 1,
      complete: true,
      declined: [],
      rows: [
        {
          ...ROUTE_A,
          credentialType: 'oauth',
          state: 'active',
          enabled: true,
          addedAt: 1,
        },
      ],
    }
    const options = { ...runtime.requestPath, source: h.options.source }
    try {
      const send = createPiVaultSend(options)
      await expect(
        send(async () => ok(), new AbortController().signal),
      ).rejects.toThrow('enrollment is not active')
      expect(h.sendRefs).toHaveLength(0)
      expect(nativeReads).toBe(0)
      expect((await (await runtime.setup()).connectStep()).state).toBe(
        'approved',
      )
      const response = await send(
        async () => ok(),
        new AbortController().signal,
      )
      expect(response.status).toBe(200)
      const port = createPiVaultAccountsPort(options)
      const listed = await port.list()
      expect(listed).toHaveLength(1)
      const account = listed[0]
      if (!account) throw new Error('Vault account missing')
      await port.decline(account.routeId)
      await port.accept(account.routeId)
      expect(h.sendRefs).toEqual([ROUTE_A])
      expect(h.events).toContain('refresh')
      expect(h.events.some((event) => event.startsWith('decline:'))).toBe(true)
      expect(h.events.some((event) => event.startsWith('accept:'))).toBe(true)
      expect(nativeReads).toBe(0)
      expect(readFileSync(authFile, 'utf8')).toBe(dormant)
      await (await runtime.setup()).disconnect()
      const dispatched = h.sendRefs.length
      const beforeStaleActions = [...h.events]
      await expect(
        send(async () => ok(), new AbortController().signal),
      ).rejects.toBeInstanceOf(PiVaultSendError)
      await expect(port.accept(account.routeId)).rejects.toBeInstanceOf(
        PiVaultSendError,
      )
      await expect(port.decline(account.routeId)).rejects.toBeInstanceOf(
        PiVaultSendError,
      )
      await expect(port.list()).rejects.toBeInstanceOf(PiVaultSendError)
      expect(h.events).toEqual(beforeStaleActions)
      expect(h.sendRefs).toHaveLength(dispatched)
      expect(nativeReads).toBe(0)
      expect(readFileSync(authFile, 'utf8')).toBe(dormant)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discovers once when no roster is committed yet', async () => {
    const h = harness()
    h.routes = []
    const options = {
      ...h.options,
      source: async () => {
        const source = await h.options.source()
        return {
          ...source,
          refresh: async () => {
            h.routes = [ROUTE_A]
            return source.refresh()
          },
        }
      },
    }
    await createPiVaultSend(options)(
      async () => ok(),
      new AbortController().signal,
    )
    expect(h.events.filter((event) => event === 'refresh')).toHaveLength(1)
    expect(h.sendRefs).toEqual([ROUTE_A])
  })

  it('serves the chosen route and refuses a declined or removed choice', async () => {
    const h = harness()
    h.routes = [ROUTE_A, ROUTE_B]
    const send = createPiVaultSend(h.options)
    await expect(
      send(async () => ok(), new AbortController().signal),
    ).rejects.toThrow(/several/)
    h.mode = {
      ok: true,
      record: { version: 1, mode: 'custody', routeId: 'vault:b' },
    }
    await send(async () => ok(), new AbortController().signal)
    expect(h.sendRefs).toEqual([ROUTE_B])

    h.routes = [ROUTE_A]
    await expect(
      send(async () => ok(), new AbortController().signal),
    ).rejects.toThrow(/no longer available/)
  })

  it('surfaces an admission refusal (for example a missing or contradicted assertion) without dispatching', async () => {
    const h = harness()
    h.refuseAdmission = new Error(
      'The vault served a different credential or account than the selected route',
    )
    let dispatched = 0
    await expect(
      createPiVaultSend(h.options)(async () => {
        dispatched++
        return ok()
      }, new AbortController().signal),
    ).rejects.toThrow(/different credential or account/)
    expect(dispatched).toBe(0)
  })

  it('does not retry on its own: the source decides the one 401 retry', async () => {
    const h = harness()
    const response = await createPiVaultSend(h.options)(
      async () => new Response('expired', { status: 401 }),
      new AbortController().signal,
    )
    expect(response.status).toBe(401)
    expect(h.events.filter((event) => event.startsWith('send:'))).toHaveLength(
      1,
    )
  })

  it('refuses to send once the caller has aborted', async () => {
    const h = harness()
    const abort = new AbortController()
    abort.abort()
    await expect(
      createPiVaultSend(h.options)(async () => ok(), abort.signal),
    ).rejects.toThrow()
    expect(h.sendRefs).toHaveLength(0)
  })
})

describe('Pi vault accounts for setup', () => {
  it('lists roster rows with declined ones marked and acts on the listed ref', async () => {
    const h = harness()
    const row = {
      credentialType: 'oauth' as const,
      state: 'active',
      enabled: true,
      addedAt: 1,
    }
    h.roster = {
      version: 1,
      complete: true,
      rows: [
        { ...ROUTE_A, ...row },
        { ...ROUTE_B, ...row, email: 'b@example.com' },
        {
          routeId: 'vault:c',
          credentialId: 'cred-c',
          label: 'Unclaimed',
          ...row,
        },
      ],
      declined: [{ credentialId: 'cred-b', accountIdentity: 'account-b' }],
    }
    const port = createPiVaultAccountsPort(h.options)
    expect(await port.list()).toEqual([
      { routeId: 'vault:a', label: 'Account A', declined: false },
      {
        routeId: 'vault:b',
        label: 'Account B',
        email: 'b@example.com',
        declined: true,
      },
    ])
    await port.decline('vault:a')
    await port.accept('vault:b')
    expect(h.events).toContain('decline:vault:a:account-a')
    expect(h.events).toContain('accept:vault:b:account-b')
    await expect(port.decline('vault:c')).rejects.toBeInstanceOf(
      PiVaultSendError,
    )
  })
})
