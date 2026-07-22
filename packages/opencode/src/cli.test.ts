import { describe, expect, it } from 'bun:test'

import type {
  AccountQuotaResult,
  AccountStorageV4,
} from '@cortexkit/antigravity-auth-core'

import { type CliDependencies, performOAuthLogin, runCli } from './cli'
import type { OAuthLoginRequest } from './plugin/oauth-methods'

function accountStorage(): AccountStorageV4 {
  return {
    version: 4,
    activeIndex: 0,
    accounts: [
      {
        email: 'alpha@example.com',
        refreshToken: 'refresh-secret',
        projectId: 'project-secret',
        managedProjectId: 'managed-secret',
        fingerprint: {
          userAgent: 'fingerprint-secret',
          deviceId: 'device-secret',
          sessionToken: 'session-secret',
          apiClient: 'api-secret',
          clientMetadata: {
            ideType: 'cli',
            platform: 'linux',
            pluginType: 'standalone',
          },
          createdAt: 1,
        },
        enabled: true,
        addedAt: 1,
        lastUsed: 2,
      },
      {
        email: 'disabled@example.com',
        refreshToken: 'disabled-refresh',
        enabled: false,
        addedAt: 3,
        lastUsed: 4,
      },
    ],
  }
}

function createHarness(overrides: Partial<CliDependencies> = {}) {
  let stdout = ''
  let stderr = ''
  let touched = 0
  const loginRequests: OAuthLoginRequest[] = []

  const deps: CliDependencies = {
    stdout: {
      write: (value) => {
        stdout += value
      },
    },
    stderr: {
      write: (value) => {
        stderr += value
      },
    },
    prompt: async () => {
      touched += 1
      return ''
    },
    openBrowser: async () => {
      touched += 1
    },
    performLogin: async (request, openBrowser) => {
      touched += 1
      loginRequests.push(request)
      if (!request.noBrowser) await openBrowser('https://accounts.example/auth')
      return {
        type: 'success',
        refresh: 'new-refresh|new-project',
        access: 'new-access',
        expires: 123,
        email: 'new@example.com',
        projectId: 'new-project',
      }
    },
    loadAccounts: async () => {
      touched += 1
      return accountStorage()
    },
    getQuota: async () => {
      touched += 1
      return []
    },
    ...overrides,
  }

  return {
    deps,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    get touched() {
      return touched
    },
    loginRequests,
  }
}

describe('runCli parser', () => {
  it('prints help without touching operational dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['--help'], harness.deps)).toBe(0)
    expect(harness.stdout).toContain('Usage: antigravity-auth')
    expect(harness.stdout).toContain('login [--project <id>] [--no-browser]')
    expect(harness.stdout).toContain('list [--json]')
    expect(harness.stdout).toContain('quota [--json] [--refresh]')
    expect(harness.stderr).toBe('')
    expect(harness.touched).toBe(0)
  })

  it('rejects unknown commands before touching dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['wat'], harness.deps)).toBe(2)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toContain('Unknown command: wat')
    expect(harness.touched).toBe(0)
  })

  it('rejects a missing project argument before touching dependencies', async () => {
    const harness = createHarness()

    expect(await runCli(['login', '--project'], harness.deps)).toBe(2)
    expect(harness.stderr).toContain('Missing value for --project')
    expect(harness.touched).toBe(0)
  })

  it('rejects unsupported command options', async () => {
    const harness = createHarness()

    expect(await runCli(['list', '--refresh'], harness.deps)).toBe(2)
    expect(harness.stderr).toContain('Unknown option for list: --refresh')
    expect(harness.touched).toBe(0)
  })
})

