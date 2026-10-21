import { accessSync, constants, mkdtempSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DISK_TEST_FILES } from './disk-test-files.ts'

const SHARED_MEMORY = '/dev/shm'
const repositoryRoot = resolve(import.meta.dir, '../..')

export interface TestRootOptions {
  env: Record<string, string | undefined>
  testFile: string
  diskTempDir: string
}

export interface TestRootIO {
  platform: string
  mountInfo: () => string
  checkWritable: (path: string) => void
  makeTemp: (prefix: string) => string
}

const systemIO: TestRootIO = {
  platform: process.platform,
  mountInfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
  checkWritable: (path) => accessSync(path, constants.W_OK | constants.X_OK),
  makeTemp: mkdtempSync,
}

function validateSharedMemory(io: TestRootIO) {
  try {
    if (io.platform !== 'linux') throw new Error('Linux is required')
    // mountinfo escapes whitespace and backslashes as octal. Use the last
    // matching mount so an overmount cannot hide a non-tmpfs filesystem.
    const mounts = io.mountInfo().trim().split('\n')
    const mount = mounts.findLast((line) => {
      const point = line
        .split(' ')[4]
        ?.replace(/\\([0-7]{3})/g, (_, octal) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        )
      return point === SHARED_MEMORY
    })
    if (!mount) throw new Error('/dev/shm is not a mount point')
    if (mount.split(' - ')[1]?.split(' ')[0] !== 'tmpfs')
      throw new Error('/dev/shm must be a tmpfs mount')
    if (!mount.split(' ')[5]?.split(',').includes('rw'))
      throw new Error('/dev/shm is not mounted writable')
    // MOTOR supplies a private mount per job. Do not require emptiness: other
    // tests and child processes from this job may already own roots here.
    io.checkWritable(SHARED_MEMORY)
  } catch (error) {
    throw new Error(
      `ANTIGRAVITY_TEST_TMPFS=1: cannot use /dev/shm; refusing disk fallback: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function createTestRoot(
  options: TestRootOptions,
  io: TestRootIO = systemIO,
): string {
  const { env, testFile } = options
  // Leave both the mkdtemp prefix and the environment unchanged without opt-in.
  if (env.ANTIGRAVITY_TEST_TMPFS !== '1')
    return io.makeTemp(join(options.diskTempDir, 'antigravity-auth-test-'))

  validateSharedMemory(io)
  const diskTempDir = env.ANTIGRAVITY_TEST_DISK_TMPDIR ?? options.diskTempDir
  if (
    resolve(diskTempDir).startsWith(`${SHARED_MEMORY}/`) ||
    resolve(diskTempDir) === SHARED_MEMORY
  )
    throw new Error(
      'ANTIGRAVITY_TEST_TMPFS=1: disk temp directory is on /dev/shm',
    )
  const file = relative(repositoryRoot, resolve(testFile)).replaceAll('\\', '/')
  const disk = Object.hasOwn(DISK_TEST_FILES, file)
  const root = io.makeTemp(
    join(disk ? diskTempDir : SHARED_MEMORY, 'antigravity-auth-test-'),
  )
  // Children inherit the original disk location, not their parent's tmpfs root.
  // Bun --isolate restores process.env before the next file's preload.
  env.ANTIGRAVITY_TEST_DISK_TMPDIR = diskTempDir
  env.TMPDIR = disk ? diskTempDir : root
  return root
}
