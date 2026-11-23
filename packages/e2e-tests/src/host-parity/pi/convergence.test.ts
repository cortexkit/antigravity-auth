import { expect, test } from 'bun:test'
import { requestCases } from '../cases.ts'
import { bodyOf, epoch, type Wire } from '../fixtures.ts'
import {
  type Captured,
  caseKey,
  caseLedger,
  type OutcomeOracle,
  outcomeFields,
  outcomeKey,
  replaySignatures,
  wireFields,
} from '../gate-data.ts'
import { runConversation } from '../runner.ts'
import { responseScenarios, scenarioUsesClock } from '../scenarios.ts'

const requestOracles = (await Bun.file(
  new URL('../request-oracles.json', import.meta.url),
).json()) as Record<string, Captured>
const responseOracles = (await Bun.file(
  new URL('../response-oracles.json', import.meta.url),
).json()) as Record<string, OutcomeOracle>
const requestRows = new Set([
  'request-wire:D1',
  'request-wire:D2',
  'request-wire:D3',
  'request-wire:D4',
  'request-wire:D5',
  'request-wire:D8',
])
const responseRows = new Set([
  'request-wire:D7',
  'response-errors:D2',
  'response-errors:D3',
  'response-errors:D6',
  'response-errors:D11',
])

const contents = (wire: Wire) =>
  (bodyOf(wire).request as { contents: unknown[] }).contents

function compareRequest(
  input: (typeof requestCases)[number],
  actual: Awaited<ReturnType<typeof runConversation>>,
  frozen: Wire[],
) {
  const actualFields = wireFields(actual.wire)
  const frozenFields = wireFields(frozen)
  expect(actualFields['wire.target']).toEqual(frozenFields['wire.target'])
  expect(actualFields['wire.headers']).toEqual(frozenFields['wire.headers'])
  if (input.replayText) {
    const signed = requestOracles[caseKey(input.id, 'opencode2', 'local')]!
    expect(replaySignatures(actual.turns)).toEqual(signed.replaySignatures!)
    const signatureInReplay = (wire: Wire) =>
      contents(wire).flatMap((turn) => {
        const { parts } = turn as {
          parts: Array<{ text?: string; thoughtSignature?: string }>
        }
        return parts
          .filter((part) => part.text === 'Four.')
          .map((part) => part.thoughtSignature)
      })
    expect(actual.wire.map(signatureInReplay)).toEqual(
      signed.wire!.map(signatureInReplay),
    )
  } else if (input.id.startsWith('Claude tool reply ending the history')) {
    // The existing Antigravity envelope bypasses the Claude tool instructions
    // added to Google SDK JSON. Compare the conversation, not those instructions.
    expect(actual.wire.map(contents)).toEqual(frozen.map(contents))
  } else {
    expect(actualFields['wire.body']).toEqual(frozenFields['wire.body'])
  }
}

type Trace = Array<{ sessionId?: string; report?: Record<string, unknown> }>
function reportTrace(input: unknown): Trace {
  const ids = new Map<string, number>()
  // A report ID is opaque. Keep its identity and reuse in the trace, without
  // counting UUID calls made by the different hosts' storage implementations.
  return (JSON.parse(JSON.stringify(input)) as Trace).map((entry) => {
    for (const key of ['attempt_id', 'wait_id']) {
      const id = entry.report?.[key]
      if (typeof id !== 'string') continue
      if (!ids.has(id)) ids.set(id, ids.size + 1)
      entry.report![key] = ids.get(id)
    }
    return entry
  })
}

function includeBoundBackoff(trace: Trace): Trace {
  return trace.flatMap((entry) => {
    if (entry.report?.kind !== 'billing' || entry.report.status !== 429)
      return [entry]
    return [
      entry,
      {
        sessionId: entry.sessionId,
        report: {
          kind: 'transient_backoff',
          account_id: 'parity-identity',
          credential_id: 'parity-credential',
          retry_at_ms: epoch + 5000 * Number(entry.report.attempt),
        },
      },
    ]
  })
}

for (const input of requestCases) {
  if (!requestRows.has(caseLedger(input) ?? '')) continue
  const oracleCase =
    input.options.raw === true
      ? 'Claude tool reply ending the history: wrapped'
      : input.id
  const frozen = requestOracles[caseKey(oracleCase, 'opencode1', 'local')]?.wire
  for (const subject of ['pi', 'pi-transcript'] as const) {
    test(`${subject} matches the request oracle for ${input.id}`, async () => {
      expect(frozen?.length).toBe(input.sessions.length)
      const actual = await runConversation({ subject, custody: 'local', input })
      compareRequest(input, actual, frozen!)
    })
  }
}

for (const scenario of responseScenarios) {
  if (!responseRows.has(scenario.ledger)) continue
  for (const custody of ['local', 'vault', 'host'] as const) {
    test(`Pi ${custody} follows engine attempts for ${scenario.input.id}`, async () => {
      const actual = await runConversation({
        subject: 'pi',
        custody,
        input: scenario.input,
        reply: (_wire, index) =>
          scenario.replies[Math.min(index, scenario.replies.length - 1)]!,
        timed: scenarioUsesClock(scenario),
      })
      const fields = outcomeFields(actual, scenario.input.id)
      const oracle = responseOracles[outcomeKey(scenario.input.id, custody)]!
      for (const field of [
        'physicalSends',
        'delays',
        'text',
        'thinking',
      ] as const)
        expect({
          [field]: fields[field],
          errors: actual.turns.flatMap((turn) => turn.errors),
        }).toEqual({
          [field]: oracle.record[field],
          errors: actual.turns.flatMap((turn) => turn.errors),
        })
      expect(fields.hooks).toEqual(oracle.piHooks)
      const baselineTrace = reportTrace(oracle.record.reports)
      expect(reportTrace(fields.reports)).toEqual(
        scenario.input.id === 'unexplained 429' && custody !== 'local'
          ? includeBoundBackoff(baselineTrace)
          : baselineTrace,
      )
    })
  }
}
