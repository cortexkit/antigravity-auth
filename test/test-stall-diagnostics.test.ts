import { expect, spyOn, test } from 'bun:test'
import {
  createPublicCommandDiagnostic,
  runPublicConsumerCommand,
} from '../scripts/prepare-common-auth-public-consumer.ts'
import { traceSyncTestChild } from '../scripts/test-child-lifecycle.ts'
import {
  createTestFileObserver,
  FILE_BOUNDARY_RECORDS,
  STALL_SNAPSHOT_BYTES,
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
      expect(snapshot.host.cpu).toContain('some avg10=')
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
          `process.stderr.write('test/green-first.test.ts:\\ntest/green-final.test.ts:\\n');`,
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
      expect(output.join('')).not.toContain('[test-file-boundary]')
      expect(output.join('')).not.toContain('[test-stall-snapshot]')
    } finally {
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
