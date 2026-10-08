import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
} from './common-auth-runtime.ts'
import {
  type AntigravityVaultAccountSource,
  AntigravityVaultSourceError,
  createAntigravityVaultAccountSource,
  type VaultClaustrumConsumer,
  type VaultClaustrumPort,
  type VaultConsumerOptions,
  type VaultReporterSource,
  type VaultRoster,
  type VaultRosterRow,
  type VaultScopedClient,
  type VaultScopedReceipt,
  type VaultSendAdmission,
} from './vault-account-source.ts'
import type { AntigravityVaultStateFs } from './vault-provider-state.ts'

type Reporter = VaultReporterSource
type VaultDeclinedAccount = VaultRoster['declined'][number]

const ACCOUNT = 'account-a'
const CREDENTIAL = 'cred-1'
const ROUTE = 'vault:route-1'

function row(overrides: Partial<VaultRosterRow> = {}): VaultRosterRow {
  return {
    routeId: ROUTE,
    credentialId: CREDENTIAL,
    credentialType: 'oauth',
    accountIdentity: ACCOUNT,
    state: 'active',
    label: 'Account A',
    enabled: true,
    addedAt: 0,
    ...overrides,
  }
}

function roster(
  rows: VaultRosterRow[] = [row()],
  declined: VaultDeclinedAccount[] = [],
): VaultRoster {
  return { version: 1, view: 'v1', complete: true, rows, declined }
}

/** A receipt shaped like the library's, with its token hidden from spreads. */
function receipt(
  version: number,
  overrides: Partial<Omit<VaultScopedReceipt, 'accessToken'>> & {
    accessToken?: string
  } = {},
): VaultScopedReceipt {
  const { accessToken = `token-v${version}`, ...rest } = overrides
  const value = {
    credentialId: CREDENTIAL,
    credentialType: 'oauth' as const,
    accountIdentity: ACCOUNT,
    accountIdentitySource: 'asserted' as const,
    expectedAccountIdentity: ACCOUNT,
    assertedCredentialId: CREDENTIAL,
    assertedAccountIdentity: ACCOUNT,
    projectId: `project-v${version}`,
    recordVersion: version,
    expiresAtMs: null,
    ...rest,
  }
  Object.defineProperty(value, 'accessToken', {
    value: accessToken,
    enumerable: false,
  })
  return value as VaultScopedReceipt
}

interface Harness {
  module: VaultClaustrumPort
  options?: VaultConsumerOptions
  roster: VaultRoster | undefined
  receipts: VaultScopedReceipt[]
  authorized: string[]
  reports: { attempt: VaultScopedReceipt; status: number; source: Reporter }[]
  hostSlotChecks: { mode: string; provider: string; auth: unknown }[]
  retryDecisions: { served: VaultScopedReceipt; current?: VaultScopedReceipt }[]
  declined: string[]
  accepted: string[]
  closed: number
  rosterGuardCalls: number
  signals: (AbortSignal | undefined)[]
}

function harness(): Harness {
  const h: Harness = {
    module: undefined as unknown as Harness['module'],
    roster: roster(),
    receipts: [],
    authorized: [],
    reports: [],
    hostSlotChecks: [],
    retryDecisions: [],
    declined: [],
    accepted: [],
    closed: 0,
    rosterGuardCalls: 0,
    signals: [],
  }
  class FakeConsumer implements VaultClaustrumConsumer {
    constructor(options: VaultConsumerOptions) {
      h.options = options
    }
    snapshot() {
      return h.roster
    }
    async refresh() {
      return h.roster
    }
    start() {}
    async authorize(routeId: string, signal?: AbortSignal) {
      h.authorized.push(routeId)
      h.signals.push(signal)
      const next = h.receipts.shift()
      if (!next) throw new Error('no receipt queued')
      return next
    }
    async reportFailure(
      attempt: VaultScopedReceipt,
      status: number,
      source: Reporter,
    ) {
      h.reports.push({ attempt, status, source })
    }
    async decline(routeId: string) {
      h.declined.push(routeId)
    }
    async accept(routeId: string) {
      h.accepted.push(routeId)
    }
    close() {
      h.closed++
    }
  }
  h.module = {
    ClaustrumConsumer: FakeConsumer,
    assertHostSlotMatchesMode(input) {
      h.hostSlotChecks.push(input)
      if (input.mode === 'custody' && input.auth === 'real-login')
        throw new Error('host-slot-login')
      return 'placeholder'
    },
    // Same rule as the library's `isScopedCredentialRotation`.
    decideScopedRetryAfter401(
      _site: string,
      served: VaultScopedReceipt,
      current: VaultScopedReceipt | undefined,
    ): current is VaultScopedReceipt {
      h.retryDecisions.push({ served, ...(current && { current }) })
      return (
        current !== undefined &&
        current.credentialId === served.credentialId &&
        current.accountIdentity === served.accountIdentity &&
        current.recordVersion !== served.recordVersion
      )
    },
    isDeclined(entries, credentialId, accountIdentity) {
      return entries.some(
        (entry) =>
          entry.credentialId === credentialId ||
          (entry.accountIdentity !== undefined &&
            entry.accountIdentity === accountIdentity),
      )
    },
    async mutateVaultRoster(_path, change) {
      h.rosterGuardCalls++
      const outcome = await change(h.roster, { assertOwned: async () => {} })
      expect(outcome.next).toBeUndefined()
      return outcome.result
    },
  }
  return h
}

