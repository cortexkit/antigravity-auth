export const hostPackages = {
  opencode1: { package: '@ai-sdk/google', version: '3.0.73' },
  opencode2: { package: '@opencode/plugin', version: '2.0.22' },
  pi: { package: '@earendil-works/pi-ai', version: '1.6.0' },
} as const

export type Host = keyof typeof hostPackages
export type Subject = Host | 'pi-transcript'
export type Custody = 'local' | 'vault' | 'host'
export const subjects: readonly Subject[] = [
  'opencode1',
  'opencode2',
  'pi',
  'pi-transcript',
]
export const custodies: readonly Custody[] = ['local', 'vault', 'host']

type Level = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type Image = { type: 'image'; mediaType: 'image/png'; data: string }
type Text = { type: 'text'; text: string; signature?: string }
type Thinking = { type: 'thinking'; text: string; signature?: string }
type Call = {
  type: 'call'
  id: string
  name: string
  args: Record<string, unknown>
  signature?: string
}
type Result = {
  type: 'result'
  id: string
  name: string
  content: (Image | Text)[]
}
export type Part = Text | Image | Thinking | Call | Result
export type Turn = { role: 'user' | 'assistant' | 'tool'; parts: Part[] }
type Tool = {
  name: string
  description: string
  schema: Record<string, unknown>
}

export const models = {
  neon: 'antigravity-gemini-4-neon',
  hydrogen: 'antigravity-gemini-4-hydrogen',
  flash: 'antigravity-gemini-3.8-flash',
  claude: 'antigravity-claude-sonnet-4-6-thinking',
} as const

export type Conversation = {
  id: string
  model: string
  prompt: string
  messages: Turn[]
  tools: Tool[]
  options: {
    level?: Level
    budget?: number
    temperature?: number
    topP?: number
    maxTokens?: number
    keepThinking?: boolean
    raw?: boolean
  }
  sessions: (string | undefined)[]
  oracle: 'opencode1' | 'opencode2'
}

export function conversation(
  id: string,
  input: Partial<Omit<Conversation, 'id'>> = {},
): Conversation {
  return {
    id,
    model: models.flash,
    prompt: 'Answer briefly.',
    messages: [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'What is two plus two?' }],
      },
    ],
    tools: [],
    options: {},
    sessions: ['parity-session'],
    oracle: 'opencode1',
    ...input,
  }
}

export const unrepresentable = 'unrepresentable'

export function nativeOptions({ options }: Conversation, host: Host) {
  const { level, budget, temperature, topP, maxTokens } = options
  return {
    source: hostPackages[host],
    thinking:
      host === 'pi'
        ? {
            reasoning: level,
            thinkingBudgets:
              budget === undefined || level === undefined
                ? undefined
                : { [level]: budget },
          }
        : host === 'opencode2'
          ? { variant: level, thinkingConfig: { thinkingBudget: budget } }
          : level === 'xhigh'
            ? unrepresentable
            : {
                thinkingConfig: {
                  thinkingLevel: budget === undefined ? level : undefined,
                  thinkingBudget: budget,
                },
              },
    temperature,
    topP,
    maxTokens,
  }
}

const signature = 'test-thought-signature-'.repeat(6)
const image: Image = {
  type: 'image',
  mediaType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XEAAAAAASUVORK5CYII=',
}
const tool: Tool = {
  name: 'lookup',
  description: 'Look up a value.',
  schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
  },
}
const user: Turn = {
  role: 'user',
  parts: [{ type: 'text', text: 'Look up the value.' }],
}
const call: Call = {
  type: 'call',
  id: 'lookup-1',
  name: tool.name,
  args: { key: 'value' },
  signature,
}
const result: Result = {
  type: 'result',
  id: call.id,
  name: call.name,
  content: [{ type: 'text', text: 'Found it.' }],
}
const thinking: Thinking = {
  type: 'thinking',
  text: 'Check the value.',
  signature,
}
const followup: Turn = {
  role: 'user',
  parts: [{ type: 'text', text: 'What did you find?' }],
}
const toolTurns = (
  calls: Call[],
  results: Result[],
  tail: Turn[] = [followup],
): Turn[] => [
  user,
  { role: 'assistant', parts: calls },
  { role: 'tool', parts: results },
  ...tail,
]

