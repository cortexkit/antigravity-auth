import { expect, test } from 'bun:test'
import { requestCases } from '../cases.ts'
import { bodyOf, type Wire } from '../fixtures.ts'
import { type CaptureRevision, requestReference } from '../gate.ts'
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
const revisions = (await Bun.file(
  new URL('../request-revisions.json', import.meta.url),
).json()) as Record<string, CaptureRevision>
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
  subject: 'pi' | 'pi-transcript',
  actual: Awaited<ReturnType<typeof runConversation>>,
  reference: Wire[],
) {
  expect(wireFields(actual.wire, input, { host: subject })).toEqual(
    wireFields(reference, input, { host: subject, reference: true }),
  )
  if (input.id.startsWith('Claude tool reply ending the history'))
    expect(actual.wire.map(({ headers }) => headers)).toEqual(
      reference.map(({ headers }) => headers),
    )
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

for (const input of requestCases) {
  if (!requestRows.has(caseLedger(input) ?? '')) continue
  const reference = requestReference(input, requestOracles, revisions)
  for (const subject of ['pi', 'pi-transcript'] as const) {
    test(`${subject} matches the request oracle for ${input.id}`, async () => {
      expect(reference.length).toBe(input.sessions.length)
      const actual = await runConversation({ subject, custody: 'local', input })
      compareRequest(input, subject, actual, reference)
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
      expect(reportTrace(fields.reports)).toEqual(
        reportTrace(oracle.record.reports),
      )
    })
  }
}
