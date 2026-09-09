import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AntigravityRefreshResult,
  getHealthTracker,
  initHealthTracker,
  initTokenTracker,
  loadAccountStorage,
  mutateAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import { PiAccountRuntime } from './runtime.ts'
import { readSettings, writeStrategy } from './settings.ts'

const model = 'gemini-3.8-flash'
let directory: string
let path: string
const runtimes: PiAccountRuntime[] = []
let previousFetch: typeof fetch
const quotaFetch = mock()
const refresh = mock(
  async (token: string): Promise<AntigravityRefreshResult> => ({
    refresh: token,
    access: `access-${token}`,
    expires: Date.now() + 3600_000,
  }),
)

function login(index: number, token = `secret-refresh-${index}`) {
  return {
    type: 'success' as const,
    email: `user${index}@example.com`,
    refresh: `${token}|project-${index}|managed-${index}`,
    access: `secret-access-${index}`,
    expires: Date.now() + 3600_000,
    projectId: `project-${index}`,
  }
}

function runtime(pid = 0) {
  const result = new PiAccountRuntime({ path, pid, refreshToken: refresh })
  runtimes.push(result)
  return result
}

async function pool(count = 3) {
  const result = runtime()
  for (let i = 1; i <= count; i++) await result.login(login(i))
  await result.refreshQuota()
  return result
}

async function dispatch(result: PiAccountRuntime) {
  const request = await result.dispatch(model, async () => new Response('ok'))
  result.complete(request.account, true)
  return request.account.index
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-pool-'))
  path = join(directory, 'accounts.json')
  initHealthTracker({})
  initTokenTracker({})
  refresh.mockClear()
  previousFetch = globalThis.fetch
  quotaFetch.mockReset()
  quotaFetch.mockImplementation(async () =>
    Response.json({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            {
              bucketId: 'gemini-test',
              displayName: 'Gemini',
              window: '5h',
              remainingFraction: 0.9,
              resetTime: '2099-01-01T00:00:00Z',
            },
          ],
        },
        {
          displayName: 'Other',
          buckets: [
            {
              bucketId: '3p-test',
              displayName: 'Other',
              window: 'weekly',
              remainingFraction: 0.8,
              resetTime: '2099-01-01T00:00:00Z',
            },
          ],
        },
      ],
    }),
  )
  globalThis.fetch = quotaFetch as unknown as typeof fetch
})

afterEach(async () => {
  for (const result of runtimes.splice(0)) await result.dispose()
  globalThis.fetch = previousFetch
  await rm(directory, { recursive: true, force: true })
})

