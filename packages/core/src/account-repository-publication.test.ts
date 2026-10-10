import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PUBLIC_CONSUMER_ENV } from './__fixtures__/common-auth-public-consumer.test.ts'
import { publicationPublicModules } from './__fixtures__/publication-public-modules.ts'

const { store, fs, consumer } = await publicationPublicModules(
  process.env[PUBLIC_CONSUMER_ENV],
)

import {
  initializeFreshAccountStore,
  readAccountStoreBinding,
} from './account-migration.ts'
import {
  ACCOUNT_STATE_POLICY,
  type AccountStoreModule,
  createAccountRepositoryFactory,
  type StorePublicationReceipt,
} from './account-repository.ts'
import {
  createProviderStateCodec,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import {
  ACCOUNT_STORE_PROVIDER,
  type AccountLoginInput,
  type AccountRepository,
  type AccountStorePaths,
  MANAGEMENT_SETTINGS_KEY,
} from './account-repository-types.ts'

const input = (id: string, enabled = true): AccountLoginInput => ({
  id,
  refreshToken: `synthetic-${id}-refresh`,
  identity: `${id}@example.invalid`,
  metadata: {
    addedAt: 1,
    lastUsed: 0,
    email: `${id}@example.invalid`,
    projectId: `synthetic-${id}-project`,
    enabled,
  },
})
const roots: string[] = []
const repositories: AccountRepository[] = []
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.dispose()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function pool() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agy-012-replacement-')),
  )
  roots.push(root)
  const legacyPath = join(root, 'accounts.json')
  const initialized = await initializeFreshAccountStore(
    { store, fs },
    { legacyPath, now: Date.now },
  )
  expect(initialized.status).toBe('completed')
  const binding = await readAccountStoreBinding(legacyPath, { store }, Date.now)
  if (binding.status !== 'bound') throw new Error(`binding: ${binding.status}`)
  const paths = binding.paths
  const open = (module: AccountStoreModule = store) => {
    const repo = createAccountRepositoryFactory({ store: module, fs })({
      paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('no network token exchange')
      },
    })
    repositories.push(repo)
    return repo
  }
  const native = store.openPoolStore({
    provider: ACCOUNT_STORE_PROVIDER,
    configPath: paths.configPath,
    statePath: paths.statePath,
    quota: QUOTA_CODEC,
    providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
    requireCredentialStamps: true,
  })
  const repo = open()
  await repo.login(input('old'))
  return { root, paths, native, repo, open }
}
async function disk(paths: AccountStorePaths) {
  return Promise.all([
    readFile(paths.configPath, 'utf8'),
    readFile(paths.statePath, 'utf8'),
  ])
}
const journal = async (paths: AccountStorePaths) =>
  JSON.parse(await readFile(paths.configPath, 'utf8'))[MANAGEMENT_SETTINGS_KEY]
function faultModule(
  step: 'before-config-write' | 'after-config-write',
): AccountStoreModule {
  let armed = true
  return {
    ...store,
    openPoolStore(options) {
      return store.openPoolStore({
        ...options,
        onStep(point, info) {
          if (armed && info.operation === 'publishRoster' && point === step) {
            armed = false
            throw new Error(`injected ${step}`)
          }
        },
      })
    },
  }
}

