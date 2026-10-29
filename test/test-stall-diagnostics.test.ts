import { expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  createPublicCommandDiagnostic,
  PUBLIC_COMMAND_BOUNDS,
  runPublicConsumerCommand,
} from '../scripts/prepare-common-auth-public-consumer.ts'
import { traceSyncTestChild } from '../scripts/test-child-lifecycle.ts'
import {
  bunSpawnSyncWedgeMessage,
  createTestFileObserver,
  FILE_BOUNDARY_RECORDS,
  matchBunSpawnSyncWedge,
  parseWedgePs,
  readWedgeSnapshot,
  STALL_SNAPSHOT_BYTES,
  type WedgeProcessRow,
  type WedgeSnapshot,
} from '../scripts/test-stall-diagnostics.ts'

const linux = process.platform === 'linux'

test.skipIf(!linux)(
  'supervisor deadline emits a bounded owned Linux snapshot without argv or environment',
  async () => {
    const output: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      output.push(String(line))
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk) => {
        output.push(String(chunk))
        return true
      },
    )
    const diagnostic = createPublicCommandDiagnostic(true)
    try {
      await expect(
        runPublicConsumerCommand(
          [
            process.execPath,
            '-e',
            `import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)', 'SECRET_ARG_MUST_NOT_APPEAR'], { stdio: 'ignore' }); process.stderr.write('test/previous.test.ts:\\ntest/current.test.ts:\\n'); setInterval(() => {}, 100);`,
          ],
          {
            executionMs: 1_000,
            reapMs: 1_000,
            termGraceMs: 50,
            outputCapBytes: 4096,
          },
          undefined,
          diagnostic,
        ),
      ).rejects.toThrow('test command execution deadline exceeded')
      const lines = output.filter((line) =>
        line.startsWith('[test-stall-snapshot] '),
      )
      expect(lines).toHaveLength(1)
      const boundaries = output.filter((line) =>
        line.startsWith('[test-file-boundary] '),
      )
      expect(
        boundaries.map((line) => {
          const record = JSON.parse(line.slice('[test-file-boundary] '.length))
          return [record.event, record.path]
        }),
      ).toEqual([
        ['start', 'test/previous.test.ts'],
        ['end', 'test/previous.test.ts'],
        ['start', 'test/current.test.ts'],
        ['end', 'test/current.test.ts'],
      ])
      expect(output.indexOf(boundaries[2] ?? '')).toBeLessThan(
        output.indexOf(lines[0] ?? ''),
      )
      const line = lines[0] ?? ''
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(STALL_SNAPSHOT_BYTES)
      expect(line).not.toContain('SECRET_')
      expect(line).not.toContain('setInterval')
      expect(line).not.toContain('HOME=')
      const snapshot = JSON.parse(line.slice('[test-stall-snapshot] '.length))
      expect(snapshot.reason).toBe('deadline')
      expect(snapshot.available).toBe(true)
      expect(snapshot.processes.length).toBeGreaterThanOrEqual(2)
      expect(
        snapshot.processes.some(
          (row: { pid: number }) => row.pid === process.pid,
        ),
      ).toBe(false)
      for (const row of snapshot.processes) {
        expect(row.ps).toMatch(/^\d+\s+\d+\s+\d+\s+\d+\s+/)
        expect(row.stat).toContain('(<redacted>)')
        expect(row.status).toContain('Pid:')
        expect(row.command.argc).toBeGreaterThan(0)
        expect(row.command).not.toHaveProperty('argv')
      }
      expect(snapshot.host.loadavg).toMatch(/^\d/)
      // The sampler reports 'unavailable' when pressure files cannot be read
      // (for example a container without /proc/pressure/cpu). Read the file
      // here, independently of the code under test, and assert whichever
      // branch this machine actually has, so the regression still fails
      // where CPU pressure readings exist.
      let cpuPressure: string | undefined
      try {
        cpuPressure = readFileSync('/proc/pressure/cpu', 'utf8')
      } catch {
        cpuPressure = undefined
      }
      if (cpuPressure !== undefined)
        expect(snapshot.host.cpu).toContain('some avg10=')
      else expect(snapshot.host.cpu).toBe('unavailable')
      expect(diagnostic.completion).toMatchObject({
        leaderExited: true,
        pipesClosed: true,
        cleanupConfirmed: true,
      })
    } finally {
      error.mockRestore()
      log.mockRestore()
      stderr.mockRestore()
    }
  },
  20_000,
)

