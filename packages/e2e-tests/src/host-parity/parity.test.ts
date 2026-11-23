import { expect, test } from 'bun:test'
import { requestCases, subjects } from './cases.ts'
import { epoch } from './fixtures.ts'
import { admittedCapture, checkCorpus } from './gate.ts'
import {
  baseCommit,
  caseKey,
  compareFields,
  digest,
  fieldKey,
  type KnownFailure,
  wireFields,
} from './gate-data.ts'
import { recordCorpus } from './record.ts'
import { runConversation } from './runner.ts'
import { responseScenarios } from './scenarios.ts'

const capturePath = process.env.HOST_PARITY_RECORD
if (capturePath) {
  test('record the stock host transport observations', async () => {
    const mode =
      process.env.HOST_PARITY_BASELINE === '1' ? 'baseline' : 'observe'
    const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' })
    const revision = (await new Response(child.stdout).text()).trim()
    if (
      (await child.exited) !== 0 ||
      (mode === 'baseline' && revision !== baseCommit)
    )
      throw new Error(
        'The capture checkout does not match the frozen source commit',
      )
    const result = await recordCorpus(revision, mode)
    await Bun.write(capturePath, `${JSON.stringify(result, null, 2)}\n`)
  }, 180_000)
}

if (!capturePath)
  test(
    'frozen wires and literal public outcomes agree or have exact known differences',
    checkCorpus,
    120_000,
  )

test('the gate rejects reordered headers and uncited capture revisions', () => {
  const input = requestCases.find(({ id }) => id === 'plain chat')!
  const headers: [string, string][] = [
    ['Host', 'captured.test'],
    ['Authorization', 'Bearer fixture'],
  ]
  const wire = [
    { target: 'https://captured.test', headers, bodyBase64: 'e30=' },
  ]
  const reordered = [{ ...wire[0]!, headers: headers.toReversed() }]
  const key = caseKey(input.id, 'opencode1', 'local')
  const mismatches: string[] = []
  compareFields({
    key,
    actual: wireFields(reordered),
    expected: wireFields(wire),
    known: new Map(),
    mismatches,
  })
  expect(mismatches).toHaveLength(1)
  expect(mismatches[0]).toContain(fieldKey(key, 'wire.headers'))
  expect(() =>
    admittedCapture(input, 'opencode1', wire, { ledger: '', wire: reordered }),
  ).toThrow('names no applicable ledger row')
})

test('the gate rejects a stale or changed known failure by exact field', () => {
  const key = caseKey('example', 'pi', 'vault')
  const name = fieldKey(key, 'terminal')
  const old: KnownFailure = [name, digest([['failure:upstream_http']])]
  const expected = { terminal: [['stop']] }
  const check = (actual: typeof expected) => {
    const mismatches: string[] = []
    compareFields({
      key,
      actual,
      expected,
      known: new Map([[name, old]]),
      mismatches,
    })
    return mismatches
  }
  expect(check({ terminal: [['failure:upstream_http']] })).toEqual([])
  expect(check(expected)).toEqual([
    `${name} passes now: remove the known failure`,
  ])
  expect(check({ terminal: [['failure:deadline']] })[0]).toContain(name)
})

const reportId = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const billingReport = (attemptId: string) => ({
  sessionId: 'example',
  report: { kind: 'billing', attempt_id: attemptId, status: 200 },
})
const waitReport = (waitId: string, phase: 'start' | 'end') => ({
  sessionId: 'example',
  report: { kind: 'wait', wait_id: waitId, phase, reason: 'rate_limited' },
})
const checkReports = (actual: unknown, expected: unknown = []) => {
  const mismatches: string[] = []
  compareFields({
    key: caseKey('example', 'pi', 'vault'),
    actual: { reports: actual },
    expected: { reports: expected },
    known: new Map(),
    mismatches,
  })
  return mismatches
}

test('the report gate compares ID relationships and all other fields', () => {
  const trace = (id: number) => [
    billingReport(reportId(id)),
    waitReport(reportId(id + 1), 'start'),
    waitReport(reportId(id + 1), 'end'),
    billingReport(reportId(id + 2)),
  ]
  const expected = trace(1)
  const actual = trace(4)
  expect(checkReports(actual, expected)).toEqual([])
  expect(checkReports(actual.slice(1), expected)).toHaveLength(1)
  expect(checkReports([...actual.slice(1), actual[0]], expected)).toHaveLength(
    1,
  )
  expect(
    checkReports(
      [
        { sessionId: 'example', report: { ...actual[0]!.report, status: 403 } },
        ...actual.slice(1),
      ],
      expected,
    ),
  ).toHaveLength(1)
})

test.each([
  ['a malformed ID', [billingReport('broken')], 'Malformed report attempt_id'],
  [
    'a reused billing ID',
    [billingReport(reportId(1)), billingReport(reportId(1))],
    'Reused report attempt_id',
  ],
  [
    'a wait end without a start',
    [waitReport(reportId(1), 'end')],
    'Unpaired report wait end',
  ],
  [
    'a reused wait ID',
    [
      waitReport(reportId(1), 'start'),
      waitReport(reportId(1), 'end'),
      waitReport(reportId(1), 'start'),
    ],
    'Reused report wait_id',
  ],
])('the report gate rejects %s', (_description, trace, message) => {
  expect(() => checkReports(trace)).toThrow(message as string)
})

test.each([
  ...subjects,
])('%s enters the stock public request and response paths', async (subject) => {
  const input = requestCases[0]!
  const result = await runConversation({
    input,
    subject,
    custody: 'local',
    timed: true,
  })
  expect(result).toMatchObject({
    wire: [{ target: expect.stringContaining(':streamGenerateContent') }],
    turns: [{ text: 'Four.', terminal: ['stop'], errors: [] }],
  })
})

test.each([
  'opencode1',
  'opencode2',
  'pi',
] as const)('%s reports each unexplained refusal on an unrouted vault login', async (subject) => {
  const scenario = responseScenarios.find(
    ({ input }) => input.id === 'unexplained 429',
  )!
  const options = {
    subject,
    custody: 'vault' as const,
    input: scenario.input,
    timed: true,
    reply: () => scenario.replies[0]!,
  }
  const withAccessor = await runConversation(options)
  expect(withAccessor.physicalSends).toHaveLength(3)
  expect(
    withAccessor.reports.filter(
      (entry) =>
        (entry as { report?: { kind?: unknown } }).report?.kind ===
        'transient_backoff',
    ),
  ).toEqual(
    [5_000, 10_000, 15_000].map((delay) => ({
      sessionId: 'parity-session',
      report: {
        kind: 'transient_backoff',
        account_id: 'parity-identity',
        credential_id: 'parity-credential',
        retry_at_ms: epoch + delay,
      },
    })),
  )
  const withoutAccessor = await runConversation({
    ...options,
    observeRouting: false,
  })
  expect(withoutAccessor.physicalSends).toHaveLength(3)
  expect(withoutAccessor.reports).toEqual([])
})
