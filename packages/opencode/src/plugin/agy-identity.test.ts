import { describe, it } from 'bun:test'
import {
  assertIdentity,
  captures,
  signature,
  toolNames,
} from '../../../../test-fixtures/agy-cli-1.5.8/assert-identity.test'
import { prepareAntigravityRequest } from './request'
import { AgySessionRegistry } from './session-context'
import { prepareAgyWireRequest } from './shared/request-services'

describe('agy 1.5.8 identity through OpenCode request builders', () => {
  for (const host of ['OpenCode 1', 'OpenCode GA']) {
    for (const [model, captureOffset] of [
      ['gemini-3.8-flash-low', 0],
      ['claude-sonnet-5-5-low', 2],
    ] as const) {
      it(`${host} ${model}: first request, tool continuation and second user turn`, () => {
        const sessions = new AgySessionRegistry('/different/workspace')
        const identity = {
          sessionId: 'identity-conversation',
          parentSessionId: null,
        }
        const contents: any[] = [{ role: 'user', parts: [{ text: 'prompt' }] }]
        let previous: any
        for (let index = 0; index < 3; index++) {
          const scope = sessions.beginRequest(identity)
          const payload = {
            contents,
            systemInstruction: { role: 'system', parts: [{ text: 'system' }] },
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
          const init = { method: 'POST', body: JSON.stringify(payload) }
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
              : prepareAgyWireRequest(
                  { prepare: prepareAntigravityRequest } as any,
                  {
                    input,
                    init,
                    accessToken: 'token',
                    projectId: 'project',
                    endpoint: 'https://cloudcode-pa.googleapis.com',
                    options,
                  },
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
                    functionCall: { name: toolNames[0], args: {}, id: 'call' },
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
})