test('file boundary observer handles split headers and bounds partial lines', () => {
  const lines: string[] = []
  const files = createTestFileObserver(
    123,
    () => 2,
    (line) => lines.push(line),
  )
  files.feed(Buffer.from('test/alpha.te'))
  files.feed(Buffer.from('st.ts:\n(pass) first\n'))
  files.feed(Buffer.from(`${'x'.repeat(10_000)}\n`))
  files.feed(
    Buffer.from('\u001b[32mpackages/core/src/beta.test.ts:\u001b[0m\n'),
  )
  const bytes = files.close()
  expect(lines).toHaveLength(0)
  expect(files.flush()).toBe(bytes)
  expect(lines).toHaveLength(4)
  expect(files.flush()).toBe(0)
  expect(bytes).toBe(Buffer.byteLength(lines.join('')))
  const records = lines.map((line) =>
    JSON.parse(line.slice('[test-file-boundary] '.length)),
  )
  expect(records.map((record) => [record.event, record.path])).toEqual([
    ['start', 'test/alpha.test.ts'],
    ['end', 'test/alpha.test.ts'],
    ['start', 'packages/core/src/beta.test.ts'],
    ['end', 'packages/core/src/beta.test.ts'],
  ])
  for (const record of records) {
    expect(record.runnerPid).toBe(123)
    expect(record.ownedLiveChildren).toBe(2)
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(record.wall).toMatch(/^\d{4}-\d\d-\d\dT/)
  }
})

test('file boundary observer retains only the last 64 records until a failure flush', () => {
  const lines: string[] = []
  const files = createTestFileObserver(
    123,
    () => 0,
    (line) => lines.push(line),
  )
  for (let index = 0; index < 40; index++)
    files.feed(Buffer.from(`test/buffer-${index}.test.ts:\n`))
  const observedBytes = files.close()
  expect(lines).toHaveLength(0)
  expect(files.flush()).toBeLessThan(observedBytes)
  expect(lines).toHaveLength(FILE_BOUNDARY_RECORDS)
  expect(
    JSON.parse((lines[0] ?? '').slice('[test-file-boundary] '.length)),
  ).toMatchObject({ event: 'start', path: 'test/buffer-8.test.ts' })
  expect(
    JSON.parse((lines.at(-1) ?? '').slice('[test-file-boundary] '.length)),
  ).toMatchObject({ event: 'end', path: 'test/buffer-39.test.ts' })
  expect(files.flush()).toBe(0)
})

test.skipIf(!linux)(
  'green supervisor command prints no file boundaries',
  async () => {
    const previousRequireDocker = process.env.ANTIGRAVITY_TEST_REQUIRE_DOCKER
    process.env.ANTIGRAVITY_TEST_REQUIRE_DOCKER = '1'
    const output: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      output.push(String(line))
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk) => {
        output.push(String(chunk))
        return true
      },
    )
    try {
      const status = await runPublicConsumerCommand(
        [
          process.execPath,
          '-e',
          `process.stderr.write('test/green-first.test.ts:\\ntest/green-final.test.ts:\\n'); process.stderr.write('require-docker=' + process.env.ANTIGRAVITY_TEST_REQUIRE_DOCKER + '\\n');`,
        ],
        {
          executionMs: 3_000,
          reapMs: 1_000,
          termGraceMs: 50,
          outputCapBytes: 4096,
        },
      )
      expect(status).toBe(0)
      expect(output.join('')).toContain('test/green-final.test.ts:')
      expect(output.join('')).toContain('require-docker=1\n')
      expect(output.join('')).not.toContain('[test-file-boundary]')
      expect(output.join('')).not.toContain('[test-stall-snapshot]')
    } finally {
      if (previousRequireDocker === undefined)
        delete process.env.ANTIGRAVITY_TEST_REQUIRE_DOCKER
      else process.env.ANTIGRAVITY_TEST_REQUIRE_DOCKER = previousRequireDocker
      error.mockRestore()
      log.mockRestore()
      stderr.mockRestore()
    }
  },
  20_000,
)

