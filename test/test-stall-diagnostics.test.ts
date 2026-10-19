import { expect, spyOn, test } from 'bun:test'
import {
  createPublicCommandDiagnostic,
  runPublicConsumerCommand,
} from '../scripts/prepare-common-auth-public-consumer.ts'
import { traceSyncTestChild } from '../scripts/test-child-lifecycle.ts'
import {
  createTestFileObserver,
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
    const diagnostic = createPublicCommandDiagnostic(true)
    try {
      await expect(
        runPublicConsumerCommand(
          [
            process.execPath,
            '-e',
            `import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)', 'SECRET_ARG_MUST_NOT_APPEAR'], { stdio: 'ignore' }); setInterval(() => {}, 100);`,
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
  expect(lines).toHaveLength(4)
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
