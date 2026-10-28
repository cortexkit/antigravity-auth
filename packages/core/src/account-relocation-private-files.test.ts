import { expect, it, mock } from 'bun:test'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

it('creates forward and reverse relocation artifacts privately without permission migration', async () => {
  // Snapshot real IO before mocking it: only the injected private-files backend
  // may create objects during relocation. Fixtures are outside the observation.
  const io = { ...fs }
  const root = await io.realpath(
    await io.mkdtemp(join(tmpdir(), 'agy-relocation-private-')),
  )
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const emitWarning = process.emitWarning
  const privateObjects = new Set<string>()
  const privateCreates: { kind: 'file' | 'dir'; path: string }[] = []
  const plainWrites: string[] = []
  const warnings: string[] = []
  let observing = false
  const identity = async (path: string) => {
    const stat = await io.lstat(path)
    return `${stat.dev}:${stat.ino}`
  }
  const markPrivate = async (path: string) => {
    privateObjects.add(await identity(path))
  }
  const recordPlain = (operation: string, path: unknown) => {
    if (observing) plainWrites.push(`${operation}: ${String(path)}`)
  }
  const backend = {
    NOT_PROTECTED: 'not-protected',
    EXTRA_ACE: 'extra-ace',
    NULL_DACL: 'null-dacl',
    EMPTY_DACL: 'empty-dacl',
    async verifySafeParent(path: string) {
      await io.stat(path)
      return { ok: true as const }
    },
    async createOwnerOnly(path: string, options: { kind: 'file' | 'dir' }) {
      if (options.kind === 'dir') await io.mkdir(path, { mode: 0o700 })
      else await io.writeFile(path, '', { flag: 'wx', mode: 0o600 })
      await markPrivate(path)
      if (observing) privateCreates.push({ kind: options.kind, path })
    },
    async createPrivateFile(path: string, bytes: string | Uint8Array) {
      await io.writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      await markPrivate(path)
      if (observing) privateCreates.push({ kind: 'file', path })
    },
    async verifyOwnerOnly(path: string) {
      return privateObjects.has(await identity(path))
        ? { ok: true as const }
        : {
            ok: false as const,
            refusal: { reason: 'not-protected' as const },
          }
    },
    async verifyPrivatePath(path: string, kind: string) {
      const stat = await io.lstat(path)
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
        throw new Error(`wrong object kind: ${path}`)
      if (kind === 'file' && !privateObjects.has(await identity(path)))
        throw new Error(`not privately created: ${path}`)
    },
    async securePrivatePath(path: string) {
      await markPrivate(path)
    },
    async readOwnerOnly(path: string) {
      await backend.verifyPrivatePath(path, 'file')
      return io.readFile(path)
    },
  }
  let resetBackend: (() => void) | undefined
  try {
    mock.module('node:fs/promises', () => ({
      ...io,
      mkdir: (...args: Parameters<typeof fs.mkdir>) => {
        recordPlain('mkdir', args[0])
        return io.mkdir(...args)
      },
      writeFile: (...args: Parameters<typeof fs.writeFile>) => {
        recordPlain('writeFile', args[0])
        return io.writeFile(...args)
      },
      copyFile: (...args: Parameters<typeof fs.copyFile>) => {
        recordPlain('copyFile', args[1])
        return io.copyFile(...args)
      },
      cp: (...args: Parameters<typeof fs.cp>) => {
        recordPlain('cp', args[1])
        return io.cp(...args)
      },
      open: async (...args: Parameters<typeof fs.open>) => {
        const flags = args[1]
        if (
          typeof flags === 'string'
            ? /[wa]/.test(flags)
            : typeof flags === 'number' && (flags & constants.O_CREAT) !== 0
        )
          recordPlain('open for write', args[0])
        const handle = await io.open(...args)
        const writeFile = handle.writeFile.bind(handle)
        handle.writeFile = (...writeArgs) => {
          recordPlain('handle.writeFile', args[0])
          return writeFile(...writeArgs)
        }
        return handle
      },
    }))
    // All embedded filesystem modules snapshot the platform on first import.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const privateFiles = await import(
      './common-auth-embedded/fs/private-files.js'
    )
    privateFiles.setPrivateFilesBackendForTest(
      backend as unknown as Parameters<
        typeof privateFiles.setPrivateFilesBackendForTest
      >[0],
    )
    resetBackend = () => privateFiles.setPrivateFilesBackendForTest()
    const migration = await import('./account-migration.ts')
    const { loadCommonAuthStoreModules } = await import(
      './common-auth-runtime.ts'
    )
    const modules = await loadCommonAuthStoreModules()
    await io.mkdir(join(root, 'config'), { mode: 0o700 })
    await io.mkdir(join(root, 'state'), { mode: 0o700 })
    const legacyPath = join(root, 'config', 'accounts.json')
    const targetPath = join(root, 'state', 'accounts.json')
    await backend.createPrivateFile(
      legacyPath,
      JSON.stringify({
        version: 4,
        accounts: [
          {
            refreshToken: 'synthetic-private-relocation',
            addedAt: 1,
            lastUsed: 1,
            email: 'é@example.test',
          },
        ],
        activeIndex: 0,
      }),
    )
    expect(
      (
        await migration.createAccountMigrationFactory(modules)({
          legacyPath,
          offline: { processesStopped: true },
          now: Date.now,
        })
      ).status,
    ).toBe('completed')
    const original =
      await migration.resolvePublishedAccountStorePaths(legacyPath)
    if (!original) throw new Error('source generation missing')
    const sourceState = await io.readFile(original.statePath)
    const relocate = migration.createAccountRelocationFactory(modules)
    process.emitWarning = ((warning, type) => {
      if (type === 'PrivateFileMigration') warnings.push(String(warning))
    }) as typeof process.emitWarning
    observing = true
    const moved = await relocate({
      legacyPath,
      targetPath,
      offline: { processesStopped: true },
      now: Date.now,
    })
    expect(moved.status).toBe('completed')
    const target = await migration.resolvePublishedAccountStorePaths(targetPath)
    if (!target) throw new Error('target generation missing')
    expect(await io.readFile(target.statePath)).toEqual(sourceState)
    const forwardCreates = [...privateCreates]
    privateCreates.length = 0
    expect(
      (
        await relocate({
          legacyPath: targetPath,
          targetPath: legacyPath,
          back: true,
          offline: { processesStopped: true },
          now: Date.now,
        })
      ).status,
    ).toBe('completed')
    expect(await io.readFile(original.statePath)).toEqual(sourceState)
    expect(
      JSON.parse(
        await io.readFile(
          migration.accountStorePointerPath(legacyPath),
          'utf8',
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      id: basename(original.storeDir).split('.').at(-2),
      directoryBasename: basename(original.storeDir),
    })
    expect(plainWrites).toEqual([])
    expect(warnings).toEqual([])

    const directories = forwardCreates
      .filter((entry) => entry.kind === 'dir')
      .map((entry) => entry.path)
    for (const path of [
      target.storeDir,
      target.backupsDir,
      target.retiredDir,
      target.transfersDir,
    ])
      expect(directories).toContain(path)
    const files = forwardCreates
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
    expect(files).toContain(target.configPath)
    expect(files).toContain(target.statePath)
    expect(
      files.some((path) => path.startsWith(`${target.migrationPath}.`)),
    ).toBe(true)
    expect(files.some((path) => dirname(path) === target.backupsDir)).toBe(true)
    expect(files.some((path) => path.endsWith('.capture.json'))).toBe(true)
    expect(
      files.some((path) =>
        path.startsWith(`${migration.accountStorePointerPath(legacyPath)}.`),
      ),
    ).toBe(true)
    expect(
      files.some((path) =>
        path.startsWith(`${migration.accountStorePointerPath(targetPath)}.`),
      ),
    ).toBe(true)
    const reverseFiles = privateCreates
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
    expect(
      reverseFiles.some((path) => path.startsWith(`${original.configPath}.`)),
    ).toBe(true)
    expect(
      reverseFiles.some((path) => path.startsWith(`${original.statePath}.`)),
    ).toBe(true)
    expect(reverseFiles.some((path) => path.includes('.reverse.json.'))).toBe(
      true,
    )
    expect(
      reverseFiles.some((path) => path.endsWith('.reverse-snapshot.json')),
    ).toBe(true)
    expect(
      reverseFiles.some((path) =>
        path.startsWith(`${migration.accountStorePointerPath(legacyPath)}.`),
      ),
    ).toBe(true)
  } finally {
    observing = false
    process.emitWarning = emitWarning
    resetBackend?.()
    Object.defineProperty(process, 'platform', platform)
    mock.restore()
    await io.rm(root, { recursive: true, force: true })
  }
}, 30_000)