const fakeFs: AntigravityVaultStateFs = {
  async withLock(_target, _options, fn) {
    return fn({ assertOwned: async () => {} })
  },
  async writeJsonAtomic(path, value, options) {
    await options?.beforeRename?.()
    await writeFile(path, JSON.stringify(value))
  },
}

let dir: string
let hostSlot: unknown
let custodyActive: boolean
let errors: unknown[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agy-vault-source-'))
  hostSlot = 'placeholder'
  custodyActive = true
  errors = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function source(h: Harness): AntigravityVaultAccountSource {
  return createAntigravityVaultAccountSource({
    claustrum: h.module,
    host: 'pi',
    hostProvider: 'google-antigravity',
    rosterPath: join(dir, 'roster.json'),
    tokenPath: join(dir, 'token.json'),
    connect: () =>
      Promise.reject(new Error('the fake consumer never connects')),
    isCustodyActive: () => custodyActive,
    readHostSlot: () => hostSlot,
    reporterSource: 'direct',
    state: { path: join(dir, 'state.json'), fs: fakeFs },
    onError: (error) => errors.push(error),
  })
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1)
  return items[0] as T
}

function response(status: number): Response {
  return new Response(`status ${status}`, { status })
}

describe('vault account source construction', () => {
  it('fixes the Antigravity family, requires assertion and parses no tokens', () => {
    const h = harness()
    source(h)
    expect(h.options?.family).toEqual({
      refreshAdapter: 'antigravity',
      category: 'antigravity-native',
      apiKeys: false,
    })
    expect(h.options?.requireAssertion).toBe(true)
    expect(h.options && 'parseIdentity' in h.options).toBe(false)
  })

  it('lists only enabled, active, OAuth, claimed and undeclined rows', () => {
    const h = harness()
    h.roster = roster(
      [
        row(),
        row({ routeId: 'r-key', credentialId: 'k', credentialType: 'api_key' }),
        row({ routeId: 'r-off', credentialId: 'c2', enabled: false }),
        row({ routeId: 'r-cold', credentialId: 'c3', state: 'needs-login' }),
        row({ routeId: 'r-unclaimed', credentialId: 'c4', unclaimed: true }),
        row({
          routeId: 'r-none',
          credentialId: 'c5',
          accountIdentity: undefined,
        }),
        row({
          routeId: 'r-declined',
          credentialId: 'c6',
          accountIdentity: 'b',
        }),
      ],
      [{ credentialId: 'c6', accountIdentity: 'b' }],
    )
    expect(source(h).routes()).toEqual([
      {
        routeId: ROUTE,
        credentialId: CREDENTIAL,
        accountIdentity: ACCOUNT,
        label: 'Account A',
      },
    ])
  })
})

