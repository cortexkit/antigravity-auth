// The one-time move of the vault files (enrollment token and state, roster,
// provider state, mode) out of OpenCode's config folder into the state home,
// and the resolver that follows it. Real files in temporary folders
// throughout; the real-process tests run `__fixtures__/runtime-layout-process.ts`.
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enrollmentAuthority,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
} from '@cortexkit/antigravity-auth-core'

import { OPENCODE_VAULT_ENROLLMENT_NAME } from './plugin/vault-custody'
import {
  __resetProcessHeartbeatForTest,
  processHeartbeatPath,
  startProcessHeartbeat,
} from './process-heartbeat'
import {
  __resetRuntimeLayoutRunsForTest,
  prepareRuntimeLayout,
  RUNTIME_LAYOUT_DEFERRED_MESSAGE,
  type RuntimeLayoutOptions,
  removeMovedVaultStateLeftover,
  VAULT_FILE_NAMES,
} from './runtime-layout'
import {
  __resetRuntimeLayoutsForTest,
  getVaultDir,
  runtimeLayoutLocation,
} from './runtime-paths'
import { processHeartbeatDir } from './version-fence'

const VERSION = '3.0.14'
const ENV_NAMES = ['OPENCODE_CONFIG_DIR', 'XDG_STATE_HOME'] as const
const POSIX = process.platform !== 'win32'
const NAME = OPENCODE_VAULT_ENROLLMENT_NAME

let root: string
let saved: Record<string, string | undefined>
let logged: { level: string; message: string; meta?: unknown }[]
let count = 0

function testRoot(): string {
  const value = process.env.ANTIGRAVITY_TEST_ROOT
  if (!value) throw new Error('test/setup.ts did not pin ANTIGRAVITY_TEST_ROOT')
  return value
}

beforeEach(() => {
  count++
  const dir = join(testRoot(), 'runtime-layout', String(count))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  root = realpathSync.native(dir)
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  process.env.OPENCODE_CONFIG_DIR = join(root, 'config', 'opencode')
  process.env.XDG_STATE_HOME = join(root, 'state')
  resetProcess()
  logged = []
})

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetProcess()
  try {
    chmodSync(join(root, 'state'), 0o700)
  } catch {}
})

/** Stands in for a new process: nothing decided, nothing logged. */
function resetProcess() {
  __resetRuntimeLayoutsForTest()
  __resetRuntimeLayoutRunsForTest()
  __resetProcessHeartbeatForTest()
}

/**
 * Runs the vault layout decision. These tests are about vault files and
 * paths, so the account store's own decision is settled separately: no store
 * exists here, and a move would create one in the state folder.
 */
function prepare(options: Partial<RuntimeLayoutOptions> = {}) {
  return prepareRuntimeLayout({
    version: VERSION,
    log: {
      info: (message, meta) => logged.push({ level: 'info', message, meta }),
      warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    },
    relocate: async () => ({ status: 'cancelled' }),
    ...options,
  })
}

/** OpenCode's config folder in these tests. */
const configDir = () => join(root, 'config', 'opencode')
/** The state-home folder the resolver names for that config folder. */
const runtimeDir = () => runtimeLayoutLocation().stateHomeDir
const oldVault = () => join(configDir(), 'antigravity-auth-vault')
const newVault = () => join(runtimeDir(), 'antigravity-auth-vault')

function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Windows only: open `path` the way an antivirus scan or another program can,
 * sharing nothing, so every other attempt to read or remove it fails with a
 * sharing violation (EBUSY) until the returned function closes it.
 */
function holdWithoutSharing(path: string): () => void {
  const kernel32 = dlopen('kernel32.dll', {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  })
  const GENERIC_READ = 0x80000000
  const NO_SHARING = 0
  const OPEN_EXISTING = 3
  const FILE_ATTRIBUTE_NORMAL = 0x80
  const name = Buffer.from(`${path}\0`, 'utf16le')
  const handle = kernel32.symbols.CreateFileW(
    ptr(name),
    GENERIC_READ,
    NO_SHARING,
    null,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    null,
  )
  // INVALID_HANDLE_VALUE
  if (BigInt(handle) === -1n) {
    kernel32.close()
    throw new Error(`could not open ${path} without sharing`)
  }
  return () => {
    kernel32.symbols.CloseHandle(handle)
    kernel32.close()
  }
}

/** The start of the one warning a clean-up that left old vault files logs. */
const CLEANUP_FAILED =
  'antigravity-auth could not finish removing its old vault files'

/** Every warning logged so far that says the clean-up left old files. */
const cleanupWarnings = () =>
  logged.filter(
    (line) => line.level === 'warn' && line.message.startsWith(CLEANUP_FAILED),
  )

/** Exactly one clean-up warning, naming the step and the kept file. */
const oneCleanupWarning = (relative: string) => [
  expect.objectContaining({
    level: 'warn',
    meta: expect.objectContaining({
      step: 'remove-old-copies',
      errorClass: 'old-files-kept',
      file: basename(relative),
    }),
  }),
]
const TOKEN = 'antigravity-auth-vault/opencode-enrollment.json'
const VAULT_STATE = 'antigravity-auth-vault/opencode-enrollment-state.json'
const ROSTER = 'antigravity-auth-vault/opencode-roster.json'
const VAULT_RELATIVE = VAULT_FILE_NAMES.map(
  (name) => `antigravity-auth-vault/${name}`,
)

const approvedState = (updatedAt = 1) =>
  `${JSON.stringify({
    version: 1,
    phase: 'approved',
    proposedName: NAME,
    approvedName: NAME,
    tokenGeneration: 1,
    updatedAt,
  })}\n`

/** Every vault file of the old layout, relative to the config folder. */
function oldLayout(tag = 'a'): Record<string, string> {
  return {
    [TOKEN]: JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    [VAULT_STATE]: approvedState(),
    'antigravity-auth-vault/opencode-roster.json': `${JSON.stringify({ version: 1, accounts: [], tag })}\n`,
    'antigravity-auth-vault/opencode-state.json': `${JSON.stringify({ version: 1, accounts: {}, tag })}\n`,
    'antigravity-auth-vault/opencode-mode.json': `${JSON.stringify({ version: 1, mode: 'custody' })}\n`,
  }
}

