import { describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withMigrationFixtures } from '../../../test/common-auth-010-store/migration-child.ts'
import { createAccountMigrationFactory } from './account-migration.ts'
import { loadCommonAuthStoreModules } from './common-auth-runtime.ts'

// Keep the real writes and syncs: the observer must describe durability, not replace it.
async function recordMigration(legacyPath: string, observed: boolean) {
  const modules = await loadCommonAuthStoreModules()
  const calls: string[] = []
  const boundaries: string[] = []
  const syncs: string[] = []
  const active: string[] = []
  const root = dirname(legacyPath)
  const normalized = (path: string) =>
    path
      .replaceAll(root, '<root>')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')
      .replace(/[0-9a-f]{64}/g, '<digest>')
  const actualOpen = fs.open
  const actualRename = fs.rename
  const actualLink = fs.link
  const opened = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = normalized(String(args[0]))
    calls.push(`open:${path}:${args[1]}:${args[2] ?? ''}`)
    const handle = await actualOpen(...args)
    // Known fixture directories avoid adding stat calls to the measured I/O.
    const directory =
      path === '<root>' ||
      path.endsWith('.generation') ||
      ['backups', 'retired', 'transfers'].includes(basename(path))
    const actualSync = handle.sync.bind(handle)
    const actualWrite = handle.writeFile.bind(handle)
    const actualClose = handle.close.bind(handle)
    handle.sync = async () => {
      calls.push(`sync:${path}`)
      if (!directory) {
        syncs.push(active.at(-1) ?? 'unobserved')
      }
      await actualSync()
    }
    handle.writeFile = async (...writeArgs) => {
      calls.push(`write:${path}`)
      return actualWrite(...writeArgs)
    }
    handle.close = async () => {
      calls.push(`close:${path}`)
      return actualClose()
    }
    return handle
  })
  const renamed = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    calls.push(
      `rename:${normalized(String(args[0]))}:${normalized(String(args[1]))}`,
    )
    return actualRename(...args)
  })
  const linked = spyOn(fs, 'link').mockImplementation(async (...args) => {
    calls.push(
      `link:${normalized(String(args[0]))}:${normalized(String(args[1]))}`,
    )
    return actualLink(...args)
  })
  try {
    const outcome = await createAccountMigrationFactory(modules)({
      legacyPath,
      offline: { processesStopped: true },
      now: () => 100,
      ...(observed
        ? {
            onBoundary: (boundary: string) => {
              const pair = /^(before|after)-file-sync:([a-z-]+)$/.exec(boundary)
              if (!pair) return
              boundaries.push(boundary)
              if (pair[1] === 'before') {
                expect(active).toEqual([])
                active.push(pair[2] ?? '')
              } else expect(active.pop()).toBe(pair[2])
            },
          }
        : {}),
    })
    expect(outcome.status).toBe('completed')
    expect(active).toEqual([])
    return { calls, boundaries, syncs }
  } finally {
    opened.mockRestore()
    renamed.mockRestore()
    linked.mockRestore()
  }
}

describe('migration file-sync observer', () => {
  it('balances every real file sync with a role-only before/after pair', async () => {
    await withMigrationFixtures(async (create) => {
      const observed = await recordMigration((await create()).legacyPath, true)
      expect(observed.syncs.length).toBeGreaterThan(0)
      expect(observed.syncs).not.toContain('unobserved')
      expect(observed.boundaries).toEqual(
        observed.syncs.flatMap((role) => [
          `before-file-sync:${role}`,
          `after-file-sync:${role}`,
        ]),
      )
      expect(observed.syncs).toEqual(
        expect.arrayContaining([
          'backup',
          'capture-record',
          'journal-stage',
          'journal',
          'pointer-stage',
          'config',
          'state',
        ]),
      )
    })
  })

  it('keeps the filesystem operation sequence identical without an observer', async () => {
    await withMigrationFixtures(async (create) => {
      const observed = await recordMigration((await create()).legacyPath, true)
      const unobserved = await recordMigration(
        (await create()).legacyPath,
        false,
      )
      expect(unobserved.boundaries).toEqual([])
      expect(unobserved.syncs).toHaveLength(observed.syncs.length)
      expect(unobserved.calls).toEqual(observed.calls)
      if (process.env.MIGRATION_FILE_SYNC_TRACE === '1')
        console.log(
          `MIGRATION_FILE_SYNC_TRACE=${JSON.stringify({
            sha256: createHash('sha256')
              .update(JSON.stringify(unobserved.calls))
              .digest('hex'),
            calls: unobserved.calls.length,
            fileSyncs: unobserved.syncs.length,
            operations: Object.fromEntries(
              ['open', 'write', 'sync', 'close', 'rename', 'link'].map(
                (kind) => [
                  kind,
                  unobserved.calls.filter((call) => call.startsWith(`${kind}:`))
                    .length,
                ],
              ),
            ),
          })}`,
        )
    })
  })
})
