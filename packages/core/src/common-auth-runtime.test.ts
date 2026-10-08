import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type CommonAuthStoreModules,
  loadCommonAuthAuthMenu,
  loadCommonAuthClaustrum,
  loadCommonAuthCommands,
  loadCommonAuthFs,
  loadCommonAuthLogger,
  loadCommonAuthQuota,
  loadCommonAuthRouting,
  loadCommonAuthStore,
  loadCommonAuthStoreModules,
} from './index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'common-auth-runtime-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('common-auth runtime bindings', () => {
  it('loads each public entry once and returns the same module afterwards', async () => {
    const loaders = [
      loadCommonAuthStore,
      loadCommonAuthFs,
      loadCommonAuthRouting,
      loadCommonAuthQuota,
      loadCommonAuthCommands,
      loadCommonAuthAuthMenu,
      loadCommonAuthClaustrum,
      loadCommonAuthLogger,
    ]
    for (const load of loaders) {
      const first = await load()
      expect(await load()).toBe(first)
    }
  })

  it('exposes the public exports each entry is used for', async () => {
    const store = await loadCommonAuthStore()
    expect(typeof store.openPoolStore).toBe('function')
    expect(typeof store.DECLINE_TRANSITION).toBe('symbol')
    expect(typeof store.PoolOperationError).toBe('function')

    const routing = await loadCommonAuthRouting()
    expect(typeof routing.routeOrdered).toBe('function')
    expect(typeof routing.routeSticky).toBe('function')

    const quota = await loadCommonAuthQuota()
    expect(quota.isQuotaMap(quota.emptyQuotaMap())).toBe(true)

    const commands = await loadCommonAuthCommands()
    expect(typeof commands.createCommandMenu).toBe('function')
    expect(typeof commands.runPiCommandMenu).toBe('function')

    const authMenu = await loadCommonAuthAuthMenu()
    expect(typeof authMenu.runAccountMenu).toBe('function')

    const claustrum = await loadCommonAuthClaustrum()
    expect(typeof claustrum.ClaustrumConsumer).toBe('function')
    expect(typeof claustrum.ClaustrumCredentialError).toBe('function')
  })

  it('pairs the store and fs entries of one embedded copy', async () => {
    const modules: CommonAuthStoreModules = await loadCommonAuthStoreModules()
    expect(modules.store).toBe(await loadCommonAuthStore())
    expect(modules.fs).toBe(await loadCommonAuthFs())
  })

  it('runs genuine library file operations through the loaded fs entry', async () => {
    const fs = await loadCommonAuthFs()
    const target = join(root, 'value.json')
    await fs.writeJsonAtomic(target, { written: true })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      written: true,
    })

    const held = await fs.withLock(
      target,
      { name: 'binding-test', ttlMs: 5_000, timeoutMs: 1_000 },
      async (lock) => {
        await lock.assertOwned()
        return 'held'
      },
    )
    expect(held).toBe('held')
  })
})
