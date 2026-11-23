import { expect, test } from 'bun:test'
import { requestCases, subjects } from './cases.ts'
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
