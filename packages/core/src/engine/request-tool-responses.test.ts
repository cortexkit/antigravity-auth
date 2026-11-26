import { describe, expect, test } from 'bun:test'
import { createAgyRequestSessionContext } from '../agy-request-metadata.ts'
import { createRequestWire, createRequestWireLocation } from './request.ts'

const noop = () => {}
const logger = { debug: noop, warn: noop }
const wire = createRequestWire(
  createRequestWireLocation({
    signatures: {
      keepThinking: false,
      signatureStore: new Map(),
      cacheSignature: noop,
      getCachedSignature: () => undefined,
    },
    debug: {
      logAntigravityDebugResponse: noop,
      isDebugTuiEnabled: () => false,
      logCacheStats: noop,
    },
    logger,
  }),
  {
    pluginSessionId: 'test',
    defaultSession: createAgyRequestSessionContext(),
    debugMessagePrefix: 'test diagnostics:',
    helperLog: logger,
    dump: {
      noteResponse: noop,
      appendResponseText: noop,
      createResponseTransform: () => null,
    },
  },
)

const call = (id: string) => ({
  functionCall: { id, name: 'lookup', args: {} },
})
const result = (id: string) => ({
  functionResponse: { id, name: 'lookup', response: { output: id } },
})
const user = (...parts: object[]) => ({ role: 'user', parts })
const model = (...parts: object[]) => ({ role: 'model', parts })
const prompt = user({ text: 'Look up the requested values.' })
const inlineData = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }
const fileData = {
  fileData: { mimeType: 'image/png', fileUri: 'gs://test-bucket/image.png' },
}

function sentContents(
  contents: object[],
  modelId = 'claude-sonnet-5-5',
  wrapped = false,
) {
  const { init } = wire.prepare(
    `https://generativelanguage.googleapis.com/v1beta/models/antigravity-${modelId}:streamGenerateContent`,
    {
      method: 'POST',
      body: JSON.stringify(
        wrapped ? { project: 'test', request: { contents } } : { contents },
      ),
    },
    'test-token',
    'test',
  )
  return JSON.parse(String(init.body)).request.contents
}

describe('tool response companion parts on the wire', () => {
  test('Claude puts user text after the response in the same turn', () => {
    const request = model(call('a'))
    const text = { text: 'Explain what you found.' }
    expect(sentContents([prompt, request, user(text, result('a'))])).toEqual([
      prompt,
      request,
      user(result('a'), text),
    ])
  })

  test('Claude keeps inline and file attachments after the response in order', () => {
    const request = model(call('a'))
    expect(
      sentContents([prompt, request, user(inlineData, result('a'), fileData)]),
    ).toEqual([prompt, request, user(result('a'), inlineData, fileData)])
  })

  test('Claude puts split parallel results first even if only the earlier turn has text', () => {
    const request = model(call('a'), call('b'))
    const text = { text: 'Compare this with the first value.' }
    expect(
      sentContents([
        prompt,
        request,
        user(result('b'), text),
        user(result('a')),
      ]),
    ).toEqual([prompt, request, user(result('a'), result('b'), text)])
  })

  test('Claude puts split parallel results first and keeps text from both turns in input order', () => {
    const request = model(call('a'), call('b'))
    const first = { text: 'Compare this with the first value.' }
    const second = { text: 'Then explain the difference.' }
    expect(
      sentContents([
        prompt,
        request,
        user(result('b'), first),
        user(second, result('a')),
      ]),
    ).toEqual([prompt, request, user(result('a'), result('b'), first, second)])
  })

  test('Claude keeps text from an incomplete group before the next model turn', () => {
    const request = model(call('a'), call('b'))
    const text = { text: 'Keep this note.' }
    const reply = model({ text: 'Acknowledged.' })
    expect(
      sentContents([prompt, request, user(result('a'), text), reply]),
    ).toMatchObject([
      prompt,
      request,
      user(result('a'), { functionResponse: { id: 'b', name: 'lookup' } }),
      user(text),
      reply,
      user({ text: '[Continue]' }),
    ])
  })

  test('Gemini leaves mixed response turns unchanged in raw and wrapped requests', () => {
    const mixed = user({ text: 'Keep this note.' }, result('a'), inlineData)
    for (const wrapped of [false, true]) {
      const contents = sentContents(
        [prompt, model(call('a')), mixed],
        'gemini-3.8-flash',
        wrapped,
      )
      expect(contents.at(-1)).toEqual(mixed)
    }
  })
})
