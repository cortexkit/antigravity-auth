/**
 * CLI-flow E2E test.
 *
 * The CLI runs in-process (it's a thin arg parser + service delegator,
 * not a long-lived process). `runCli(argv, deps)` is called with
 * injected `CliDependencies` so the test can:
 *
 *   - Replace the OAuth callback prompt with a deterministic string
 *     and the OAuth exchange with a stub that resolves to a fixture
 *     account.
 *   - Redirect `stdout` / `stderr` to in-memory buffers so we can
 *     assert the output without polluting test logs.
 *   - Read accounts through the genuine account-file reader and the
 *     genuine account-store operations (the embedded common-auth store and
 *     the migration module) in the harness temp root; only the quota
 *     fetcher is injected, since it would reach the network.
 *
 * The live `script/test-models.ts` and `script/test-regression.ts`
 * remain manual-only diagnostics (see `test:e2e:models` /
 * `test:e2e:regression` scripts). They are NOT exercised here — this
 * suite gates the deterministic in-process paths only.
 */

import './setup'

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  type CliDependencies,
  createDefaultAccountStoreOperations,
  runCli,
} from '../../opencode/src/cli'
import {
  loadAccounts,
  saveAccountsReplace,
} from '../../opencode/src/plugin/storage'
import { cleanupE2eRootsForCurrentFile } from './setup'

afterAll(cleanupE2eRootsForCurrentFile)

const FIXED_NOW = Date.parse('2026-07-22T12:00:00.000Z')

