import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { DISK_TEST_FILES } from './support/disk-test-files.ts'
import { createTestRoot, type TestRootIO } from './support/test-root.ts'

const repositoryRoot = resolve(import.meta.dir, '..')
const mountInfo =
  '42 1 0:20 / /dev/shm rw,nosuid,nodev - tmpfs shm rw,size=16G\n'

function fixture(overrides: Partial<TestRootIO> = {}) {
  const calls: string[] = []
  const env: Record<string, string | undefined> = {
    ANTIGRAVITY_TEST_TMPFS: '1',
  }
  const io: TestRootIO = {
    platform: 'linux',
    mountInfo: () => {
      calls.push('mountinfo')
      return mountInfo
    },
    checkWritable: (path) => {
      calls.push(`writable:${path}`)
    },
    makeTemp: (prefix) => {
      calls.push(`mkdtemp:${prefix}`)
      return `${prefix}fixture`
    },
    ...overrides,
  }
  const options = {
    env,
    testFile: join(repositoryRoot, 'packages/core/src/auth.test.ts'),
    diskTempDir: '/disk/tmp',
  }
  return { calls, env, io, options }
}

describe('test temp roots', () => {
  it('preserves the original prefix and environment without explicit opt-in', () => {
    for (const optIn of [undefined, '', '0', 'true']) {
      const { calls, env, io, options } = fixture()
      env.ANTIGRAVITY_TEST_TMPFS = optIn
      const original = { ...env }
      expect(createTestRoot(options, io)).toBe(
        '/disk/tmp/antigravity-auth-test-fixture',
      )
      expect(calls).toEqual(['mkdtemp:/disk/tmp/antigravity-auth-test-'])
      expect(env).toEqual(original)
    }
  })

  it('uses checked tmpfs only with explicit opt-in and redirects os tmpdir', () => {
    const { calls, env, io, options } = fixture()
    const root = createTestRoot(options, io)
    expect(root).toBe('/dev/shm/antigravity-auth-test-fixture')
    expect(calls).toEqual([
      'mountinfo',
      'writable:/dev/shm',
      'mkdtemp:/dev/shm/antigravity-auth-test-',
    ])
    expect(env.TMPDIR).toBe(root)
    expect(env.ANTIGRAVITY_TEST_DISK_TMPDIR).toBe('/disk/tmp')
  })

  it('durability-listed files keep disk roots', () => {
    for (const file of Object.keys(DISK_TEST_FILES)) {
      const { env, io, options } = fixture()
      options.testFile = join(repositoryRoot, file)
      // A child may inherit TMPDIR from a parent test's tmpfs root.
      options.diskTempDir = '/dev/shm/parent-root'
      env.ANTIGRAVITY_TEST_DISK_TMPDIR = '/disk/tmp'
      expect(createTestRoot(options, io)).toBe(
        '/disk/tmp/antigravity-auth-test-fixture',
      )
      expect(env.TMPDIR).toBe('/disk/tmp')
    }
  })

  it.each([
    ['non-Linux', { platform: 'darwin' }, 'Linux is required'],
    ['missing mount', { mountInfo: () => '' }, '/dev/shm is not a mount point'],
    [
      'wrong mount',
      { mountInfo: () => mountInfo.replace('/dev/shm ', '/dev/shm-other ') },
      '/dev/shm is not a mount point',
    ],
    [
      'disk filesystem',
      { mountInfo: () => mountInfo.replace(' - tmpfs ', ' - xfs ') },
      '/dev/shm must be a tmpfs mount',
    ],
    [
      'read-only mount',
      { mountInfo: () => mountInfo.replace('rw,nosuid', 'ro,nosuid') },
      '/dev/shm is not mounted writable',
    ],
    [
      'overmounted disk',
      {
        mountInfo: () => mountInfo + mountInfo.replace(' - tmpfs ', ' - xfs '),
      },
      '/dev/shm must be a tmpfs mount',
    ],
    [
      'unreadable mountinfo',
      {
        mountInfo: () => {
          throw new Error('mountinfo denied')
        },
      },
      'mountinfo denied',
    ],
    [
      'unwritable mount',
      {
        checkWritable: () => {
          throw new Error('write denied')
        },
      },
      'write denied',
    ],
  ] satisfies [
    string,
    Partial<TestRootIO>,
    string,
  ][])('fails loudly without fallback for %s', (_name, overrides, message) => {
    const { calls, io, options } = fixture(overrides)
    expect(() => createTestRoot(options, io)).toThrow(
      `refusing disk fallback: ${message}`,
    )
    expect(calls.some((call) => call.startsWith('mkdtemp:'))).toBe(false)
  })

  it('does not disguise a tmpfs parent as a disk directory', () => {
    const { io, options } = fixture()
    options.diskTempDir = '/dev/shm/parent-root'
    expect(() => createTestRoot(options, io)).toThrow(
      'disk temp directory is on /dev/shm',
    )
  })

  it('surfaces allocation failures rather than falling back to disk', () => {
    const { env, io, options } = fixture({
      makeTemp: () => {
        throw new Error('no space')
      },
    })
    expect(() => createTestRoot(options, io)).toThrow('no space')
    expect(env.TMPDIR).toBeUndefined()
  })

  it('live preload sees this isolated file and preserves its disk location', () => {
    expect(Bun.main).toBe(import.meta.path)
    const root = process.env.ANTIGRAVITY_TEST_ROOT
    expect(root).toBeDefined()
    if (!root) throw new Error('preload did not create a test root')
    if (process.env.ANTIGRAVITY_TEST_TMPFS === '1') {
      const diskTempDir = process.env.ANTIGRAVITY_TEST_DISK_TMPDIR
      if (!diskTempDir)
        throw new Error('preload did not preserve the disk directory')
      expect(dirname(root)).toBe(diskTempDir)
      expect(tmpdir()).toBe(diskTempDir)
    }
  })
})