describe('per-send admission', () => {
  it('takes token and project of each send from that send’s own receipt', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(7))
    const admission = await src.admit(ref)
    expect(admission.accessToken).toBe('token-v7')
    expect(admission.projectId).toBe('project-v7')
    expect(admission.recordVersion).toBe(7)
    expect(admission.accountIdentity).toBe(ACCOUNT)
    expect(JSON.stringify(admission)).not.toContain('token-v7')
    expect({ ...admission }).not.toHaveProperty('accessToken')
  })

  it('authorizes again for every endpoint fallback and every 401 retry', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    const seen: { token: string; project: string }[] = []
    const dispatch = async (admission: VaultSendAdmission) => {
      seen.push({ token: admission.accessToken, project: admission.projectId })
      return response(seen.length === 1 ? 401 : 200)
    }
    // First request: 401, the vault rotated to version 2, retry succeeds.
    h.receipts.push(receipt(1), receipt(2))
    expect((await src.send(ref, dispatch, { site: 'model' })).status).toBe(200)
    // Endpoint fallback: a second request gets a third, fresh receipt.
    h.receipts.push(receipt(3))
    expect((await src.send(ref, dispatch, { site: 'model' })).status).toBe(200)
    expect(h.authorized).toEqual([ROUTE, ROUTE, ROUTE])
    expect(seen).toEqual([
      { token: 'token-v1', project: 'project-v1' },
      { token: 'token-v2', project: 'project-v2' },
      { token: 'token-v3', project: 'project-v3' },
    ])
    expect(h.reports).toEqual([])
  })

  it('refuses a receipt for another asserted account before dispatch', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    let dispatched = 0
    h.receipts.push(
      receipt(1, {
        assertedAccountIdentity: 'account-b',
        accountIdentity: 'account-b',
      }),
    )
    await expect(
      src.send(ref, async () => response(200 + dispatched++), {
        site: 'model',
      }),
    ).rejects.toMatchObject({ kind: 'identity-contradicted' })
    h.receipts.push(receipt(1, { assertedCredentialId: 'cred-other' }))
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'identity-contradicted',
    })
    expect(dispatched).toBe(0)
  })

  it('refuses a receipt whose identity the vault did not assert', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(
      receipt(1, {
        accountIdentitySource: 'expected',
        assertedAccountIdentity: undefined,
      }),
    )
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'identity-unasserted',
    })
  })

  it('refuses a receipt with no served project instead of using any other', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(1, { projectId: undefined }))
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'project-missing',
    })
    h.receipts.push(receipt(1, { projectId: '  ' }))
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'project-missing',
    })
  })

  it('refuses an API-key credential', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(1, { credentialType: 'api_key' }))
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'api-key-refused',
    })
  })
})

describe('served 401 reporting', () => {
  it('reports a 401 with the exact receipt when the vault has not rotated', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    const served = receipt(4)
    h.receipts.push(served, receipt(4))
    let calls = 0
    const result = await src.send(
      ref,
      async () => {
        calls++
        return response(401)
      },
      { site: 'model' },
    )
    expect(result.status).toBe(401)
    expect(calls).toBe(1)
    const report = only(h.reports)
    expect(report.attempt).toBe(served)
    expect(report.status).toBe(401)
    expect(report.source).toBe('direct')
  })

  it('reports a retried 401 against the newer receipt only', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    const newer = receipt(9)
    h.receipts.push(receipt(8), newer)
    await src.send(ref, async () => response(401), {
      site: 'quota',
      reporterSource: 'relay_status_field',
    })
    const report = only(h.reports)
    expect(report.attempt).toBe(newer)
    expect(report.attempt.recordVersion).toBe(9)
    expect(report.source).toBe('relay_status_field')
  })

  it('never reports other statuses as authentication failures', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    for (const status of [403, 429, 500]) {
      h.receipts.push(receipt(1))
      expect(
        (await src.send(ref, async () => response(status), { site: 'model' }))
          .status,
      ).toBe(status)
    }
    h.receipts.push(receipt(1))
    const admission = await src.admit(ref)
    expect(await src.reportServedStatus(admission, 403)).toBe(false)
    expect(h.reports).toEqual([])
    expect(h.authorized).toHaveLength(4)
  })

  it('reports an admission at most once and refuses admissions it did not issue', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(2))
    const admission = await src.admit(ref)
    expect(await src.reportServedStatus(admission, 401)).toBe(true)
    expect(await src.reportServedStatus(admission, 401)).toBe(false)
    expect(h.reports).toHaveLength(1)
    const forged = { ...admission, accessToken: 'x' } as VaultSendAdmission
    await expect(src.reportServedStatus(forged, 401)).rejects.toMatchObject({
      kind: 'not-issued',
    })
  })
})