async function seedAccounts(): Promise<void> {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('ANTIGRAVITY_TEST_ROOT not set by preload')
  mkdirSync(join(root, 'pi-agent'), { recursive: true })
  await saveAccountsReplace({
    version: 4,
    accounts: [
      {
        email: 'cli@example.test',
        refreshToken: 'refresh-cli',
        projectId: 'project-cli',
        managedProjectId: 'managed-cli',
        addedAt: FIXED_NOW - 10_000,
        lastUsed: FIXED_NOW - 5_000,
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  })
}

/**
 * The genuine account-store operations, given the account file's canonical
 * path. The store refuses an account file whose parent directories pass
 * through a symbolic link, and the temporary root can (macOS's /var is
 * one), so the canonical spelling of the same file is used.
 */
function storeOperations(): CliDependencies['accountStore'] {
  const operations = createDefaultAccountStoreOperations()
  return {
    ...operations,
    legacyPath: () => {
      const file = operations.legacyPath()
      return join(realpathSync(dirname(file)), basename(file))
    },
  }
}

class StringBuffer {
  private chunks: string[] = []
  write(value: string): boolean {
    this.chunks.push(value)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

interface CliTestHandle {
  deps: CliDependencies
  stdout: StringBuffer
  stderr: StringBuffer
}

function buildCliDeps(overrides: Partial<CliDependencies> = {}): CliTestHandle {
  const stdout = new StringBuffer()
  const stderr = new StringBuffer()
  const deps: CliDependencies = {
    stdout,
    stderr,
    prompt: async () => '',
    openBrowser: async () => undefined,
    isHeadless: () => true,
    performLogin: async () => ({
      type: 'success' as const,
      refresh: 'refresh-injected|project-injected|managed-injected',
      access: 'access-injected',
      expires: Date.now() + 3_600_000,
      email: 'injected@example.test',
      projectId: 'project-injected',
      managedProjectId: 'managed-injected',
    }),
    loadAccounts,
    getQuota: async () => [
      {
        index: 0,
        email: 'cli@example.test',
        status: 'ok' as const,
        disabled: false,
        quota: {
          groups: {
            'non-gemini': {
              remainingFraction: 0.5,
              resetTime: 'in 1h',
              modelCount: 1,
            },
          },
          modelCount: 1,
        },
      },
    ],
    accountStore: storeOperations(),
    ...overrides,
  }
  return { deps, stdout, stderr }
}

describe('cli flow (e2e)', () => {
  afterEach(() => {
    // Reset for the next test.
  })

  it('prints help text on --help and exits 0', async () => {
    const handle = buildCliDeps()
    const exit = await runCli(['--help'], handle.deps)
    expect(exit).toBe(0)
    expect(handle.stdout.text()).toContain('Usage: antigravity-auth')
  })

  it('returns exit 2 on unknown command', async () => {
    const handle = buildCliDeps()
    const exit = await runCli(['bogus'], handle.deps)
    expect(exit).toBe(2)
    expect(handle.stderr.text()).toContain('Unknown command')
  })

  it('runs `login` with the injected performLogin', async () => {
    await seedAccounts()
    const handle = buildCliDeps()
    const exit = await runCli(['login', '--no-browser'], handle.deps)
    expect(exit).toBe(0)
    expect(handle.stdout.text()).toContain(
      'Authenticated injected@example.test',
    )
  })

  it('runs `list` and prints the seeded account without leaking secrets', async () => {
    const seeded = seedAccounts()
    expect(seeded).toBeInstanceOf(Promise)
    await seeded
    const handle = buildCliDeps()
    const exit = await runCli(['list'], handle.deps)
    expect(exit).toBe(0)
    const output = handle.stdout.text()
    expect(output).toContain('cli@example.test')
    expect(output).not.toContain('refresh-cli')
    expect(output).not.toContain('access-cli')
  })

  it('runs `list --json` and emits machine-readable JSON', async () => {
    await seedAccounts()
    const handle = buildCliDeps()
    const exit = await runCli(['list', '--json'], handle.deps)
    expect(exit).toBe(0)
    const parsed = JSON.parse(handle.stdout.text()) as {
      accounts: Array<{ email: string; status: string }>
    }
    expect(parsed.accounts[0]?.email).toBe('cli@example.test')
    expect(parsed.accounts[0]?.status).toBe('active')
  })

  it('runs `quota` against the injected quota response without printing secrets', async () => {
    await seedAccounts()
    const handle = buildCliDeps()
    const exit = await runCli(['quota'], handle.deps)
    expect(exit).toBe(0)
    const output = handle.stdout.text()
    expect(output).toContain('cli@example.test')
    expect(output).toContain('non-gemini')
    expect(output).toContain('50%')
    expect(output).not.toContain('refresh-cli')
  })

  it('runs `quota --json` and emits a deterministic JSON shape', async () => {
    await seedAccounts()
    const handle = buildCliDeps()
    const exit = await runCli(['quota', '--json'], handle.deps)
    expect(exit).toBe(0)
    const parsed = JSON.parse(handle.stdout.text()) as {
      accounts: Array<{
        email: string
        groups: Array<{ name: string; remainingPercent?: number }>
      }>
    }
    expect(parsed.accounts[0]?.email).toBe('cli@example.test')
    expect(parsed.accounts[0]?.groups[0]?.name).toBe('non-gemini')
    expect(parsed.accounts[0]?.groups[0]?.remainingPercent).toBe(50)
  })

  it('returns exit 1 when the injected quota loader throws', async () => {
    await seedAccounts()
    const handle = buildCliDeps({
      getQuota: async () => {
        throw new Error('quota-fetch-failed')
      },
    })
    const exit = await runCli(['quota'], handle.deps)
    expect(exit).toBe(1)
    expect(handle.stderr.text()).toContain('quota-fetch-failed')
  })

  it('migrates the seeded account file offline, then lists and quotas from the store', async () => {
    await seedAccounts()
    const migrate = buildCliDeps()
    expect(await runCli(['migrate', '--offline', '--yes'], migrate.deps)).toBe(
      0,
    )
    expect(migrate.stderr.text()).toBe('')
    // After migration the account file is retired: list and quota must come
    // from the store, never from the file reader.
    let fileReads = 0
    const list = buildCliDeps({
      loadAccounts: async () => {
        fileReads += 1
        return loadAccounts()
      },
    })
    expect(await runCli(['list', '--json'], list.deps)).toBe(0)
    const listed = JSON.parse(list.stdout.text()) as {
      accounts: Array<{ email: string }>
    }
    expect(listed.accounts.map((account) => account.email)).toEqual([
      'cli@example.test',
    ])
    expect(list.stdout.text()).not.toContain('refresh-cli')
    let quotaEmails: Array<string | undefined> = []
    const quota = buildCliDeps({
      loadAccounts: async () => {
        fileReads += 1
        return loadAccounts()
      },
      getQuota: async (accounts) => {
        quotaEmails = accounts.map((account) => account.email)
        return []
      },
    })
    expect(await runCli(['quota', '--json'], quota.deps)).toBe(0)
    expect(quotaEmails).toEqual(['cli@example.test'])
    expect(fileReads).toBe(0)
  })

  it('refuses migrate without --offline and without the typed confirmation', async () => {
    await seedAccounts()
    const missingFlag = buildCliDeps()
    expect(await runCli(['migrate'], missingFlag.deps)).toBe(2)
    const declined = buildCliDeps({ prompt: async () => 'no' })
    expect(await runCli(['migrate', '--offline'], declined.deps)).toBe(1)
    expect(declined.stderr.text()).toContain('nothing was changed')
    // Nothing moved: the account file is still the source.
    const list = buildCliDeps()
    expect(await runCli(['list', '--json'], list.deps)).toBe(0)
    expect(list.stdout.text()).toContain('cli@example.test')
  })

  it('returns exit 1 when login performLogin throws', async () => {
    const handle = buildCliDeps({
      performLogin: async () => {
        throw new Error('oauth-rejected')
      },
    })
    const exit = await runCli(['login', '--no-browser'], handle.deps)
    expect(exit).toBe(1)
    expect(handle.stderr.text()).toContain('oauth-rejected')
  })
})