// Conservative identifier/import fence, not a semantic filesystem analysis.
// False positives belong on disk; indirect new helpers need review as well.
const durabilityPattern =
  /\b(?:f(?:data)?sync(?:Sync)?|datasync|syncFile|syncDirectory|writeJsonAtomic|acquire\w*Lock|with(?:File|AccountPool)?Lock|chmod(?:Sync)?|fchmod(?:Sync)?)\b|\brename(?:Sync)?\s*\(|\.sync\s*\(|\.mode\s*&|0o[0-7]{3}|(?:file-lock|proper-lockfile|atomic-write|migration-crash|pointer-durability|migration-temp-recovery|native-inert-cleanup)/i

it('durability identifier guard recognizes representative new lock and sync tests', () => {
  for (const source of [
    "import { acquireFileLock } from './file-lock.ts'",
    'fs.fsyncSync(fd)',
    'await handle.datasync()',
    'await syncDirectory(root)',
    'chmodSync(file, 0o600)',
  ]) {
    expect(durabilityPattern.test(source)).toBe(true)
  }
  expect(durabilityPattern.test('expect(2 + 2).toBe(4)')).toBe(false)
})

it('durability identifier guard lists every matching test on disk', () => {
  const missing: string[] = []
  for (const base of ['packages', 'test', 'scripts']) {
    for (const file of new Bun.Glob(
      '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
    ).scanSync({
      cwd: join(repositoryRoot, base),
      absolute: true,
      onlyFiles: true,
    })) {
      if (
        file
          .split('/')
          .some((part) => ['node_modules', 'dist', 'target'].includes(part))
      )
        continue
      const name = relative(repositoryRoot, file)
      if (
        durabilityPattern.test(readFileSync(file, 'utf8')) &&
        !Object.hasOwn(DISK_TEST_FILES, name)
      )
        missing.push(name)
    }
  }
  expect(missing.sort()).toEqual([])
  for (const [file, reason] of Object.entries(DISK_TEST_FILES)) {
    expect(
      readFileSync(join(repositoryRoot, file), 'utf8').length,
    ).toBeGreaterThan(0)
    expect(reason.length).toBeGreaterThan(10)
  }
})