test.skipIf(!linux)(
  'nonzero supervisor exit flushes recent boundaries including the final file end',
  async () => {
    const output: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      output.push(String(line))
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk) => {
        output.push(String(chunk))
        return true
      },
    )
    try {
      const status = await runPublicConsumerCommand(
        [
          process.execPath,
          '-e',
          `process.stderr.write('test/nonzero.test.ts:\\n'); process.exitCode = 7;`,
        ],
        {
          executionMs: 3_000,
          reapMs: 1_000,
          termGraceMs: 50,
          outputCapBytes: 4096,
        },
      )
      expect(status).toBe(7)
      const boundaries = output.filter((line) =>
        line.startsWith('[test-file-boundary] '),
      )
      expect(
        boundaries.map((line) => {
          const record = JSON.parse(line.slice('[test-file-boundary] '.length))
          return [record.event, record.path]
        }),
      ).toEqual([
        ['start', 'test/nonzero.test.ts'],
        ['end', 'test/nonzero.test.ts'],
      ])
    } finally {
      error.mockRestore()
      log.mockRestore()
      stderr.mockRestore()
    }
  },
  20_000,
)

test('synchronous lifecycle failures report only safe command metadata and observation times', () => {
  const journalRoot = process.env.AGY_COMMON_AUTH_STORE_CONSUMER
  delete process.env.AGY_COMMON_AUTH_STORE_CONSUMER
  const lines: string[] = []
  const error = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line))
  })
  try {
    const result = traceSyncTestChild(
      'native-run',
      '/private/path/bun',
      3,
      () => ({
        pid: 123,
        status: 1,
        signal: null,
        stdout: 'SECRET_OUTPUT',
        stderr: 'SECRET_ERROR',
      }),
    )
    expect(result.status).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('SECRET')
    expect(lines[0]).not.toContain('/private/path')
    const record = JSON.parse(
      (lines[0] ?? '').slice('[test-child-lifecycle] '.length),
    )
    expect(record).toMatchObject({
      command: 'bun',
      argc: 3,
      pid: 123,
      status: 1,
      signal: null,
      failed: true,
      observation: 'synchronous-wait-return',
    })
    expect(record.spawnRequested.wall).toMatch(/^\d{4}/)
    expect(record.exitObserved).toEqual(record.waitReturned)
    expect(record.pipesClosedObserved).toEqual(record.waitReturned)
  } finally {
    if (journalRoot !== undefined)
      process.env.AGY_COMMON_AUTH_STORE_CONSUMER = journalRoot
    error.mockRestore()
  }
})

// Rows modelled on a real CI stall: the test runner in state R at 99.8% CPU
// and its only child a zombie for 1,195 s.
const runner = (overrides: Partial<WedgeProcessRow> = {}): WedgeProcessRow => ({
  pid: 4174,
  ppid: 4118,
  state: 'Rsl',
  elapsedS: 1199,
  cpuPercent: 99.8,
  ...overrides,
})
const child = (overrides: Partial<WedgeProcessRow> = {}): WedgeProcessRow => ({
  pid: 4207,
  ppid: 4174,
  state: 'Z',
  elapsedS: 1195,
  cpuPercent: 0,
  ...overrides,
})
const wedgeSnapshot = (
  runnerRow = runner(),
  children = [child()],
): WedgeSnapshot => ({ runner: runnerRow, children })

test('wedge detector matches a spinning runner with an old zombie child', () => {
  expect(matchBunSpawnSyncWedge(wedgeSnapshot(), 'linux')).toEqual({
    runnerPid: 4174,
    cpuPercent: 99.8,
    zombiePid: 4207,
    zombieElapsedS: 1195,
  })
  // The thresholds are inclusive.
  expect(
    matchBunSpawnSyncWedge(
      wedgeSnapshot(runner({ cpuPercent: 90 }), [child({ elapsedS: 60 })]),
      'linux',
    ),
  ).toBeDefined()
})

test('wedge detector ignores a runner at 50 percent CPU', () => {
  expect(
    matchBunSpawnSyncWedge(wedgeSnapshot(runner({ cpuPercent: 50 })), 'linux'),
  ).toBeUndefined()
})

test('wedge detector ignores a zombie only 30 s old', () => {
  expect(
    matchBunSpawnSyncWedge(
      wedgeSnapshot(runner(), [child({ elapsedS: 30 })]),
      'linux',
    ),
  ).toBeUndefined()
})

test('wedge detector ignores a sleeping runner with an old zombie', () => {
  expect(
    matchBunSpawnSyncWedge(wedgeSnapshot(runner({ state: 'Ssl' })), 'linux'),
  ).toBeUndefined()
})