describe('published account store through AccountRepository.replacePool', () => {
  it('stages disabled rows, publishes once, removes old credentials and preserves metadata/settings/order', async () => {
    const p = await pool()
    await p.native.updateSettings((settings) => ({
      ...settings,
      syntheticSetting: 'kept',
    }))
    let observed = false
    const module: AccountStoreModule = {
      ...store,
      openPoolStore(options) {
        const real = store.openPoolStore(options)
        return {
          ...real,
          async publishRoster(plan, options) {
            const read = await real.read()
            if (read.status !== 'ready')
              throw new Error('pre-decision native read failed')
            expect(read.rows.find((row) => row.id === 'old')?.candidate).toBe(
              true,
            )
            for (const id of ['new-a', 'new-b']) {
              const staged = read.rows.find((row) => row.id === id)
              expect(staged?.enabled).toBe(false)
              expect(staged?.candidate).toBe(false)
              expect(staged?.staged?.reservation).toBe(plan.operationId)
            }
            observed = true
            return real.publishRoster(plan, options)
          },
        }
      },
    }
    const replacement = p.open(module)
    expect(
      (await replacement.replacePool([input('new-a'), input('new-b', false)]))
        .outcome,
    ).toBe('completed')
    expect(observed).toBe(true)
    const read = await replacement.read()
    if (read.status !== 'ready') throw new Error(`read: ${read.status}`)
    expect(read.rows.map((row) => row.ref.id)).toEqual(['new-a', 'new-b'])
    expect(read.rows.map((row) => row.enabled)).toEqual([true, false])
    expect(
      read.rows.map((row) =>
        row.metadata.status === 'present'
          ? row.metadata.metadata.projectId
          : undefined,
      ),
    ).toEqual(['synthetic-new-a-project', 'synthetic-new-b-project'])
    const [config, state] = await disk(p.paths)
    expect(config).toContain('syntheticSetting')
    expect(config).not.toContain('replacement-pending')
    expect(state).not.toContain('synthetic-old-refresh')
    const native = await p.native.read()
    if (native.status !== 'ready') throw new Error('native unavailable')
    expect(native.rows.map((row) => row.candidate)).toEqual([true, false])
    expect(native.rows.every((row) => row.staged === undefined)).toBe(true)
  })
  for (const step of ['before-config-write', 'after-config-write'] as const) {
    it(`recovers the same publication after failure at ${step}`, async () => {
      const p = await pool()
      const failed = p.open(faultModule(step))
      const request = [input('new')]
      if (step === 'before-config-write') {
        await expect(failed.replacePool(request)).rejects.toMatchObject({
          failure: { kind: 'unexpected', retryable: false },
        })
      } else {
        expect((await failed.replacePool(request)).outcome).toBe('pending')
      }
      const operation = await journal(p.paths)
      const receipt = await p.native.publication(operation.id)
      if (step === 'before-config-write') {
        expect(receipt).toBeUndefined()
        const native = await p.native.read()
        if (native.status !== 'ready') throw new Error('native unavailable')
        expect(native.rows.find((row) => row.id === 'old')?.candidate).toBe(
          true,
        )
        expect(native.rows.find((row) => row.id === 'new')?.candidate).toBe(
          false,
        )
      } else {
        expect(receipt?.phase).toBe('committed')
        const native = await p.native.read()
        if (native.status !== 'ready') throw new Error('native unavailable')
        expect(native.rows.map((row) => row.id)).toEqual(['new'])
      }
      await failed.dispose()
      const restarted = p.open()
      expect((await restarted.replacePool(request)).outcome).toBe('completed')
      const cleaned: StorePublicationReceipt | undefined =
        await p.native.publication(operation.id)
      expect(cleaned?.phase).toBe('cleaned')
      expect(cleaned?.operationId).toBe(operation.id)
      expect(cleaned?.finalized[0]?.id).toBe('new')
      expect(await journal(p.paths)).toBeUndefined()
      expect(
        (await readFile(p.paths.statePath, 'utf8')).includes(
          'synthetic-old-refresh',
        ),
      ).toBe(false)
    })
  }
  it('refuses a reused id before changing any stored bytes', async () => {
    const p = await pool()
    const before = await disk(p.paths)
    await expect(
      p.repo.replacePool([
        { ...input('old'), refreshToken: 'synthetic-successor' },
      ]),
    ).rejects.toMatchObject({
      failure: { kind: 'invalid-input', retryable: false },
    })
    expect(await disk(p.paths)).toEqual(before)
    expect((await p.repo.read()).status).toBe('ready')
  })
})

