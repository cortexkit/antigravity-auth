import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStoreAdmissionModules,
  initializeFreshAccountStore,
  readAccountStoreAdmission,
  readAccountStoreBinding,
} from './account-migration.ts'
import { createAccountRepositoryFactory } from './account-repository.ts'
import { loadCommonAuthStoreModules } from './common-auth-runtime.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'admission-snapshot-'))
  const legacyPath = join(root, 'accounts.json')
  const modules = await loadCommonAuthStoreModules()
  await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
  const binding = await readAccountStoreBinding(legacyPath, modules, Date.now)
  if (binding.status !== 'bound') throw new Error(binding.status)
  const repository = createAccountRepositoryFactory(modules)({
    paths: binding.paths,
    now: Date.now,
    exchange: async () => {
      throw new Error('No network')
    },
  })
  await repository.login({
    id: randomUUID(),
    refreshToken: 'synthetic-refresh',
    metadata: { email: 'snapshot@example.test', addedAt: 1, lastUsed: 1 },
  })
  const read = await repository.read()
  if (read.status !== 'ready' || !read.rows[0]) throw new Error('Missing row')
  const row = read.rows[0]
  let beforeRead: (() => Promise<void>) | undefined
  const admissionModules: AccountStoreAdmissionModules = {
    store: {
      openPoolStore(options) {
        const store = modules.store.openPoolStore(options)
        return {
          readSettings: () => store.readSettings(),
          read: async () => {
            await beforeRead?.()
            return store.read()
          },
        }
      },
    },
  }
  return {
    repository,
    row,
    gate: (hook: () => Promise<void>) => {
      beforeRead = hook
    },
    admit: () =>
      readAccountStoreAdmission(
        legacyPath,
        admissionModules,
        Date.now,
        binding.receipt.id,
      ),
    cleanup: async () => {
      await repository.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('coherent lock-free serving admission', () => {
  it('admits a healthy generation after a real quota save between config and public rows', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let gated = false
    f.gate(async () => {
      if (gated) return
      gated = true
      entered.resolve()
      await release.promise
    })
    const admission = f.admit()
    try {
      await entered.promise
      await f.repository.recordQuota(f.row.ref, {
        schemaVersion: 1,
        cachedQuotaUpdatedAt: 123,
      })
      release.resolve()
      expect(await admission).toMatchObject({ status: 'active' })
      const read = await f.repository.read()
      expect(read.status === 'ready' && read.rows[0]?.quota).toEqual({
        status: 'present',
        quota: { schemaVersion: 1, cachedQuotaUpdatedAt: 123 },
      })
    } finally {
      release.resolve()
      await admission
      await f.cleanup()
    }
  })

  it('returns retryable busy rather than damage when every snapshot stamp changes', async () => {
    const f = await fixture()
    let writes = 0
    f.gate(async () => {
      await f.repository.recordQuota(f.row.ref, {
        schemaVersion: 1,
        cachedQuotaUpdatedAt: ++writes,
      })
    })
    try {
      expect(await f.admit()).toEqual({ status: 'busy', retryable: true })
      expect(writes).toBe(3)
    } finally {
      await f.cleanup()
    }
  })
})
