import { custodies, requestCases, subjects } from './cases.ts'
import { excepts } from './exceptions.ts'
import {
  baseCommit,
  type Captured,
  caseKey,
  caseLedger,
  digest,
  expectedOutcome,
  type Fields,
  fieldKey,
  type KnownFailure,
  type OutcomeOracle,
  outcomeFields,
  outcomeKey,
  replaySignatures,
  wireFields,
  wireSemantics,
} from './gate-data.ts'
import type { Observation } from './runner.ts'
import { responseScenarios } from './scenarios.ts'

type Recording = {
  requests: Record<string, Captured & Partial<Observation>>
  responses: Record<string, Observation>
}

function requireEntry<T>(entries: Record<string, T>, key: string): T {
  const value = entries[key]
  if (value === undefined) throw new Error(`Missing observation ${key}`)
  return value
}

async function main(baselinePath: string, observedPath: string) {
  const baseline: Recording = await Bun.file(baselinePath).json()
  const current: Recording = await Bun.file(observedPath).json()
  const requests: Record<string, Captured> = {}
  const responses: Record<string, OutcomeOracle> = {}
  const failures: KnownFailure[] = []

  function collect(
    key: string,
    actual: Fields,
    expected: Fields,
    ledger?: string,
  ) {
    for (const [field, value] of Object.entries(expected)) {
      const sha = digest(actual[field])
      if (sha !== digest(value))
        failures.push(
          ledger === undefined
            ? [fieldKey(key, field), sha]
            : [fieldKey(key, field), sha, ledger],
        )
    }
  }

  for (const input of requestCases) {
    for (const subject of ['opencode1', 'opencode2'] as const) {
      const key = caseKey(input.id, subject, 'local')
      const captured = requireEntry(baseline.requests, key)
      const observed = requireEntry(current.requests, key)
      if (captured.sourceCommit !== baseCommit)
        throw new Error(`${key} was not captured from the frozen baseline`)
      if (captured.unrepresentable) {
        if (
          !observed.unrepresentable ||
          !excepts(input.id, subject, 'wire.thinkingLevel')
        )
          throw new Error(`${key} has an invalid representability exception`)
        requests[key] = {
          sourceCommit: captured.sourceCommit,
          host: captured.host,
          unrepresentable: true,
        }
      } else {
        if (
          captured.wire?.length !== input.sessions.length ||
          captured.turns?.some(({ errors }) => errors.length)
        )
          throw new Error(
            `${key} did not traverse the full baseline request path: ${JSON.stringify(captured.turns)}`,
          )
        if (digest(captured.wire) !== digest(observed.wire))
          throw new Error(
            `${key} differs from its frozen host capture without a ledger change`,
          )
        requests[key] = {
          sourceCommit: captured.sourceCommit,
          host: captured.host,
          wire: captured.wire,
          ...(input.replayText
            ? { replaySignatures: replaySignatures(captured.turns ?? []) }
            : {}),
        }
      }
    }
    const oracleInput =
      input.options.raw === true
        ? 'Claude tool reply ending the history: wrapped'
        : input.id
    const oracle = requireEntry(
      baseline.requests,
      caseKey(oracleInput, input.oracle, 'local'),
    )
    for (const subject of subjects) {
      const key = caseKey(input.id, subject, 'local')
      const observed = requireEntry(current.requests, key)
      if (observed.unrepresentable) continue
      if (observed.wire?.length !== input.sessions.length)
        throw new Error(`${key} did not traverse the request path`)
      const semantics = wireSemantics(input, observed.wire)
      collect(
        key,
        { ...wireFields(observed.wire), ...semantics.actual },
        {
          ...wireFields(oracle.wire ?? []),
          ...semantics.expected,
        },
        caseLedger(input),
      )
      if (
        input.replayText &&
        !excepts(input.id, subject, 'replay.textSignature')
      ) {
        const signatures =
          requireEntry(
            baseline.requests,
            caseKey(input.id, 'opencode2', 'local'),
          ).turns ?? []
        collect(
          key,
          { 'replay.textSignature': replaySignatures(observed.turns ?? []) },
          {
            'replay.textSignature': replaySignatures(signatures),
          },
          caseLedger(input),
        )
      }
    }
  }
  for (const scenario of responseScenarios) {
    for (const custody of custodies) {
      const oracle = requireEntry(
        baseline.responses,
        caseKey(scenario.input.id, 'opencode1', custody),
      )
      responses[outcomeKey(scenario.input.id, custody)] = {
        record: expectedOutcome(scenario, oracle, 'opencode1'),
        piHooks: expectedOutcome(scenario, oracle, 'pi').hooks,
      }
      for (const subject of subjects) {
        const key = caseKey(scenario.input.id, subject, custody)
        const expected = expectedOutcome(scenario, oracle, subject)
        collect(
          key,
          outcomeFields(requireEntry(current.responses, key)),
          expected,
          scenario.ledger,
        )
      }
    }
  }
  for (const [path, data] of Object.entries({
    'request-oracles.json': requests,
    'response-oracles.json': responses,
    'known-failures.json': failures,
  })) {
    const file = new URL(path, import.meta.url)
    await Bun.write(file, `${JSON.stringify(data, null, 2)}\n`)
    const bytes = await Bun.file(file).arrayBuffer()
    console.log(
      `CHANGED ${path} bytes=${bytes.byteLength} sha256=${Bun.SHA256.hash(bytes, 'hex')}`,
    )
  }
  console.log(
    `frozen request inputs: ${Object.keys(requests).length}; outcome records: ${Object.keys(responses).length}; known field differences: ${failures.length}; request oracle digest: ${digest(requests)}`,
  )
}

if (import.meta.main) {
  const [baseline, observed] = process.argv.slice(2)
  if (!baseline || !observed)
    throw new Error('Usage: bun materialize.ts BASELINE.json OBSERVED.json')
  await main(baseline, observed)
}
