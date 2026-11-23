import { expect, test } from 'bun:test'
import { createRequestExecutor } from '../../../../opencode/src/plugin/shared/request-executor.ts'
import {
  CHAT_INIT,
  disposePools,
  harness,
  NON_STREAM_URL,
  routedTime,
  routingAdmission,
  vaultDeps,
} from '../../../../opencode/src/plugin/shared/request-services-harness.test.ts'

test('buffered empty replies use the configured attempt count and delay', async () => {
  for (const domain of ['local', 'vault'] as const) {
    for (const [attempts, delay] of [
      [1, 600],
      [3, 800],
    ] as const) {
      const clock = routedTime(600, 800, 2000)
      const h = harness({
        config: {
          empty_response_max_attempts: attempts,
          empty_response_retry_delay_ms: delay,
        },
        respond: async () => Response.json({ response: { candidates: [] } }),
      })
      const executor = createRequestExecutor(
        domain === 'local'
          ? h.deps
          : vaultDeps(h, async (account) => routingAdmission(account)),
      )
      try {
        const response = await executor.execute(NON_STREAM_URL, CHAT_INIT())
        expect(await response.text()).toContain(
          'Antigravity returned an empty response.',
        )
        expect(h.calls).toHaveLength(attempts)
        expect(clock.delays).toEqual(attempts === 1 ? [] : [delay, delay])
      } finally {
        clock.restore()
        await executor.dispose()
        await disposePools()
      }
    }
  }
})
