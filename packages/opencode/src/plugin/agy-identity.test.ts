import { describe, expect, it } from 'bun:test'
import {
  assertIdentity,
  assertUserAgent,
  captures,
  signature,
  toolNames,
} from '../../../../test-fixtures/agy-cli-1.5.8/assert-identity.test'
import { DEFAULT_CONFIG } from './config'
import { createLocationDebug } from './debug'
import { createLocationLogger } from './logger'
import {
  createRequestWire,
  createRequestWireLocation,
  prepareAntigravityRequest,
} from './request'
import { AgySessionRegistry } from './session-context'
import { prepareAgyWireRequest } from './shared/request-services'
import { createSignatureStore } from './stores/signature-store'

describe('agy 1.5.8 identity through OpenCode request builders', () => {
  for (const family of [
    'gemini-3.8-flash',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
  ]) {
    for (const tier of ['low', 'medium', 'high']) {
      for (const wrapped of [false, true]) {
        it(`${family}-${tier} preserves caller thinking budgets and caps, wrapped=${wrapped}`, () => {
          for (const thinkingBudget of [-1, 0, 1234]) {
            const model = `${family}-${tier}`
            const request = {
              contents: [{ role: 'user', parts: [{ text: 'prompt' }] }],
              generationConfig: {
                maxOutputTokens: 1,
                thinkingConfig: { includeThoughts: true, thinkingBudget },
              },
            }
            const prepared = prepareAntigravityRequest(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                body: JSON.stringify(
                  wrapped ? { project: 'project', model, request } : request,
                ),
              },
              'token',
              'project',
            )
            expect(
              JSON.parse(String(prepared.init.body)).request.generationConfig,
            ).toEqual({
              maxOutputTokens: 1,
              thinkingConfig: { includeThoughts: true, thinkingBudget },
            })
          }
        })
      }
    }
  }
  for (const wrapped of [false, true]) {
    it(`keeps Continue after a plain Gemini model-text ending, wrapped=${wrapped}`, () => {
      const model = 'gemini-3.8-flash-low'
      const request = {
        contents: [
          { role: 'user', parts: [{ text: 'prompt' }] },
          { role: 'model', parts: [{ text: 'answer' }] },
        ],
      }
      const prepared = prepareAntigravityRequest(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          body: JSON.stringify(
            wrapped ? { project: 'project', model, request } : request,
          ),
        },
        'token',
        'project',
      )
      expect(JSON.parse(String(prepared.init.body)).request.contents).toEqual([
        ...request.contents,
        { role: 'user', parts: [{ text: '[Continue]' }] },
      ])
    })
  }
  for (const host of ['OpenCode 1', 'OpenCode GA']) {
    for (const [model, captureOffset] of [
      ['gemini-3.8-flash-low', 0],
      ['claude-sonnet-5-5-low', 2],
    ] as const) {
      for (const wrapped of [false, true]) {
        it(`${host} ${model} wrapped=${wrapped}: first request, tool continuation and second user turn`, () => {
          const gaWire = createRequestWire(
            createRequestWireLocation({
              signatures: {
                keepThinking: false,
                signatureStore: createSignatureStore(),
                cacheSignature: () => {},
                getCachedSignature: () => undefined,
              },
              debug: createLocationDebug({ ...DEFAULT_CONFIG, debug: false }),
              logger: createLocationLogger({
                sinkEnabled: () => false,
              }).createLogger('identity-test'),
            }),
          )
          const sessions = new AgySessionRegistry()
          const identity = {
            sessionId: 'identity-conversation',
            parentSessionId: null,
          }
          const contents: any[] = [
            { role: 'user', parts: [{ text: 'prompt' }] },
          ]
          let previous: any
          for (let index = 0; index < 3; index++) {
            const scope = sessions.beginRequest(identity)
            const payload = {
              contents,
              systemInstruction: {
                role: 'system',
                parts: [{ text: 'system' }],
              },
              tools: [
                {
                  functionDeclarations: toolNames.map((name) => ({
                    name,
                    description: 'tool',
                    parameters: { type: 'object', properties: {} },
                  })),
                },
              ],
              toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            }
            const input = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`
            const init = {
              method: 'POST',
              body: JSON.stringify(
                wrapped
                  ? { project: 'project', model, request: payload }
                  : payload,
              ),
            }
            const options = {
              agySession: scope.session,
              agyRequestTimestamp: scope.timestamp,
            }
            const prepared =
              host === 'OpenCode 1'
                ? prepareAntigravityRequest(
                    input,
                    init,
                    'token',
                    'project',
                    undefined,
                    false,
                    options,
                  )
                : prepareAgyWireRequest(gaWire, {
                    input,
                    init,
                    accessToken: 'token',
                    projectId: 'project',
                    endpoint: 'https://cloudcode-pa.googleapis.com',
                    options,
                  })
            assertUserAgent(
              new Headers(prepared.init.headers).get('User-Agent'),
            )
            const envelope = JSON.parse(String(prepared.init.body))
            assertIdentity(
              envelope,
              captures[captureOffset + (index === 1 ? 1 : 0)]!,
              index,
              previous,
            )
            previous = envelope
            if (index === 0) {
              contents.push(
                {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: toolNames[0],
                        args: {},
                        id: 'call',
                      },
                      ...(captureOffset === 0
                        ? { thoughtSignature: signature }
                        : {}),
                    },
                  ],
                },
                {
                  role: 'user',
                  parts: [
                    {
                      functionResponse: {
                        name: toolNames[0],
                        response: { output: 'result' },
                        id: 'call',
                      },
                    },
                  ],
                },
              )
            } else if (index === 1) {
              contents.push(
                { role: 'model', parts: [{ text: 'answer' }] },
                { role: 'user', parts: [{ text: 'next turn' }] },
              )
            }
          }
        })
      }
    }
  }
})
