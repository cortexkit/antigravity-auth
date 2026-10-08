import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { Plugin } from '@opencode/plugin'
import {
  assertRewriteConformance,
  matchesGoogleContentPath,
  normalizedRewrite,
} from './ga-loopback-request-contract.ts'

// Native host dispatch of the rewritten Request is what this plugin measures.
// It must not predict that route from proxy environment variables.
const plugin: Plugin.Plugin = {
  id: 'cortexkit.measure.ga-host-contract',
  async setup(context) {
    const logPath = process.env.GA_MEASURE_LOG
    const mockPort = Number(process.env.GA_MOCK_PORT)
    if (
      !logPath ||
      !Number.isInteger(mockPort) ||
      mockPort < 1024 ||
      mockPort > 65535
    ) {
      throw new Error('measurement requires an explicit log and mock port')
    }
    const record = (event: object) =>
      appendFileSync(logPath, `${JSON.stringify(event)}\n`)
    record({
      type: 'setup',
      runtime: { name: 'Bun', version: Bun.version, revision: Bun.revision },
    })
    await context.session.hook(
      'http.request',
      async (event) => {
        if (event.model.providerID !== 'google') return
        const original = new URL(event.request.url)
        if (!matchesGoogleContentPath(original.pathname)) return
        if (event.request.method !== 'POST')
          throw new Error('unexpected Google request method')
        const body = await event.request.clone().text()
        const nonce = /GA-NONCE-[0-9a-f-]{36}/.exec(body)?.[0] ?? null
        const job = randomUUID()
        const request = new Request(`http://127.0.0.1:${mockPort}/agy/${job}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: event.request.signal,
        })
        await assertRewriteConformance(request)
        record({
          type: 'rewrite',
          job,
          kind: event.kind,
          sessionID: event.sessionID,
          nonce,
          originalURL: original.href,
          originalBodySha256: createHash('sha256').update(body).digest('hex'),
          dispatch: await normalizedRewrite(request),
        })
        event.request = request
      },
      { providerID: 'google' },
    )
    // Finite, one-dispatch cases measure routing rather than retry policy.
    await context.session.hook(
      'retry',
      (event) => {
        event.decision = { retry: false }
      },
      { providerID: 'google' },
    )
  },
}

export default plugin