describe('custody, host slot and decline fencing', () => {
  it('refuses before authorizing when custody is off or the host slot holds a login', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    custodyActive = false
    await expect(src.admit(ref)).rejects.toMatchObject({ kind: 'not-active' })
    custodyActive = true
    hostSlot = 'real-login'
    await expect(src.admit(ref)).rejects.toThrow('host-slot-login')
    expect(h.authorized).toEqual([])
    expect(h.hostSlotChecks.at(-1)).toEqual({
      mode: 'custody',
      auth: 'real-login',
      provider: 'google-antigravity',
    })
  })

  it('refuses a ref whose route was declined or rebound after selection', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.roster = roster([row()], [{ credentialId: CREDENTIAL }])
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    h.roster = roster([row({ accountIdentity: 'account-b' })])
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    h.roster = roster([])
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    expect(h.authorized).toEqual([])
  })

  it('passes decline and accept to the library and refuses everything after close', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    await src.decline(ref)
    await src.accept(ref)
    expect(h.declined).toEqual([ROUTE])
    expect(h.accepted).toEqual([ROUTE])
    src.close()
    src.close()
    expect(h.closed).toBe(1)
    expect(src.routes()).toEqual([])
    await expect(src.admit(ref)).rejects.toBeInstanceOf(
      AntigravityVaultSourceError,
    )
  })
})

describe('provider-state commits through the source', () => {
  it('writes credential-free state attributed to the served receipt', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(5), receipt(5))
    const admission = await src.admit(ref)
    const result = await src.commitState(src.attribution(admission), () => ({
      metadata: { addedAt: 1, lastUsed: 2, label: 'Main' },
    }))
    expect(result.status).toBe('written')
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(text).not.toContain('token-v5')
    expect(text).not.toContain('project-v5')
    expect(JSON.parse(text).accounts[ACCOUNT].observed).toEqual({
      routeId: ROUTE,
      credentialId: CREDENTIAL,
      recordVersion: 5,
    })
  })

  it('refuses a commit once the vault serves another record version', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(5), receipt(6))
    const admission = await src.admit(ref)
    let updates = 0
    await expect(
      src.commitState(src.attribution(admission), () => {
        updates++
        return { metadata: { addedAt: 1, lastUsed: 2 } }
      }),
    ).rejects.toMatchObject({ kind: 'state-unavailable' })
    expect(updates).toBe(0)
    await expect(readFile(join(dir, 'state.json'), 'utf8')).rejects.toThrow()
  })

  it('refuses a commit whose fresh vault check asserts another account', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(
      receipt(5),
      receipt(5, {
        assertedAccountIdentity: 'account-b',
        accountIdentity: 'account-b',
      }),
    )
    const admission = await src.admit(ref)
    await expect(
      src.commitState(src.attribution(admission), () => ({
        metadata: { addedAt: 1, lastUsed: 2 },
      })),
    ).rejects.toMatchObject({ kind: 'identity-contradicted' })
  })

  it('refuses a commit while the host slot holds a login', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(5), receipt(5))
    const admission = await src.admit(ref)
    hostSlot = 'real-login'
    await expect(
      src.commitState(src.attribution(admission), () => ({
        metadata: { addedAt: 1, lastUsed: 2 },
      })),
    ).rejects.toThrow('host-slot-login')
    expect(h.authorized).toHaveLength(1)
  })
})

describe('cancellation', () => {
  it('cancels the 401 body before retrying and passes the caller signal to the vault', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    h.receipts.push(receipt(1), receipt(2))
    let cancelled = false
    const first = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 401 },
    )
    const controller = new AbortController()
    let calls = 0
    const result = await src.send(
      ref,
      async () => (calls++ === 0 ? first : response(200)),
      { site: 'model', signal: controller.signal },
    )
    expect(result.status).toBe(200)
    expect(cancelled).toBe(true)
    expect(h.signals).toEqual([controller.signal, controller.signal])
  })

  it('does not retry an aborted send and still reports the served 401', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    const served = receipt(1)
    h.receipts.push(served, receipt(2))
    const controller = new AbortController()
    const result = await src.send(
      ref,
      async () => {
        controller.abort()
        return response(401)
      },
      { site: 'model', signal: controller.signal },
    )
    expect(result.status).toBe(401)
    expect(h.authorized).toHaveLength(1)
    expect(only(h.reports).attempt).toBe(served)
  })

  it('refuses an already aborted admission before asking the vault', async () => {
    const h = harness()
    const src = source(h)
    const [ref] = src.routes()
    if (!ref) throw new Error('no route')
    const controller = new AbortController()
    controller.abort(new Error('caller gave up'))
    await expect(src.admit(ref, controller.signal)).rejects.toThrow(
      'caller gave up',
    )
    expect(h.authorized).toEqual([])
  })
})