/** The old layout with an enrollment that waits for approval. */
function pendingLayout(): Record<string, string> {
  const { [TOKEN]: _token, ...rest } = oldLayout()
  return {
    ...rest,
    [VAULT_STATE]: `${JSON.stringify({
      version: 1,
      phase: 'pending',
      proposedName: NAME,
      requestSecret: 'ab'.repeat(32),
      requestId: 'request-1',
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
  }
}

function seed(dir: string, files: Record<string, string>) {
  for (const [relative, text] of Object.entries(files))
    writePrivate(join(dir, relative), text)
}

function present(dir: string, files: Record<string, string>) {
  return Object.fromEntries(
    Object.keys(files).map((relative) => {
      const path = join(dir, relative)
      return [relative, existsSync(path) ? readFileSync(path, 'utf8') : null]
    }),
  )
}

const absent = (files: Record<string, string>) =>
  Object.fromEntries(Object.keys(files).map((relative) => [relative, null]))

/**
 * What a finished move leaves of `files` in the config folder: only an
 * approved enrollment state file, byte for byte, so older versions stay in
 * vault mode.
 */
const leftAfterMove = (files: Record<string, string>) => ({
  ...absent(files),
  ...(VAULT_STATE in files && files[VAULT_STATE]?.includes('"approved"')
    ? { [VAULT_STATE]: files[VAULT_STATE] }
    : {}),
})

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

function marker(dir = runtimeDir()) {
  const path = join(dir, 'layout.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

async function authorityAt(vaultDir: string) {
  const claustrum = await loadCommonAuthClaustrum()
  return enrollmentAuthority(
    claustrum.hostEnrollmentPaths({ stateDir: vaultDir, host: 'opencode' }),
    NAME,
  )
}

/** The vault mode an older version reads from OpenCode's config folder. */
const oldFolderAuthority = () => authorityAt(oldVault())

function heartbeat(pid: number, body: Record<string, unknown>) {
  const dir = processHeartbeatDir(join(root, 'state'))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${pid}.json`)
  writeFileSync(path, JSON.stringify({ pid, startedAt: 1, ...body }))
  return path
}

const layoutLockPath = () =>
  `${join(runtimeDir(), 'layout.json')}.runtime-layout.lock`

/** Another process takes the layout lease over from this one. */
function stealLayoutLease() {
  writeFileSync(
    layoutLockPath(),
    JSON.stringify({
      ownerId: 'another-process',
      expiresAt: Date.now() + 60_000,
    }),
  )
}

const REFUSED = /^antigravity-auth cannot start: /

const conflictMessage = (relative: string) =>
  `antigravity-auth cannot start: vault files conflict between ${join(configDir(), relative)} and ${join(runtimeDir(), relative)}. Keep the newer one, delete the other, then restart OpenCode.`

/**
 * A vault client that records every call. Approves the pending request when
 * `approve` is set; a vault with a valid token on disk is never called.
 */
function fakeVaultClient(approve?: { token: string; generation: number }) {
  const calls: string[] = []
  return {
    calls,
    client: {
      async enrollPropose() {
        calls.push('propose')
        return { requestId: 'request-new' }
      },
      async enrollPoll() {
        calls.push('poll')
        return approve
          ? {
              status: 'approved',
              token: approve.token,
              tokenGeneration: approve.generation,
              name: NAME,
            }
          : { status: 'pending' }
      },
    },
  }
}

/** Reconcile the enrollment in `vaultDir` the way vault custody does. */
async function reconcileAt(
  vaultDir: string,
  client: ReturnType<typeof fakeVaultClient>['client'],
) {
  const claustrum = await loadCommonAuthClaustrum()
  const manager = new claustrum.ClaustrumEnrollmentManager({
    client: client as never,
    paths: claustrum.hostEnrollmentPaths({
      stateDir: vaultDir,
      host: 'opencode',
    }),
    proposedName: NAME,
  })
  return manager.reconcile()
}

/** The token a scoped vault operation reads, from `vaultDir`. */
async function tokenAt(vaultDir: string) {
  const claustrum = await loadCommonAuthClaustrum()
  return claustrum.readClaustrumEnrollmentToken(
    claustrum.hostEnrollmentPaths({ stateDir: vaultDir, host: 'opencode' })
      .tokenPath,
  )
}

describe('the vault layout on a fresh install', () => {
  it('writes the marker and resolves the vault folder in the state home', async () => {
    expect(await prepare()).toBe('state-home')
    expect(runtimeDir()).toMatch(/[\\/]opencode-[0-9a-f]{16}$/)
    expect(marker()).toEqual({
      version: 1,
      oldDir: runtimeLayoutLocation().key,
      oldFilesRemoved: true,
    })
    expect(getVaultDir()).toBe(newVault())
    expect(
      JSON.parse(readFileSync(join(runtimeDir(), 'config-dir.json'), 'utf8')),
    ).toEqual({ version: 1, configDir: runtimeLayoutLocation().key })
    if (POSIX) expect(statSync(runtimeDir()).mode & 0o777).toBe(0o700)
    // Choosing the vault layout alone never authorizes account-store work.
    expect(existsSync(configDir()) ? readdirSync(configDir()) : []).toEqual([])
  })

  it('a tool that never prepared follows the marker alone', async () => {
    expect(getVaultDir()).toBe(oldVault())
    await prepare()
    resetProcess()
    expect(getVaultDir()).toBe(newVault())
  })
})

