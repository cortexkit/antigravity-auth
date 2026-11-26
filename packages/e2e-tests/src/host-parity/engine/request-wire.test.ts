import { expect, test } from 'bun:test'
import {
  conversation,
  historySignature,
  requestCases,
  type Subject,
} from '../cases.ts'
import { bodyOf, type Wire } from '../fixtures.ts'
import { type Captured, caseKey } from '../gate-data.ts'
import { runConversation } from '../runner.ts'

function inner(wire: Wire) {
  return bodyOf(wire).request as {
    contents: { role: string; parts: Record<string, unknown>[] }[]
    labels: { cascade_id: string; trajectory_id: string }
  }
}

for (const subject of ['opencode1', 'opencode2', 'pi'] satisfies Subject[]) {
  test(`${subject} preserves object-valued tool arguments named thinking`, async () => {
    const original = requestCases.find(
      ({ id }) => id === 'object tool arguments with a thinking key',
    )!
    const input = {
      ...original,
      messages: original.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'call'
            ? { ...part, args: { thinking: { steps: ['a'] } } }
            : part,
        ),
      })),
    }
    const { wire } = await runConversation({ subject, custody: 'local', input })
    const call = inner(wire[0]!)
      .contents.flatMap(({ parts }) => parts)
      .find((part) => part.functionCall)?.functionCall as { args: unknown }
    expect(JSON.stringify(call.args)).toBe('{"thinking":{"steps":["a"]}}')
  })

  test(`${subject} preserves ordinary text but replaces an injected thinking placeholder at its index`, async () => {
    const user = '[Thinking preserved]\nWhat does this mean?'
    const debugPrefix =
      subject === 'pi'
        ? 'Antigravity diagnostics:'
        : '[opencode-antigravity-auth debug]'
    const assistant = `${debugPrefix} is an example.`
    const input = conversation('thinking placeholder replay', {
      options: { keepThinking: true },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: user }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'thinking',
              text: '[Thinking preserved]\n',
              signature: historySignature,
            },
            { type: 'text', text: assistant },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: 'Explain.' }] },
      ],
    })
    const { wire } = await runConversation({ subject, custody: 'local', input })
    const [first, model] = inner(wire[0]!).contents
    expect(first?.parts).toEqual([{ text: user }])
    expect(model?.parts).toEqual([{ text: '.' }, { text: assistant }])
  })

  test(`${subject} gives each request without a host session ID its own scope`, async () => {
    const input = conversation('anonymous scopes', {
      sessions: [undefined, undefined],
    })
    const { wire } = await runConversation({ subject, custody: 'local', input })
    const labels = wire.map((attempt) => inner(attempt).labels)
    expect(labels).toHaveLength(2)
    expect(labels[0]?.cascade_id).not.toBe(labels[1]?.cascade_id)
    expect(labels[0]?.trajectory_id).not.toBe(labels[1]?.trajectory_id)
  })
}

test('OpenCode raw Claude tool results use the wrapped capture’s continuation order', async () => {
  const raw = requestCases.find(
    ({ id }) => id === 'Claude tool reply ending the history: raw',
  )!
  const captures: Record<string, Captured> = await Bun.file(
    new URL('../request-oracles.json', import.meta.url),
  ).json()
  const expected =
    captures[
      caseKey(
        'Claude tool reply ending the history: wrapped',
        'opencode1',
        'local',
      )
    ]!
  const { wire } = await runConversation({
    subject: 'opencode1',
    custody: 'local',
    input: raw,
  })
  expect(inner(wire[0]!).contents).toEqual(inner(expected.wire![0]!).contents)
})

test('Claude keeps a tool result and its image across hosts', async () => {
  const original = requestCases.find(
    ({ id }) => id === 'Claude tool reply ending the history: raw',
  )!
  const imageCase = requestCases.find(
    ({ id }) => id === 'tool-result image: mixed',
  )!
  const image = imageCase.messages
    .flatMap(({ parts }) => parts)
    .flatMap((part) => (part.type === 'result' ? part.content : []))
    .find((part) => part.type === 'image')!
  const input = {
    ...original,
    id: 'Claude tool result with image',
    messages: imageCase.messages.slice(0, -1),
  }
  const inlineData = { mimeType: image.mediaType, data: image.data }
  for (const subject of ['opencode2', 'pi', 'opencode1'] as const) {
    const { wire } = await runConversation({ subject, custody: 'local', input })
    const contents = inner(wire[0]!).contents
    const call = contents.at(-2)?.parts[0]?.functionCall as { id: string }
    const response = {
      id: call.id,
      name: 'lookup',
      response: { name: 'lookup', content: 'Found it.' },
    }
    // OpenCode 1's SDK emits the image as a sibling; the other hosts nest it.
    expect(contents.at(-1)).toEqual({
      role: 'user',
      parts:
        subject === 'opencode1'
          ? [
              { functionResponse: response },
              { inlineData },
              {
                text: 'Tool executed successfully and returned this image as a response',
              },
            ]
          : [{ functionResponse: { ...response, parts: [{ inlineData }] } }],
    })
  }
})