test('wedge detector ignores an old child that is not a zombie', () => {
  expect(
    matchBunSpawnSyncWedge(
      wedgeSnapshot(runner(), [child({ state: 'S' }), child({ state: 'R' })]),
      'linux',
    ),
  ).toBeUndefined()
})

test('wedge detector ignores a runner without children', () => {
  expect(
    matchBunSpawnSyncWedge(wedgeSnapshot(runner(), []), 'linux'),
  ).toBeUndefined()
})

test('wedge detector does nothing without a snapshot or off Linux', () => {
  expect(matchBunSpawnSyncWedge(undefined, 'linux')).toBeUndefined()
  expect(matchBunSpawnSyncWedge(wedgeSnapshot(), 'darwin')).toBeUndefined()
  expect(matchBunSpawnSyncWedge(wedgeSnapshot(), 'win32')).toBeUndefined()
})

test('wedge stop error names the Bun issue and both pids', () => {
  const wedge = matchBunSpawnSyncWedge(wedgeSnapshot(), 'linux')
  if (!wedge) throw new Error('full match expected')
  expect(bunSpawnSyncWedgeMessage(wedge)).toBe(
    'Bun spawnSync child-exit loss (oven-sh/bun#34069): test runner pid 4174 is spinning at 99.8% CPU with zombie child pid 4207 for 1195s',
  )
})

test('wedge ps rows parse into the runner and only its direct children', () => {
  const parsed = parseWedgePs(
    '   4174    4118 Rsl     1199 99.8\n   4207    4174 Z       1195  0.0\n   4300    4207 S         10  0.0\nnot a row\n',
    4174,
  )
  expect(parsed).toEqual(wedgeSnapshot())
  expect(parseWedgePs('   4207    4174 Z  1195  0.0\n', 4174)).toBeUndefined()
})

test.skipIf(!linux)(
  'supervisor stops on the wedge signature with a snapshot instead of waiting for its deadline',
  async () => {
    const output: string[] = []
    const error = spyOn(console, 'error').mockImplementation((line) => {
      output.push(String(line))
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk) => {
        output.push(String(chunk))
        return true
      },
    )
    const reads: number[] = []
    const started = performance.now()
    try {
      await expect(
        runPublicConsumerCommand(
          [
            process.execPath,
            '-e',
            `process.stderr.write('test/wedged.test.ts:\\n'); setInterval(() => {}, 100);`,
          ],
          {
            executionMs: PUBLIC_COMMAND_BOUNDS.executionMs,
            reapMs: 1_000,
            termGraceMs: 50,
            outputCapBytes: 4096,
          },
          undefined,
          undefined,
          {
            intervalMs: 100,
            platform: 'linux',
            read: async (pid) => {
              reads.push(pid)
              return wedgeSnapshot(runner({ pid }), [child({ ppid: pid })])
            },
          },
        ),
      ).rejects.toThrow(
        /^Bun spawnSync child-exit loss \(oven-sh\/bun#34069\): test runner pid \d+ is spinning at 99\.8% CPU with zombie child pid 4207 for 1195s$/,
      )
      expect(performance.now() - started).toBeLessThan(10_000)
      expect(reads.length).toBeGreaterThan(0)
      const lines = output.filter((line) =>
        line.startsWith('[test-stall-snapshot] '),
      )
      expect(lines).toHaveLength(1)
      const snapshot = JSON.parse(
        (lines[0] ?? '').slice('[test-stall-snapshot] '.length),
      )
      expect(snapshot.reason).toBe('bun-spawnsync-wedge')
      expect(snapshot.processes[0].pid).toBe(reads[0])
    } finally {
      error.mockRestore()
      log.mockRestore()
      stderr.mockRestore()
    }
  },
  20_000,
)

test.skipIf(!linux)(
  'wedge snapshot reads the live runner and its direct children through ps',
  async () => {
    const sleeper = Bun.spawn(
      [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    try {
      const observed = await readWedgeSnapshot(process.pid)
      expect(observed?.runner.pid).toBe(process.pid)
      expect(observed?.runner.state).toMatch(/^[A-Z]/)
      expect(
        observed?.children.some(
          (row) => row.pid === sleeper.pid && row.ppid === process.pid,
        ),
      ).toBe(true)
    } finally {
      sleeper.kill('SIGKILL')
      await sleeper.exited
    }
  },
  10_000,
)
