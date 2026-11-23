import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import * as engine from '@cortexkit/antigravity-auth-core/engine'
import { createGaPoolLogin } from '../../../../opencode/src/ga/server/pool-login.ts'
import { createAccountCommandOAuthService } from '../../../../opencode/src/plugin/account-command-oauth.ts'
import { DEFAULT_CONFIG } from '../../../../opencode/src/plugin/config/index.ts'
import { createFetchInterceptor } from '../../../../opencode/src/plugin/fetch-interceptor.ts'
import { createLogger } from '../../../../opencode/src/plugin/logger.ts'
import { createLocationProactiveRefreshQueue } from '../../../../opencode/src/plugin/refresh-queue.ts'
import { createRequestExecutor } from '../../../../opencode/src/plugin/shared/request-executor.ts'
import {
  CHAT_INIT,
  harness,
  STREAM_URL,
} from '../../../../opencode/src/plugin/shared/request-services-harness.test.ts'
import { CUSTODY_PROVIDER_KEY_MARKER } from '../../../../pi/src/index.ts'
import { Environment } from '../environment.ts'
import { piAdapter } from '../pi-surface.ts'

const authorityMessage =
  'Antigravity credential authority changed. No further local account operations were performed.'

function admissionRefusal() {
  // Let this fixture run on versions that still use a general local refusal.
  const ErrorType = Reflect.get(engine, 'EngineRefusalError')
  return ErrorType
    ? new ErrorType('authority_changed')
    : new Error(authorityMessage)
}

const authorization = {
  url:
    'https://accounts.google.com/o/oauth2/v2/auth?state=encoded-state&redirect_uri=' +
    encodeURIComponent('http://localhost:51121/oauth-callback'),
  verifier: 'fixture-verifier',
}
const credentials = {
  type: 'success' as const,
  access: 'fixture-access',
  refresh: 'fixture-refresh',
  expires: 999_999,
  projectId: 'fixture-project',
}

