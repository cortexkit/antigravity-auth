import { type Conversation, conversation, models } from './cases.ts'
import { candidate, type Reply, sse, success } from './environment.ts'

export type Scenario = {
  input: Conversation
  replies: readonly Reply[]
  expected: {
    sends: number
    delays: number[]
    terminal: string[][]
    text: string[]
    thinking?: string[]
    usage?: {
      input: number
      output: number
      cacheRead: number
      reasoning: number
      total: number
    }
    compaction?: boolean
    tool?: string
  }
  ledger: `response-errors:D${number}` | 'request-wire:D7'
}

export const signature = 'response-thought-signature-'.repeat(6)
const text = { text: 'Four.' }
const thought = {
  text: 'Count twice.',
  thought: true,
  thoughtSignature: signature,
}
const stop = candidate([], 'STOP')
const usage = (usageMetadata: object) => ({ response: { usageMetadata } })
const splitUsage = {
  input: 6,
  cacheRead: 4,
  output: 5,
  reasoning: 3,
  total: 15,
}

function jsonError(
  status: number,
  code: string,
  message: string,
  details?: object[],
): Reply {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: { code: status, status: code, message, details },
    }),
  }
}

const unconfirmed = jsonError(429, 'RESOURCE_EXHAUSTED', 'Fixture rate limit')
const quota = jsonError(429, 'RESOURCE_EXHAUSTED', 'Fixture quota exhaustion', [
  {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason: 'QUOTA_EXHAUSTED',
    domain: 'cloudcode-pa.googleapis.com',
    metadata: { quotaResetDelay: '3600s' },
  },
])
const capacity = jsonError(503, 'UNAVAILABLE', 'Fixture capacity', [
  {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason: 'MODEL_CAPACITY_EXHAUSTED',
    domain: 'cloudcode-pa.googleapis.com',
  },
])
const forbidden = jsonError(
  403,
  'PERMISSION_DENIED',
  'Fixture validation required',
  [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'VALIDATION_REQUIRED',
      domain: 'cloudcode-pa.googleapis.com',
    },
  ],
)
const notFound = jsonError(404, 'NOT_FOUND', 'Fixture model not found')
const signatureError = jsonError(
  400,
  'INVALID_ARGUMENT',
  'Function call is missing a thought_signature',
)
const overflow = jsonError(
  400,
  'INVALID_ARGUMENT',
  'The input token count (123) exceeds the maximum number of tokens allowed (100).',
)
const embedded = {
  error: {
    code: 503,
    status: 'UNAVAILABLE',
    message: 'Fixture embedded error',
  },
}

function scenario(
  id: string,
  ledger: Scenario['ledger'],
  replies: Reply[],
  expected: Partial<Scenario['expected']> = {},
  input?: Partial<Omit<Conversation, 'id'>>,
): Scenario {
  return {
    input: conversation(id, input),
    replies,
    ledger,
    expected: {
      sends: 1,
      delays: [],
      terminal: [['stop']],
      text: ['Four.'],
      ...expected,
    },
  }
}

const refusal = (id: string, visible = '') => ({
  terminal: [[`failure:${id}`]],
  text: [visible],
})
const stream = (
  id: string,
  frames: (object | string)[],
  expected?: Partial<Scenario['expected']>,
) => scenario(id, 'response-errors:D5', [{ body: sse(...frames) }], expected)

