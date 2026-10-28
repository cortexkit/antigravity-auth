import { expect, it } from 'bun:test'
import { join } from 'node:path'
import { collectRelocationCommand } from './relocate-command.mjs'

it('collects stdout, stderr, PID and exit status from an awaited CLI child', async () => {
  const attempt = await collectRelocationCommand('capture', process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err')",
  ])
  expect(attempt.stdout).toBe('out')
  expect(attempt.stderr).toBe('err')
  expect(attempt.pid).toBeGreaterThan(0)
  expect(attempt.status).toBe(0)
  expect(attempt.signal).toBeNull()
  expect(attempt.error).toBeUndefined()
  expect(attempt.timedOut).toBe(false)
})

it('preserves an unsuccessful command exit without retrying', async () => {
  const attempt = await collectRelocationCommand('refused', process.execPath, [
    '-e',
    "process.stdout.write('one attempt'); process.exit(17)",
  ])
  expect(attempt.stdout).toBe('one attempt')
  expect(attempt.status).toBe(17)
  expect(attempt.signal).toBeNull()
  expect(attempt.error).toBeUndefined()
})

it('kills and reaps a deadline-exceeding command before returning its named error', async () => {
  const attempt = await collectRelocationCommand(
    'relocate-deadline',
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { deadlineMs: 200 },
  )
  expect(attempt.timedOut).toBe(true)
  expect(attempt.error?.message).toBe(
    'relocate-deadline exceeded its 200ms command deadline',
  )
  expect(attempt.signal).toBe('SIGKILL')
  if (!attempt.pid) throw new Error('deadline child did not spawn')
  expect(() => process.kill(attempt.pid!, 0)).toThrow()
})

it('records a spawn failure with no PID or termination signal', async () => {
  const attempt = await collectRelocationCommand(
    'missing',
    join(import.meta.dir, 'nonexistent-relocate-executable'),
    [],
  )
  expect(attempt.error).toBeDefined()
  expect(attempt.pid).toBeUndefined()
  expect(attempt.signal).toBeNull()
  expect(attempt.timedOut).toBe(false)
})

it('bounds collected output and kills an overflowing child', async () => {
  const attempt = await collectRelocationCommand(
    'noisy',
    process.execPath,
    [
      '-e',
      "process.stdout.write('x'.repeat(1000)); setInterval(() => {}, 1000)",
    ],
    { maxBuffer: 16 },
  )
  expect(attempt.error?.message).toBe('noisy exceeded its 16-byte stdout limit')
  expect(attempt.stdout.length).toBeLessThanOrEqual(16)
  expect(attempt.signal).toBe('SIGKILL')
  expect(attempt.timedOut).toBe(false)
})
