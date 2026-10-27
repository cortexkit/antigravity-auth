import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  type AccountMigrationModules,
  accountStorePointerPath,
  createAccountMigrationFactory,
  createAccountRelocationFactory,
  decodeAccountMigrationJournal,
  readAccountStoreAdmission,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/src/account-migration.ts'
import {
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from '../../packages/core/src/account-repository-codecs.ts'
import {
  type ChildLockClaim,
  installReleasedCore,
  loadPublicMigrationModules,
  type MigrationFixture,
  migrationChildEnvironment,
  migrationFixtureInputs,
  RELEASED_CORE_CHILD,
  runReleasedCommand,
  withMigrationFixtures,
} from './migration-child.ts'

const ROOT = resolve(import.meta.dir, '../..')
const CHILD = join(import.meta.dir, 'migration-child.ts')
const inputs = migrationFixtureInputs(process.env)
const released = await installReleasedCore()
if ('unavailable' in released) {
  if (process.env.ANTIGRAVITY_RELEASED_CORE_REQUIRED === '1')
    throw new Error(released.unavailable)
  console.warn(`relocation-crash: ${released.unavailable}`)
}
afterAll(async () => {
  if ('root' in released)
    await fs.rm(released.root, { recursive: true, force: true })
})

interface Event {
  kind: string
  path: string
}
interface Crash {
  locks: ChildLockClaim[]
  events: Event[]
}

/** Exit is observed before any lease is removed; only matching claims inside this disposable fixture are removed. */
async function crash(
  fixture: MigrationFixture,
  seam: string,
  back = false,
): Promise<Event[]> {
  const child = spawn(
    process.execPath,
    [
      CHILD,
      '--child',
      fixture.root,
      fixture.nonce,
      seam,
      back ? 'relocate-back' : 'relocate',
    ],
    {
      cwd: ROOT,
      env: migrationChildEnvironment(fixture, inputs),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  fixture.cleanupBlocked = 'relocation child has not exited'
  let owned = false
  let report: Crash | undefined
  let failure: Error | undefined
  let output = ''
  const capture = (chunk: Buffer) => {
    output += chunk
    if (output.length > 1_000_000) {
      failure = new Error('child output bound exceeded')
      child.kill('SIGKILL')
    }
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('message', (message: unknown) => {
    const reply = message as Record<string, unknown>
    if (!reply || reply.nonce !== fixture.nonce || reply.pid !== child.pid) {
      failure = new Error('child identity mismatch')
      child.kill('SIGKILL')
      return
    }
    if (reply.kind === 'owned') owned = true
    else if (
      reply.kind === 'crash' &&
      owned &&
      reply.boundary === seam &&
      Array.isArray(reply.locks) &&
      Array.isArray(reply.events)
    )
      report = { locks: reply.locks, events: reply.events }
    else {
      failure = new Error(`unexpected child report ${String(reply.kind)}`)
      child.kill('SIGKILL')
    }
  })
  const timer = setTimeout(() => {
    failure = new Error('relocation child deadline')
    child.kill('SIGKILL')
  }, 10_000)
  let code: number | null
  try {
    code = await new Promise<number | null>((resolveClose, reject) => {
      child.once('error', reject)
      child.once('close', resolveClose)
    })
  } finally {
    clearTimeout(timer)
  }
  fixture.cleanupBlocked = undefined
  if (failure || code !== 73 || !report)
    throw new Error(
      `${failure?.message ?? 'crash seam not reached'} (${code}): ${output}`,
    )
  expect(owned).toBe(true)
  expect(report.locks.length).toBeGreaterThan(0)
  for (const claim of report.locks) {
    if (
      resolve(claim.path) !== claim.path ||
      !claim.path.startsWith(`${fixture.root}${sep}`) ||
      !claim.path.endsWith('.lock')
    )
      throw new Error('foreign lease claim')
    if ((await fs.realpath(dirname(claim.path))) !== dirname(claim.path))
      throw new Error('lease claim traverses a symbolic link')
    const before = await fs.lstat(claim.path)
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('claimed lease is not a regular file')
    const payload = JSON.parse(await fs.readFile(claim.path, 'utf8'))
    const after = await fs.lstat(claim.path)
    if (
      payload.ownerId !== claim.ownerId ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      throw new Error('claimed lease changed')
    await fs.unlink(claim.path)
  }
  return report.events
}

function rawStore(
  modules: AccountMigrationModules,
  paths: { configPath: string; statePath: string },
) {
  return modules.store.openPoolStore({
    provider: 'antigravity',
    ...paths,
    now: Date.now,
    requireCredentialStamps: true,
    quota: QUOTA_CODEC,
    providerState: {
      validate: isValidProviderState,
      credentialBound: providerStateCredentialBound,
      merge: (_previous, incoming) => incoming,
      onReplace: () => undefined,
    },
  })
}
async function rows(modules: AccountMigrationModules, anchor: string) {
  const paths = await resolvePublishedAccountStorePaths(anchor)
  if (!paths) throw new Error('published paths missing')
  const result = await rawStore(modules, paths).read()
  if (result.status !== 'ready') throw new Error(`rows are ${result.status}`)
  return result.rows
}
async function oldRead(fixture: MigrationFixture) {
  if (!('dir' in released)) throw new Error('released package unavailable')
  const child = join(fixture.root, 'released-child.mjs')
  await fs.writeFile(child, RELEASED_CORE_CHILD)
  const result = await runReleasedCommand(
    'node',
    [child, released.dir, fixture.legacyPath, 'rows'],
    fixture.root,
    10_000,
  )
  if (result.code !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}
async function prepared(fixture: MigrationFixture) {
  const modules = await loadPublicMigrationModules(fixture, inputs)
  expect(
    (
      await createAccountMigrationFactory(modules)({
        legacyPath: fixture.legacyPath,
        now: Date.now,
        offline: { processesStopped: true },
      })
    ).status,
  ).toBe('completed')
  await fs.mkdir(join(fixture.root, 'relocated'), { mode: 0o700 })
  const target = join(fixture.root, 'relocated', 'accounts.json')
  return {
    modules,
    target,
    options: {
      legacyPath: fixture.legacyPath,
      targetPath: target,
      now: Date.now,
      offline: { processesStopped: true as const },
    },
  }
}

function hasSequence(events: Event[], paths: string[]) {
  return events.some(
    (event, start) =>
      event.kind === 'sync' &&
      paths.every(
        (path, index) =>
          events[start + index]?.kind === 'sync' &&
          events[start + index]?.path === path,
      ),
  )
}

/** Trace successful real fsyncs, not boundary notifications. These assertions also catch a barrier moved past the crash seam. */
async function durablePrefix(
  fixture: MigrationFixture,
  seam: string,
  events: Event[],
) {
  for (const [index, event] of events.entries()) {
    if (event.kind !== 'rename') continue
    if (
      event.path === accountStorePointerPath(fixture.legacyPath) &&
      seam === 'relocate:forward:after-rename-before-sync'
    )
      continue
    expect(events.slice(index + 1, index + 3)).toEqual([
      { kind: 'sync', path: event.path },
      { kind: 'sync', path: dirname(event.path) },
    ])
    if (event.path.endsWith('/migration.json'))
      expect(events[index - 1]).toEqual({
        kind: 'sync',
        path: `${event.path}.${basenameOfGeneration(event.path)}.tmp`,
      })
  }
  const source = await resolvePublishedAccountStorePaths(
    fixture.legacyPath,
  ).catch(() => undefined)
  const sourceDir =
    source?.storeDir ??
    join(
      fixture.root,
      (await fs.readdir(fixture.root)).find((name) =>
        name.endsWith('.generation'),
      ) ?? 'missing',
    )
  const sourceConfig = join(sourceDir, 'config.json')
  if (seam === 'relocate:before-capture') {
    expect(events.some((event) => event.path === sourceConfig)).toBe(false)
    return
  }
  expect(
    hasSequence(events, [
      sourceConfig,
      join(sourceDir, 'state.json'),
      sourceDir,
    ]),
  ).toBe(true)
  const targetRoot = join(fixture.root, 'relocated')
  const targetDir = join(
    targetRoot,
    (await fs.readdir(targetRoot)).find((name) =>
      name.endsWith('.generation'),
    ) ?? 'missing',
  )
  const backup = events.find((event) =>
    event.path.includes(`${sep}backups${sep}`),
  )?.path
  expect(backup).toBeDefined()
  if (!backup) throw new Error('backup trace missing')
  expect(hasSequence(events, [backup, backup, dirname(backup)])).toBe(true)
  if (seam === 'relocate:capture:after-backup') return
  const pointer = accountStorePointerPath(join(targetRoot, 'accounts.json'))
  const stage = events.find(
    (event) =>
      event.path.startsWith(`${pointer}.`) && event.path.endsWith('.tmp'),
  )?.path
  expect(stage).toBeDefined()
  if (!stage) throw new Error('pointer stage trace missing')
  expect(hasSequence(events, [stage, targetRoot])).toBe(true)
  const link = events.findIndex(
    (event) => event.kind === 'link' && event.path === pointer,
  )
  if (seam === 'pointer:before-link') {
    expect(link).toBe(-1)
    return
  }
  expect(link).toBeGreaterThan(0)
  if (seam === 'pointer:after-link-before-parent-sync') return
  expect(events[link + 1]).toEqual({ kind: 'sync', path: targetRoot })
  if (
    seam === 'pointer:after-sync-before-stage-cleanup' ||
    seam === 'relocate:after-capture'
  )
    return
  const state = join(targetDir, 'state.json')
  expect(hasSequence(events, [state, state, targetDir])).toBe(true)
  if (seam === 'relocate:build:after-state') return
  const config = join(targetDir, 'config.json')
  expect(hasSequence(events, [config, config, targetDir])).toBe(true)
  if (
    seam === 'relocate:build:after-config' ||
    seam === 'public:updateSettings:before-config-write'
  )
    return
  const renamed = events.findIndex(
    (event) => event.kind === 'rename' && event.path === config,
  )
  expect(events.slice(renamed + 1, renamed + 3)).toEqual([
    { kind: 'sync', path: config },
    { kind: 'sync', path: targetDir },
  ])
  if (
    forwardSeams.indexOf(seam) >= forwardSeams.indexOf('relocate:after-verify')
  )
    expect(hasSequence(events, [config, state, targetDir])).toBe(true)
  if (
    [
      'relocate:retire:after-tombstone',
      'relocate:retire:after-drain',
      'relocate:forward:before-rename',
      'relocate:forward:after-rename-before-sync',
      'relocate:after-retire',
      'relocate:before-activate',
      'relocate:after-activate',
    ].includes(seam)
  ) {
    const tombstone = events.findIndex(
      (event) => event.kind === 'rename' && event.path === sourceConfig,
    )
    expect(tombstone).toBeGreaterThan(0)
    expect(events.slice(tombstone + 1, tombstone + 3)).toEqual([
      { kind: 'sync', path: sourceConfig },
      { kind: 'sync', path: sourceDir },
    ])
    if (seam !== 'relocate:retire:after-tombstone')
      expect(
        hasSequence(events.slice(tombstone + 3), [
          sourceConfig,
          join(sourceDir, 'state.json'),
          sourceDir,
        ]),
      ).toBe(true)
  }
  if (
    [
      'relocate:after-retire',
      'relocate:before-activate',
      'relocate:after-activate',
    ].includes(seam)
  ) {
    const oldPointer = accountStorePointerPath(fixture.legacyPath)
    const forwarded = events.findIndex(
      (event) => event.kind === 'rename' && event.path === oldPointer,
    )
    expect(events.slice(forwarded + 1, forwarded + 3)).toEqual([
      { kind: 'sync', path: oldPointer },
      { kind: 'sync', path: fixture.root },
    ])
  }
}

function basenameOfGeneration(path: string) {
  const id = dirname(path).match(/\.store\.([0-9a-f-]{36})\.generation$/)?.[1]
  if (!id) throw new Error('journal path has no generation id')
  return id
}

const forwardSeams = [
  'relocate:before-capture',
  'relocate:capture:after-backup',
  'pointer:before-link',
  'pointer:after-link-before-parent-sync',
  'pointer:after-sync-before-stage-cleanup',
  'relocate:after-capture',
  'relocate:build:after-state',
  'relocate:build:after-config',
  'public:updateSettings:before-config-write',
  'public:updateSettings:after-config-write',
  'relocate:after-build',
  'relocate:before-verify',
  'relocate:after-verify',
  'relocate:source:public:updateSettings:before-config-write',
  'relocate:source:public:updateSettings:after-config-write',
  'relocate:retire:after-tombstone',
  'relocate:retire:after-drain',
  'relocate:forward:before-rename',
  'relocate:forward:after-rename-before-sync',
  'relocate:after-retire',
  'relocate:before-activate',
  'relocate:after-activate',
]

describe.skipIf(process.platform === 'win32' || 'unavailable' in released)(
  'relocation crash matrix',
  () => {
    for (const seam of forwardSeams)
      it(`forward crash: ${seam}`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          const { modules, target, options } = await prepared(fixture)
          const expected = await rows(modules, fixture.legacyPath)
          const events = await crash(fixture, seam)
          await durablePrefix(fixture, seam, events)
          const tombstoned =
            forwardSeams.indexOf(seam) >=
            forwardSeams.indexOf(
              'relocate:source:public:updateSettings:after-config-write',
            )
          const active = seam === 'relocate:after-activate'
          const old = await oldRead(fixture)
          if (!tombstoned) {
            expect(old.bind.status).toBe('bound')
            expect(old.read.rows).toEqual(expected)
          } else {
            expect(old.bind.status).not.toBe('bound')
            expect(old.bind.reason ?? old.bind.status).toMatch(
              /pending|unknown fields/,
            )
          }
          const admissions = await Promise.all(
            [fixture.legacyPath, target].map((anchor) =>
              readAccountStoreAdmission(anchor, modules, Date.now),
            ),
          )
          // Both anchors may resolve the same generation; count physical authorities, not aliases.
          const serving = new Set(
            admissions.flatMap((admission) =>
              admission.status === 'active' ? [admission.receipt.id] : [],
            ),
          )
          expect(serving.size).toBe(tombstoned && !active ? 0 : 1)
          expect(
            (await createAccountRelocationFactory(modules)(options)).status,
          ).toBe('completed')
          expect(await rows(modules, target)).toEqual(expected)
          for (const anchor of [fixture.legacyPath, target])
            expect(
              (await readAccountStoreAdmission(anchor, modules, Date.now))
                .status,
            ).toBe('active')
        })
      }, 30_000)

    for (const seam of [
      'relocate:back:before-clone',
      'relocate:back:after-state',
      'relocate:back:after-clone',
      'relocate:back:after-management-clear',
      'relocate:back:after-record',
      'relocate:back:pointer:before-rename',
      'relocate:back:pointer:after-rename-before-sync',
      'relocate:back:after-pointer',
    ])
      it(`reverse crash: ${seam}`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          const { modules, target, options } = await prepared(fixture)
          expect(
            (await createAccountRelocationFactory(modules)(options)).status,
          ).toBe('completed')
          const expected = await rows(modules, target)
          const originalDir = join(
            fixture.root,
            (await fs.readdir(fixture.root)).find((name) =>
              name.endsWith('.generation'),
            ) ?? 'missing',
          )
          const originalJournal = await fs.readFile(
            join(originalDir, 'migration.json'),
          )
          const events = await crash(fixture, seam, true)
          for (const [index, event] of events.entries()) {
            if (event.kind !== 'rename') continue
            if (
              event.path === accountStorePointerPath(fixture.legacyPath) &&
              seam === 'relocate:back:pointer:after-rename-before-sync'
            )
              continue
            expect(events.slice(index + 1, index + 3)).toEqual([
              { kind: 'sync', path: event.path },
              { kind: 'sync', path: dirname(event.path) },
            ])
          }
          const flipped =
            seam === 'relocate:back:pointer:after-rename-before-sync' ||
            seam === 'relocate:back:after-pointer'
          const old = await oldRead(fixture)
          expect(old.bind.status).toBe(flipped ? 'bound' : 'error')
          if (flipped) expect(old.read.rows).toEqual(expected)
          const serving = new Set<string>()
          for (const anchor of [fixture.legacyPath, target]) {
            const admitted = await readAccountStoreAdmission(
              anchor,
              modules,
              Date.now,
            )
            expect(admitted.status).toBe('active')
            if (admitted.status === 'active') serving.add(admitted.receipt.id)
          }
          expect(serving.size).toBe(1)
          if (seam !== 'relocate:back:before-clone') {
            const state = join(originalDir, 'state.json')
            const renamed = events.findIndex(
              (event) => event.kind === 'rename' && event.path === state,
            )
            expect(events.slice(renamed + 1, renamed + 3)).toEqual([
              { kind: 'sync', path: state },
              { kind: 'sync', path: originalDir },
            ])
          }
          if (seam === 'relocate:back:after-pointer') {
            const pointer = accountStorePointerPath(fixture.legacyPath)
            const renamed = events.findIndex(
              (event) => event.kind === 'rename' && event.path === pointer,
            )
            expect(events.slice(renamed + 1, renamed + 3)).toEqual([
              { kind: 'sync', path: pointer },
              { kind: 'sync', path: fixture.root },
            ])
          }
          expect(
            (
              await createAccountRelocationFactory(modules)({
                ...options,
                legacyPath: target,
                targetPath: fixture.legacyPath,
                back: true,
              })
            ).status,
          ).toBe('completed')
          expect(await rows(modules, fixture.legacyPath)).toEqual(expected)
          expect(
            await fs.readFile(join(originalDir, 'migration.json')),
          ).toEqual(originalJournal)
          const recovered = await oldRead(fixture)
          expect(recovered.bind.status).toBe('bound')
          expect(recovered.read.rows).toEqual(expected)
        })
      }, 30_000)

    for (const failure of ['snapshot file', 'forward directory'] as const)
      it(`refuses acknowledgment when the ${failure} sync fails`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          const { modules, target, options } = await prepared(fixture)
          const expected = await rows(modules, fixture.legacyPath)
          const source = await resolvePublishedAccountStorePaths(
            fixture.legacyPath,
          )
          if (!source) throw new Error('source missing')
          const actualOpen = fs.open
          let forwarded = false
          let injected = false
          const opened = spyOn(fs, 'open').mockImplementation(
            async (...args) => {
              const handle = await actualOpen(...args)
              const path = String(args[0])
              const actualSync = handle.sync.bind(handle)
              handle.sync = async () => {
                if (
                  !injected &&
                  (failure === 'snapshot file'
                    ? path === source.configPath
                    : forwarded && path === fixture.root)
                ) {
                  injected = true
                  throw new Error(`injected ${failure} sync failure`)
                }
                await actualSync()
              }
              return handle
            },
          )
          try {
            await expect(
              createAccountRelocationFactory(modules)({
                ...options,
                onBoundary(point) {
                  if (point === 'relocate:forward:after-rename-before-sync')
                    forwarded = true
                },
              }),
            ).rejects.toThrow(`injected ${failure} sync failure`)
            expect(injected).toBe(true)
            const paths = await resolvePublishedAccountStorePaths(target)
            if (failure === 'snapshot file') expect(paths).toBeUndefined()
            else {
              if (!paths) throw new Error('pending destination missing')
              expect(
                decodeAccountMigrationJournal(
                  JSON.parse(await fs.readFile(paths.migrationPath, 'utf8')),
                ).status,
              ).toBe('pending')
            }
          } finally {
            opened.mockRestore()
          }
          expect(
            (await createAccountRelocationFactory(modules)(options)).status,
          ).toBe('completed')
          expect(await rows(modules, target)).toEqual(expected)
        })
      }, 30_000)
  },
)
