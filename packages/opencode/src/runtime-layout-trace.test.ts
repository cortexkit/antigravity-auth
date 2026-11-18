import { expect, it } from 'bun:test'
import { RuntimeLayoutLockTrace } from './plugin/__fixtures__/runtime-layout-lock-trace.test'

function traceHarness() {
  let now = 0
  let alarm: { due: number; callback: () => void } | undefined
  const lines: string[] = []
  const trace = new RuntimeLayoutLockTrace({
    now: () => now,
    emit: (line) => lines.push(line),
    schedule: (callback, ms) => {
      alarm = { callback, due: now + ms }
      return () => {
        alarm = undefined
      }
    },
  })
  trace.arm('sample layout test', 5_000)
  return {
    trace,
    lines,
    advance(ms: number) {
      now += ms
      if (alarm && now >= alarm.due) {
        const { callback } = alarm
        alarm = undefined
        callback()
      }
    },
  }
}

function table(lines: string[], reason: string, rowCount: number) {
  const prefix = 'AGY_LAYOUT_TRACE '
  expect(lines).toHaveLength(rowCount + 2)
  const [header, ...rows] = lines.map((line) => {
    expect(line.startsWith(prefix)).toBe(true)
    return JSON.parse(line.slice(prefix.length))
  })
  expect(header).toMatchObject({
    kind: 'header',
    test: 'sample layout test',
    reason,
    rowCount,
  })
  expect(rows.pop()).toEqual({
    kind: 'footer',
    test: 'sample layout test',
    reason,
    rowCount,
  })
  return rows
}

it('prints one row per phase after a slow pass', async () => {
  const { trace, lines, advance } = traceHarness()
  trace.syncPhase('setup', () => advance(5))
  await trace.phase('injected slow prepare', () => advance(3_100))
  trace.bodySettled()
  trace.syncPhase('teardown', () => advance(5))
  trace.finish('passed')
  const rows = table(lines, 'slow, passed', 3)
  expect(rows).toMatchObject([
    { kind: 'event', index: 0, phase: 'setup', ms: 5, pending: false },
    {
      kind: 'event',
      index: 1,
      phase: 'injected slow prepare',
      ms: 3_100,
      pending: false,
    },
    { kind: 'event', index: 2, phase: 'teardown', ms: 5, pending: false },
  ])
})

it('prints nothing for a fast pass and cancels the pending snapshot', async () => {
  const { trace, lines, advance } = traceHarness()
  await trace.phase('prepare', () => advance(100))
  trace.bodySettled()
  trace.finish('passed')
  advance(5_000)
  expect(lines).toEqual([])
})

it('prints pending work at 4.8 s and a complete table when the timed-out body settles', async () => {
  const { trace, lines, advance } = traceHarness()
  const prepare = Promise.withResolvers<void>()
  const body = trace.phase('prepare', () => prepare.promise)
  advance(4_799)
  expect(lines).toEqual([])
  advance(1)
  expect(
    table(lines.splice(0), 'near timeout, may still pass', 1)[0],
  ).toMatchObject({ phase: 'prepare', ms: 4_800, pending: true })

  advance(300)
  prepare.resolve()
  await body
  trace.bodySettled()
  trace.syncPhase('teardown', () => advance(20))
  trace.finish('timeout')
  expect(table(lines, 'timeout', 2)).toMatchObject([
    { phase: 'prepare', ms: 5_100, pending: false },
    { phase: 'teardown', ms: 20, pending: false },
  ])
})

it('prints even a fast failure with its error code', async () => {
  const { trace, lines } = traceHarness()
  const error = Object.assign(new Error('simulated refusal'), { code: 'EBUSY' })
  await expect(
    trace.phase('prepare', () => {
      throw error
    }),
  ).rejects.toBe(error)
  trace.bodySettled()
  trace.finish('failure')
  expect(table(lines, 'failure', 1)[0]).toMatchObject({
    phase: 'prepare',
    error: { code: 'EBUSY' },
  })
})
