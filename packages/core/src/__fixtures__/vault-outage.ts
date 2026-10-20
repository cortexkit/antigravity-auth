import { spyOn } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import {
  createAntigravityVaultAccountSource,
  loadCommonAuthClaustrum,
  type VaultScopedClient,
} from '../../dist/index.js'

/** Real consumer and core source; only the scoped vault transport is replaced. */
export async function outageVault(host: 'opencode' | 'pi') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-outage-')))
  const tokenPath = join(root, 'enrollment-token.json')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const claustrum = await loadCommonAuthClaustrum()
  const authorize = spyOn(claustrum.ClaustrumConsumer.prototype, 'authorize')
  let failure: Error | undefined
  const gets: Parameters<VaultScopedClient['getScoped']>[0][] = []
  const reports: Parameters<VaultScopedClient['reportAuthFailureScoped']>[0][] =
    []
  let lists = 0
  let settledLists = 0
  const listWaiters: Array<{ count: number; resolve: () => void }> = []
  const settleListWaiters = () => {
    const pending = listWaiters.filter((waiter) => settledLists < waiter.count)
    for (const waiter of listWaiters) {
      if (settledLists >= waiter.count) waiter.resolve()
    }
    listWaiters.splice(0, listWaiters.length, ...pending)
  }
  const waitForLists = (count: number) =>
    settledLists >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => listWaiters.push({ count, resolve }))
  const client: VaultScopedClient = {
    async listScoped() {
      lists++
      try {
        if (failure) throw failure
        return {
          view: 'outage-roster',
          rows: [
            {
              id: 'outage-credential',
              accountId: 'outage-account',
              categories: ['antigravity-native'],
              credentialType: 'oauth',
              serves: [],
              providerIds: [],
              refreshAdapter: 'antigravity',
              state: 'active',
              recordVersion: 1,
              operations: ['read'],
              createdAtMs: null,
            },
          ],
          grants: undefined,
          grantTuples: undefined,
        }
      } finally {
        settledLists++
        settleListWaiters()
      }
    },
    async getScoped(input) {
      gets.push(input)
      if (failure) throw failure
      return {
        material: 'outage-bearer',
        recordVersion: 1,
        expiresAtMs: Date.now() + 3_600_000,
        credentialId: 'outage-credential',
        projectId: 'outage-project',
        accountId: 'outage-account',
      }
    },
    async reportAuthFailureScoped(input) {
      reports.push(input)
      if (failure) throw failure
    },
    close() {},
  }
  const source = createAntigravityVaultAccountSource({
    claustrum,
    host,
    rosterPath: join(root, 'roster.json'),
    tokenPath,
    connect: async () => client,
    isCustodyActive: () => true,
    reporterSource: 'direct',
    logger: { warn() {}, debug() {} },
  })
  await source.refresh()
  const ref = source.routes()[0]
  if (!ref) throw new Error('missing vault route')
  return {
    source,
    ref,
    gets,
    reports,
    authorize,
    lists: () => lists,
    waitForLists,
    unreachable() {
      failure = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      })
    },
    reachable() {
      failure = undefined
    },
    deny() {
      failure = new ClaustrumCredentialError(
        'grant_denied',
        'permanent',
        'gone',
      )
    },
    dispose() {
      source.close()
      authorize.mockRestore()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Read the actual consumer result rather than inferring receipt origin from the bearer. */
export async function keptReceipts(
  vault: Awaited<ReturnType<typeof outageVault>>,
) {
  return Promise.all(
    vault.authorize.mock.results
      .filter((result) => result.type === 'return')
      .map(async (result) => {
        try {
          const receipt = await result.value
          return (
            'fromKeptReceipt' in receipt && receipt.fromKeptReceipt === true
          )
        } catch {
          return false
        }
      }),
  )
}