describe('moving an existing vault folder', () => {
  it('moves the five vault files byte for byte, removes the old token and keeps vault mode', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    writePrivate(join(configDir(), 'antigravity.json'), '{"keep":true}\n')
    writePrivate(join(configDir(), 'antigravity-accounts.json'), '{"a":1}\n')
    expect(await authorityAt(oldVault())).toBe('vault')

    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    // Only the approved enrollment state stays in the old vault folder.
    expect(readdirSync(oldVault())).toEqual(['opencode-enrollment-state.json'])
    // The settings and the account store stay in the config folder.
    expect(readFileSync(join(configDir(), 'antigravity.json'), 'utf8')).toBe(
      '{"keep":true}\n',
    )
    expect(
      readFileSync(join(configDir(), 'antigravity-accounts.json'), 'utf8'),
    ).toBe('{"a":1}\n')
    expect(getVaultDir()).toBe(newVault())
    expect(await authorityAt(getVaultDir())).toBe('vault')
    if (POSIX) {
      for (const name of VAULT_FILE_NAMES)
        expect(statSync(join(newVault(), name)).mode & 0o777).toBe(0o600)
      expect(statSync(newVault()).mode & 0o777).toBe(0o700)
    }
    expect(marker()).toEqual({
      version: 1,
      oldDir: runtimeLayoutLocation().key,
      oldFilesRemoved: true,
      keptVaultState: sha256(files[VAULT_STATE] as string),
    })
    expect(existsSync(join(runtimeDir(), 'layout-moving.json'))).toBe(false)
    expect(logged.map((line) => line.message)).toContain(
      "antigravity-auth moved its vault files out of OpenCode's config folder",
    )
  })

  it('Pi vault files sharing antigravity-auth-vault are neither moved nor removed', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const pi = {
      'antigravity-auth-vault/pi-enrollment.json': '{"pi":"token"}\n',
      'antigravity-auth-vault/pi-enrollment-state.json': '{"pi":"state"}\n',
      'antigravity-auth-vault/pi-roster.json': '{"pi":"roster"}\n',
      'antigravity-auth-vault/google-login-stash.json': '{"pi":"stash"}\n',
    }
    seed(configDir(), pi)
    expect(await prepare()).toBe('state-home')
    expect(present(configDir(), pi)).toEqual(pi)
    expect(present(runtimeDir(), pi)).toEqual(absent(pi))
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    // A later start does not count Pi's files as reappeared vault files.
    resetProcess()
    expect(await prepare()).toBe('state-home')
  })

  it('an approved enrollment moves and serves without re-enrolling', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const vault = fakeVaultClient()
    expect(await reconcileAt(getVaultDir(), vault.client)).toMatchObject({
      state: 'approved',
      tokenGeneration: 1,
    })
    expect(vault.calls).toEqual([])
    expect((await tokenAt(getVaultDir())).token).toBe('01'.repeat(32))
  })

  it('a pending enrollment moves, and its approval lands in the new folder', async () => {
    const files = pendingLayout()
    seed(configDir(), files)
    expect(await prepare()).toBe('state-home')
    // A pending state protects nothing in the old folder: it is removed.
    expect(present(configDir(), files)).toEqual(absent(files))
    expect(existsSync(oldVault())).toBe(false)
    expect(marker()?.keptVaultState).toBeUndefined()

    const vault = fakeVaultClient({ token: 'cd'.repeat(32), generation: 2 })
    expect(await reconcileAt(getVaultDir(), vault.client)).toMatchObject({
      state: 'approved',
    })
    // The request the old folder proposed is polled, not proposed again.
    expect(vault.calls).toEqual(['poll'])
    expect((await tokenAt(newVault())).token).toBe('cd'.repeat(32))
    expect(existsSync(join(configDir(), TOKEN))).toBe(false)
  })

  it('a crash after the copy and before the marker leaves the old files authoritative; the next start completes', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(
      await prepare({
        steps: {
          afterCopy: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
    expect(getVaultDir()).toBe(oldVault())

    // A later start: the old files changed meanwhile (they were still
    // authoritative), so the partial copies must not survive.
    const changed: Record<string, string> = {
      ...files,
      'antigravity-auth-vault/opencode-roster.json': '{"changed":true}\n',
    }
    seed(configDir(), changed)
    rmSync(join(configDir(), 'antigravity-auth-vault/opencode-mode.json'))
    const { 'antigravity-auth-vault/opencode-mode.json': _gone, ...remaining } =
      changed
    // This process's own heartbeat says legacy; the next start is another
    // process, which would not skip it.
    rmSync(processHeartbeatPath(), { force: true })
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), changed)).toEqual({
      ...remaining,
      'antigravity-auth-vault/opencode-mode.json': null,
    })
    expect(present(configDir(), changed)).toEqual(leftAfterMove(changed))
  })

  it('a crash after the marker: the next start removes identical leftovers', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('state-home')
    expect(marker()).toEqual({
      version: 1,
      oldDir: runtimeLayoutLocation().key,
      keptVaultState: sha256(files[VAULT_STATE] as string),
    })
    expect(present(configDir(), files)).toEqual(files)
    expect(present(runtimeDir(), files)).toEqual(files)

    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(join(runtimeDir(), 'layout-moving.json'))).toBe(false)
  })

  it.each(
    VAULT_RELATIVE,
  )('refuses changed old vault files during immediate clean-up: %s', async (relative) => {
    seed(configDir(), oldLayout())
    const original = readFileSync(join(configDir(), relative), 'utf8')
    await expect(
      prepare({
        steps: {
          afterMarker: () => {
            writePrivate(join(configDir(), relative), 'newer\n')
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: conflictMessage(relative),
    })
    expect(marker()?.oldFilesRemoved).not.toBe(true)
    expect(readFileSync(join(configDir(), relative), 'utf8')).toBe('newer\n')
    expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(original)
  })

  it.each(
    VAULT_RELATIVE,
  )('refuses changed old vault files when clean-up retries after a crash: %s', async (relative) => {
    seed(configDir(), oldLayout())
    const original = readFileSync(join(configDir(), relative), 'utf8')
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    writePrivate(join(configDir(), relative), 'newer\n')
    resetProcess()
    await expect(prepare()).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: conflictMessage(relative),
    })
    expect(marker()?.oldFilesRemoved).not.toBe(true)
    expect(readFileSync(join(configDir(), relative), 'utf8')).toBe('newer\n')
    expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(original)
  })

  it.each(
    VAULT_RELATIVE,
  )('refuses clean-up when the new copy cannot be compared: %s', async (relative) => {
    seed(configDir(), oldLayout())
    await expect(
      prepare({
        steps: {
          afterMarker: () => {
            rmSync(join(runtimeDir(), relative))
          },
        },
      }),
    ).rejects.toThrow(conflictMessage(relative))
    expect(existsSync(join(configDir(), relative))).toBe(true)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it.each(
    VAULT_RELATIVE,
  )('refuses old vault files that reappear after a finished move: %s', async (relative) => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare()
    expect(marker()?.oldFilesRemoved).toBe(true)
    writePrivate(join(configDir(), relative), 'newer\n')
    resetProcess()
    await expect(prepare()).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: conflictMessage(relative),
    })
    expect(readFileSync(join(configDir(), relative), 'utf8')).toBe('newer\n')
    expect(readFileSync(join(runtimeDir(), relative), 'utf8')).toBe(
      files[relative] as string,
    )
  })

  it.each([
    ['claustrum-roster-write', 'antigravity-auth-vault/opencode-roster.json'],
    ['ceremony', VAULT_STATE],
  ])('clean-up after a crash waits for the %s lock and compares again before it unlinks', async (name, relative) => {
    seed(configDir(), oldLayout())
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    const old = join(configDir(), relative)
    // A vault writer holds its own lock on the old file and replaces it.
    const fs = await loadCommonAuthFs()
    const held = await fs.acquireRefreshFileLock({
      name,
      path: old,
      ttlMs: 10_000,
    })
    expect(held).not.toBeNull()
    resetProcess()
    let settled = false
    const run = prepare().then((layout) => {
      settled = true
      return layout
    })
    await Bun.sleep(300)
    expect(settled).toBe(false)
    writePrivate(old, '{"written-under-the-lock":true}\n')
    await held?.release()
    await expect(run).rejects.toThrow(conflictMessage(relative))
    expect(readFileSync(old, 'utf8')).toBe('{"written-under-the-lock":true}\n')
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  // An old vault file identical to its copy that cannot be removed, as when
  // Windows holds it open, stands in here as the old vault folder made
  // read-only right before that removal. Root ignores folder permissions, so
  // the test needs an ordinary user.
  it.skipIf(!POSIX || process.getuid?.() === 0).each([TOKEN, ROSTER])(
    'an old vault file that cannot be removed is retried at the next start, not refused: %s',
    async (relative) => {
      const files = oldLayout()
      seed(configDir(), files)
      const oldPath = join(configDir(), relative)
      try {
        expect(
          await prepare({
            steps: {
              // Writable again before the next removal, so the lock files in
              // that folder can go when the move releases them.
              beforeRemove: (path) => {
                chmodSync(oldVault(), path === oldPath ? 0o500 : 0o700)
              },
            },
          }),
        ).toBe('state-home')
      } finally {
        chmodSync(oldVault(), 0o700)
      }
      expect(readFileSync(oldPath, 'utf8')).toBe(files[relative] as string)
      // The enrollment state stays. When the token is the file that could not
      // be removed, keeping the state beside it means an older version never
      // finds the token alone.
      expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
        files[VAULT_STATE] as string,
      )
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(cleanupWarnings()).toEqual(oneCleanupWarning(relative))

      // The file can be removed again: the next start finishes the clean-up
      // instead of finding a reappeared vault file.
      resetProcess()
      logged = []
      expect(await prepare()).toBe('state-home')
      expect(existsSync(oldPath)).toBe(false)
      expect(present(configDir(), files)).toEqual(leftAfterMove(files))
      expect(present(runtimeDir(), files)).toEqual(files)
      expect(marker()?.oldFilesRemoved).toBe(true)
      expect(logged.filter((line) => line.level === 'warn')).toEqual([])
      resetProcess()
      expect(await prepare()).toBe('state-home')
    },
  )

  it.skipIf(!POSIX || process.getuid?.() === 0)(
    'an old vault file that a later start cannot remove is logged once and retried again',
    async () => {
      const files = oldLayout()
      seed(configDir(), files)
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      })
      const oldPath = join(configDir(), ROSTER)
      resetProcess()
      logged = []
      try {
        expect(
          await prepare({
            steps: {
              beforeRemove: (path) => {
                chmodSync(oldVault(), path === oldPath ? 0o500 : 0o700)
              },
            },
          }),
        ).toBe('state-home')
      } finally {
        chmodSync(oldVault(), 0o700)
      }
      expect(existsSync(oldPath)).toBe(true)
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(logged.filter((line) => line.level === 'warn')).toEqual(
        oneCleanupWarning(ROSTER),
      )

      resetProcess()
      expect(await prepare()).toBe('state-home')
      expect(present(configDir(), files)).toEqual(leftAfterMove(files))
      expect(marker()?.oldFilesRemoved).toBe(true)
    },
  )

  // Windows refuses to read or remove a file that another program (an
  // antivirus scan, an indexer) holds open without sharing. Such an old vault
  // file cannot be compared, which says nothing about its bytes: the clean-up
  // keeps it and tries again at the next start instead of reporting a
  // conflict between two copies that may be identical.
  it.skipIf(POSIX).each([
    ['during the move', ROSTER],
    ['after a crash', ROSTER],
    ['after a crash', TOKEN],
  ] as const)(
    'an old vault file Windows holds open during clean-up %s is retried at the next start, not refused: %s',
    async (when, relative) => {
      const files = oldLayout()
      seed(configDir(), files)
      const oldPath = join(configDir(), relative)
      let release: (() => void) | undefined
      try {
        if (when === 'after a crash') {
          await prepare({
            steps: {
              afterMarker: () => {
                throw new Error('crash')
              },
            },
          })
          release = holdWithoutSharing(oldPath)
          resetProcess()
          expect(await prepare()).toBe('state-home')
        } else {
          expect(
            await prepare({
              steps: {
                afterMarker: () => {
                  release = holdWithoutSharing(oldPath)
                },
              },
            }),
          ).toBe('state-home')
        }
      } finally {
        release?.()
      }
      expect(readFileSync(oldPath, 'utf8')).toBe(files[relative] as string)
      expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
        files[VAULT_STATE] as string,
      )
      expect(marker()?.oldFilesRemoved).not.toBe(true)
      expect(cleanupWarnings()).toEqual(oneCleanupWarning(relative))

      resetProcess()
      logged = []
      expect(await prepare()).toBe('state-home')
      expect(present(configDir(), files)).toEqual(leftAfterMove(files))
      expect(present(runtimeDir(), files)).toEqual(files)
      expect(marker()?.oldFilesRemoved).toBe(true)
      expect(logged.filter((line) => line.level === 'warn')).toEqual([])
    },
  )

  it.each([
    '{ not json',
    'null',
    '[]',
    'false',
    '42',
    '"marker"',
  ])('a malformed marker refuses the start and leaves old files untouched: %s', async (text) => {
    const files = oldLayout()
    seed(configDir(), files)
    const path = join(runtimeDir(), 'layout.json')
    writePrivate(path, text)
    await expect(prepare()).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: expect.stringContaining(`${path} is malformed`),
    })
    // The refusal says what to check and which file to delete.
    await expect(prepare()).rejects.toThrow(
      `Check that the old vault files are still in ${oldVault()}. If they are, delete ${path}, then restart OpenCode`,
    )
    expect(present(configDir(), files)).toEqual(files)
    expect(present(runtimeDir(), files)).toEqual(absent(files))
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('a marker that cannot be read refuses the start instead of counting as moved', async () => {
    seed(configDir(), oldLayout())
    // A folder where the marker should be: it exists, and reading it fails.
    mkdirSync(join(runtimeDir(), 'layout.json'), { recursive: true })
    await expect(prepare()).rejects.toThrow(REFUSED)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a layout lease lost before the marker writes no marker and refuses to run unregistered', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await expect(
      prepare({ steps: { afterCopy: stealLayoutLease } }),
    ).rejects.toThrow(REFUSED)
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
  })
})