describe('Pi shared account runtime', () => {
  it('persists first, second and third logins using v4 and secure permissions', async () => {
    const result = runtime()
    for (let i = 1; i <= 3; i++) {
      await result.login(login(i))
      expect((await loadAccountStorage(path))?.accounts).toHaveLength(i)
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain('secret-access')
  })

  it('deduplicates by email and token, updates rotated credentials, preserves disabled state', async () => {
    const result = await pool()
    await result.setEnabled(0, false)
    await result.login(login(1, 'rotated-secret'))
    await result.login(login(2))
    const stored = await loadAccountStorage(path)
    expect(stored?.accounts).toHaveLength(3)
    expect(stored?.accounts[0]).toMatchObject({
      refreshToken: 'rotated-secret',
      enabled: false,
    })
    expect(await dispatch(result)).not.toBe(0)
  })

  it('reloads across sessions and refreshes the selected stored credential', async () => {
    await pool()
    const next = runtime()
    expect(await dispatch(next)).toBe(0)
    expect(refresh).toHaveBeenCalledWith('secret-refresh-1')
    expect(await next.describe()).toContain('agy3')
  })

  it.each([
    'sticky',
    'hybrid',
  ] as const)('%s keeps a healthy current account', async (strategy) => {
    const result = await pool()
    await writeStrategy(result.settingsPath, strategy)
    expect(await dispatch(result)).toBe(0)
    expect(await dispatch(result)).toBe(0)
  })

  it('round-robin rotates per request while preserving the cursor through reloads', async () => {
    const result = await pool()
    await writeStrategy(result.settingsPath, 'round-robin')
    const selected = []
    for (let i = 0; i < 4; i++) selected.push(await dispatch(result))
    expect(selected).toEqual([0, 1, 2, 0])
  })

  it.each([
    'sticky',
    'hybrid',
    'round-robin',
  ] as const)('%s applies PID offset once for independent workers', async (strategy) => {
    const result = await pool()
    await writeStrategy(result.settingsPath, strategy)
    expect(await dispatch(runtime(3))).toBe(0)
    expect(await dispatch(runtime(4))).toBe(1)
    expect(await dispatch(runtime(5))).toBe(2)
  })

  it('hybrid uses core health and token-bucket scoring', async () => {
    const result = await pool()
    getHealthTracker().recordFailure(0)
    getHealthTracker().recordFailure(0)
    expect(await dispatch(result)).toBe(1)
  })

  it.each([
    429, 503, 529, 500,
  ])('records HTTP %s cooldown and fails over once', async (status) => {
    const result = await pool()
    const send = mock(async () => new Response('ok'))
    send.mockImplementationOnce(async () =>
      Response.json(
        {
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'QUOTA_EXHAUSTED',
              },
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '120s',
              },
            ],
          },
        },
        { status },
      ),
    )
    const selected = await result.dispatch(model, send)
    expect(selected.account.index).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
    const stored = await loadAccountStorage(path)
    expect(
      stored?.accounts[0]?.rateLimitResetTimes?.[`gemini-antigravity:${model}`],
    ).toBeGreaterThan(Date.now() + 110_000)
    expect(getHealthTracker().getScore(0)).toBe(60)
    expect(await dispatch(runtime())).not.toBe(0)
  })

  it('terminates when all accounts become rate-limited, without exposing provider secrets', async () => {
    const result = await pool()
    const send = mock(
      async () => new Response('secret-refresh-1', { status: 429 }),
    )
    await expect(result.dispatch(model, send)).rejects.toThrow('HTTP 429')
    expect(send).toHaveBeenCalledTimes(3)
    await expect(result.dispatch(model, send)).rejects.toThrow(
      'All Antigravity',
    )
    expect(send).toHaveBeenCalledTimes(3)
    expect(await result.describe()).not.toContain('secret-refresh')
  })

  it('does not retry non-retryable responses or ambiguous transport failures', async () => {
    const result = await pool()
    const send = mock(async () => new Response('bad request', { status: 400 }))
    expect((await result.dispatch(model, send)).response.status).toBe(400)
    expect(send).toHaveBeenCalledTimes(1)
    const broken = mock(async (): Promise<Response> => {
      throw new Error('transport failure')
    })
    await expect(result.dispatch(model, broken)).rejects.toThrow(
      'transport failure',
    )
    expect(broken).toHaveBeenCalledTimes(1)
  })

  it.each([
    'gemini-3.8-flash',
    'gemini-3.1-pro',
    'claude-sonnet-4-6-thinking',
    'gpt-oss-120b-medium',
  ])('bypasses exhausted quota for %s', async (requested) => {
    const result = await pool()
    await mutateAccountStorage(path, (current) => {
      current.accounts[0]!.cachedQuota = {
        gemini: { remainingFraction: 0, modelCount: 1 },
        'non-gemini': { remainingFraction: 0, modelCount: 1 },
      }
      return current
    })
    expect(
      (await result.dispatch(requested, async () => new Response('ok'))).account
        .index,
    ).toBe(1)
  })

  it('retains core single-account quota exception', async () => {
    const result = await pool(1)
    await mutateAccountStorage(path, (current) => {
      current.accounts[0]!.cachedQuota!.gemini!.remainingFraction = 0
      return current
    })
    expect(await dispatch(result)).toBe(0)
  })

  it('fails open on stale quota when refresh is unavailable and retains the stale cache', async () => {
    const result = await pool()
    await mutateAccountStorage(path, (current) => {
      current.accounts[0]!.cachedQuota!.gemini!.remainingFraction = 0
      current.accounts[0]!.cachedQuotaUpdatedAt = Date.now() - 3 * 3600_000
      return current
    })
    quotaFetch.mockImplementation(async () => {
      throw new Error('network unavailable')
    })
    expect(await dispatch(result)).toBe(0)
    expect(
      (await loadAccountStorage(path))?.accounts[0]?.cachedQuota?.gemini
        ?.remainingFraction,
    ).toBe(0)
    expect(await result.describe()).toContain('stale')
  })

  it('excludes disabled accounts, including changes made by another running instance', async () => {
    const first = await pool()
    const second = runtime()
    expect(await dispatch(first)).toBe(0)
    await second.setEnabled(0, false)
    expect(await dispatch(first)).toBe(1)
    await second.setEnabled(1, false)
    await second.setEnabled(2, false)
    await expect(dispatch(first)).rejects.toThrow('All Antigravity')
    await second.setEnabled(2, true)
    expect(await dispatch(first)).toBe(2)
  })

  it('an in-flight cooldown write cannot undo another process disable or add', async () => {
    const first = await pool()
    const second = runtime()
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const pending = first.dispatch(model, async () => {
      if (++calls > 1) return new Response('ok')
      started()
      await gate
      return new Response('', { status: 429 })
    })
    await ready
    await second.setEnabled(0, false)
    await second.login(login(4))
    release()
    await pending
    const stored = await loadAccountStorage(path)
    expect(stored?.accounts).toHaveLength(4)
    expect(stored?.accounts[0]?.enabled).toBe(false)
    expect(stored?.accounts[0]?.rateLimitResetTimes).toBeDefined()
  })

  it('concurrent logins preserve every account through fenced writes', async () => {
    await Promise.all([1, 2, 3].map((i) => runtime(i).login(login(i))))
    expect((await loadAccountStorage(path))?.accounts).toHaveLength(3)
  })

  it('independent OS processes reload the same pool and apply their actual PID offset', async () => {
    await pool()
    const script = `
      import { PiAccountRuntime } from ${JSON.stringify(new URL('./runtime.ts', import.meta.url).pathname)};
      const runtime = new PiAccountRuntime({ path: process.argv[1], refreshToken: async token => ({ refresh: token, access: 'test-access', expires: Date.now() + 3600000 }) });
      const result = await runtime.dispatch('gemini-3.8-flash', async () => new Response('ok'));
      console.log(JSON.stringify({ pid: process.pid, index: result.account.index }));
      await runtime.dispose();
    `
    const children = Array.from({ length: 3 }, () =>
      Bun.spawn([process.execPath, '--eval', script, path], {
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    const results = await Promise.all(
      children.map(async (child) => {
        const [code, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(errors).toBe('')
        expect(code).toBe(0)
        return JSON.parse(output) as { pid: number; index: number }
      }),
    )
    for (const result of results) expect(result.index).toBe(result.pid % 3)
    expect((await loadAccountStorage(path))?.accounts).toHaveLength(3)
  })

  it('serializes simultaneous token rotations and never restores the old token', async () => {
    await pool(1)
    const calls: string[] = []
    const rotatingRefresh = async (token: string) => {
      calls.push(token)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        refresh: `${token}-rotated`,
        access: 'new-access',
        expires: Date.now() + 3600_000,
      }
    }
    const workers = [1, 2].map(
      () =>
        new PiAccountRuntime({ path, pid: 0, refreshToken: rotatingRefresh }),
    )
    runtimes.push(...workers)
    await Promise.all(workers.map(dispatch))
    expect(calls).toEqual(['secret-refresh-1', 'secret-refresh-1-rotated'])
    const stored = await loadAccountStorage(path)
    expect(stored?.accounts).toHaveLength(1)
    expect(stored?.accounts[0]?.refreshToken).toBe(
      'secret-refresh-1-rotated-rotated',
    )
  })

  it('simultaneous cooldown writes retain the longest deadline for the same quota key', async () => {
    await pool(1)
    const workers = [runtime(), runtime()]
    let waiting = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const results = await Promise.allSettled(
      workers.map((worker, index) =>
        worker.dispatch(model, async () => {
          if (++waiting === 2) release()
          await gate
          return new Response('', {
            status: 429,
            headers: { 'retry-after': index === 0 ? '120' : '60' },
          })
        }),
      ),
    )
    expect(waiting).toBe(2)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected')
        expect(String(result.reason)).toContain('HTTP 429')
    }
    expect(
      (await loadAccountStorage(path))?.accounts[0]?.rateLimitResetTimes?.[
        `gemini-antigravity:${model}`
      ],
    ).toBeGreaterThan(Date.now() + 110_000)
  })

  it('a stale refresh cannot overwrite a token rotated by a peer', async () => {
    const first = await pool()
    const second = runtime()
    await first.login(login(1, 'new-refresh'))
    const result = await second.dispatch(model, async (auth) => {
      expect(auth.refresh).toStartWith('new-refresh|')
      return new Response('ok')
    })
    expect(result.account.index).toBe(0)
    expect((await loadAccountStorage(path))?.accounts).toHaveLength(3)
  })

  it('fails over a selected credential refresh failure and persists its cooldown', async () => {
    await pool()
    const broken = new PiAccountRuntime({
      path,
      pid: 0,
      refreshToken: async (token) => {
        if (token === 'secret-refresh-1')
          throw new Error('invalid_grant secret-access-1')
        return refresh(token)
      },
    })
    runtimes.push(broken)
    expect(await dispatch(broken)).toBe(1)
    expect((await loadAccountStorage(path))?.accounts[0]?.cooldownReason).toBe(
      'auth-failure',
    )
    expect(await broken.describe()).not.toContain('secret-access')
  })

  it('the Pi host refresh can recover through another pool member', async () => {
    const result = await pool()
    await result.setEnabled(0, false)
    const next = await result.refreshHost({ ...login(1), expires: 0 })
    expect(next.refresh).toStartWith('secret-refresh-2|')
  })

  it('migrates a legacy Pi credential once without overwriting or resurrecting accounts', async () => {
    const result = runtime()
    await result.migrate({ ...login(1) })
    await result.login(login(2))
    await result.login(login(1, 'new-refresh'))
    await runtime().migrate({ ...login(1) })
    const stored = await loadAccountStorage(path)
    expect(stored?.accounts).toHaveLength(2)
    expect(stored?.accounts[0]?.refreshToken).toBe('new-refresh')
  })

  it.each([
    '{broken secret-refresh-1',
    '{"version":99,"accounts":[]}',
    '{"version":4,"accounts":"invalid"}',
  ])('fails closed on malformed/future storage', async (text) => {
    await writeFile(path, text)
    const result = runtime()
    await expect(result.login(login(1))).rejects.toThrow()
    await expect(result.migrate({ ...login(2) })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('aborted requests do not dispatch or consume routing attempts', async () => {
    const result = await pool()
    const send = mock(async () => new Response('ok'))
    await expect(
      result.dispatch(model, send, AbortSignal.abort()),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('operator output contains neither credentials nor arbitrary account labels', async () => {
    const result = await pool()
    await mutateAccountStorage(path, (current) => {
      current.accounts[0]!.label = 'secret-access-1'
      return current
    })
    const output = await result.describe()
    expect(output).toContain('u***@example.com')
    expect(output).not.toContain('secret-')
    expect(output).not.toContain('user1@')
    expect(await readSettings(result.settingsPath)).toEqual({
      account_selection_strategy: 'hybrid',
      pid_offset_enabled: true,
    })
  })
})
