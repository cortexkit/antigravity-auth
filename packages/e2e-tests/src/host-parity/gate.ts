import {
  type Conversation,
  custodies,
  hostPackages,
  requestCases,
  type Subject,
  subjects,
} from './cases.ts'
import { excepts } from './exceptions.ts'
import { maskedFields, type Wire } from './fixtures.ts'
import {
  baseCommit,
  type Captured,
  caseKey,
  caseLedger,
  compareFields,
  digest,
  isLedgerRow,
  type KnownFailure,
  type OutcomeOracle,
  outcomeFields,
  outcomeKey,
  replaySignatures,
  wireFields,
  wireSemantics,
} from './gate-data.ts'
import { runConversation } from './runner.ts'
import {
  expectedScenarioNotices,
  responseScenarios,
  scenarioUsesClock,
} from './scenarios.ts'

const baselineDigest =
  '191b5d83aa7b69f54d580ac4686e16a98543c8b3ca941160ba83d27bea965ee2'
const owners = ['pi', 'opencode2', 'engine', 'removals', 'settings'] as const
type CaptureRevision = { ledger: string; wire: Wire[] }

const file = (path: string) => Bun.file(new URL(path, import.meta.url))

async function readKnown(): Promise<Map<string, KnownFailure>> {
  const known = new Map<string, KnownFailure>()
  for (const dir of ['', ...owners.map((owner) => `${owner}/`)]) {
    const list = file(`${dir}known-failures.json`)
    if (dir && !(await list.exists())) continue
    const entries: KnownFailure[] = await list.json()
    for (const entry of entries) {
      const [key, sha, ledger] = entry
      if (known.has(key)) throw new Error(`Duplicate known failure: ${key}`)
      if (
        !/^[a-f0-9]{64}$/.test(sha) ||
        (ledger !== undefined && !isLedgerRow(ledger))
      )
        throw new Error(`Invalid known failure: ${key}`)
      known.set(key, entry)
    }
  }
  return known
}

export function admittedCapture(
  input: Conversation,
  subject: Subject,
  prior: Wire[],
  revision?: CaptureRevision,
) {
  if (revision === undefined) return prior
  if (
    !isLedgerRow(revision.ledger) ||
    caseLedger(input) !== revision.ledger ||
    !revision.wire.length
  )
    throw new Error(
      `Capture change for ${input.id}/${subject} names no applicable ledger row`,
    )
  if (digest(prior) === digest(revision.wire))
    throw new Error(
      `Capture revision for ${input.id}/${subject} changes no bytes`,
    )
  return revision.wire
}