for (const target of ['vault', 'unreadable'] as const) {
  test(`OpenCode's proactive refresh discards its result after switching to ${target}`, async () => {
    let authority: string = 'local'
    const fixture = harness()
    const account = fixture.pool.getAccounts()[0]!
    account.expires = Date.now() + 60_000
    let updates = 0
    let saves = 0
    let subsequentReads = 0
    const stopped = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queue = createLocationProactiveRefreshQueue(
      {
        logger: createLogger('authority-regression'),
        async refreshToken(auth) {
          stopped.resolve()
          await release.promise
          return { ...auth, access: 'refreshed-access' }
        },
      },
      { mayRun: async () => authority === 'local' },
    )
    queue.setAccountManager({
      getAccounts() {
        if (authority !== 'local') subsequentReads++
        return [account]
      },
      toAuthDetails: (entry) => fixture.pool.toAuthDetails(entry),
      updateFromAuth() {
        updates++
      },
      async saveToDisk() {
        saves++
      },
    })
    const realTimer = globalThis.setTimeout
    let invoke: (() => void) | undefined
    let displacedTimer: ReturnType<typeof setTimeout> | undefined
    try {
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        invoke = callback
        displacedTimer = realTimer(() => {}, delay)
        return displacedTimer
      }) as typeof setTimeout
      try {
        queue.start()
      } finally {
        globalThis.setTimeout = realTimer
      }
      clearTimeout(displacedTimer)
      expect(invoke).toBeFunction()
      invoke?.()
      await stopped.promise
      const settling = Reflect.get(queue, 'inflightRefresh') as Promise<void>
      authority = target
      release.resolve()
      await settling
      expect([subsequentReads, updates, saves]).toEqual([0, 0, 0])
    } finally {
      release.resolve()
      await queue.dispose()
      await fixture.pool.dispose()
    }
  })

  test(`OpenCode 1 selects no sender after the host auth read switches to ${target}`, async () => {
    let authority: string = 'local'
    const fixture = harness()
    const stopped = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let sends = 0
    const interceptor = createFetchInterceptor({
      directory: 'in-memory',
      providerId: 'google',
      config: DEFAULT_CONFIG,
      accountSource: { kind: 'pool-file' },
      accountManager: fixture.pool,
      quotaManager: {},
      client: {},
      agySessionRegistry: fixture.deps.sessions,
      async assertAdmission() {
        if (authority !== 'local') throw admissionRefusal()
      },
      async getAuth() {
        stopped.resolve()
        await release.promise
        return { type: 'api', key: 'fixture-key' }
      },
      async fetchImpl() {
        sends++
        return new Response('unexpected send')
      },
    } as Parameters<typeof createFetchInterceptor>[0])
    try {
      const done = interceptor
        .fetch(STREAM_URL, CHAT_INIT())
        .catch((error: Error) => error.message)
      await stopped.promise
      authority = target
      release.resolve()
      const outcome = await done
      expect(outcome).toBe(authorityMessage)
      expect(sends).toBe(0)
    } finally {
      release.resolve()
      await interceptor.dispose()
      await fixture.pool.dispose()
    }
  })

  test(`a local helper quota reading is not written after switching to ${target}`, async () => {
    let authority: string = 'local'
    let saves = 0
    let updates = 0
    const fixture = harness()
    const account = fixture.pool.getAccounts()[0]!
    const quotaStarted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const operation = engine.createLocalQuotaRefresh(
      {
        getAccounts: () => [account],
        getAccountsForQuotaCheck: () => fixture.pool.getAccountsForQuotaCheck(),
        updateQuotaCache() {
          updates++
          return true
        },
        requestSaveToDisk() {
          saves++
        },
      },
      {
        async refreshAccount() {
          quotaStarted.resolve()
          await release.promise
          return {
            index: 0,
            status: 'ok',
            checkedAt: Date.now(),
            quota: { groups: {}, modelCount: 0 },
          }
        },
        hashedLogLabel: () => 'fixture',
      },
      fixture.deps.logger,
      async () => {
        if (authority !== 'local') throw admissionRefusal()
      },
    )
    try {
      const done = operation(account, 1)
      await quotaStarted.promise
      authority = target
      release.resolve()
      await done
      expect(updates).toBe(0)
      expect(saves).toBe(0)
    } finally {
      release.resolve()
      await fixture.pool.dispose()
    }
  })

  test(`an expired-token refresh cannot update, save, or dispatch after switching to ${target}`, async () => {
    let authority: string = 'local'
    const stopped = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const after: string[] = []
    const fixture = harness({
      async refresh(auth) {
        stopped.resolve()
        await release.promise
        return { ...auth, access: 'fresh-access', expires: Date.now() + 60_000 }
      },
    })
    const original = fixture.deps.credentials
    if (original.domain !== 'local')
      throw new Error('Expected the local fixture')
    const executor = createRequestExecutor({
      ...fixture.deps,
      async assertAdmission() {
        if (authority !== 'local') throw admissionRefusal()
      },
      credentials: {
        ...original,
        updateFromAuth() {
          after.push('update')
        },
        async saveToDisk() {
          after.push('save')
        },
        async clearStoredAuth() {
          after.push('clear')
        },
        async ensureProject(auth) {
          after.push('project')
          return { auth, effectiveProjectId: 'fixture-project' }
        },
      },
    })
    try {
      const done = executor
        .execute(STREAM_URL, CHAT_INIT())
        .catch((error: Error) => error.message)
      await stopped.promise
      authority = target
      release.resolve()
      expect(await done).toBe(authorityMessage)
      expect(after).toEqual([])
      expect(fixture.calls).toHaveLength(0)
    } finally {
      release.resolve()
      await executor.dispose()
      await fixture.pool.dispose()
    }
  })

  test(`the project continuation skips onboarding after switching to ${target}`, async () => {
    let authority: string = 'local'
    const stopped = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let onboarding = 0
    const fixture = harness()
    const original = fixture.deps.credentials
    if (original.domain !== 'local')
      throw new Error('Expected the local fixture')
    const executor = createRequestExecutor({
      ...fixture.deps,
      async assertAdmission() {
        if (authority !== 'local') throw admissionRefusal()
      },
      credentials: {
        ...original,
        async ensureProject(auth, admit) {
          stopped.resolve()
          await release.promise
          await admit?.()
          onboarding++
          return { auth, effectiveProjectId: 'fixture-project' }
        },
      },
    })
    try {
      const done = executor
        .execute(STREAM_URL, CHAT_INIT())
        .catch((error: Error) => error.message)
      await stopped.promise
      authority = target
      release.resolve()
      expect(await done).toBe(authorityMessage)
      expect(onboarding).toBe(0)
      expect(fixture.calls).toHaveLength(0)
    } finally {
      release.resolve()
      await executor.dispose()
      await fixture.pool.dispose()
    }
  })

  test(`OpenCode 1 pasted sign-in cannot read or save after a switch to ${target}`, async () => {
    let authority: string = 'local'
    const after: string[] = []
    const exchangeEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const service = createAccountCommandOAuthService({
      authorize: async () => authorization,
      admit: async () => {
        if (authority !== 'local') throw admissionRefusal()
      },
      async exchange() {
        exchangeEntered.resolve()
        await release.promise
        return credentials
      },
      async persist() {
        after.push('save')
      },
      async listAccounts() {
        if (authority !== 'local') after.push('read')
        return []
      },
    })
    try {
      await service.start('session')
      const completion = service.finish('session', 'fixture-code')
      const observed = completion.catch((error: Error) => error.message)
      await exchangeEntered.promise
      authority = target
      release.resolve()
      expect(await observed).toBe(authorityMessage)
      expect(after).toEqual([])
    } finally {
      release.resolve()
      service.dispose()
    }
  })

  test(`OpenCode 2 pasted sign-in fails closed after a switch to ${target}`, async () => {
    let authority: string = 'local'
    let saves = 0
    const exchangeEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const service = createGaPoolLogin({
      local: {
        assertAdmission: async () => {
          if (authority !== 'local') throw admissionRefusal()
        },
        async persist() {
          saves++
        },
      },
      oauth: {
        authorize: async () => authorization,
        async exchange() {
          exchangeEntered.resolve()
          await release.promise
          return credentials
        },
      },
    })
    try {
      const attempt = await service.start(false)
      const completion = attempt
        .paste(
          'http://localhost:51121/oauth-callback?state=encoded-state&code=fixture-code',
        )
        .catch((error: Error) => error.message)
      await exchangeEntered.promise
      authority = target
      release.resolve()
      expect(await completion).toBe(authorityMessage)
      expect(saves).toBe(0)
    } finally {
      release.resolve()
      await service.dispose()
    }
  })

  test(`Pi native refresh returns no credential after a switch to ${target}`, async () => {
    const env = new Environment()
    const adapter = await piAdapter(env, 'local', false)
    const realFetch = globalThis.fetch
    const exchangeEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let refreshes = 0
    try {
      const provider = await adapter.activate()
      const native = (await Bun.file(adapter.nativeAuthPath).json()).google
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (String(input) !== 'https://oauth2.googleapis.com/token')
          return realFetch(input, init)
        refreshes++
        exchangeEntered.resolve()
        await release.promise
        return Response.json({
          access_token: 'successor-access',
          expires_in: 3_600,
        })
      }) as typeof fetch
      const completion = provider
        .oauth!.refreshToken(native)
        .catch((error: Error) => error.message)
      await exchangeEntered.promise
      if (target === 'vault') await adapter.switchToVault()
      else
        await Bun.write(
          join(dirname(adapter.nativeAuthPath), 'pi-mode.json'),
          '{bad json',
        )
      release.resolve()
      expect(await completion).toBe(authorityMessage)
      expect(refreshes).toBe(1)
      const final = (await Bun.file(adapter.nativeAuthPath).json()).google
      if (target === 'vault')
        expect(final).toEqual({
          type: 'api_key',
          key: CUSTODY_PROVIDER_KEY_MARKER,
        })
      else expect(final).toEqual(native)
    } finally {
      release.resolve()
      globalThis.fetch = realFetch
      await adapter.dispose()
      await env.dispose()
    }
  })
}
