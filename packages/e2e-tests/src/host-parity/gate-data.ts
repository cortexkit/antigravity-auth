import type { Conversation, Custody, Subject } from './cases.ts'
import { bodyOf, credential, type Wire } from './fixtures.ts'
import type { Observation } from './runner.ts'
import { expectedScenarioNotices, type Scenario } from './scenarios.ts'

export const baseCommit = 'b845e1a9bdf76a94f9c8869eaa43376032ba8e21'
export const caseKey = (id: string, subject: Subject, custody: Custody) =>
  JSON.stringify([id, subject, custody])
export const fieldKey = (caseKey: string, field: string) =>
  JSON.stringify([...JSON.parse(caseKey), field])

export type Captured = {
  sourceCommit: string
  host: { package: string; version: string }
  unrepresentable?: true
  wire?: Wire[]
  replaySignatures?: string[][]
}

export function replaySignatures(turns: Observation['turns']) {
  return turns.map(({ signatures }) =>
    signatures
      .filter(({ channel }) => channel === 'text')
      .map(({ value }) => value),
  )
}

export type Fields = Record<string, unknown>
export type OutcomeOracle = { record: Fields; piHooks: unknown }
export const outcomeKey = (id: string, custody: Custody) =>
  JSON.stringify([id, custody])
export type KnownFailure = readonly [
  field: string,
  observedSha: string,
  ledger?: string,
]

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

export function digest(value: unknown): string {
  return Bun.SHA256.hash(JSON.stringify(canonical(value)) ?? 'undefined', 'hex')
}

const ledger =
  /^(?:request-wire:D[1-9]|request-wire:D10|response-errors:D(?:[1-9]|1[0-3])|accounts-features:D[1-9])$/
export const isLedgerRow = (value: unknown): value is string =>
  typeof value === 'string' && ledger.test(value)

export function caseLedger(input: Conversation): string | undefined {
  if (
    input.id.startsWith('Claude tool reply') ||
    input.id.startsWith('empty and whitespace')
  )
    return 'request-wire:D4'
  if (
    input.id.includes('tool loop') ||
    input.id === 'parallel calls' ||
    input.id === 'unsigned call'
  )
    return 'request-wire:D1'
  if (
    input.id.includes('thinking on') ||
    input.id.includes('thinking off') ||
    input.id.includes(' → ')
  )
    return 'request-wire:D2'
  if (input.id.includes('union types')) return 'request-wire:D3'
  if (input.id.includes('budgets')) return 'request-wire:D5'
  if (input.id.includes('sessions') || input.id.includes('session id'))
    return 'request-wire:D6'
  if (input.id.includes('tool-result image')) return 'request-wire:D8'
  if (input.id.includes('thinking key')) return 'request-wire:D9'
  if (input.id.endsWith('xhigh')) return 'accounts-features:D1'
  return undefined
}

const inner = (wire: Wire) =>
  bodyOf(wire).request as {
    labels?: { cascade_id?: string; trajectory_id?: string }
    contents?: {
      parts?: { functionCall?: { args?: Record<string, unknown> } }[]
    }[]
    generationConfig?: { thinkingConfig?: { thinkingLevel?: unknown } }
  }

/** Decodes one captured send's body: chunked framing removed, JSON parsed. */
function decodedBody(wire: Wire): Record<string, unknown> {
  let text = Buffer.from(wire.bodyBase64, 'base64').toString('utf8')
  if (/^[0-9a-f]+\r\n/i.test(text)) {
    let data = ''
    for (;;) {
      const end = text.indexOf('\r\n')
      const size = Number.parseInt(text.slice(0, end), 16)
      if (!size) break
      data += text.slice(end + 2, end + 2 + size)
      text = text.slice(end + 2 + size + 2)
    }
    text = data
  }
  return JSON.parse(text)
}

