/**
 * GA location services. Account state and dialog commands run against a
 * small in-memory repository that keeps exact row refs (id, credential
 * epoch, identity) the way the real one does; the credential refresh runs
 * against a genuine repository on the public store in a disposable
 * directory, with a deterministic token exchange. No network or host.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountManager,
  AccountRepositoryError,
  type AccountRepositoryRead,
  type AccountRow,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  type RowRef,
  readAccountStoreAdmission,
  sameRowRef,
} from '@cortexkit/antigravity-auth-core'

import type { HarnessAccountsObservation } from '../ga/server/index.ts'
import {
  accessBlockOf,
  authorizeGaQuotaCheck,
  createGaAccountStateSource,
  createGaFetchAccountQuota,
  createGaJobExecutor,
  createGaLocalCredentials,
  createGaLocationServices,
  createGaMenuCommandService,
  createGaRouteBook,
  createGaSelectorRegistry,
  createGaVaultCredentials,
  GA_ACCOUNTS_FILE,
  gaSettingsOf,
} from './ga-location-services.ts'
import {
  createOperatorSettingsRegistry,
  emptyOperatorSettings,
  type OperatorSettings,
} from './operator-settings.ts'
import { createLocationRuntime } from './shared/runtime.ts'

function row(ref: RowRef, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    ref,
    index: 0,
    enabled: true,
    usable: true,
    stamp: 'bound',
    metadata: { status: 'present', metadata: { addedAt: 1, lastUsed: 1 } },
    quota: { status: 'absent' },
    ...overrides,
  }
}

class MemoryRepository {
  rows: AccountRow[]
  routing: Extract<AccountRepositoryRead, { status: 'ready' }>['routing']
  status: AccountRepositoryRead['status'] = 'ready'
  writes: string[] = []
  reads = 0
  readGate: Promise<void> | null = null

  constructor(rows: AccountRow[]) {
    this.rows = rows
  }

  async read(): Promise<AccountRepositoryRead> {
    this.reads += 1
    if (this.readGate) await this.readGate
    if (this.status === 'pending-migration')
      return { status: 'pending-migration' }
    return {
      status: 'ready',
      rows: this.rows.map((entry, index) => ({ ...entry, index })),
      ...(this.routing ? { routing: this.routing } : {}),
    }
  }

  private holding(ref: RowRef): AccountRow {
    const found = this.rows.find((entry) => sameRowRef(entry.ref, ref))
    if (!found)
      throw new AccountRepositoryError({
        operation: 'setEnabled',
        kind: 'attribution',
        retryable: false,
        ambiguous: false,
        message: 'changed',
      })
    return found
  }

  async setEnabled(ref: RowRef, input: { enabled: boolean }) {
    const target = this.holding(ref)
    target.enabled = input.enabled
    this.writes.push(`${input.enabled ? 'enable' : 'disable'}:${ref.id}`)
    return { ref }
  }

  async remove(ref: RowRef) {
    this.holding(ref)
    this.rows = this.rows.filter((entry) => !sameRowRef(entry.ref, ref))
    this.writes.push(`remove:${ref.id}`)
  }

  async selectAccount(target: string, ref: RowRef | null) {
    if (ref) this.holding(ref)
    this.writes.push(`select:${target}:${ref?.id ?? 'none'}`)
  }
}

const A: RowRef = { id: 'row-a', credentialEpoch: 1, identity: 'a@example' }
const B: RowRef = { id: 'row-b', credentialEpoch: 1 }

const settingsDto = () => gaSettingsOf(emptyOperatorSettings(), dumpOff)
const dumpOff = { isEnabled: () => false }
const status = () => ({
  checkedAt: null,
  quotaBackoffUntil: null,
  routingAuthoritative: true,
})

function stateSource(
  repository: MemoryRepository,
  registry = createGaSelectorRegistry(),
  observed: HarnessAccountsObservation[] = [],
) {
  return createGaAccountStateSource({
    repository,
    registry,
    generation: 'g-test',
    settings: settingsDto,
    status,
    route: () => null,
    observe: (observation) => {
      observed.push(observation)
      return undefined
    },
  })
}

const sessionless = { kind: 'sessionless' } as const

async function selectorsOf(
  source: ReturnType<typeof stateSource>,
): Promise<[string, string, ...string[]]> {
  const read = await source.read({
    scope: sessionless,
    signal: new AbortController().signal,
  })
  if (read.accounts.kind !== 'complete') throw new Error('over limit')
  const selectors = read.accounts.rows.map((entry) => entry.selector)
  // Callers destructure the first two; a shorter roster pads with ''.
  return [selectors[0] ?? '', selectors[1] ?? '', ...selectors.slice(2)]
}

describe('GA account state', () => {
  it('keeps a selector for the same credential and retires it when the epoch changes', async () => {
    const repository = new MemoryRepository([row(A), row(B)])
    const observed: HarnessAccountsObservation[] = []
    const source = stateSource(repository, undefined, observed)
    const [a1, b1] = await selectorsOf(source)
    const [a2, b2] = await selectorsOf(source)
    expect(a2).toBe(a1)
    expect(b2).toBe(b1)

    const replaced = { ...A, credentialEpoch: 2 }
    repository.rows = [row(replaced), row(B)]
    const [a3, b3] = await selectorsOf(source)
    expect(a3).not.toBe(a1)
    expect(b3).toBe(b1)
    expect(observed.at(-1)?.retiredSelectors).toEqual([a1])
    expect(observed.map((entry) => entry.readSeq)).toEqual([1, 2, 3])
  })

  it('keeps selectors across a reorder and never exposes row data', async () => {
    const repository = new MemoryRepository([row(A), row(B)])
    const source = stateSource(repository)
    const [a1, b1] = await selectorsOf(source)
    repository.rows = [row(B), row(A)]
    const read = await source.read({
      scope: sessionless,
      signal: new AbortController().signal,
    })
    if (read.accounts.kind !== 'complete') throw new Error('over limit')
    expect(read.accounts.rows.map((entry) => entry.selector)).toEqual([b1, a1])
    // The RPC contract's selector shape.
    for (const selector of [a1, b1]) expect(selector).toMatch(/^sel-[\w-]{32}$/)
    const text = JSON.stringify(read)
    expect(text).not.toContain('row-a')
    expect(text).not.toContain('a@example')
  })

  it('leaves the registry unchanged when a read is aborted', async () => {
    const repository = new MemoryRepository([row(A)])
    const registry = createGaSelectorRegistry()
    const observed: HarnessAccountsObservation[] = []
    const source = stateSource(repository, registry, observed)
    let release: () => void = () => undefined
    repository.readGate = new Promise((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const pending = source.read({
      scope: sessionless,
      signal: controller.signal,
    })
    controller.abort(new Error('client gave up'))
    release()
    await expect(pending).rejects.toThrow('client gave up')
    repository.readGate = null
    const [selector] = await selectorsOf(source)
    expect(selector).not.toBe('')
    expect(registry.resolve(selector).kind).toBe('live')
    // The aborted read built no answer: the first answer is readSeq 1.
    expect(observed.map((entry) => entry.readSeq)).toEqual([1])
  })

  it('reports an over-limit roster without issuing selectors', async () => {
    const rows = Array.from({ length: 65 }, (_, index) =>
      row({ id: `row-${index}`, credentialEpoch: 1 }),
    )
    const source = stateSource(new MemoryRepository(rows))
    const read = await source.read({
      scope: sessionless,
      signal: new AbortController().signal,
    })
    expect(read.accounts).toEqual({ kind: 'over-limit', count: 65 })
  })

  it('reads settings fresh for every answer', async () => {
    let settings: OperatorSettings = emptyOperatorSettings()
    const source = createGaAccountStateSource({
      repository: new MemoryRepository([]),
      registry: createGaSelectorRegistry(),
      generation: 'g-test',
      settings: () => gaSettingsOf(settings, dumpOff),
      status,
      route: () => null,
    })
    const signal = new AbortController().signal
    const first = await source.read({ scope: sessionless, signal })
    settings = { ...settings, log_level: 'debug' }
    const second = await source.read({ scope: sessionless, signal })
    expect(first.settings.logLevel).toBe('info')
    expect(second.settings.logLevel).toBe('debug')
  })

  it('reports an unknown access block when metadata was dropped', () => {
    expect(
      accessBlockOf(
        row(A, { metadata: { status: 'dropped', reason: 'invalid' } }),
      ),
    ).toEqual({ kind: 'unknown' })
    expect(accessBlockOf(row(A))).toEqual({ kind: 'none' })
  })
})

describe('GA menu command service', () => {
  it('runs each request through the menu with an invocation for its scope', async () => {
    const calls: unknown[] = []
    const notices: unknown[] = []
    const service = createGaMenuCommandService({
      menu: {
        command: 'antigravity',
        open: async () => {
          throw new Error('not used')
        },
        apply: async (request, invocation) => {
          calls.push({ request, sessionId: invocation.sessionId })
          invocation.notify('Routing updated')
          return {
            command: 'antigravity',
            ok: true,
            text: 'done',
            menu: {
              command: 'antigravity',
              title: 'Antigravity',
              sections: [],
            },
          }
        },
      },
      notify: (scope, payload) => {
        notices.push({ scope, payload })
        return 1
      },
    })
    const request = {
      command: 'antigravity',
      sectionId: 'routing',
      actionId: 'set',
    }
    const scope = { kind: 'session', sessionID: 'ses-1' } as const
    const result = await service.apply({
      request,
      scope,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ request, sessionId: 'ses-1' }])
    expect(notices).toEqual([
      {
        scope,
        payload: {
          command: 'antigravity',
          notify: { message: 'Routing updated', kind: 'info' },
        },
      },
    ])

    const aborted = new AbortController()
    aborted.abort(new Error('disposed'))
    await expect(
      service.apply({ request, scope, signal: aborted.signal }),
    ).rejects.toThrow('disposed')
    expect(calls).toHaveLength(1)
  })
})

describe('GA request pipeline pieces', () => {
  it('keeps each session route in memory and shows it only to that session', () => {
    const routes = createGaRouteBook()
    routes.record('session-a', {
      accountId: 'acct-0',
      modelFamily: 'claude',
      headerStyle: 'antigravity',
      updatedAt: 7,
    })
    expect(routes.route({ kind: 'session', sessionID: 'session-a' })).toEqual({
      accountId: 'acct-0',
      modelFamily: 'claude',
      headerStyle: 'antigravity',
      updatedAt: 7,
    })
    expect(routes.route({ kind: 'session', sessionID: 'session-b' })).toBeNull()
    expect(routes.route({ kind: 'sessionless' })).toBeNull()
  })

  it('hands a bridged job to the engine with its body, signal and session', async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const execute = createGaJobExecutor({
      execute: async (input, init, options) => {
        calls.push({ input, init, options })
        return new Response('ok')
      },
    })
    await execute(
      {
        sessionID: 'session-a',
        parentSessionID: null,
        kind: 'primary',
        modelID: 'gemini-3-pro',
        variant: null,
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent',
        body: '{"contents":[]}',
      },
      { signal: controller.signal, send: async () => new Response('unused') },
    )
    expect(calls).toEqual([
      {
        input:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"contents":[]}',
          signal: controller.signal,
        },
        options: {
          session: { sessionId: 'session-a', parentSessionId: null },
        },
      },
    ])
  })

  it('refreshes through the genuine repository and stores the successor there', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-credentials-')))
    try {
      const legacyPath = join(root, 'antigravity-accounts.json')
      const modules = await loadCommonAuthStoreModules()
      await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
      const admission = await readAccountStoreAdmission(
        legacyPath,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const exchanged: string[] = []
      const repository = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async ({ refreshToken }) => {
          exchanged.push(refreshToken)
          return {
            accessToken: 'access-new',
            refreshToken: 'refresh-successor',
            expiresAt: Date.now() + 3_600_000,
          }
        },
      })
      try {
        await repository.login({
          id: crypto.randomUUID(),
          refreshToken: 'refresh-original',
          metadata: { addedAt: 1, lastUsed: 1, projectId: 'project-1' },
        })
        await repository.login({
          id: crypto.randomUUID(),
          refreshToken: 'refresh-other',
          metadata: { addedAt: 2, lastUsed: 2, projectId: 'project-2' },
        })
        const manager = AccountManager.fromRepository(await repository.read(), {
          repository,
        })
        const credentials = createGaLocalCredentials(manager, {
          overrides: {},
        })
        const [first, second] = manager.getAccounts()
        if (!first || !second) throw new Error('missing accounts')
        const refreshed = await credentials.refresh(second)
        // The selected account itself is refreshed; no row is looked up again
        // by token.
        expect(exchanged).toEqual(['refresh-other'])
        expect(refreshed?.access).toBe('access-new')
        expect(refreshed?.refresh).toBe('refresh-successor|project-2')
        const read = await repository.read()
        if (read.status !== 'ready') throw new Error(read.status)
        expect(read.rows.map((row) => row.credential?.refreshToken)).toEqual([
          'refresh-original',
          'refresh-successor',
        ])
        expect(first.parts.refreshToken).toBe('refresh-original')
      } finally {
        await repository.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('GA quota check authorization', () => {
  async function freshRepository() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-quota-')))
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
    const admission = await readAccountStoreAdmission(
      legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const exchanged: string[] = []
    const repository = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async ({ refreshToken }) => {
        exchanged.push(refreshToken)
        return {
          accessToken: 'access-fresh',
          refreshToken,
          expiresAt: Date.now() + 3_600_000,
        }
      },
    })
    const { ref } = await repository.login({
      id: crypto.randomUUID(),
      refreshToken: 'refresh-quota',
      metadata: { addedAt: 1, lastUsed: 1, projectId: 'project-q' },
    })
    return {
      repository,
      ref,
      exchanged,
      cleanup: async () => {
        await repository.dispose()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  it('refuses a target without a captured ref', async () => {
    const { repository, exchanged, cleanup } = await freshRepository()
    try {
      expect(await authorizeGaQuotaCheck(repository, {}, Date.now)).toEqual({
        status: 'refused',
        reason: 'unattributed',
      })
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refreshes the captured credential through the repository', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      const result = await authorizeGaQuotaCheck(
        repository,
        { rowRef: ref },
        Date.now,
      )
      expect(result).toMatchObject({
        status: 'authorized',
        auth: { access: 'access-fresh', refresh: 'refresh-quota|project-q' },
      })
      expect(exchanged).toEqual(['refresh-quota'])
      // A second check reuses the stored, unexpired token.
      await authorizeGaQuotaCheck(repository, { rowRef: ref }, Date.now)
      expect(exchanged).toEqual(['refresh-quota'])
    } finally {
      await cleanup()
    }
  })

  it('fetches quota with the bearer of the manager target it was handed', async () => {
    const { repository, exchanged, cleanup } = await freshRepository()
    try {
      const manager = AccountManager.fromRepository(await repository.read(), {
        repository,
      })
      const calls: { url: string; authorization: string | null }[] = []
      const fetchQuota = createGaFetchAccountQuota({
        repository,
        now: Date.now,
        logger: { debug: () => undefined },
        overrides: {
          ensureProjectContext: async (auth) => ({
            auth,
            effectiveProjectId: 'project-q',
          }),
          quotaFetch: async (url, init) => {
            calls.push({
              url,
              authorization: new Headers(init.headers).get('authorization'),
            })
            return new Response(
              url.includes('retrieveUserQuotaSummary')
                ? '{"groups":[]}'
                : '{"buckets":[]}',
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          },
        },
      })
      const [target] = manager.getAccountsForQuotaCheck()
      if (!target) throw new Error('missing target')
      const result = await fetchQuota(target, new AbortController().signal)
      expect(result.status).toBe('ok')
      expect(exchanged).toEqual(['refresh-quota'])
      expect(calls.length).toBeGreaterThan(0)
      expect(
        calls.every((call) => call.authorization === 'Bearer access-fresh'),
      ).toBe(true)

      const { rowRef: _dropped, ...unattributed } = target
      const refused = await fetchQuota(
        unattributed,
        new AbortController().signal,
      )
      expect(refused).toMatchObject({
        status: 'error',
        error: 'quota check refused (unattributed)',
      })
    } finally {
      await cleanup()
    }
  })

  it('never checks a stale target on its successor, even with the same token and position', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      const manager = AccountManager.fromRepository(await repository.read(), {
        repository,
      })
      const [target] = manager.getAccountsForQuotaCheck()
      if (!target) throw new Error('missing target')
      // Same position, same refresh token; only the credential epoch moved on.
      await repository.replaceCredential(ref, {
        refreshToken: 'refresh-quota',
        disabled: 'keep',
      })
      const requests: string[] = []
      const fetchQuota = createGaFetchAccountQuota({
        repository,
        now: Date.now,
        logger: { debug: () => undefined },
        overrides: {
          quotaFetch: async (url) => {
            requests.push(url)
            return new Response('{}')
          },
        },
      })
      expect(
        await fetchQuota(target, new AbortController().signal),
      ).toMatchObject({
        status: 'error',
        error: 'quota check refused (stale)',
      })
      expect(requests).toEqual([])
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses a target whose credential was replaced, never checking its successor', async () => {
    const { repository, ref, exchanged, cleanup } = await freshRepository()
    try {
      await repository.replaceCredential(ref, {
        refreshToken: 'refresh-replacement',
        disabled: 'keep',
      })
      expect(
        await authorizeGaQuotaCheck(repository, { rowRef: ref }, Date.now),
      ).toEqual({ status: 'refused', reason: 'stale' })
      expect(exchanged).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('GA vault credentials', () => {
  it('asks the source for a fresh receipt per send and reports 401 against that receipt', async () => {
    const route = {
      routeId: 'route-1',
      credentialId: 'credential-1',
      accountIdentity: 'identity-1',
      label: 'Work',
    }
    const issued: { recordVersion: number; accessToken: string }[] = []
    const reported: unknown[] = []
    const source = {
      admit: async (ref: typeof route, signal?: AbortSignal) => {
        expect(ref).toBe(route)
        expect(signal).toBeUndefined()
        const admission = {
          routeId: ref.routeId,
          credentialId: ref.credentialId,
          accountIdentity: ref.accountIdentity,
          recordVersion: issued.length + 1,
          projectId: `project-${issued.length + 1}`,
          accessToken: `token-${issued.length + 1}`,
          expiresAtMs: null,
        }
        issued.push(admission)
        return admission
      },
      reportServedStatus: async (admission: unknown, status: number) => {
        reported.push({ admission, status })
        return status === 401
      },
    }
    const credentials = createGaVaultCredentials(source)
    const account = { index: 0, rateLimitResetTimes: {}, route }
    const first = await credentials.admit({ account, signal: undefined })
    const second = await credentials.admit({ account, signal: undefined })
    expect([first.accessToken, second.accessToken]).toEqual([
      'token-1',
      'token-2',
    ])
    expect([first.projectId, second.projectId]).toEqual([
      'project-1',
      'project-2',
    ])
    expect(first.recordVersion).toBe(1)
    await first.report401(401)
    expect(reported).toEqual([{ admission: issued[0], status: 401 }])
  })
})

describe('createGaLocationServices (production factory)', () => {
  it('serves same-read state and exact-credential menu actions over a real store, then disposes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-factory-')))
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    }
    // Every user-level path the runtime derives lands under the test root.
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
    process.env.XDG_CONFIG_HOME = join(root, 'xdg')
    try {
      const directory = join(root, 'location')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(directory)
      const legacyPath = join(directory, GA_ACCOUNTS_FILE)
      const modules = await loadCommonAuthStoreModules()
      await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
      const admission = await readAccountStoreAdmission(
        legacyPath,
        modules,
        Date.now,
      )
      if (admission.status !== 'active') throw new Error(admission.status)
      const seed = createAccountRepositoryFactory(modules)({
        paths: admission.paths,
        now: Date.now,
        exchange: async () => {
          throw new Error('token exchange is not part of this test')
        },
      })
      for (const name of ['one', 'two']) {
        await seed.login({
          id: crypto.randomUUID(),
          refreshToken: `refresh-${name}`,
          metadata: { email: `${name}@example.com`, addedAt: 1, lastUsed: 1 },
        })
      }
      await seed.dispose()

      const observed: HarnessAccountsObservation[] = []
      const services = await createGaLocationServices({
        directory,
        overrides: {
          observeAccountSnapshot: (observation) => {
            observed.push(observation)
            return undefined
          },
        },
      })
      expect(Object.keys(services.runtime)).not.toContain('sidebarStateFile')
      const runtime = await createLocationRuntime({
        ...services.runtime,
        directory,
        operatorSettingsRegistry: createOperatorSettingsRegistry(),
      })
      try {
        const serving = await services.start({
          runtime,
          generation: 'g-test',
          send: async () => new Response('not used'),
          notify: () => null,
          isConnected: () => false,
        })
        const signal = new AbortController().signal
        const read = await serving.state.read({
          scope: { kind: 'sessionless' },
          signal,
        })
        if (read.accounts.kind !== 'complete') throw new Error('over limit')
        expect(read.accounts.rows).toHaveLength(2)
        expect(observed.map((entry) => entry.readSeq)).toEqual([read.readSeq])
        const text = JSON.stringify(read)
        expect(text).not.toContain('@example.com')
        expect(text).not.toContain('refresh-')

        // A client learns the menu's item ids from any apply answer; an
        // action the menu does not offer answers with the current menu.
        const scope = { kind: 'sessionless' } as const
        const probe = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'accounts',
            actionId: 'not-an-action',
          },
          scope,
          signal,
        })
        expect(probe).toMatchObject({ ok: false, code: 'unavailable' })
        const items =
          probe.menu.sections.find((section) => section.id === 'accounts')
            ?.items ?? []
        expect(JSON.stringify(probe)).not.toContain('@example.com')
        const result = await serving.commands.apply({
          request: {
            command: 'antigravity',
            sectionId: 'accounts',
            itemId: items[1]?.id ?? '',
            actionId: 'disable',
          },
          scope,
          signal,
        })
        expect(result.ok).toBe(true)
        expect(observed.at(-1)?.accounts.map((entry) => entry.enabled)).toEqual(
          [true, true],
        )
        const after = await serving.state.read({
          scope: { kind: 'sessionless' },
          signal,
        })
        expect(observed.at(-1)?.readSeq).toBe(after.readSeq)
        expect(observed.at(-1)?.accounts.map((entry) => entry.enabled)).toEqual(
          [true, false],
        )
        expect(typeof serving.execute).toBe('function')
      } finally {
        await services.dispose()
        await runtime.dispose()
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an uninitialized location without creating a store', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-factory-empty-')))
    try {
      await expect(
        createGaLocationServices({ directory: root, overrides: {} }),
      ).rejects.toThrow('not initialized')
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