export async function checkCorpus() {
  const known = await readKnown()
  const requests: Record<string, Captured> = await file(
    'request-oracles.json',
  ).json()
  const outcomeRecords: Record<string, OutcomeOracle> = await file(
    'response-oracles.json',
  ).json()
  const revisionsFile = file('request-revisions.json')
  const revisions: Record<string, CaptureRevision> =
    (await revisionsFile.exists()) ? await revisionsFile.json() : {}
  const revised = new Set<string>()
  const errors: string[] = []
  if (digest(requests) !== baselineDigest)
    throw new Error(
      'The frozen baseline changed. Add a request revision naming the applicable ledger row instead.',
    )
  if (maskedFields.length)
    throw new Error('The default wire comparison must have no masks')

  for (const input of requestCases) {
    const oracleId =
      input.options.raw === true
        ? 'Claude tool reply ending the history: wrapped'
        : input.id
    const oracle = requests[caseKey(oracleId, input.oracle, 'local')]
    if (!oracle?.wire?.length)
      throw new Error(`Missing designated request oracle for ${input.id}`)
    const oracleInput = requestCases.find(({ id }) => id === oracleId) ?? input
    const oracleWire = admittedCapture(
      oracleInput,
      input.oracle,
      oracle.wire,
      revisions[caseKey(oracleId, input.oracle, 'local')],
    )

    if (input.id.endsWith('xhigh')) {
      const { actual, expected } = wireSemantics(input, oracleWire)
      if (digest(actual) !== digest(expected))
        throw new Error(
          `${input.id}: the OpenCode 2 oracle must send numeric XHigh`,
        )
    }

    for (const subject of subjects) {
      const key = caseKey(input.id, subject, 'local')
      const captured = requests[key]
      const openCode = subject === 'opencode1' || subject === 'opencode2'
      if (
        openCode &&
        (captured?.sourceCommit !== baseCommit ||
          digest(captured.host) !== digest(hostPackages[subject]))
      )
        throw new Error(`Missing baseline provenance for ${key}`)
      if (captured?.unrepresentable) {
        if (!excepts(input.id, subject, 'wire.thinkingLevel') || revisions[key])
          throw new Error(`Unexpected representability exception for ${key}`)
        continue
      }
      const result = await runConversation({ subject, custody: 'local', input })
      if (result.wire.length !== input.sessions.length)
        errors.push(
          `${key}: missing physical capture (observed ${result.wire.length}, requested ${input.sessions.length}; ${JSON.stringify(result.turns.map(({ errors }) => errors))})`,
        )
      if (openCode && captured?.wire) {
        const expected = admittedCapture(
          input,
          subject,
          captured.wire,
          revisions[key],
        )
        if (revisions[key]) revised.add(key)
        if (digest(result.wire) !== digest(expected))
          errors.push(
            `${key}: changed the after-allowlist host capture without an exact ledger revision`,
          )
      }
      const semantics = wireSemantics(input, result.wire)
      compareFields({
        key,
        known,
        mismatches: errors,
        ledger: caseLedger(input),
        actual: { ...wireFields(result.wire, input), ...semantics.actual },
        expected: { ...wireFields(oracleWire, input), ...semantics.expected },
      })
      if (input.replayText) {
        const [field, replay] = [
          'replay.textSignature',
          replaySignatures(result.turns),
        ] as const
        const expected = excepts(input.id, subject, field)
          ? captured?.replaySignatures
          : requests[caseKey(input.id, 'opencode2', 'local')]?.replaySignatures
        compareFields({
          key,
          known,
          mismatches: errors,
          ledger: caseLedger(input),
          actual: { [field]: replay },
          expected: { [field]: expected },
        })
      }
    }
  }
  for (const key of Object.keys(revisions)) {
    if (!revised.has(key)) errors.push(`Unused capture revision for ${key}`)
  }

  for (const scenario of responseScenarios) {
    for (const subject of subjects) {
      for (const custody of custodies) {
        const key = caseKey(scenario.input.id, subject, custody)
        const oracle = outcomeRecords[outcomeKey(scenario.input.id, custody)]
        if (!oracle)
          throw new Error(`Missing literal outcome record for ${key}`)
        const expected = {
          ...oracle.record,
          ...(subject.startsWith('pi') && { hooks: oracle.piHooks }),
          notices:
            expectedScenarioNotices(scenario, subject) ?? oracle.record.notices,
        }
        const result = await runConversation({
          subject,
          custody,
          input: scenario.input,
          reply: (_wire, index) =>
            scenario.replies[Math.min(index, scenario.replies.length - 1)]!,
          timed: scenarioUsesClock(scenario),
        })
        const actual = outcomeFields(result, scenario.input.id)
        if (
          digest(Object.keys(expected).sort()) !==
          digest(Object.keys(actual).sort())
        )
          throw new Error(`Incomplete literal outcome record for ${key}`)
        compareFields({
          key,
          known,
          mismatches: errors,
          ledger: scenario.ledger,
          actual,
          expected,
        })
      }
    }
  }
  for (const key of known.keys())
    errors.push(`${key}: known failure did not run`)
  if (errors.length)
    throw new Error(
      `Host parity found ${errors.length} unexpected fields:\n${errors.join('\n')}`,
    )
}
