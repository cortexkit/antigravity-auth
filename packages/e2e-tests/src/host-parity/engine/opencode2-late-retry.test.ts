import { expect, test } from 'bun:test'
import { EngineRefusalError } from '@cortexkit/antigravity-auth-core/engine'
import { AIError, Message } from '@opencode/ai'
import { make } from '@opencode/ai/promise'
import { configure } from '@opencode/ai/providers/google'
import { RequestExecutor } from '@opencode/ai/route/executor'
import { Effect } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { OpenCode230Retryability } from '../../../../opencode/src/ga/server/__fixtures__/opencode-230-retryability.test.ts'
import { startGaLoopbackBridge } from '../../../../opencode/src/ga/server/index.ts'
import { models } from '../cases.ts'
import { candidate, placeholder, sse } from '../fixtures.ts'

for (const id of [
  'empty',
  'embedded_error',
  'incomplete',
  'stopped_by_google',
  'quota_wait_exhausted',
  'transport_error',
] as const) {
  test(`OpenCode 2 native retry classification after ${id} counts physical sends`, async () => {
    const error = new EngineRefusalError(id, { finishReason: 'SAFETY' })
    const transport = id === 'transport_error'
    let sends = 0
    const bridge = await startGaLoopbackBridge({
      execute: (job, context) =>
        context.send({
          envelope: JSON.parse(job.body),
          auth: { access: 'fixture' },
          endpoint: 'https://daily-cloudcode-pa.googleapis.com',
          signal: context.signal,
          kind: job.kind,
        }),
      async send() {
        ++sends
        let first = true
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (first) {
                first = false
                controller.enqueue(
                  new TextEncoder().encode(
                    sse(candidate([{ text: 'Partial.' }]).response),
                  ),
                )
              } else controller.error(error)
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const ai = make({
      layer: RequestExecutor.middleware((request) =>
        Effect.flatMap(HttpClientRequest.toWeb(request), (native) =>
          Effect.tryPromise({
            async try() {
              const rewritten = bridge.rewrite(
                native,
                {
                  sessionID: 'late-generate',
                  parentSessionID: null,
                  kind: 'generate',
                  modelID: models.flash,
                  variant: null,
                  url: native.url,
                  body: await native.clone().text(),
                },
                {},
              )
              const response = await fetch(rewritten)
              return HttpClientResponse.fromWeb(
                request,
                bridge.adaptResponse(rewritten, response)!,
              )
            },
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          }),
        ),
      ),
    })
    try {
      let last: AIError | undefined
      let text = ''
      // The OpenCode 2.0.22 decoder constructs the reason. Apply the vendored
      // OpenCode 2.3.0 retryability getter before making a second send.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          for await (const event of ai.llm.stream({
            model: configure({ apiKey: placeholder }).model(models.flash),
            messages: [
              Message.make({
                role: 'user',
                content: [{ type: 'text', text: 'Four?' }],
              }),
            ],
          }))
            if (event.type === 'text-delta') text += event.text
          throw new Error('Expected a native refusal')
        } catch (caught) {
          if (!(caught instanceof AIError)) throw caught
          last = caught
          const reason = caught.reason
          if (reason._tag === 'Transport') {
            if (
              new OpenCode230Retryability({
                _tag: 'Transport',
                operation: 'read',
                delivery: 'unknown',
                http: reason.http,
              }).isRetryable
            )
              continue
          } else if (reason._tag === 'InvalidRequest') {
            if (
              new OpenCode230Retryability({
                _tag: 'InvalidRequest',
                http: reason.http,
              }).isRetryable
            )
              continue
          } else throw caught
          break
        }
      }
      expect(sends).toBe(transport ? 2 : 1)
      expect(last?.reason._tag).toBe(transport ? 'Transport' : 'InvalidRequest')
      expect(last?.message).toBe(
        transport
          ? `Connection lost while reading the response: ${error.message}`
          : error.message,
      )
      expect(text).toBe(transport ? 'Partial.Partial.' : 'Partial.')
    } finally {
      await ai.dispose()
      await bridge.dispose()
    }
  })
}
