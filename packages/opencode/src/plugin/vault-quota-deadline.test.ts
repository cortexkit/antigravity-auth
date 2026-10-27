import { expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AntigravityVaultAccountSource,
  VaultAccountState,
  VaultProviderStateFile,
} from '@cortexkit/antigravity-auth-core'
import type { BackgroundVaultQuotaRefresh } from './background-vault-quota-refresh'
import { createAntigravityPlugin } from './index'
import type { PluginClient, PluginInput } from './types'
import * as custodyModule from './vault-custody'

const realSetTimeout = globalThis.setTimeout
async function settles(pending: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = realSetTimeout(() => resolve(false), 1_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(
  mode: 'headers' | 'body' | 'failure' | 'fresh' | 'recorded',
) {
  const root = mkdtempSync(join(tmpdir(), 'vault-deadline-'))
  const stateFile = join(root, 'sidebar.json')
  const savedEnvironment = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    ANTIGRAVITY_AUTH_RPC_DIR: process.env.ANTIGRAVITY_AUTH_RPC_DIR,
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE:
      process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE,
  }
  process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
  process.env.ANTIGRAVITY_AUTH_RPC_DIR = join(root, 'rpc')
  process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE = stateFile
  mkdirSync(join(root, '.opencode'))
  writeFileSync(
    join(root, '.opencode', 'antigravity.json'),
    JSON.stringify({
      background_quota_refresh: true,
      proactive_token_refresh: false,
      auto_update: false,
      debug: false,
      debug_tui: false,
    }),
  )
  const accounts: Record<string, VaultAccountState> = {
    'secret-account': {
      observed: {
        routeId: 'secret-route',
        credentialId: 'secret-credential',
        recordVersion: 1,
      },
      quota: {
        schemaVersion: 1,
        cachedQuota: {},
        cachedQuotaUpdatedAt: mode === 'fresh' ? Date.now() : 123,
      },
    },
  }
  const stored: VaultProviderStateFile = { schemaVersion: 1, accounts }
  const ref = {
    routeId: 'secret-route',
    credentialId: 'secret-credential',
    accountIdentity: 'secret-account',
    label: 'secret@example.test',
  }
  const commitState: AntigravityVaultAccountSource['commitState'] = async (
    by,
    update,
    signal,
  ) => {
    if (mode !== 'recorded')
      throw new Error('must not commit a stalled reading')
    signal?.throwIfAborted()
    const next = update(stored.accounts[by.accountIdentity])
    if (!next) throw new Error('missing quota update')
    const state = {
      observed: {
        routeId: by.routeId,
        credentialId: by.credentialId,
        recordVersion: by.recordVersion,
      },
      ...next,
    }
    accounts[by.accountIdentity] = state
    return { status: 'written', state }
  }
  const source: AntigravityVaultAccountSource = {
    host: 'opencode',
    start: () => {},
    close: () => {},
    dispose: async () => {},
    admit: async () => {
      throw new Error('unused')
    },
    reportServedStatus: async () => false,
    decline: async () => {},
    accept: async () => {},
    grantReach: () => undefined,
    emptyRosterCause: () => 'unknown',
    refresh: async () => {},
    routes: () => [ref],
    attribution: () => ({ ...ref, recordVersion: 1 }),
    send: async (_ref, dispatch, options) =>
      dispatch(
        {
          ...ref,
          recordVersion: 1,
          accessToken: 'secret-token',
          projectId: 'secret-project',
          expiresAtMs: null,
        },
        options.signal,
      ),
    commitState,
    commitStates: async (entries, signal) => {
      const results = []
      for (const { attribution, update } of entries)
        results.push(await commitState(attribution, update, signal))
      return results
    },
  }
  const createCustody = custodyModule.createOpenCodeVaultCustody
  const custodySpy = spyOn(
    custodyModule,
    'createOpenCodeVaultCustody',
  ).mockImplementation((options) => ({
    ...createCustody(options),
    readMode: async () => ({
      ok: true,
      record: { version: 1, mode: 'custody' },
    }),
    readState: async () => stored,
    custodySource: async () => source,
    startObservation: async () => {},
  }))
  const timers: { delay: number; fire: () => void }[] = []
  const timerHandles: ReturnType<typeof setTimeout>[] = []
  const realTimeout = globalThis.setTimeout
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    timers.push({ delay, fire: callback })
    const handle = realTimeout(() => {}, 2 ** 30)
    handle.unref()
    timerHandles.push(handle)
    return handle
  }) as typeof setTimeout)
  const headerTimers: { delay: number; controller: AbortController }[] = []
  const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(
    (delay) => {
      const controller = new AbortController()
      headerTimers.push({ delay, controller })
      return controller.signal
    },
  )
  let aborted = 0
  let fetched = 0
  let bodyCanceled = 0
  const onAbort = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const fetchImpl = (async (_url, init) => {
    fetched++
    entered.resolve()
    const signal = init?.signal
    if (mode === 'recorded')
      return Response.json({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly',
                window: 'weekly',
                remainingFraction: 0.5,
              },
            ],
          },
        ],
      })
    if (mode === 'fresh') throw new Error('fresh quota must not fetch')
    if (mode === 'failure')
      return new Response(
        'secret-token secret-project secret@example.test secret-route secret-credential secret-account',
        { status: 500 },
      )
    if (mode === 'headers')
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted++
            onAbort.resolve()
            reject(signal.reason)
          },
          { once: true },
        )
      })
    return new Response(
      new ReadableStream({
        start() {
          signal?.addEventListener(
            'abort',
            () => {
              aborted++
              onAbort.resolve()
            },
            { once: true },
          )
        },
        cancel() {
          bodyCanceled++
        },
      }),
    )
  }) as typeof fetch
  const networkSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 404 }),
  )
  const records: unknown[] = []
  const client = {
    app: {
      log: async (entry: unknown) => {
        records.push(entry)
      },
    },
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
  } as unknown as PluginClient
  let poller: BackgroundVaultQuotaRefresh | undefined
  const plugin = await createAntigravityPlugin('google', {
    dependencies: { fetchImpl, clock: { now: Date.now, random: () => 0 } },
    _onVaultPollerCreated: (created) => {
      poller = created
    },
  })({ client, directory: root } as PluginInput)
  if (!poller) throw new Error('vault producer not composed')
  const activePoller = poller
  return {
    poller: activePoller,
    timers,
    headerTimers,
    records,
    stored,
    entered: entered.promise,
    onAbort: onAbort.promise,
    get aborted() {
      return aborted
    },
    get fetched() {
      return fetched
    },
    get bodyCanceled() {
      return bodyCanceled
    },
    lockFile: `${stateFile}.bg-vault-quota-poll.lock`,
    async close() {
      await plugin.dispose()
      custodySpy.mockRestore()
      timerSpy.mockRestore()
      timeoutSpy.mockRestore()
      networkSpy.mockRestore()
      for (const handle of timerHandles) clearTimeout(handle)
      for (const [key, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

for (const mode of ['fresh', 'recorded'] as const) {
  it(`V1 ${mode} outcome does not reach app.log with debug disabled`, async () => {
    const f = await fixture(mode)
    try {
      const before =
        f.stored.accounts['secret-account']?.quota?.cachedQuotaUpdatedAt
      await f.poller.tick()
      if (mode === 'fresh') {
        expect(f.fetched).toBe(0)
        expect(
          f.stored.accounts['secret-account']?.quota?.cachedQuotaUpdatedAt,
        ).toBe(before)
      } else {
        expect(f.fetched).toBe(1)
        expect(
          f.stored.accounts['secret-account']?.quota?.cachedQuotaUpdatedAt,
        ).toBeGreaterThan(123)
      }
      expect(f.records).toEqual([])
      expect(JSON.stringify(f.records)).not.toContain('secret-')
    } finally {
      await f.close()
    }
  })
}

for (const mode of ['headers', 'body'] as const) {
  it(`V1 ${mode} stall settles at the tick deadline and releases its fence`, async () => {
    const f = await fixture(mode)
    try {
      const tick = f.poller.tick()
      await f.entered
      expect(existsSync(f.lockFile)).toBe(true)
      const deadline = f.timers.find((timer) => timer.delay === 60_000)
      deadline?.fire()
      expect(await settles(tick)).toBe(true)
      await tick
      expect(existsSync(f.lockFile)).toBe(false)
      if (mode === 'body') expect(f.bodyCanceled).toBe(1)
      expect(
        f.stored.accounts['secret-account']?.quota?.cachedQuotaUpdatedAt,
      ).toBe(123)
      expect(f.timers.some((timer) => timer.delay >= 300_000)).toBe(true)
      const summaries = f.records.filter((entry) =>
        JSON.stringify(entry).includes('vault-quota-tick'),
      )
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({
        body: { level: 'warn', extra: { reason: 'deadline' } },
      })
      for (const secret of [
        'secret-token',
        'secret-project',
        'secret@example.test',
        'secret-route',
        'secret-credential',
        'secret-account',
      ])
        expect(JSON.stringify(summaries)).not.toContain(secret)
    } finally {
      await f.close()
    }
  })
}

it('V1 injected fetch applies the builder header timeout before the tick deadline', async () => {
  const f = await fixture('headers')
  try {
    const tick = f.poller.tick()
    await f.entered
    f.headerTimers
      .find((timer) => timer.delay === 10_000)
      ?.controller.abort(new DOMException('header deadline', 'TimeoutError'))
    expect(await settles(f.onAbort)).toBe(true)
    expect(f.aborted).toBe(1)
    f.timers.find((timer) => timer.delay === 60_000)?.fire()
    await tick
  } finally {
    await f.close()
  }
})

it('V1 stale fetch failure reaches app.log once with debug disabled and no remote text', async () => {
  const f = await fixture('failure')
  try {
    await f.poller.tick()
    const summaries = f.records.filter((entry) =>
      JSON.stringify(entry).includes('vault-quota-tick'),
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      body: {
        level: 'warn',
        extra: {
          reason: 'fetch-failed',
          checked: 0,
          notChecked: 1,
          status: 500,
        },
      },
    })
    expect(JSON.stringify(summaries)).not.toContain('secret-')
    expect(
      f.stored.accounts['secret-account']?.quota?.cachedQuotaUpdatedAt,
    ).toBe(123)
  } finally {
    await f.close()
  }
})
