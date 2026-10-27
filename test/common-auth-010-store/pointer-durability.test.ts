import { describe, expect, it, spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AccountMigrationModules,
  accountStorePointerPath,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  decodeAccountMigrationJournal,
  initializeFreshAccountStore,
  readAccountStoreAdmission,
  resolveAccountStorePaths,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/src/account-migration.ts'
import { loadCommonAuthStoreModules } from '../../packages/core/src/common-auth-runtime.ts'
import {
  MIGRATION_SOURCE,
  publishPendingFreshFixture,
  withMigrationFixtures,
} from './migration-child.ts'

interface Event {
  kind:
    | 'file-sync'
    | 'directory-sync'
    | 'lock'
    | 'rename'
    | 'pointer-create'
    | 'link'
  path: string
}

// Every observation delegates to the real filesystem and the real embedded store.
async function observe(body: (events: Event[]) => Promise<void>) {
  const events: Event[] = []
  const actualOpen = fs.open
  const actualRename = fs.rename
  const actualLink = fs.link
  const opened = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = String(args[0])
    if (path.includes('.store.pointer.json.') && args[1] === 'wx')
      events.push({ kind: 'pointer-create', path })
    const handle = await actualOpen(...args)
    if (path.endsWith('.lock') && args[1] === 'wx')
      events.push({ kind: 'lock', path })
    const directory = (await handle.stat()).isDirectory()
    const actualSync = handle.sync.bind(handle)
    handle.sync = async () => {
      await actualSync()
      events.push({ kind: directory ? 'directory-sync' : 'file-sync', path })
    }
    return handle
  })
  const renamed = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await actualRename(...args)
    events.push({ kind: 'rename', path: String(args[1]) })
  })
  const linked = spyOn(fs, 'link').mockImplementation(async (...args) => {
    await actualLink(...args)
    events.push({ kind: 'link', path: String(args[1]) })
  })
  try {
    await body(events)
  } finally {
    opened.mockRestore()
    renamed.mockRestore()
    linked.mockRestore()
  }
}

