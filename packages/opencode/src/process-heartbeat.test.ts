import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { CliDependencies } from './cli'
import { runCliProcess } from './cli'
import * as heartbeatModule from './process-heartbeat'
import {
  __resetProcessHeartbeatForTest,
  type ProcessHeartbeat,
  processConfigFolderKey,
  processHeartbeatDir,
  processHeartbeatPath,
  startProcessHeartbeat,
} from './process-heartbeat'

const packageVersion = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version

function testRoot(): string {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('test/setup.ts did not pin ANTIGRAVITY_TEST_ROOT')
  return root
}

let dirCount = 0
function freshDir(): string {
  dirCount++
  return join(testRoot(), 'heartbeats', String(dirCount), 'processes')
}

function recordingLogger() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    []
  return {
    warnings,
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta })
    },
  }
}

function readHeartbeat(path: string): ProcessHeartbeat {
  const text = readFileSync(path, 'utf8')
  expect(text.endsWith('}\n')).toBe(true)
  return JSON.parse(text) as ProcessHeartbeat
}

afterEach(() => {
  __resetProcessHeartbeatForTest()
})

describe('process heartbeat location', () => {
  it('lives under $XDG_STATE_HOME/cortexkit/antigravity-auth/processes', () => {
    const state = process.env.XDG_STATE_HOME
    expect(state).toBe(join(testRoot(), 'state'))
    expect(processHeartbeatDir()).toBe(
      join(testRoot(), 'state', 'cortexkit', 'antigravity-auth', 'processes'),
    )
    expect(processHeartbeatPath(4242)).toBe(
      join(processHeartbeatDir(), '4242.json'),
    )
  })

  it('falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
    const saved = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    try {
      // Only the path is computed here; nothing is written to the real home.
      expect(processHeartbeatDir()).toBe(
        join(
          homedir(),
          '.local',
          'state',
          'cortexkit',
          'antigravity-auth',
          'processes',
        ),
      )
    } finally {
      process.env.XDG_STATE_HOME = saved
    }
  })

  it.skipIf(process.platform === 'win32')(
    'keys the config folder by its real path, exactly as realpath returns it',
    () => {
      const saved = process.env.OPENCODE_CONFIG_DIR
      const real = join(testRoot(), 'Real-Config')
      const link = join(testRoot(), 'linked-config')
      mkdirSync(real, { recursive: true })
      rmSync(link, { force: true })
      symlinkSync(real, link)
      process.env.OPENCODE_CONFIG_DIR = link
      try {
        // Letter case is kept: the key is the file move's folder identity.
        expect(processConfigFolderKey()).toBe(realpathSync.native(real))
        expect(processConfigFolderKey()).toContain('Real-Config')
      } finally {
        process.env.OPENCODE_CONFIG_DIR = saved
      }
    },
  )

  it('keys a config folder that does not exist yet by its resolved path', () => {
    const saved = process.env.OPENCODE_CONFIG_DIR
    const missing = join(testRoot(), 'Not-Created-Yet', '..', 'Not-Created')
    process.env.OPENCODE_CONFIG_DIR = missing
    try {
      expect(processConfigFolderKey()).toBe(resolve(missing))
    } finally {
      process.env.OPENCODE_CONFIG_DIR = saved
    }
  })
})