/**
 * The request fields compared across hosts.
 *
 * - Claude tool-reply cases compare only the conversation turns. The raw
 *   OpenCode path and Pi add Claude tool-hardening text to the system
 *   instruction that the wrapped reference omits by design. These cases pin
 *   where the continuation turn goes; other Claude cases pin the system text.
 * - Gemini text-reply replay cases compare the parsed body without the
 *   signature on replayed text parts. OpenCode 1's ai library drops that
 *   signature (see exceptions.ts), so its frozen capture can't be the
 *   reference for it. The gate checks the signature separately against
 *   OpenCode 2 as `replay.textSignature`. Every other byte still has to match.
 */
export function wireFields(wire: Wire[], input?: Conversation): Fields {
  const caseId = input?.id
  if (caseId?.startsWith('Claude tool reply ending the history'))
    return {
      'wire.target': wire.map(({ target }) => target),
      'wire.contents': wire.map((w) => inner(w).contents ?? null),
    }
  if (input?.replayText)
    return {
      'wire.target': wire.map(({ target }) => target),
      'wire.headers': wire.map(({ headers }) => headers),
      'wire.bodyWithoutTextSignature': wire.map((w) => {
        const body = decodedBody(w)
        const request = body.request as {
          contents?: { parts?: Record<string, unknown>[] }[]
        }
        for (const content of request?.contents ?? [])
          for (const part of content.parts ?? [])
            if (typeof part.text === 'string' && !part.functionCall)
              delete part.thoughtSignature
        return body
      }),
    }
  return {
    'wire.target': wire.map(({ target }) => target),
    'wire.headers': wire.map(({ headers }) => headers),
    'wire.body': wire.map(({ bodyBase64 }) => bodyBase64),
  }
}

export function wireSemantics(
  input: Conversation,
  wire: Wire[],
): { actual: Fields; expected: Fields } {
  const actual: Fields = {}
  const expected: Fields = {}
  if (input.id.startsWith('two ')) {
    const labels = wire.map((w) => inner(w).labels)
    actual['wire.freshScope'] =
      labels.length === 2 &&
      labels.every((value) => value?.cascade_id && value.trajectory_id)
        ? labels[0]?.cascade_id !== labels[1]?.cascade_id &&
          labels[0]?.trajectory_id !== labels[1]?.trajectory_id
        : null
    expected['wire.freshScope'] = input.sessions.every(
      (session) => session === undefined,
    )
  }
  if (input.id.includes('thinking key')) {
    actual['wire.toolArguments'] = wire.flatMap(
      (w) =>
        inner(w).contents?.flatMap(({ parts }) =>
          (parts ?? []).flatMap(({ functionCall }) =>
            functionCall ? [functionCall.args] : [],
          ),
        ) ?? [],
    )
    expected['wire.toolArguments'] = [{ thinking: { effort: 'short' } }]
  }
  if (input.id.endsWith('xhigh')) {
    actual['wire.thinkingLevel'] = wire.map(
      (w) => inner(w).generationConfig?.thinkingConfig?.thinkingLevel,
    )
    expected['wire.thinkingLevel'] = [100]
  }
  return { actual, expected }
}

