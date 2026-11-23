import { expect, test } from 'bun:test'
import { requestCases } from '../cases.ts'
import {
  type Captured,
  caseKey,
  caseLedger,
  type OutcomeOracle,
  outcomeFields,
  outcomeKey,
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

for (const input of requestCases) {
  if (!requestRows.has(caseLedger(input) ?? '')) continue
  const oracleCase =
    input.options.raw === true
      ? 'Claude tool reply ending the history: wrapped'
      : input.id
  const frozen = requestOracles[caseKey(oracleCase, 'opencode1', 'local')]?.wire
  for (const subject of ['pi', 'pi-transcript'] as const) {
    test(`${subject} sends the OpenCode 1 capture for ${input.id}`, async () => {
      expect(frozen?.length).toBe(input.sessions.length)
      const actual = await runConversation({ subject, custody: 'local', input })
      expect(wireFields(actual.wire)).toEqual(wireFields(frozen!))
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
        'reports',
      ] as const)
        expect(fields[field]).toEqual(oracle.record[field])
      expect(fields.hooks).toEqual(oracle.piHooks)
    })
  }
}