describe('genuine public common-auth modules', () => {
  it('binds the real ./claustrum and ./fs modules and fences the host slot before connecting', async () => {
    const claustrum = await loadCommonAuthClaustrum()
    const port: VaultClaustrumPort = claustrum
    const stateFs: AntigravityVaultStateFs = await loadCommonAuthFs()
    let connects = 0
    const src = createAntigravityVaultAccountSource({
      claustrum: port,
      host: 'opencode',
      hostProvider: 'google',
      rosterPath: join(dir, 'roster.json'),
      tokenPath: join(dir, 'token.json'),
      connect: () => {
        connects++
        return Promise.reject(new Error('no vault in tests'))
      },
      isCustodyActive: () => custodyActive,
      readHostSlot: () => hostSlot,
      reporterSource: 'direct',
      state: { path: join(dir, 'state.json'), fs: stateFs },
    })
    expect(src.routes()).toEqual([])
    const ref = {
      routeId: ROUTE,
      credentialId: CREDENTIAL,
      accountIdentity: ACCOUNT,
      label: 'A',
    }
    hostSlot = { type: 'oauth', access: 'a', refresh: 'host-login', expires: 1 }
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'host-slot-login',
    })
    hostSlot = claustrum.custodyPlaceholder('google')
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    expect(connects).toBe(0)
    src.close()
    await expect(src.admit(ref)).rejects.toMatchObject({ kind: 'closed' })
  })
})

// ---------------------------------------------------------------------------
// The real public consumer, custody, roster and locks, with only the vault
// transport replaced by a local client that serves controlled receipts.
// ---------------------------------------------------------------------------

type ScopedInventory = Awaited<ReturnType<VaultScopedClient['listScoped']>>
type ScopedRow = ScopedInventory['rows'][number]
type ServedCredential = Awaited<ReturnType<VaultScopedClient['getScoped']>>
type GetScopedInput = Parameters<VaultScopedClient['getScoped']>[0]
type ReportInput = Parameters<VaultScopedClient['reportAuthFailureScoped']>[0]

const ENROLLMENT_TOKEN = 'ab'.repeat(32)
const SILENT = { warn() {}, debug() {} }

interface LocalVault {
  rows: ScopedRow[]
  served: ServedCredential[]
  gets: GetScopedInput[]
  reports: ReportInput[]
  listTokens: (string | undefined)[]
  closed: number
  /** When set, `getScoped` waits for it before answering. */
  hold?: Promise<void>
}

function vaultRow(overrides: Partial<ScopedRow> = {}): ScopedRow {
  return {
    id: CREDENTIAL,
    categories: ['antigravity-native'],
    credentialType: 'oauth',
    serves: [],
    providerIds: [],
    refreshAdapter: 'antigravity',
    state: 'active',
    recordVersion: 1,
    operations: ['read'],
    createdAtMs: null,
    accountId: ACCOUNT,
    ...overrides,
  }
}

function servedCredential(
  version: number,
  overrides: Partial<ServedCredential> = {},
): ServedCredential {
  return {
    material: `test-access-v${version}`,
    recordVersion: version,
    expiresAtMs: Date.now() + 3_600_000,
    credentialId: CREDENTIAL,
    projectId: `test-project-v${version}`,
    accountId: ACCOUNT,
    ...overrides,
  }
}

function localVault(rows: ScopedRow[] = [vaultRow()]): LocalVault {
  return {
    rows,
    served: [],
    gets: [],
    reports: [],
    listTokens: [],
    closed: 0,
  }
}