for (const step of [
  'before-config-write',
  'after-config-write',
  'after-state-write',
] as const) {
  it(`replays after an actual child exit at ${step}`, async () => {
    const p = await pool()
    const child = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, '__fixtures__/publication-crash-child.ts'),
        p.paths.legacyPath,
        step,
        consumer,
      ],
      {
        cwd: p.root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: p.root,
          USERPROFILE: p.root,
          TMPDIR: p.root,
          XDG_CONFIG_HOME: p.root,
          XDG_DATA_HOME: p.root,
          XDG_STATE_HOME: p.root,
          XDG_CACHE_HOME: p.root,
        },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      },
    )
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(91)
    expect(child.stderr).toBe('')
    const operation = await journal(p.paths)
    expect(operation.progress.step).toBe(
      step === 'after-state-write' ? 'add' : 'publish',
    )
    const receipt = await p.native.publication(operation.id)
    expect(receipt?.phase).toBe(
      step === 'after-config-write' ? 'committed' : undefined,
    )
    const before = await p.native.read()
    if (before.status !== 'ready')
      throw new Error('native read failed after child exit')
    if (step === 'before-config-write') {
      expect(before.rows.find((row) => row.id === 'old')?.candidate).toBe(true)
      expect(before.rows.find((row) => row.id === 'new')?.candidate).toBe(false)
    } else if (step === 'after-state-write') {
      expect(before.rows.map((row) => [row.id, row.candidate])).toEqual([
        ['old', true],
      ])
      expect(await readFile(p.paths.statePath, 'utf8')).toContain(
        'synthetic-new-refresh',
      )
    } else {
      expect(before.rows.map((row) => row.id)).toEqual(['new'])
    }
    // The exited crash-fixture process used one-second lock expirations. Wait
    // for its abandoned locks to expire before reopening the pool; do not delete
    // lock files or change the production lease durations and deadlines.
    await Bun.sleep(1100)
    expect((await p.open().replacePool([input('new')])).outcome).toBe(
      'completed',
    )
    expect((await p.native.publication(operation.id))?.phase).toBe('cleaned')
    expect(await journal(p.paths)).toBeUndefined()
    const served = await p.native.read()
    if (served.status !== 'ready')
      throw new Error('native unavailable after replay')
    expect(served.rows.map((row) => [row.id, row.candidate])).toEqual([
      ['new', true],
    ])
    expect(
      (await readFile(p.paths.statePath, 'utf8')).includes(
        'synthetic-old-refresh',
      ),
    ).toBe(false)
  })
}

it('replaces an account with overlapping secret and identity without rotating the old row during staging', async () => {
  const p = await pool()
  const successor = {
    ...input('new'),
    refreshToken: input('old').refreshToken,
    identity: input('old').identity,
    metadata: { ...input('new').metadata, email: input('old').metadata.email },
  }
  expect((await p.repo.replacePool([successor])).outcome).toBe('completed')
  const result = await p.native.read()
  if (result.status !== 'ready') throw new Error('native unavailable')
  expect(result.rows.map((row) => row.id)).toEqual(['new'])
  expect(result.rows[0]?.credential).toMatchObject({
    refresh: input('old').refreshToken,
  })
  expect(result.rows[0]?.candidate).toBe(true)
})

it('refuses native publication after a captured old secret changes, without any publication writes', async () => {
  const p = await pool()
  let captured: Awaited<ReturnType<typeof disk>> | undefined
  const module: AccountStoreModule = {
    ...store,
    openPoolStore(options) {
      const real = store.openPoolStore(options)
      return {
        ...real,
        async publishRoster(plan, options) {
          await real.rotate('old', {
            type: 'oauth',
            refresh: 'synthetic-concurrent-refresh',
          })
          captured = await disk(p.paths)
          return real.publishRoster(plan, options)
        },
      }
    },
  }
  await expect(
    p.open(module).replacePool([input('new')]),
  ).rejects.toMatchObject({ failure: { kind: 'attribution' } })
  expect(captured).toBeDefined()
  if (!captured)
    throw new Error('the pre-publication snapshot was not captured')
  expect(await disk(p.paths)).toEqual(captured)
  const result = await p.native.read()
  if (result.status !== 'ready') throw new Error('native unavailable')
  expect(result.rows.find((row) => row.id === 'old')?.candidate).toBe(true)
  expect(result.rows.find((row) => row.id === 'new')?.candidate).toBe(false)
  expect(
    await p.native.publication((await journal(p.paths)).id),
  ).toBeUndefined()
})
