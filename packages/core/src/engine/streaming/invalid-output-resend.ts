import { EngineRefusalError, responseRefusal } from '../refusals.ts'
import { getResponseCleanup } from '../request-cancellation.ts'
import { ResendableInvalidOutput } from './refusal-stream.ts'

/** Keep the published body open while the executor replaces an unusable attempt. */
export function forwardInvalidOutputResend(
  first: Response,
  resend: () => Promise<Response>,
): Response {
  let reader = first.body!.getReader()
  let cleanup = getResponseCleanup(first)
  let retried = false
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (!cancelled) {
          try {
            const next = await reader.read()
            if (cancelled) return
            if (next.done) {
              reader.releaseLock()
              await cleanup
              if (!cancelled) controller.close()
            } else controller.enqueue(next.value)
            return
          } catch (error) {
            if (cancelled) return
            if (retried || !(error instanceof ResendableInvalidOutput)) {
              reader.releaseLock()
              await cleanup
              if (!cancelled) controller.error(error)
              return
            }
            retried = true
          }
          try {
            reader.releaseLock()
            await cleanup
            if (cancelled) return
            const reply = await resend()
            if (cancelled) {
              await reply.body?.cancel().catch(() => {})
              return
            }
            if (!reply.ok || !reply.body) {
              void reply.body?.cancel().catch(() => {})
              throw (
                responseRefusal(reply) ??
                new EngineRefusalError('upstream_http')
              )
            }
            reader = reply.body.getReader()
            cleanup = getResponseCleanup(reply)
          } catch (error) {
            if (!cancelled) controller.error(error)
            return
          }
        }
      },
      async cancel(reason) {
        cancelled = true
        await reader.cancel(reason).catch(() => {})
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, { status: first.status, headers: first.headers })
}