async function realSource(vault: LocalVault) {
  const claustrum = await loadCommonAuthClaustrum()
  const fs = await loadCommonAuthFs()
  const tokenPath = join(dir, 'enrollment-token.json')
  await writeFile(
    tokenPath,
    JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
    { mode: 0o600 },
  )
  const client: VaultScopedClient = {
    async listScoped(enrollmentToken) {
      vault.listTokens.push(enrollmentToken)
      return {
        view: JSON.stringify(
          vault.rows.map((entry) => [entry.id, entry.state, entry.accountId]),
        ),
        rows: vault.rows,
      }
    },
    async getScoped(input) {
      vault.gets.push(input)
      if (vault.hold) await vault.hold
      const next = vault.served.shift()
      if (!next) throw new Error('no served credential queued')
      return next
    },
    async reportAuthFailureScoped(input) {
      vault.reports.push(input)
    },
    close() {
      vault.closed++
    },
  }
  hostSlot = claustrum.custodyPlaceholder('google-antigravity')
  const rosterPath = join(dir, 'roster.json')
  const src = createAntigravityVaultAccountSource({
    claustrum,
    host: 'pi',
    hostProvider: 'google-antigravity',
    rosterPath,
    tokenPath,
    connect: async () => client,
    isCustodyActive: () => custodyActive,
    readHostSlot: () => hostSlot,
    reporterSource: 'direct',
    state: { path: join(dir, 'state.json'), fs },
    logger: SILENT,
    onError: (error) => errors.push(error),
  })
  await src.refresh()
  const [ref] = src.routes()
  if (!ref) throw new Error('the real roster produced no route')
  return { src, ref, claustrum, rosterPath }
}