describe('an approved vault enrollment and older versions', () => {
  it('an old reader sees vault mode, not idle', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    expect(await prepare()).toBe('state-home')
    expect(existsSync(join(configDir(), TOKEN))).toBe(false)
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
      files[VAULT_STATE] as string,
    )
    // An older version reads the old folder: approved without a token is
    // vault mode with a missing token, never local.
    const claustrum = await loadCommonAuthClaustrum()
    expect(
      await claustrum.readClaustrumEnrollmentStatus(
        claustrum.hostEnrollmentPaths({
          stateDir: oldVault(),
          host: 'opencode',
        }),
        NAME,
      ),
    ).toMatchObject({ state: 'blocked', code: 'missing_token' })
    expect(await oldFolderAuthority()).toBe('vault')
    expect(await authorityAt(getVaultDir())).toBe('vault')
  })

  it('the expected leftover is accepted at the next start, without a warning', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare()
    resetProcess()
    logged = []
    expect(await prepare()).toBe('state-home')
    expect(logged.filter((line) => line.level === 'warn')).toEqual([])
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
      files[VAULT_STATE] as string,
    )
  })

  it('accepts a leftover an older version rewrote to blocked missing_token', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    // An older version's reconcile, run against the old folder, finds no token
    // beside the approved state and rewrites it as blocked missing_token.
    expect(
      await reconcileAt(oldVault(), fakeVaultClient().client),
    ).toMatchObject({
      state: 'blocked',
      proposedName: NAME,
      code: 'missing_token',
    })
    const rewritten = readFileSync(join(configDir(), VAULT_STATE), 'utf8')
    expect(rewritten).toContain('"blocked"')
    // The marker still records the bytes the move left, not these.
    expect(marker()?.keptVaultState).toBe(
      sha256(oldLayout()[VAULT_STATE] as string),
    )

    resetProcess()
    logged = []
    expect(await prepare()).toBe('state-home')
    expect(logged.filter((line) => line.level === 'warn')).toEqual([])
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(rewritten)
    expect(getVaultDir()).toBe(newVault())
  })

  it('accepts a leftover rewritten to approved with a newer timestamp', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    // Same phase, a newer timestamp: an older version wrote the state again.
    const rewritten = approvedState(2)
    writePrivate(join(configDir(), VAULT_STATE), rewritten)
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(rewritten)
  })

  it.each([
    [
      'a pending state',
      `${JSON.stringify({
        version: 1,
        phase: 'pending',
        proposedName: NAME,
        requestSecret: 'ab'.repeat(32),
        requestId: 'request-1',
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
    ],
    ['unparseable bytes', '{ not json'],
    [
      "another plugin's proposedName",
      `${JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: 'antigravity-auth-pi',
        tokenGeneration: 1,
        updatedAt: 1,
      })}\n`,
    ],
  ])('a leftover holding %s refuses', async (_label, rewritten) => {
    seed(configDir(), oldLayout())
    await prepare()
    writePrivate(join(configDir(), VAULT_STATE), rewritten)
    resetProcess()
    await expect(prepare()).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: conflictMessage(VAULT_STATE),
    })
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(rewritten)
  })

  it('a token file beside an otherwise valid leftover refuses', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    // The old folder is enrolled again: which copy is current is unknown, even
    // though the state there is still one the rule would accept.
    writePrivate(
      join(configDir(), TOKEN),
      JSON.stringify({ token: '02'.repeat(32), token_generation: 2 }),
    )
    resetProcess()
    // The start names the reappeared token file first; the refused state file
    // there is a conflict too.
    await expect(prepare()).rejects.toMatchObject({
      name: 'RuntimeLayoutRefusal',
      message: conflictMessage(TOKEN),
    })
    expect(existsSync(join(configDir(), TOKEN))).toBe(true)
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(true)
    // With the token gone again, the very same state file is accepted.
    rmSync(join(configDir(), TOKEN))
    resetProcess()
    expect(await prepare()).toBe('state-home')
  })

  // A failed read can make the leftover check reject the old enrollment state
  // for a moment. This test makes that check reject it without a failed read,
  // through a pending state (never accepted as a leftover) and a marker that
  // records a kept state. The old state file, byte for byte its state-home
  // copy, must still stay.
  it('clean-up after a crash keeps an old enrollment state identical to its copy when the leftover check rejects it', async () => {
    const files = pendingLayout()
    seed(configDir(), files)
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    writePrivate(
      join(runtimeDir(), 'layout.json'),
      JSON.stringify({ ...marker(), keptVaultState: sha256('other bytes') }),
    )
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(
      files[VAULT_STATE] as string,
    )
    expect(existsSync(join(configDir(), ROSTER))).toBe(false)
  })

  it('disconnect removes the leftover, and an older version then reads local', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    // Disconnect removes the new token and state, then the leftover.
    rmSync(join(newVault(), 'opencode-enrollment.json'))
    rmSync(join(newVault(), 'opencode-enrollment-state.json'))
    await removeMovedVaultStateLeftover(getVaultDir())
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(false)
    expect(existsSync(oldVault())).toBe(false)
    expect(await oldFolderAuthority()).toBe('local')
    expect(await authorityAt(getVaultDir())).toBe('local')
    // A later start finds nothing left over.
    resetProcess()
    expect(await prepare()).toBe('state-home')
  })

  it('disconnect removes a leftover an older version rewrote, and an older version then reads local', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    expect(
      await reconcileAt(oldVault(), fakeVaultClient().client),
    ).toMatchObject({
      state: 'blocked',
      code: 'missing_token',
    })
    // Disconnect removes the new token and state, then the leftover.
    rmSync(join(newVault(), 'opencode-enrollment.json'))
    rmSync(join(newVault(), 'opencode-enrollment-state.json'))
    await removeMovedVaultStateLeftover(getVaultDir())
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(false)
    expect(existsSync(oldVault())).toBe(false)
    expect(await oldFolderAuthority()).toBe('local')
    expect(await authorityAt(getVaultDir())).toBe('local')
    // A later start finds nothing left over.
    resetProcess()
    expect(await prepare()).toBe('state-home')
  })

  it("disconnect keeps a leftover that is not this plugin's vault state", async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const foreign = `${JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: 'antigravity-auth-pi',
      tokenGeneration: 1,
      updatedAt: 2,
    })}\n`
    writePrivate(join(configDir(), VAULT_STATE), foreign)
    await removeMovedVaultStateLeftover(getVaultDir())
    expect(readFileSync(join(configDir(), VAULT_STATE), 'utf8')).toBe(foreign)
    // Called for another vault folder, it does nothing.
    writePrivate(join(configDir(), VAULT_STATE), approvedState())
    await removeMovedVaultStateLeftover(join(root, 'some', 'other', 'vault'))
    expect(existsSync(join(configDir(), VAULT_STATE))).toBe(true)
  })
})

describe('the layout lease before every removal', () => {
  it('a lease lost right before an old file is unlinked removes nothing', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const removing: string[] = []
    await prepare({
      steps: {
        beforeRemove: (path) => {
          removing.push(path)
          if (removing.length === 1) stealLayoutLease()
        },
      },
    })
    expect(removing[0]).toBe(join(configDir(), TOKEN))
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it('a lease lost between two unlinks stops the clean-up and keeps the remaining old files', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const removing: string[] = []
    await prepare({
      steps: {
        beforeRemove: (path) => {
          removing.push(path)
          if (removing.length === 2) stealLayoutLease()
        },
      },
    })
    expect(removing).toEqual([
      join(configDir(), TOKEN),
      join(configDir(), 'antigravity-auth-vault/opencode-roster.json'),
    ])
    const { [TOKEN]: _token, ...rest } = files
    expect(present(configDir(), rest)).toEqual(rest)
    expect(existsSync(join(configDir(), TOKEN))).toBe(false)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it('a lease lost right before the manifest is removed keeps it; the next start removes it', async () => {
    seed(configDir(), oldLayout())
    const manifest = join(runtimeDir(), 'layout-moving.json')
    await prepare({
      steps: {
        beforeRemove: (path) => {
          if (path === manifest) stealLayoutLease()
        },
      },
    })
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(manifest)).toBe(true)

    rmSync(layoutLockPath(), { force: true })
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(existsSync(manifest)).toBe(false)
  })

  it('a manifest left after a finished move is removed at the next start', async () => {
    seed(configDir(), oldLayout())
    await prepare()
    const manifest = join(runtimeDir(), 'layout-moving.json')
    // As if the move stopped between its last marker write and this removal.
    writePrivate(
      manifest,
      `${JSON.stringify({ version: 1, files: [join(newVault(), 'opencode-roster.json')] })}\n`,
    )
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(existsSync(manifest)).toBe(false)
    expect(existsSync(join(newVault(), 'opencode-roster.json'))).toBe(true)
  })

  it('a lease lost right before the old vault folder is removed keeps the folder', async () => {
    seed(configDir(), pendingLayout())
    await prepare({
      steps: {
        beforeRemove: (path) => {
          if (path === oldVault()) stealLayoutLease()
        },
      },
    })
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(oldVault())).toBe(true)
    expect(readdirSync(oldVault())).toEqual([])
  })

  it('clean-up after a crash reads the fence again under the data locks', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    await prepare({
      steps: {
        afterMarker: () => {
          throw new Error('crash')
        },
      },
    })
    resetProcess()
    let reads = 0
    // Open before the locks; closed under them, as when a process on the
    // legacy layout started while this one waited for them.
    const fence = async () => {
      reads++
      return reads === 1
        ? { open: true as const }
        : { open: false as const, blockers: [] }
    }
    expect(await prepare({ fence })).toBe('state-home')
    expect(reads).toBe(2)
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).not.toBe(true)
  })

  it('a start that waits for the layout lock says which lock it waits for, and its refusal names it', async () => {
    mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 })
    const fs = await loadCommonAuthFs()
    const held = await fs.acquireRefreshFileLock({
      name: 'runtime-layout',
      path: join(runtimeDir(), 'layout.json'),
      ttlMs: 10_000,
      renew: true,
    })
    expect(held).not.toBeNull()
    try {
      await expect(prepare({ layoutLockWaitMs: 1_500 })).rejects.toThrow(
        `antigravity-auth cannot start: it waited 2 s for the runtime-layout lock at ${join(runtimeDir(), 'layout.json')}.`,
      )
      resetProcess()
      await expect(prepare({ layoutLockWaitMs: 100 })).rejects.toThrow(
        'Try again, or restart OpenCode, once that OpenCode has finished the move.',
      )
      expect(logged).toContainEqual(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining(
            'is waiting up to 2 s for the runtime-layout lock',
          ),
        }),
      )
    } finally {
      await held?.release()
    }
  })
})

describe('the old signature cache', () => {
  // Older versions kept the signature cache in `$XDG_CONFIG_HOME/opencode`
  // (`%APPDATA%\opencode` on Windows), whatever OPENCODE_CONFIG_DIR said.
  // Both point at this test's config folder here.
  let savedConfigHome: Record<string, string | undefined>
  beforeEach(() => {
    savedConfigHome = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    }
    process.env.XDG_CONFIG_HOME = join(root, 'config')
    process.env.APPDATA = join(root, 'config')
  })
  afterEach(() => {
    for (const [name, value] of Object.entries(savedConfigHome)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const oldCache = () => join(configDir(), 'antigravity-signature-cache.json')
  const newCache = () =>
    join(root, 'state', 'cortexkit', 'antigravity-auth', basename(oldCache()))

  it('the move removes it once and never copies it', async () => {
    seed(configDir(), oldLayout())
    writeFileSync(oldCache(), '{"version":"1.0","entries":{}}\n')

    expect(await prepare()).toBe('state-home')
    expect(existsSync(oldCache())).toBe(false)
    expect(existsSync(newCache())).toBe(false)

    // Once the move is done it is never looked at again.
    writeFileSync(oldCache(), 'written by an older version\n')
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(readFileSync(oldCache(), 'utf8')).toBe(
      'written by an older version\n',
    )
  })

  it('a fresh install removes it too', async () => {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(oldCache(), '{}\n')
    expect(await prepare()).toBe('state-home')
    expect(existsSync(oldCache())).toBe(false)
  })

  it('stays while the move waits for an older version', async () => {
    seed(configDir(), oldLayout())
    writeFileSync(oldCache(), '{}\n')
    heartbeat(process.ppid, { version: '3.0.13' })
    expect(await prepare()).toBe('legacy')
    expect(existsSync(oldCache())).toBe(true)
  })

  it('clean-up after a crash after the marker removes it', async () => {
    seed(configDir(), oldLayout())
    writeFileSync(oldCache(), '{}\n')
    expect(
      await prepare({
        steps: {
          afterMarker: () => {
            throw new Error('crash')
          },
        },
      }),
    ).toBe('state-home')
    expect(existsSync(oldCache())).toBe(true)

    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(existsSync(oldCache())).toBe(false)
    expect(marker()?.oldFilesRemoved).toBe(true)
  })

  it('a lease lost right before it is removed keeps it and records nothing as done', async () => {
    seed(configDir(), oldLayout())
    writeFileSync(oldCache(), '{}\n')
    await prepare({
      steps: {
        beforeRemove: (path) => {
          if (path === oldCache()) stealLayoutLease()
        },
      },
    }).catch(() => {})
    expect(existsSync(oldCache())).toBe(true)
    expect(marker()?.oldFilesRemoved).toBeUndefined()
  })
})

describe('processes that could still use the old files', () => {
  it('a live older version defers the move; once it is gone the move completes', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    // The test runner's parent is alive and is not this process.
    const older = heartbeat(process.ppid, { version: '3.0.12' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
    expect(getVaultDir()).toBe(oldVault())
    expect(logged).toContainEqual(
      expect.objectContaining({ message: RUNTIME_LAYOUT_DEFERRED_MESSAGE }),
    )
    // This process recorded its legacy layout for others to see.
    const own = JSON.parse(readFileSync(processHeartbeatPath(), 'utf8'))
    expect(own.layouts).toEqual({ [runtimeLayoutLocation().key]: 'legacy' })

    rmSync(older)
    rmSync(processHeartbeatPath())
    resetProcess()
    expect(await prepare()).toBe('state-home')
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
  })

  it('a live legacy heartbeat under another key blocks the move', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, {
      version: VERSION,
      layouts: { [join(root, 'some', 'other', 'opencode')]: 'legacy' },
    })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a heartbeat with version unknown and empty layouts blocks', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, { version: 'unknown', layouts: {} })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
  })

  it('a fresh install waits for an older version too', async () => {
    heartbeat(process.ppid, { version: '3.0.13' })
    expect(await prepare()).toBe('legacy')
    expect(marker()).toBeUndefined()
  })

  it('a process that cannot record its legacy layout refuses to start', async () => {
    seed(configDir(), oldLayout())
    heartbeat(process.ppid, { version: '3.0.12' })
    // This process's own heartbeat file cannot be written: a folder with a
    // file in it is in its place.
    mkdirSync(join(processHeartbeatPath(), 'keep'), { recursive: true })
    await expect(prepare()).rejects.toThrow(REFUSED)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a state folder that cannot be created refuses the start rather than run unregistered', async () => {
    seed(configDir(), oldLayout())
    mkdirSync(join(root, 'state', 'cortexkit'), { recursive: true })
    // A file where the state folder's parent should be.
    writeFileSync(join(root, 'state', 'cortexkit', 'antigravity-auth'), 'x')
    await expect(prepare()).rejects.toThrow(REFUSED)
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('a legacy-layout process keeps its heartbeat after its last owner releases it', async () => {
    heartbeat(process.ppid, { version: '3.0.12' })
    expect(await prepare()).toBe('legacy')
    const handle = await startProcessHeartbeat({
      version: VERSION,
      logger: { warn() {} },
    })
    await handle.release()
    expect(existsSync(processHeartbeatPath())).toBe(true)
  })
})

describe('paths the move must not touch', () => {
  it.skipIf(!POSIX)(
    'a state folder that is the config folder itself (a link) is refused and nothing is lost',
    async () => {
      const files = oldLayout()
      seed(configDir(), files)
      mkdirSync(dirname(runtimeDir()), { recursive: true })
      symlinkSync(configDir(), runtimeDir(), 'dir')
      // Registered on the legacy layout; the move is refused.
      expect(await prepare()).toBe('legacy')
      expect(present(configDir(), files)).toEqual(files)
      expect(existsSync(join(configDir(), 'layout.json'))).toBe(false)
    },
  )

  it('a hard-linked old vault file is not deleted as its own copy', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    mkdirSync(newVault(), { recursive: true, mode: 0o700 })
    linkSync(
      join(configDir(), 'antigravity-auth-vault/opencode-roster.json'),
      join(newVault(), 'opencode-roster.json'),
    )
    expect(await prepare()).toBe('legacy')
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()).toBeUndefined()
    expect(logged).toContainEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'same-physical-file' }),
      }),
    )
  })

  it('a vault file another process put in the destination stops the move and is kept', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const foreign = join(newVault(), 'opencode-roster.json')
    writePrivate(foreign, '{"someone-elses":true}\n')
    expect(await prepare()).toBe('legacy')
    expect(readFileSync(foreign, 'utf8')).toBe('{"someone-elses":true}\n')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
  })

  it('an existing destination vault folder that is not private stays legacy, is left unchanged, and is logged', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    mkdirSync(newVault(), { recursive: true })
    const checked: string[] = []
    expect(
      await prepare({
        destinationPrivate: async (dir) => {
          checked.push(dir)
          return false
        },
      }),
    ).toBe('legacy')
    expect(checked).toEqual([newVault()])
    expect(readdirSync(newVault())).toEqual([])
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()).toBeUndefined()
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        meta: expect.objectContaining({ reason: 'destination-not-private' }),
      }),
    )
  })

  it('a state folder that names another config folder is refused and left untouched', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    writePrivate(
      join(runtimeDir(), 'config-dir.json'),
      `${JSON.stringify({ version: 1, configDir: join(root, 'elsewhere') })}\n`,
    )
    await expect(prepare()).rejects.toThrow(/belongs to another OpenCode/)
    expect(present(configDir(), files)).toEqual(files)
    expect(marker()).toBeUndefined()
  })

  it('a marker naming another config folder is refused', async () => {
    seed(configDir(), oldLayout())
    writePrivate(
      join(runtimeDir(), 'layout.json'),
      `${JSON.stringify({ version: 1, oldDir: join(root, 'elsewhere'), oldFilesRemoved: true })}\n`,
    )
    await expect(prepare()).rejects.toThrow(/belongs to another OpenCode/)
    await expect(prepare()).rejects.toThrow(
      `${join(runtimeDir(), 'layout.json')} belongs to another OpenCode config folder`,
    )
    await expect(prepare()).rejects.toThrow(
      `Check that the old vault files are still in ${oldVault()}. If they are, delete ${join(runtimeDir(), 'layout.json')}, then restart OpenCode`,
    )
    expect(present(configDir(), oldLayout())).toEqual(oldLayout())
  })

  it('two config folders never share a state-home folder', async () => {
    const first = join(root, 'first-config')
    const second = join(root, 'second-config')
    seed(first, oldLayout('first'))
    seed(second, oldLayout('second'))

    process.env.OPENCODE_CONFIG_DIR = first
    expect(await prepare()).toBe('state-home')
    const firstDir = runtimeDir()

    resetProcess()
    process.env.OPENCODE_CONFIG_DIR = second
    expect(await prepare()).toBe('state-home')
    const secondDir = runtimeDir()

    expect(secondDir).not.toBe(firstDir)
    expect(present(firstDir, oldLayout('first'))).toEqual(oldLayout('first'))
    expect(present(secondDir, oldLayout('second'))).toEqual(oldLayout('second'))
    for (const [dir, config] of [
      [firstDir, first],
      [secondDir, second],
    ] as const)
      expect(
        JSON.parse(readFileSync(join(dir, 'config-dir.json'), 'utf8')),
      ).toEqual({ version: 1, configDir: config })
  })
})

describe('real processes', () => {
  it('a live 3.0.13 OpenCode keeps the vault in place; after it exits the next start moves', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    // The child writes its heartbeat with the real runtime heartbeat and
    // never decides, as 3.0.13 does: its config folder on the legacy
    // layout, under the package's own version.
    const old = await spawnLayoutProcess('heartbeat')
    expect(old.result.heartbeat).toEqual(
      expect.stringContaining(String(old.child.pid)),
    )
    const blocked = await spawnLayoutProcess('once')
    expect(blocked.result.layout).toBe('legacy')
    expect(blocked.result.vaultDir).toBe(oldVault())
    expect(present(configDir(), files)).toEqual(files)

    old.child.kill('SIGKILL')
    await old.child.exited
    const moved = await spawnLayoutProcess('once')
    expect(moved.result.layout).toBe('state-home')
    expect(moved.result.vaultDir).toBe(newVault())
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
  }, 30_000)

  it('a live process on the legacy layout keeps a new one legacy; after it exits the next start moves', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const older = heartbeat(process.ppid, { version: '3.0.12' })
    // A starts while an older version runs, so it takes the legacy layout
    // and keeps running after the older version exits.
    const a = await spawnLayoutProcess('hold')
    expect(a.result.layout).toBe('legacy')
    rmSync(older)
    const b = await spawnLayoutProcess('once')
    expect(b.result.layout).toBe('legacy')
    expect(present(configDir(), files)).toEqual(files)

    a.child.kill()
    await a.child.exited
    const c = await spawnLayoutProcess('once')
    expect(c.result.layout).toBe('state-home')
    expect(present(runtimeDir(), files)).toEqual(files)
  }, 30_000)

  it('two processes starting together produce one move and identical files', async () => {
    const files = oldLayout()
    seed(configDir(), files)
    const barrier = join(root, 'barrier')
    const trace = join(root, 'trace')
    const extra = {
      RUNTIME_LAYOUT_TEST_BARRIER: barrier,
      RUNTIME_LAYOUT_TEST_TRACE: trace,
    }
    const both = Promise.all([
      spawnLayoutProcess('once', extra),
      spawnLayoutProcess('once', extra),
    ])
    // Release both only once both are loaded and waiting.
    while (
      readdirSync(root).filter((name) => name.endsWith('.ready')).length < 2
    )
      await Bun.sleep(10)
    writeFileSync(barrier, '')
    const [one, two] = await both
    expect([one.result.layout, two.result.layout]).toEqual([
      'state-home',
      'state-home',
    ])
    expect(one.result.vaultDir).toBe(two.result.vaultDir as string)
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(
      readdirSync(newVault()).filter((name) => name.includes('.tmp')),
    ).toEqual([])
  }, 30_000)

  it.each([
    'afterManifest',
    'afterCopy',
  ])('a killed move before the marker leaves the old vault authoritative and the next start completes: %s', async (step) => {
    const files = oldLayout()
    seed(configDir(), files)
    const killed = await spawnLayoutProcess('once', {
      RUNTIME_LAYOUT_TEST_KILL_AT: step,
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(marker()).toBeUndefined()
    expect(present(configDir(), files)).toEqual(files)
    // A tool that never decided still reads the old folder.
    expect(getVaultDir()).toBe(oldVault())

    // The next start waits out the killed process's leases, then moves.
    const next = await spawnLayoutProcess('once')
    expect(next.result.layout).toBe('state-home')
    expect(next.result.vaultDir).toBe(newVault())
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    await expectServedWithoutProposal(newVault())
  }, 60_000)

  it.each([
    'afterMarker',
    'midCleanup',
  ])('a killed move after the marker leaves the new vault authoritative and the next start removes identical leftovers: %s', async (step) => {
    const files = oldLayout()
    seed(configDir(), files)
    const killed = await spawnLayoutProcess('once', {
      RUNTIME_LAYOUT_TEST_KILL_AT: step,
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(marker()).toMatchObject({ version: 1 })
    expect(marker()?.oldFilesRemoved).not.toBe(true)
    expect(present(runtimeDir(), files)).toEqual(files)
    // A tool that never decided already reads the new folder.
    expect(getVaultDir()).toBe(newVault())
    await expectServedWithoutProposal(newVault())

    const next = await spawnLayoutProcess('once')
    expect(next.result.layout).toBe('state-home')
    expect(present(configDir(), files)).toEqual(leftAfterMove(files))
    expect(present(runtimeDir(), files)).toEqual(files)
    expect(marker()?.oldFilesRemoved).toBe(true)
    expect(existsSync(join(runtimeDir(), 'layout-moving.json'))).toBe(false)
    await expectServedWithoutProposal(newVault())
  }, 60_000)
})

/**
 * The enrollment in `vaultDir` serves a vault request as it is: a scoped
 * operation reads the token there, and reconciling makes no vault call (no
 * new proposal).
 */
async function expectServedWithoutProposal(vaultDir: string) {
  expect((await tokenAt(vaultDir)).token).toBe('01'.repeat(32))
  const vault = fakeVaultClient()
  expect(await reconcileAt(vaultDir, vault.client)).toMatchObject({
    state: 'approved',
  })
  expect(vault.calls).toEqual([])
}

/**
 * Runs the layout decision in its own process with this test's environment
 * plus `extra` (an undefined value removes a variable).
 */
async function spawnLayoutProcess(
  mode: 'once' | 'hold' | 'heartbeat',
  extra: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    RUNTIME_LAYOUT_TEST_VERSION: VERSION,
    ...extra,
  }
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name]
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./__fixtures__/runtime-layout-process.ts', import.meta.url),
      ),
      mode,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  if (mode === 'once') await child.exited
  if (!text.includes('\n')) {
    if (child.signalCode)
      return { child, signal: child.signalCode, result: {} as LayoutLine }
    const stderr = await new Response(child.stderr).text()
    // Windows has no signals: a process that killed itself outright exits
    // nonzero with no signal code. The fixture names the step on stderr
    // first, so a deliberate kill is told apart from a crash.
    if (
      process.platform === 'win32' &&
      child.exitCode !== 0 &&
      stderr.includes(
        `RUNTIME_LAYOUT_KILLED_AT=${extra.RUNTIME_LAYOUT_TEST_KILL_AT}`,
      )
    )
      return { child, signal: 'SIGKILL' as const, result: {} as LayoutLine }
    throw new Error(`layout process printed nothing: ${stderr}`)
  }
  return {
    child,
    signal: child.signalCode,
    result: JSON.parse(text.trim()) as LayoutLine,
  }
}

interface LayoutLine {
  layout?: string
  error?: string
  pid?: number
  vaultDir?: string
  heartbeat?: string | null
}