export function outcomeFields(result: Observation, scenarioId: string): Fields {
  return {
    physicalSends: result.physicalSends,
    delays: result.delays,
    aborts: result.aborts,
    cancellations: result.cancellations,
    reports: result.reports,
    text: result.turns.map(({ text }) => text),
    thinking: result.turns.map(({ thinking }) => thinking),
    signatures: result.turns.map(({ signatures }) => signatures),
    calls: result.turns.map(({ calls }) => calls),
    usage: result.turns.map(
      ({ usage }) =>
        usage ?? { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 },
    ),
    terminal: result.turns.map(({ terminal }) => terminal),
    notices: result.notices,
    ...(scenarioId === 'unlisted finish code'
      ? {
          finishCode: result.turns.map(({ errors }) => {
            if (
              errors.some((message) => message.includes('PRIVATE_FIXTURE_CODE'))
            )
              return 'PRIVATE_FIXTURE_CODE'
            return errors.some((message) => /\bunknown\b/i.test(message))
              ? 'unknown'
              : null
          }),
        }
      : {}),
    compaction: result.turns.some(({ compaction }) => compaction),
    hooks: result.hooks.map((item) => {
      const hook = item as {
        payload?: unknown
        response?: { status: number; headers?: Record<string, string> }
      }
      if ('payload' in hook) {
        const clean =
          typeof hook.payload === 'object' &&
          hook.payload !== null &&
          'contents' in hook.payload &&
          !JSON.stringify(hook.payload).includes(credential.accessToken) &&
          !JSON.stringify(hook.payload).includes(credential.projectId) &&
          !('project' in hook.payload || 'requestId' in hook.payload)
        return {
          payload: clean ? digest(hook.payload) : 'invalid inner request',
        }
      }
      return {
        response: hook.response?.status,
        headers: hook.response?.headers,
      }
    }),
  }
}

export function expectedOutcome(
  scenario: Scenario,
  baseline: Observation,
  subject: Subject,
): Fields {
  const record = outcomeFields(baseline, scenario.input.id)
  const expected = scenario.expected
  const tool = expected.tool
  const sends =
    baseline.physicalSends.length === expected.sends
      ? baseline.physicalSends
      : Array.from(
          { length: expected.sends },
          (_, i) => baseline.physicalSends[i] ?? baseline.physicalSends[0],
        )
  return {
    ...record,
    physicalSends: sends,
    delays: expected.delays,
    terminal: expected.terminal,
    notices: expectedScenarioNotices(scenario, subject) ?? record.notices,
    ...(scenario.input.id === 'unlisted finish code'
      ? { finishCode: ['unknown'] }
      : {}),
    text: expected.text,
    thinking: expected.thinking ?? expected.text.map(() => ''),
    compaction: expected.compaction ?? false,
    ...(tool
      ? {
          calls: [
            [
              {
                name: tool,
                input: { key: 'value' },
                signature: 'response-thought-signature-'.repeat(6),
              },
            ],
          ],
        }
      : {}),
    ...(expected.usage ? { usage: [expected.usage] } : {}),
    hooks: subject.startsWith('pi')
      ? sends.flatMap((_, i) => {
          const reply =
            scenario.replies[Math.min(i, scenario.replies.length - 1)]
          return [
            {
              payload: baseline.wire[i]
                ? digest(bodyOf(baseline.wire[i]).request)
                : 'inner retry request',
            },
            ...(reply?.transportError || reply?.stall === 'before-headers'
              ? []
              : [
                  {
                    response: reply?.status ?? 200,
                    headers: {
                      'content-type': 'text/event-stream',
                      ...reply?.headers,
                      ...(reply?.stall
                        ? {}
                        : {
                            'content-length': String(
                              Buffer.byteLength(reply?.body ?? ''),
                            ),
                          }),
                    },
                  },
                ]),
          ]
        })
      : [],
  }
}

export function compareFields({
  key,
  actual,
  expected,
  known,
  mismatches,
  ledger,
}: {
  key: string
  actual: Fields
  expected: Fields
  known: Map<string, KnownFailure>
  mismatches: string[]
  ledger?: string
}) {
  for (const [field, value] of Object.entries(expected)) {
    const name = fieldKey(key, field)
    const knownFailure = known.get(name)
    known.delete(name)
    const observed = digest(actual[field])
    if (observed === digest(value)) {
      if (knownFailure)
        mismatches.push(`${name} passes now: remove the known failure`)
    } else if (
      !knownFailure ||
      knownFailure[1] !== observed ||
      (ledger !== undefined && knownFailure[2] !== ledger)
    ) {
      mismatches.push(
        `${name}: expected ${JSON.stringify(value)?.slice(0, 180)}, observed ${JSON.stringify(actual[field])?.slice(0, 180)} [${observed}]`,
      )
    }
  }
}