describe('runCli commands', () => {
  it('passes login flags through the injected boundary', async () => {
    const harness = createHarness()

    expect(
      await runCli(
        ['login', '--project', 'my-project', '--no-browser'],
        harness.deps,
      ),
    ).toBe(0)
    expect(harness.loginRequests).toEqual([
      {
        projectId: 'my-project',
        noBrowser: true,
        isHeadless: false,
        refreshAccountIndex: undefined,
        accounts: [],
        startFresh: true,
      },
    ])
    expect(harness.touched).toBe(1)
    expect(harness.stdout).toContain('Authenticated new@example.com')
    expect(harness.stderr).toBe('')
  })

  it('opens the authorization URL during browser login', async () => {
    let opened = ''
    const harness = createHarness({
      openBrowser: async (url) => {
        opened = url
      },
    })

    expect(await runCli(['login'], harness.deps)).toBe(0)
    expect(opened).toBe('https://accounts.example/auth')
  })

  it('returns one and writes operational failures to stderr', async () => {
    const harness = createHarness({
      performLogin: async () => {
        throw new Error('callback failed')
      },
    })

    expect(await runCli(['login'], harness.deps)).toBe(1)
    expect(harness.stdout).toBe('')
    expect(harness.stderr).toBe('callback failed\n')
  })

  it('prints redacted parseable account JSON without prose', async () => {
    const harness = createHarness()

    expect(await runCli(['list', '--json'], harness.deps)).toBe(0)
    const value = JSON.parse(harness.stdout) as unknown
    expect(value).toEqual({
      accounts: [
        { index: 1, email: 'alpha@example.com', status: 'active' },
        { index: 2, email: 'disabled@example.com', status: 'disabled' },
      ],
    })
    expect(harness.stdout).not.toContain('refresh-secret')
    expect(harness.stdout).not.toContain('access-secret')
    expect(harness.stdout).not.toContain('project-secret')
    expect(harness.stdout).not.toContain('fingerprint-secret')
    expect(harness.stderr).toBe('')
  })

  it('prints a stable human account table', async () => {
    const harness = createHarness()

    expect(await runCli(['list'], harness.deps)).toBe(0)
    expect(harness.stdout).toBe(
      'INDEX  EMAIL                 STATUS\n' +
        '1      alpha@example.com     active\n' +
        '2      disabled@example.com  disabled\n',
    )
  })

  it('prints quota JSON with groups and partial failures', async () => {
    const results: AccountQuotaResult[] = [
      {
        index: 0,
        email: 'alpha@example.com',
        status: 'ok',
        quota: {
          groups: {
            claude: {
              remainingFraction: 0.25,
              resetTime: '2026-07-22T12:00:00.000Z',
              modelCount: 2,
            },
          },
          modelCount: 2,
        },
      },
      {
        index: 1,
        email: 'disabled@example.com',
        status: 'error',
        error: 'quota unavailable',
      },
    ]
    let refresh = false
    const harness = createHarness({
      getQuota: async (_accounts, options) => {
        refresh = options.refresh
        return results
      },
    })

    expect(await runCli(['quota', '--json', '--refresh'], harness.deps)).toBe(0)
    expect(refresh).toBe(true)
    expect(JSON.parse(harness.stdout)).toEqual({
      accounts: [
        {
          index: 1,
          email: 'alpha@example.com',
          status: 'ok',
          groups: [
            {
              name: 'claude',
              remainingPercent: 25,
              resetTime: '2026-07-22T12:00:00.000Z',
            },
          ],
        },
        {
          index: 2,
          email: 'disabled@example.com',
          status: 'error',
          error: 'quota unavailable',
          groups: [],
        },
      ],
    })
  })

  it('prints a stable human quota table', async () => {
    const harness = createHarness({
      getQuota: async () => [
        {
          index: 0,
          email: 'alpha@example.com',
          status: 'ok',
          quota: {
            groups: { claude: { remainingFraction: 0.25, modelCount: 1 } },
            modelCount: 1,
          },
        },
        {
          index: 1,
          email: 'disabled@example.com',
          status: 'error',
          error: 'quota unavailable',
        },
      ],
    })

    expect(await runCli(['quota'], harness.deps)).toBe(0)
    expect(harness.stdout).toBe(
      'ACCOUNT               STATUS  GROUP   REMAINING  RESET\n' +
        'alpha@example.com     ok      claude  25%        -\n' +
        'disabled@example.com  error   -       -          quota unavailable\n',
    )
  })
})

describe('performOAuthLogin', () => {
  const request: OAuthLoginRequest = {
    projectId: 'project-id',
    noBrowser: false,
    isHeadless: false,
    refreshAccountIndex: undefined,
    accounts: [],
    startFresh: true,
  }

  it('opens, waits, exchanges once, persists once, and closes the listener', async () => {
    let opened = ''
    let exchanges = 0
    let upserts = 0
    let closes = 0

    const result = await performOAuthLogin(request, {
      authorize: async () => ({
        url: 'https://accounts.example/auth?state=expected',
        verifier: 'verifier',
        projectId: 'project-id',
      }),
      exchange: async (code, state) => {
        exchanges += 1
        expect(code).toBe('oauth-code')
        expect(state).toBe('expected')
        return {
          type: 'success',
          refresh: 'refresh|project-id',
          access: 'access',
          expires: 123,
          email: 'alpha@example.com',
          projectId: 'project-id',
        }
      },
      startListener: async () => ({
        waitForCallback: async () =>
          new URL(
            'http://localhost:51121/oauth-callback?code=oauth-code&state=expected',
          ),
        close: async () => {
          closes += 1
        },
      }),
      openBrowser: async (url) => {
        opened = url
      },
      upsert: async () => {
        upserts += 1
      },
    })

    expect(result.email).toBe('alpha@example.com')
    expect(opened).toBe('https://accounts.example/auth?state=expected')
    expect(exchanges).toBe(1)
    expect(upserts).toBe(1)
    expect(closes).toBe(1)
  })

  it('does not open a browser with --no-browser', async () => {
    let opens = 0
    const result = await performOAuthLogin(
      { ...request, noBrowser: true },
      {
        authorize: async () => ({
          url: 'https://accounts.example/auth?state=expected',
          verifier: 'verifier',
          projectId: 'project-id',
        }),
        exchange: async () => ({
          type: 'success',
          refresh: 'refresh|project-id',
          access: 'access',
          expires: 123,
          projectId: 'project-id',
        }),
        startListener: async () => ({
          waitForCallback: async () =>
            new URL(
              'http://localhost:51121/oauth-callback?code=code&state=expected',
            ),
          close: async () => {},
        }),
        openBrowser: async () => {
          opens += 1
        },
        upsert: async () => {},
      },
    )

    expect(result.type).toBe('success')
    expect(opens).toBe(0)
  })

  it('closes the listener and leaves storage unchanged when callback validation fails', async () => {
    let exchanges = 0
    let upserts = 0
    let closes = 0

    await expect(
      performOAuthLogin(request, {
        authorize: async () => ({
          url: 'https://accounts.example/auth?state=expected',
          verifier: 'verifier',
          projectId: 'project-id',
        }),
        exchange: async () => {
          exchanges += 1
          return {
            type: 'failed',
            error: 'not reached',
          }
        },
        startListener: async () => ({
          waitForCallback: async () =>
            new URL(
              'http://localhost:51121/oauth-callback?code=code&state=wrong',
            ),
          close: async () => {
            closes += 1
          },
        }),
        openBrowser: async () => {},
        upsert: async () => {
          upserts += 1
        },
      }),
    ).rejects.toThrow('OAuth state mismatch')

    expect(exchanges).toBe(0)
    expect(upserts).toBe(0)
    expect(closes).toBe(1)
  })
})