export const requestCases: readonly Conversation[] = [
  conversation('plain chat'),
  conversation('Gemini tool loop', {
    tools: [tool],
    messages: toolTurns([call], [result]),
  }),
  conversation('parallel calls', {
    tools: [tool],
    messages: toolTurns(
      [call, { ...call, id: 'lookup-2' }],
      [result, { ...result, id: 'lookup-2' }],
    ),
  }),
  conversation('unsigned call', {
    tools: [tool],
    messages: toolTurns([{ ...call, signature: undefined }], [result]),
  }),
  conversation('Gemini → Claude → Gemini', {
    messages: [
      user,
      {
        role: 'assistant',
        parts: [thinking, { type: 'text', text: 'Gemini reply.', signature }],
      },
      followup,
      {
        role: 'assistant',
        parts: [
          { ...thinking, signature: undefined },
          { type: 'text', text: 'Claude reply.' },
        ],
      },
      followup,
    ],
  }),
  ...[true, false].map((keepThinking) =>
    conversation(`Claude thinking ${keepThinking ? 'on' : 'off'}`, {
      model: models.claude,
      messages: [
        user,
        {
          role: 'assistant',
          parts: [thinking, { type: 'text', text: 'Claude reply.' }],
        },
        followup,
      ],
      options: { keepThinking },
    }),
  ),
  conversation('Claude tool with union types', {
    model: models.claude,
    tools: [
      {
        ...tool,
        name: 'lookup.value',
        schema: {
          type: 'object',
          properties: { key: { type: ['string', 'number'] } },
        },
      },
      {
        name: 'noop',
        description: 'No arguments.',
        schema: { type: 'object', properties: {} },
      },
    ],
  }),
  ...(
    [
      ['empty parts array', []],
      ['explicit empty text', [{ type: 'text', text: '' }]],
      ['whitespace', [{ type: 'text', text: ' \t ' }]],
      ['signature-bearing empty part', [{ type: 'text', text: '', signature }]],
    ] satisfies [string, Part[]][]
  ).map(([label, parts]) =>
    conversation(`empty and whitespace turns: ${label}`, {
      messages: [user, { role: 'assistant', parts }, followup],
    }),
  ),
  ...[true, false].map((raw) =>
    conversation(
      `Claude tool reply ending the history: ${raw ? 'raw' : 'wrapped'}`,
      {
        model: models.claude,
        tools: [tool],
        messages: toolTurns([call], [result], []),
        options: { raw },
      },
    ),
  ),
  conversation('two sessions without ids', {
    sessions: [undefined, undefined],
  }),
  conversation('two requests with one explicit session id', {
    sessions: ['parity-session', 'parity-session'],
  }),
  conversation('user image', {
    messages: [{ role: 'user', parts: [...user.parts, image] }],
  }),
  conversation('tool-result image: image-only', {
    tools: [tool],
    messages: toolTurns([call], [{ ...result, content: [image] }]),
  }),
  conversation('tool-result image: mixed', {
    tools: [tool],
    messages: toolTurns(
      [call],
      [{ ...result, content: [...result.content, image] }],
    ),
  }),
  conversation('object tool arguments with a thinking key', {
    tools: [tool],
    messages: toolTurns(
      [{ ...call, args: { thinking: { effort: 'short' } } }],
      [
        {
          ...result,
          content: [{ type: 'text', text: '{"thinking":{"effort":"short"}}' }],
        },
      ],
    ),
  }),
  conversation('custom thinking budgets and temperature', {
    options: {
      level: 'high',
      budget: 2345,
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 123,
    },
  }),
  ...(['neon', 'hydrogen'] as const).flatMap((tier) =>
    (['low', 'medium', 'high', 'xhigh'] as const).map((level) =>
      conversation(`${tier} ${level}`, {
        model: models[tier],
        options: { level },
        oracle: level === 'xhigh' ? 'opencode2' : 'opencode1',
      }),
    ),
  ),
]