describe('process heartbeat write', () => {
  it.skipIf(process.platform === 'win32')(
    'writes <pid>.json with mode 0600 in a 0700 folder, tightening an existing folder',
    async () => {
      const dir = freshDir()
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      const logger = recordingLogger()
      const handle = await startProcessHeartbeat({
        version: '9.9.9',
        logger,
        layouts: { '/config/opencode': 'legacy' },
        now: () => 1234,
        pid: 4242,
        dir,
      })
      expect(handle.path).toBe(join(dir, '4242.json'))
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, '4242.json')).mode & 0o777).toBe(0o600)
      expect(readHeartbeat(join(dir, '4242.json'))).toEqual({
        pid: 4242,
        version: '9.9.9',
        startedAt: 1234,
        layouts: { '/config/opencode': 'legacy' },
      })
      expect(logger.warnings).toEqual([])
    },
  )

  it('renames a complete temporary file into place, so readers never see a partial one', async () => {
    const dir = freshDir()
    const target = join(dir, '4242.json')
    const logger = recordingLogger()
    const seen: string[] = []
    let writing = true
    // Read the target as fast as possible while it is rewritten many times.
    const reader = (async () => {
      while (writing) {
        try {
          seen.push(await readFile(target, 'utf8'))
        } catch {
          // Not written yet.
        }
      }
    })()
    for (let index = 0; index < 40; index++) {
      // A new layout key makes every start rewrite the file.
      await startProcessHeartbeat({
        version: '9.9.9',
        logger,
        layouts: { [`/config/${index}/${'x'.repeat(2000)}`]: 'legacy' },
        pid: 4242,
        dir,
      })
    }
    writing = false
    await reader
    for (const text of seen) {
      expect(text.endsWith('}\n')).toBe(true)
      expect(() => JSON.parse(text)).not.toThrow()
    }
    expect(readdirSync(dir)).toEqual(['4242.json'])
    expect(Object.keys(readHeartbeat(target).layouts)).toHaveLength(40)
  })

  it('leaves no partial or temporary file when the rename fails', async () => {
    const dir = freshDir()
    // A non-empty folder at the target name makes the rename fail after the
    // temporary file was written.
    mkdirSync(join(dir, '4242.json'), { recursive: true })
    writeFileSync(join(dir, '4242.json', 'keep'), 'x')
    const logger = recordingLogger()
    const handle = await startProcessHeartbeat({
      version: '9.9.9',
      logger,
      layouts: { '/config/opencode': 'legacy' },
      pid: 4242,
      dir,
    })
    expect(handle.path).toBeUndefined()
    expect(readdirSync(dir)).toEqual(['4242.json'])
    expect(statSync(join(dir, '4242.json')).isDirectory()).toBe(true)
    expect(logger.warnings.map((warning) => warning.message)).toEqual([
      'process heartbeat not written',
    ])
  })

  it('logs one warning without throwing when the write fails, and retries at the next owner start', async () => {
    const parent = join(freshDir(), '..')
    mkdirSync(join(parent, '..'), { recursive: true })
    // A file where the folder should be makes mkdir fail.
    writeFileSync(parent, 'not a folder')
    const dir = join(parent, 'processes')
    const logger = recordingLogger()
    const first = await startProcessHeartbeat({
      version: '9.9.9',
      logger,
      layouts: { '/config/opencode': 'legacy' },
      pid: 4242,
      dir,
    })
    expect(first.path).toBeUndefined()
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]?.message).toBe('process heartbeat not written')
    expect(logger.warnings[0]?.meta?.dir).toBe(dir)

    rmSync(parent)
    const second = await startProcessHeartbeat({
      version: '9.9.9',
      logger,
      pid: 4242,
      dir,
    })
    expect(second.path).toBe(join(dir, '4242.json'))
    expect(readHeartbeat(join(dir, '4242.json')).layouts).toEqual({
      '/config/opencode': 'legacy',
    })
    expect(logger.warnings).toHaveLength(1)
  })

  it('writes at the first owner start and not again while the file is current', async () => {
    const dir = freshDir()
    const logger = recordingLogger()
    const layouts = { '/config/opencode': 'legacy' } as const
    await startProcessHeartbeat({
      version: '9.9.9',
      logger,
      layouts,
      now: () => 1000,
      pid: 4242,
      dir,
    })
    const target = join(dir, '4242.json')
    writeFileSync(target, 'marker')
    const second = await startProcessHeartbeat({
      version: '9.9.9',
      logger,
      layouts,
      now: () => 2000,
      pid: 4242,
      dir,
    })
    expect(second.path).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('marker')
  })
})

