import { expect, mock, test } from 'bun:test'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RETIRED_AGY_MODEL_MESSAGE } from '@cortexkit/antigravity-auth-core'
import { placeholderSecret } from '../../../../opencode/src/common-auth-embedded/opencode2/index.js'
import {
  type GaBridgeJob,
  type GaHttpRequestEvent,
  GaRequestOwnership,
  rewriteGaHttpRequest,
} from '../../../../opencode/src/ga/server/index.ts'
import { createGaJobExecutor } from '../../../../opencode/src/plugin/ga-location-services.ts'
import {
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from '../../../../opencode/src/plugin/request.ts'
import { conversation, models, requestCases } from '../cases.ts'
import { bodyOf, candidate, sse } from '../fixtures.ts'
import { google2 } from '../native-google.ts'
import { runConversation } from '../runner.ts'
import {
  hosts,
  imageModel,
  retiredChat,
  retiredTitle,
  searchContinuation,
} from './cases.ts'

const nativeUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`

test('a reply containing inlineData is no longer saved to a generated image file', async () => {
  const response = await transformAntigravityResponse(
    new Response(
      sse(
        candidate(
          [
            { inlineData: { mimeType: 'image/png', data: 'Zml4dHVyZQ==' } },
            { text: 'Text reply.' },
          ],
          'STOP',
        ),
      ),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
    true,
  )
  const text = await response.text()
  expect(text).toContain('Text reply.')
  expect(text).not.toContain('Antigravity image saved')
  await expect(
    access(join(homedir(), '.opencode', 'generated-images')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([
  ...hosts,
])('%s refuses the removed image chat before any upstream send', async (subject) => {
  const result = await runConversation({
    subject,
    custody: 'local',
    input: retiredChat,
  })
  expect(result.turns[0]?.errors).toContain(RETIRED_AGY_MODEL_MESSAGE)
  expect(result.wire).toHaveLength(0)
})

test('OpenCode 1 refuses a retired selector even for the legacy title prompt', async () => {
  const result = await runConversation({
    subject: 'opencode1',
    custody: 'local',
    input: retiredTitle,
  })
  expect(result.turns[0]?.errors).toContain(RETIRED_AGY_MODEL_MESSAGE)
  expect(result.wire).toHaveLength(0)
})

test.each([
  'primary',
  'title',
  'compaction',
  'generate',
] as const)('OpenCode 2 refuses the original retired selector for %s before catalog or engine dispatch', async (kind) => {
  // The URL has already been substituted. Retirement must use the original host selector too.
  const event: GaHttpRequestEvent = {
    sessionID: 'retired',
    kind,
    model: { id: imageModel, providerID: 'google' },
    request: new Request(nativeUrl(models.flash), {
      method: 'POST',
      headers: { 'x-goog-api-key': placeholderSecret('google') },
      body: '{}',
    }),
  }
  const isRegisteredModel = mock(() => false)
  const jobs: GaBridgeJob[] = []
  await expect(
    rewriteGaHttpRequest(event, {
      ownership: new GaRequestOwnership(),
      isRegisteredModel,
      env: {},
      bridge: {
        rewrite(original, job) {
          jobs.push(job)
          return original
        },
      },
    }),
  ).resolves.toBeUndefined()
  expect(isRegisteredModel).not.toHaveBeenCalled()
  expect(jobs).toHaveLength(1)
  const execute = mock(async () => new Response('replacement sent'))
  const response = await createGaJobExecutor({ execute })(jobs[0]!, {
    signal: event.request.signal,
    send: async () => {
      throw new Error('The retired job must never send')
    },
  })
  expect(response.status).toBe(412)
  expect(await response.json()).toMatchObject({
    error: { message: RETIRED_AGY_MODEL_MESSAGE },
  })
  expect(execute).not.toHaveBeenCalled()
})

test('OpenCode 2 leaves a real-key request with the same selector untouched', async () => {
  const key = 'test-native-google-key'
  const rewrite = mock(() => {
    throw new Error('The plugin must not own this request')
  })
  const isRegisteredModel = mock(() => false)
  const received: Request[] = []
  const result = await google2(
    conversation('native image ID', { model: imageModel }),
    async (request) => {
      const event: GaHttpRequestEvent = {
        sessionID: 'native',
        kind: 'primary',
        model: { id: imageModel, providerID: 'google' },
        request,
      }
      await rewriteGaHttpRequest(event, {
        bridge: { rewrite },
        ownership: new GaRequestOwnership(),
        env: {},
        isRegisteredModel,
      })
      expect(event.request).toBe(request)
      received.push(event.request)
      return new Response(
        sse(candidate([{ text: 'Native reply.' }], 'STOP').response),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
    undefined,
    key,
  )
  expect(rewrite).not.toHaveBeenCalled()
  expect(isRegisteredModel).not.toHaveBeenCalled()
  expect(received).toHaveLength(1)
  expect(received[0]?.url).toContain(`/models/${imageModel}:`)
  expect(received[0]?.headers.get('x-goog-api-key')).toBe(key)
  expect(result.text).toBe('Native reply.')
})

for (const subject of hosts) {
  test.each([
    models.flash,
    models.claude,
  ])(`${subject} continues a historical google_search call on %s without re-registering it`, async (model) => {
    const result = await runConversation({
      subject,
      custody: 'local',
      input: searchContinuation(model),
    })
    expect(result.turns[0]?.text).toBe('Four.')
    expect(result.turns[0]?.terminal).toEqual(['stop'])
    const request = bodyOf(result.wire.at(-1)!).request as {
      contents: unknown
      tools?: unknown
    }
    expect(JSON.stringify(request.contents)).toContain('It is sunny.')
    expect(JSON.stringify(request.tools ?? [])).not.toMatch(
      /google_search|googleSearch/,
    )
  })

  test.each([
    'user image',
    'tool-result image: mixed',
  ])(`${subject} still delivers %s input`, async (id) => {
    const input = requestCases.find((entry) => entry.id === id)!
    const result = await runConversation({ subject, custody: 'local', input })
    expect(result.turns[0]?.text).toBe('Four.')
    const request = bodyOf(result.wire.at(-1)!).request
    const wire = JSON.stringify(request)
    expect(wire).toContain('image/png')
    expect(wire).toContain('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')
  })
}

test('a legacy web_search declaration no longer injects Google grounding', () => {
  const { init } = prepareAntigravityRequest(
    nativeUrl(models.flash),
    {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Look up the weather.' }] }],
        tools: [{ name: 'web_search', parameters: { type: 'object' } }],
        providerOptions: { google: { googleSearch: { mode: 'auto' } } },
      }),
    },
    'test-token',
    'test-project',
  )
  const { request } = JSON.parse(String(init.body))
  expect(request).not.toHaveProperty('providerOptions')
  expect(JSON.stringify(request.tools ?? [])).not.toContain('googleSearch')
})