describe('real public consumer with a local vault transport', () => {
  it('routes only the Antigravity OAuth record and never an API key', async () => {
    const vault = localVault([
      vaultRow(),
      vaultRow({
        id: 'key-1',
        credentialType: 'api_key',
        refreshAdapter: undefined,
        accountId: 'account-k',
      }),
      vaultRow({ id: 'other-1', refreshAdapter: 'anthropic', accountId: 'x' }),
    ])
    const { src, ref } = await realSource(vault)
    expect(src.routes()).toHaveLength(1)
    expect(ref.credentialId).toBe(CREDENTIAL)
    expect(ref.accountIdentity).toBe(ACCOUNT)
    expect(ref.routeId.startsWith('vault:')).toBe(true)
    expect(vault.listTokens).toEqual([ENROLLMENT_TOKEN])
    src.close()
    expect(vault.closed).toBe(1)
  })

  it('serves every physical send from its own fresh receipt', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.served.push(
      servedCredential(1),
      servedCredential(2),
      servedCredential(3),
    )
    const seen: string[] = []
    let calls = 0
    const dispatch = async (admission: VaultSendAdmission) => {
      seen.push(
        `${admission.accessToken}|${admission.projectId}|${admission.recordVersion}`,
      )
      return response(calls++ === 0 ? 401 : 200)
    }
    expect((await src.send(ref, dispatch, { site: 'model' })).status).toBe(200)
    expect((await src.send(ref, dispatch, { site: 'model' })).status).toBe(200)
    expect(seen).toEqual([
      'test-access-v1|test-project-v1|1',
      'test-access-v2|test-project-v2|2',
      'test-access-v3|test-project-v3|3',
    ])
    expect(vault.gets).toHaveLength(3)
    for (const input of vault.gets)
      expect(input).toEqual({
        credentialId: CREDENTIAL,
        enrollmentToken: ENROLLMENT_TOKEN,
        minTtlMs: 300_000,
      })
    expect(vault.reports).toEqual([])
  })

  it('reports a served 401 with the exact record version that send used', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.served.push(servedCredential(5), servedCredential(5))
    let calls = 0
    const result = await src.send(
      ref,
      async () => {
        calls++
        return response(401)
      },
      { site: 'model' },
    )
    expect(result.status).toBe(401)
    expect(calls).toBe(1)
    expect(vault.reports).toEqual([
      {
        credentialId: CREDENTIAL,
        enrollmentToken: ENROLLMENT_TOKEN,
        providerStatus: 401,
        recordVersion: 5,
        reporterSource: 'direct',
      },
    ])
  })

  it('keeps a stale admission’s 401 on its own version and reports nothing else', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.served.push(servedCredential(1), servedCredential(2))
    const stale = await src.admit(ref)
    const fresh = await src.admit(ref)
    expect(await src.reportServedStatus(fresh, 403)).toBe(false)
    expect(await src.reportServedStatus(fresh, 500)).toBe(false)
    expect(await src.reportServedStatus(stale, 401)).toBe(true)
    expect(await src.reportServedStatus(stale, 401)).toBe(false)
    expect(vault.reports.map((report) => report.recordVersion)).toEqual([1])
  })

  it('refuses a served credential that asserts another account or no account', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    let dispatched = 0
    const dispatch = async () => {
      dispatched++
      return response(200)
    }
    vault.served.push(servedCredential(1, { accountId: 'account-b' }))
    await expect(
      src.send(ref, dispatch, { site: 'model' }),
    ).rejects.toMatchObject({ kind: 'identity-changed' })
    vault.served.push(servedCredential(1, { accountId: undefined }))
    await expect(
      src.send(ref, dispatch, { site: 'model' }),
    ).rejects.toMatchObject({ kind: 'identity-unasserted' })
    vault.served.push(servedCredential(1, { credentialId: undefined }))
    await expect(
      src.send(ref, dispatch, { site: 'model' }),
    ).rejects.toMatchObject({ kind: 'identity-unasserted' })
    vault.served.push(servedCredential(1, { projectId: undefined }))
    await expect(
      src.send(ref, dispatch, { site: 'model' }),
    ).rejects.toMatchObject({ kind: 'project-missing' })
    expect(dispatched).toBe(0)
  })

  it('refuses before fetching a credential once another process declines the account', async () => {
    const vault = localVault()
    const { src, ref, claustrum, rosterPath } = await realSource(vault)
    await claustrum.declineVaultRoute(rosterPath, ref.routeId)
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-declined',
    })
    await src.accept(ref)
    vault.served.push(servedCredential(1))
    expect((await src.admit(ref)).recordVersion).toBe(1)
    await src.decline(ref)
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    expect(vault.gets).toHaveLength(1)
  })

  it('stops routing an account the vault no longer names or that moved to another account', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.rows = [vaultRow({ accountId: undefined })]
    await src.refresh()
    expect(src.routes()).toEqual([])
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    vault.rows = [vaultRow({ accountId: 'account-b' })]
    await src.refresh()
    const [moved] = src.routes()
    expect(moved?.accountIdentity).toBe('account-b')
    expect(moved?.routeId).not.toBe(ref.routeId)
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'route-unavailable',
    })
    expect(vault.gets).toEqual([])
  })

  it('refuses before fetching a credential while the host slot holds a login', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    hostSlot = { type: 'oauth', access: 'a', refresh: 'host-login', expires: 1 }
    await expect(src.admit(ref)).rejects.toMatchObject({
      kind: 'host-slot-login',
    })
    expect(vault.gets).toEqual([])
  })

  it('abandons a credential fetch when the caller aborts and never dispatches', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    let release = () => {}
    vault.hold = new Promise((resolve) => {
      release = resolve
    })
    vault.served.push(servedCredential(1))
    const controller = new AbortController()
    let dispatched = 0
    const pending = src.send(
      ref,
      async () => {
        dispatched++
        return response(200)
      },
      { site: 'model', signal: controller.signal },
    )
    while (vault.gets.length === 0) await new Promise((r) => setTimeout(r, 1))
    controller.abort(new Error('caller gave up'))
    await expect(pending).rejects.toThrow('caller gave up')
    release()
    expect(dispatched).toBe(0)
  })

  it('commits provider state only while the vault still serves the attributed version', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.served.push(servedCredential(3), servedCredential(3))
    const admission = await src.admit(ref)
    const attribution = src.attribution(admission)
    const written = await src.commitState(attribution, () => ({
      metadata: { addedAt: 1, lastUsed: 2, label: 'Real' },
    }))
    expect(written.status).toBe('written')
    const text = await readFile(join(dir, 'state.json'), 'utf8')
    expect(text).not.toContain('test-access')
    expect(text).not.toContain('test-project')
    vault.served.push(servedCredential(4))
    await expect(
      src.commitState(attribution, () => ({
        metadata: { addedAt: 1, lastUsed: 9 },
      })),
    ).rejects.toMatchObject({ kind: 'state-unavailable' })
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(text)
    expect(vault.gets).toHaveLength(3)
  })

  it('refuses attributions with a boolean, string or fractional version or extra fields', async () => {
    const vault = localVault()
    const { src, ref } = await realSource(vault)
    vault.served.push(servedCredential(3))
    const attribution = src.attribution(await src.admit(ref))
    const bad: unknown[] = [
      { ...attribution, recordVersion: true },
      { ...attribution, recordVersion: '3' },
      { ...attribution, recordVersion: 3.5 },
      { ...attribution, recordVersion: -1 },
      { ...attribution, projectId: 'test-project-v3' },
      Object.create(attribution),
    ]
    for (const value of bad)
      await expect(
        src.commitState(value as typeof attribution, () => ({
          metadata: { addedAt: 1, lastUsed: 2 },
        })),
      ).rejects.toMatchObject({ kind: 'invalid-attribution' })
    expect(vault.gets).toHaveLength(1)
  })
})