async function stagePaths(legacyPath: string) {
  const root = join(legacyPath, '..')
  const generation = (await fs.readdir(root)).find((name) =>
    name.endsWith('.generation'),
  )
  if (!generation) throw new Error('missing freshly saved generation')
  const journalPath = join(root, generation, 'migration.json')
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
  const pointer = {
    schemaVersion: 1,
    id: journal.id,
    directoryBasename: generation,
  }
  return {
    journalPath,
    journal,
    stage: `${accountStorePointerPath(legacyPath)}.${journal.id}.tmp`,
    bytes: Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`),
  }
}

describe.skipIf(process.platform === 'win32')(
  'pointer publication durability',
  () => {
    for (const owner of ['topology', 'management', 'accounts'] as const)
      it(`returns pending after losing the private ${owner} lease without resetting residue`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          let configPath = ''
          const result = await initializeFreshAccountStore(modules, {
            legacyPath: fixture.legacyPath,
            now: () => 100,
            async onBoundary(point) {
              if (point !== 'empty-stage:after-seed') return
              const directory = (await fs.readdir(fixture.root)).find((name) =>
                name.endsWith('.generation'),
              )
              if (!directory) throw new Error('private stage missing')
              configPath = join(fixture.root, directory, 'config.json')
              await fs.unlink(
                modules.fs.lockPathFor(
                  owner === 'management' ? configPath : fixture.legacyPath,
                  owner === 'accounts' ? 'accounts' : 'antigravity-management',
                ),
              )
            },
          })
          expect(result).toEqual({
            status: 'pending',
            reason: 'ownership-lost',
          })
          expect(await fs.readFile(configPath, 'utf8')).toBe(
            '{"version":1,"accounts":[]}\n',
          )
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    it('returns contention to a racing initializer while the winner holds its leases', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        let release!: () => void
        let entered!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const winner = initializeFreshAccountStore(modules, {
          legacyPath: fixture.legacyPath,
          now: () => 100,
          async onBoundary(point) {
            if (point === 'empty-stage:after-seed') {
              entered()
              await held
            }
          },
        })
        try {
          await started
          expect(
            await initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
            }),
          ).toEqual({ status: 'pending', reason: 'lock-contention' })
        } finally {
          release()
        }
        expect((await winner).status).toBe('completed')
        expect(
          (
            await readAccountStoreAdmission(
              fixture.legacyPath,
              modules,
              () => 100,
            )
          ).status,
        ).toBe('active')
        expect(
          (await fs.readdir(fixture.root)).filter((name) =>
            name.endsWith('.generation'),
          ),
        ).toHaveLength(1)
      })
    })

    it('persists the parent before linking a private empty generation', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        await observe(async (events) => {
          await initializeFreshAccountStore(modules, {
            legacyPath: fixture.legacyPath,
            now: () => 100,
          })
          const linked = events.findIndex((e) => e.kind === 'link')
          const parent = events.findIndex(
            (e) => e.kind === 'directory-sync' && e.path === fixture.root,
          )
          expect(parent).toBeGreaterThan(-1)
          expect(parent).toBeLessThan(linked)
          expect(
            events.filter(
              (e) => e.kind === 'directory-sync' && e.path === fixture.root,
            ),
          ).toHaveLength(2)
        })
      })
    })

    it('rechecks source absence immediately before the private link', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        await observe(async (events) => {
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
              async onBoundary(point) {
                if (point === 'pointer:before-link')
                  await fs.writeFile(
                    fixture.legacyPath,
                    'appearing legacy source',
                    { flag: 'wx', mode: 0o600 },
                  )
              },
            }),
          ).rejects.toThrow()
          expect(events.filter((e) => e.kind === 'link')).toHaveLength(0)
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await fs.readFile(fixture.legacyPath, 'utf8')).toBe(
            'appearing legacy source',
          )
        })
      })
    })

    it('persists all empty support directories before the generation and link', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        await observe(async (events) => {
          await initializeFreshAccountStore(modules, {
            legacyPath: fixture.legacyPath,
            now: () => 100,
          })
          const paths = await resolvePublishedAccountStorePaths(
            fixture.legacyPath,
          )
          if (!paths) throw new Error('missing published generation')
          expect(
            events.filter(
              (e) =>
                e.kind === 'file-sync' ||
                e.kind === 'directory-sync' ||
                e.kind === 'link',
            ),
          ).toEqual([
            { kind: 'file-sync', path: paths.configPath },
            { kind: 'file-sync', path: paths.migrationPath },
            ...[
              paths.backupsDir,
              paths.retiredDir,
              paths.transfersDir,
              paths.storeDir,
            ].map((path) => ({ kind: 'directory-sync' as const, path })),
            {
              kind: 'file-sync',
              path: `${accountStorePointerPath(fixture.legacyPath)}.${JSON.parse(await fs.readFile(paths.migrationPath, 'utf8')).id}.tmp`,
            },
            { kind: 'directory-sync', path: fixture.root },
            { kind: 'link', path: accountStorePointerPath(fixture.legacyPath) },
            { kind: 'directory-sync', path: fixture.root },
          ])
        })
      })
    })

    it('preserves independently encoded old-path bytes and historical digest inputs', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const id = '00000000-0000-4000-8000-000000000091'
        const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(id)
        const modules = await loadCommonAuthStoreModules()
        const paths = resolveAccountStorePaths(fixture.legacyPath, id)
        const sha = (bytes: string | Buffer) =>
          createHash('sha256').update(bytes).digest('hex')
        // Literal sorted manifest is independent of the adapter's canonical encoder.
        const manifestInput =
          '{"accounts":[],"effectiveActiveIndex":0,"normalizationClock":100,"routing":{"schemaVersion":1},"sourceVersion":null}'
        const generation = {
          schemaVersion: 1,
          id,
          legacyPath: fixture.legacyPath,
          storeDir: paths.storeDir,
          sourceKind: 'absent',
          initialManifestSha256: sha(manifestInput),
        }
        const config = {
          version: 1,
          accounts: [],
          commonAuthPool: { schemaVersion: 1, rows: {} },
          antigravityRouting: { schemaVersion: 1 },
          antigravityGeneration: generation,
        }
        const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
        const buildBytes = encode({
          ...config,
          antigravityManagement: {
            id,
            kind: 'migration',
            targets: [],
            progress: { step: 'build', completedTargets: [] },
          },
        })
        let historical: Buffer | undefined
        try {
          await publishPendingFreshFixture(modules, fixture.legacyPath)
          let oldHistorical: Buffer | undefined
          const oldResult = await initializeFreshAccountStore(modules, {
            legacyPath: fixture.legacyPath,
            now: () => 100,
            async onBoundary(point) {
              if (point === 'before-verify')
                oldHistorical = await fs.readFile(paths.configPath)
            },
          })
          const oldConfig = await fs.readFile(paths.configPath)
          const oldJournal = decodeAccountMigrationJournal(
            JSON.parse(await fs.readFile(paths.migrationPath, 'utf8')),
          )
          const oldPointer = await fs.readFile(
            accountStorePointerPath(fixture.legacyPath),
          )
          expect(oldHistorical?.toString()).toBe(buildBytes)
          await fs.unlink(accountStorePointerPath(fixture.legacyPath))
          await fs.rm(paths.storeDir, { recursive: true })
          const result = await initializeFreshAccountStore(modules, {
            legacyPath: fixture.legacyPath,
            now: () => 100,
            async onBoundary(point) {
              if (point === 'empty-stage:after-build-settings')
                historical = await fs.readFile(paths.configPath)
            },
          })
          expect(historical).toEqual(oldHistorical)
          expect(await fs.readFile(paths.configPath)).toEqual(oldConfig)
          expect(
            decodeAccountMigrationJournal(
              JSON.parse(await fs.readFile(paths.migrationPath, 'utf8')),
            ),
          ).toEqual(oldJournal)
          expect(
            await fs.readFile(accountStorePointerPath(fixture.legacyPath)),
          ).toEqual(oldPointer)
          expect(result).toEqual(oldResult)
          expect(historical?.toString()).toBe(buildBytes)
          expect(await fs.readFile(paths.configPath, 'utf8')).toBe(
            encode(config),
          )
          expect(result).toEqual({
            status: 'completed',
            receipt: {
              id,
              status: 'active',
              legacyPath: fixture.legacyPath,
              storeDir: paths.storeDir,
              sourceKind: 'absent',
              durability: 'posix-directory-synced',
              restartRequired: false,
            },
          })
          expect(
            decodeAccountMigrationJournal(
              JSON.parse(await fs.readFile(paths.migrationPath, 'utf8')),
            ),
          ).toEqual({
            schemaVersion: 1,
            id,
            legacyPath: fixture.legacyPath,
            storeDir: paths.storeDir,
            sourceKind: 'absent',
            status: 'active',
            operation: 'migrate',
            phase: 'activate',
            manifest: {
              sourceVersion: null,
              normalizationClock: 100,
              accounts: [],
              routing: { schemaVersion: 1 },
              effectiveActiveIndex: 0,
            },
            mapping: [],
            completedRows: [],
            sourceAbsenceVerified: true,
            verification: {
              manifestSha256: sha(manifestInput),
              configSha256: sha(buildBytes),
              statePresent: false,
              durability: 'posix-directory-synced',
            },
          })
          expect(sha(buildBytes)).not.toBe(sha(encode(config)))
          expect(
            await fs.readFile(
              accountStorePointerPath(fixture.legacyPath),
              'utf8',
            ),
          ).toBe(
            encode({
              schemaVersion: 1,
              id,
              directoryBasename: paths.storeDir.split('/').at(-1),
            }),
          )
          expect((await fs.readdir(paths.storeDir)).sort()).toEqual([
            'backups',
            'config.json',
            'migration.json',
            'retired',
            'transfers',
          ])
          for (const path of [
            paths.backupsDir,
            paths.retiredDir,
            paths.transfersDir,
          ]) {
            expect(await fs.readdir(path)).toEqual([])
            expect((await fs.lstat(path)).mode & 0o777).toBe(0o700)
          }
          expect((await fs.lstat(paths.configPath)).mode & 0o777).toBe(0o600)
          expect((await fs.lstat(paths.migrationPath)).mode & 0o777).toBe(0o600)
        } finally {
          uuid.mockRestore()
        }
      })
    })

    for (let failedSync = 1; failedSync <= 9; failedSync++)
      it(`refuses acknowledgment when final barrier ${failedSync} fails`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          const actualOpen = fs.open
          let syncs = 0
          const opened = spyOn(fs, 'open').mockImplementation(
            async (...args) => {
              const handle = await actualOpen(...args)
              const sync = handle.sync.bind(handle)
              handle.sync = async () => {
                if (++syncs === failedSync)
                  throw new Error('injected final barrier failure')
                await sync()
              }
              return handle
            },
          )
          try {
            await expect(
              initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
              }),
            ).rejects.toThrow('injected final barrier failure')
            expect(syncs).toBe(failedSync)
            expect(
              (
                await readAccountStoreAdmission(
                  fixture.legacyPath,
                  modules,
                  () => 100,
                )
              ).status,
            ).toBe(failedSync === 9 ? 'active' : 'initialization-required')
          } finally {
            opened.mockRestore()
          }
        })
      })

    it('persists a clean empty initialization with the embedded store', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        await observe(async (events) => {
          expect(
            (
              await initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
              })
            ).status,
          ).toBe('completed')
          const start = events.findIndex(
            (event) => event.kind === 'pointer-create',
          )
          const stage = events[start]?.path
          if (stage === undefined)
            throw new Error('pointer creation was not observed')
          expect(events.slice(start, start + 5)).toEqual([
            { kind: 'pointer-create', path: stage },
            { kind: 'file-sync', path: stage },
            { kind: 'directory-sync', path: fixture.root },
            { kind: 'link', path: accountStorePointerPath(fixture.legacyPath) },
            { kind: 'directory-sync', path: fixture.root },
          ])
        })
      })
    })

    it('syncs a validated reused pointer stage before linking', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        const modules = await loadCommonAuthStoreModules()
        let stage = ''
        let checkedBeforeLink = false
        const guarded: AccountMigrationModules = {
          ...modules,
          fs: {
            ...modules.fs,
            async writeJsonAtomic(path, value, options) {
              await modules.fs.writeJsonAtomic(path, value, options)
              if (!stage && path.endsWith('/migration.json')) {
                const paths = await stagePaths(fixture.legacyPath)
                stage = paths.stage
                await fs.writeFile(stage, paths.bytes, {
                  mode: 0o600,
                  flag: 'wx',
                })
              }
            },
          },
        }
        await observe(async (events) => {
          expect(
            (
              await createAccountMigrationFactory(guarded)({
                legacyPath: fixture.legacyPath,
                offline: { processesStopped: true },
                now: () => 100,
                async onBoundary(point) {
                  if (point === 'pointer:before-link') {
                    checkedBeforeLink = true
                    expect(
                      events.filter(
                        (e) => e.kind === 'file-sync' && e.path === stage,
                      ),
                    ).toHaveLength(1)
                    expect(events.at(-1)).toEqual({
                      kind: 'directory-sync' as const,
                      path: fixture.root,
                    })
                  }
                },
              })
            ).status,
          ).toBe('completed')
          expect(stage).not.toBe('')
          expect(checkedBeforeLink).toBe(true)
          const persistence = events.filter(
            (event) =>
              event.kind === 'file-sync' ||
              event.kind === 'directory-sync' ||
              event.kind === 'link',
          )
          const stageSync = persistence.findIndex(
            (event) => event.kind === 'file-sync' && event.path === stage,
          )
          expect(stageSync).toBeGreaterThanOrEqual(0)
          expect(persistence.slice(stageSync, stageSync + 4)).toEqual([
            { kind: 'file-sync', path: stage },
            { kind: 'directory-sync', path: fixture.root },
            { kind: 'link', path: accountStorePointerPath(fixture.legacyPath) },
            { kind: 'directory-sync', path: fixture.root },
          ])
        })
      })
    })

    it('keeps captured-journal barriers without an explicit same-owner save', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create(MIGRATION_SOURCE)
        const modules = await loadCommonAuthStoreModules()
        let checked = false
        await observe(async (events) => {
          expect(
            (
              await createAccountMigrationFactory(modules)({
                legacyPath: fixture.legacyPath,
                now: () => 100,
                offline: { processesStopped: true },
                async onBoundary(point) {
                  if (point !== 'pointer:before-link') return
                  const { journalPath } = await stagePaths(fixture.legacyPath)
                  expect(
                    events.filter(
                      (e) => e.kind === 'file-sync' && e.path === journalPath,
                    ),
                  ).toHaveLength(2)
                  expect(
                    events.filter(
                      (e) =>
                        e.kind === 'directory-sync' &&
                        e.path === join(journalPath, '..'),
                    ),
                  ).toHaveLength(2)
                  checked = true
                },
              })
            ).status,
          ).toBe('completed')
        })
        expect(checked).toBe(true)
      })
    })

    for (const damage of ['uuid', 'content'] as const)
      it(`rejects canonical journal ${damage} changes after the owned save`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          await observe(async (events) => {
            await expect(
              initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
                async onBoundary(point) {
                  if (point !== 'pointer:before-publication') return
                  const { journalPath, journal } = await stagePaths(
                    fixture.legacyPath,
                  )
                  if (damage === 'uuid')
                    journal.id = '00000000-0000-4000-8000-000000000001'
                  else journal.phase = 'build'
                  await fs.writeFile(
                    journalPath,
                    `${JSON.stringify(journal)}\n`,
                  )
                },
              }),
            ).rejects.toThrow()
            expect(
              events.some(
                (e) => e.kind === 'pointer-create' || e.kind === 'link',
              ),
            ).toBe(false)
          })
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    for (const owner of ['management', 'topology', 'accounts'] as const)
      it(`asserts ${owner} ownership even after an owned save`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          let lose = false
          const guarded: AccountMigrationModules = {
            ...modules,
            fs: {
              ...modules.fs,
              withLock(path, options, body) {
                return modules.fs.withLock(path, options, (lease) =>
                  body({
                    async assertOwned() {
                      await lease.assertOwned()
                      const selected =
                        owner !== 'management'
                          ? path === fixture.legacyPath
                          : path.endsWith('/config.json')
                      if (
                        lose &&
                        selected &&
                        options.name ===
                          (owner === 'accounts'
                            ? 'accounts'
                            : 'antigravity-management')
                      )
                        throw new Error('synthetic lost publication lease')
                    },
                  }),
                )
              },
            },
          }
          await expect(
            initializeFreshAccountStore(guarded, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
              onBoundary(point) {
                if (point === 'pointer:before-publication') lose = true
              },
            }),
          ).rejects.toThrow('synthetic lost publication lease')
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    for (const damage of ['bytes', 'mode'] as const)
      it(`rejects a reused pointer stage with wrong ${damage}`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
              async onBoundary(point) {
                if (point !== 'pointer:before-publication') return
                const { stage, bytes } = await stagePaths(fixture.legacyPath)
                await fs.writeFile(
                  stage,
                  damage === 'bytes' ? Buffer.from('{}\n') : bytes,
                  { mode: 0o600, flag: 'wx' },
                )
                if (damage === 'mode') await fs.chmod(stage, 0o644)
              },
            }),
          ).rejects.toThrow()
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    it('does not publish when the created pointer write-handle sync fails', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        const actualOpen = fs.open
        let reached = false
        const opened = spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await actualOpen(...args)
          if (
            String(args[0]).includes('.store.pointer.json.') &&
            args[1] === 'wx'
          ) {
            handle.sync = async () => {
              reached = true
              throw new Error('synthetic pointer sync failure')
            }
          }
          return handle
        })
        try {
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
            }),
          ).rejects.toThrow('synthetic pointer sync failure')
          expect(reached).toBe(true)
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          opened.mockRestore()
        }
      })
    })

    it('keeps bootstrap backup retired and export double file syncs', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create({
          version: 4,
          accounts: [],
          activeIndex: 0,
        })
        const modules = await loadCommonAuthStoreModules()
        const hash = createHash('sha256')
          .update(await fs.readFile(fixture.legacyPath))
          .digest('hex')
        const request = {
          legacyPath: fixture.legacyPath,
          now: () => 100,
          offline: { processesStopped: true as const },
        }
        await observe(async (events) => {
          expect(
            (await createAccountMigrationFactory(modules)(request)).status,
          ).toBe('completed')
          const paths = await resolvePublishedAccountStorePaths(
            fixture.legacyPath,
          )
          if (!paths) throw new Error('migration did not publish')
          const syncs = (path: string) =>
            events.filter((e) => e.kind === 'file-sync' && e.path === path)
              .length
          expect(syncs(join(paths.backupsDir, `${hash}.json`))).toBe(2)
          const journal = JSON.parse(
            await fs.readFile(paths.migrationPath, 'utf8'),
          )
          expect(syncs(join(paths.retiredDir, `${journal.id}.json`))).toBe(2)
          // The bootstrap's two syncs precede the first native config replacement.
          const firstConfigRename = events.findIndex(
            (e) => e.kind === 'rename' && e.path === paths.configPath,
          )
          expect(
            events
              .slice(0, firstConfigRename)
              .filter(
                (e) => e.kind === 'file-sync' && e.path === paths.configPath,
              ),
          ).toHaveLength(2)
          events.length = 0
          expect(
            (await createAccountRollbackFactory(modules)(request)).status,
          ).toBe('completed')
          const rolledBack = JSON.parse(
            await fs.readFile(paths.migrationPath, 'utf8'),
          )
          expect(
            syncs(join(paths.transfersDir, `${rolledBack.rollback.id}.json`)),
          ).toBe(2)
          expect(syncs(fixture.legacyPath)).toBeGreaterThanOrEqual(2)
        })
      })
    })
  },
)