export const responseScenarios: readonly Scenario[] = [
  scenario(
    'unexplained 429',
    'response-errors:D2',
    [unconfirmed, unconfirmed, unconfirmed],
    {
      sends: 3,
      delays: [5000, 5000],
      ...refusal('quota_wait_exhausted'),
    },
  ),
  scenario(
    'structured QUOTA_EXHAUSTED',
    'response-errors:D2',
    [quota],
    refusal('quota_exhausted'),
  ),
  scenario('503 then success', 'response-errors:D3', [capacity, success], {
    sends: 2,
  }),
  scenario(
    'daily failure then prod success',
    'request-wire:D7',
    [jsonError(503, 'UNAVAILABLE', 'Fixture daily unavailable'), success],
    { sends: 2 },
  ),
  scenario(
    'NOT_FOUND then a second request and control model',
    'response-errors:D3',
    [notFound, success],
    {
      sends: 2,
      terminal: [
        ['failure:model_not_found'],
        ['failure:model_not_found'],
        ['stop'],
      ],
      text: ['', '', 'Four.'],
    },
    {
      sessions: ['parity-session', 'parity-session', 'parity-session'],
      model: models.flash,
    },
  ),
  scenario(
    'lasting 403',
    'response-errors:D3',
    [forbidden],
    refusal('account_reauthorize'),
  ),
  scenario(
    'thinking-signature 400 then recovery',
    'response-errors:D11',
    [signatureError, success],
    { sends: 2 },
  ),
  scenario(
    'thinking-signature terminal refusal',
    'response-errors:D11',
    [signatureError, signatureError],
    { sends: 2, ...refusal('signature_recovery_failed') },
  ),
  scenario('prompt too long', 'response-errors:D1', [overflow], {
    ...refusal('context_overflow'),
    compaction: true,
  }),
  stream(
    'tool call then STOP',
    [
      candidate([
        {
          functionCall: { name: 'lookup', args: { key: 'value' } },
          thoughtSignature: signature,
        },
      ]),
      stop,
    ],
    { text: [''], tool: 'lookup' },
  ),
  stream(
    'safety stop',
    [candidate([], 'SAFETY')],
    refusal('stopped_by_google'),
  ),
  stream(
    'RECITATION stop',
    [candidate([], 'RECITATION')],
    refusal('stopped_by_google'),
  ),
  stream(
    'unlisted finish code',
    [candidate([], 'PRIVATE_FIXTURE_CODE')],
    refusal('stopped_by_google'),
  ),
  stream('length stop', [candidate([text], 'MAX_TOKENS')], {
    terminal: [['length']],
  }),
  stream(
    'finish on candidate 1 only',
    [candidate([text]), candidate([], 'STOP', 1)],
    refusal('incomplete', 'Four.'),
  ),
  stream('malformed frame', ['{malformed', candidate([text], 'STOP')]),
  stream(
    'embedded error before content',
    [embedded],
    refusal('embedded_error'),
  ),
  stream(
    'embedded error after content',
    [candidate([text]), embedded],
    refusal('embedded_error', 'Four.'),
  ),
  stream(
    '[DONE] without finish',
    [candidate([text]), '[DONE]'],
    refusal('incomplete', 'Four.'),
  ),
  stream('empty response', [], refusal('empty')),
  stream('thinking-only then STOP', [candidate([thought]), stop], {
    ...refusal('empty'),
    thinking: ['Count twice.'],
  }),
  scenario(
    'split usage',
    'response-errors:D4',
    [
      {
        body: sse(
          candidate([text]),
          usage({ promptTokenCount: 10, cachedContentTokenCount: 4 }),
          usage({
            candidatesTokenCount: 2,
            thoughtsTokenCount: 3,
            totalTokenCount: 15,
          }),
          stop,
        ),
      },
    ],
    { usage: splitUsage },
  ),
  scenario(
    'usage after STOP',
    'response-errors:D4',
    [
      {
        body: sse(
          candidate([text], 'STOP'),
          usage({
            promptTokenCount: 10,
            cachedContentTokenCount: 4,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 3,
            totalTokenCount: 15,
          }),
        ),
      },
    ],
    { usage: splitUsage },
  ),
  stream('second finish during the usage drain', [
    candidate([text], 'STOP'),
    candidate([], 'RECITATION'),
  ]),
  scenario(
    'duplicate thinking',
    'response-errors:D6',
    [
      {
        body: sse(
          candidate([thought]),
          candidate([thought]),
          candidate([text], 'STOP'),
        ),
      },
    ],
    { thinking: ['Count twice.'] },
  ),
  scenario(
    'identical thinking in two sessions',
    'response-errors:D6',
    [
      { body: sse(candidate([thought]), candidate([text], 'STOP')) },
      { body: sse(candidate([thought]), candidate([text], 'STOP')) },
    ],
    {
      sends: 2,
      terminal: [['stop'], ['stop']],
      text: ['Four.', 'Four.'],
      thinking: ['Count twice.', 'Count twice.'],
    },
    { sessions: ['parity-session-a', 'parity-session-b'] },
  ),
  scenario(
    'idle stall',
    'response-errors:D7',
    [{ body: sse(candidate([text])), stall: 'after-body' }],
    refusal('deadline', 'Four.'),
  ),
  scenario(
    'pre-response deadline',
    'response-errors:D1',
    [{ stall: 'before-headers' }],
    refusal('deadline'),
  ),
]