describe('process heartbeat owners', () => {
  it('keeps a legacy-layout file after the last owner releases it', async () => {
    const dir = freshDir()
    const logger = recordingLogger()
    const options = {
      version: '9.9.9',
      logger,
      layouts: { '/config/opencode': 'legacy' as const },
      pid: 4242,
      dir,
    }
    const first = await startProcessHeartbeat(options)
    const second = await startProcessHeartbeat(options)
    await first.release()
    await first.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(true)
    await second.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(true)
  })

  it('removes a file without a legacy layout only when the last owner releases it', async () => {
    const dir = freshDir()
    const logger = recordingLogger()
    const options = { version: '9.9.9', logger, pid: 4242, dir }
    const first = await startProcessHeartbeat(options)
    const second = await startProcessHeartbeat(options)
    await first.release()
    // A second release of one owner must not count as the other owner's.
    await first.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(true)
    await second.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(false)
    expect(logger.warnings).toEqual([])
  })

  it('shares one file and one owner count between two copies of the bundle', async () => {
    const dir = freshDir()
    const logger = recordingLogger()
    // A query string makes Bun evaluate the module again, as a second copy
    // of the bundle loaded into the same process would be.
    const specifier = './process-heartbeat.ts'
    const copyA = (await import(
      `${specifier}?copy=a`
    )) as typeof heartbeatModule
    const copyB = (await import(
      `${specifier}?copy=b`
    )) as typeof heartbeatModule
    expect(copyA).not.toBe(copyB)
    expect(copyA.startProcessHeartbeat).not.toBe(
      heartbeatModule.startProcessHeartbeat,
    )

    const a = await copyA.startProcessHeartbeat({
      version: '9.9.9',
      logger,
      now: () => 1000,
      pid: 4242,
      dir,
    })
    const b = await copyB.startProcessHeartbeat({
      version: '9.9.9',
      logger,
      layouts: { '/config/opencode': 'legacy' },
      now: () => 2000,
      pid: 4242,
      dir,
    })
    expect(b.path).toBe(a.path)
    expect(readdirSync(dir)).toEqual(['4242.json'])
    // The second copy keeps the first copy's start time and adds its layout.
    expect(readHeartbeat(join(dir, '4242.json'))).toEqual({
      pid: 4242,
      version: '9.9.9',
      startedAt: 1000,
      layouts: { '/config/opencode': 'legacy' },
    })
    // Copy A's owner leaving does not end copy B's ownership, and the legacy
    // layout copy B recorded keeps the file after both leave.
    await a.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(true)
    await b.release()
    expect(existsSync(join(dir, '4242.json'))).toBe(true)
  })
})

describe('CLI process heartbeat', () => {
  it('writes the heartbeat for the whole command and removes it after', async () => {
    const target = processHeartbeatPath(process.pid)
    rmSync(target, { force: true })
    let duringRun: ProcessHeartbeat | undefined
    const output: string[] = []
    const deps = {
      stdout: { write: (value: string) => output.push(value) },
      stderr: { write: (value: string) => output.push(value) },
      accountStore: {
        legacyPath: () => join(testRoot(), 'accounts.json'),
        read: async () => {
          duringRun = readHeartbeat(target)
          return { kind: 'uninitialized' as const }
        },
      },
    } as unknown as CliDependencies
    expect(await runCliProcess(['list', '--json'], deps)).toBe(0)
    expect(duringRun).toEqual({
      pid: process.pid,
      version: packageVersion,
      startedAt: expect.any(Number),
      layouts: { [processConfigFolderKey()]: 'legacy' },
    })
    expect(existsSync(target)).toBe(false)
  })

  it('removes the heartbeat when the command fails', async () => {
    const target = processHeartbeatPath(process.pid)
    const deps = {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      accountStore: {
        legacyPath: () => join(testRoot(), 'accounts.json'),
        read: async () => {
          expect(existsSync(target)).toBe(true)
          throw new Error('synthetic read failure')
        },
      },
    } as unknown as CliDependencies
    expect(await runCliProcess(['list'], deps)).toBe(1)
    expect(existsSync(target)).toBe(false)
  })
})
