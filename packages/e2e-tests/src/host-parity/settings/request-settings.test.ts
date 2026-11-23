import { expect, spyOn, test } from 'bun:test'
import { conversation, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf } from '../fixtures.ts'
import { openCode2 } from '../open-code.ts'
import { piAdapter } from '../pi-surface.ts'

const hosts = {
  opencode2: (env: Environment, settings: RequestSettings) =>
    openCode2(env, 'local', claude, settings),
  pi: async (env: Environment, settings: RequestSettings) => {
    const host = await piAdapter(env, 'local', false, settings)
    try {
      await host.activate()
      return host
    } catch (error) {
      await host.dispose()
      throw error
    }
  },
}

type RequestSettings = Partial<{
  claude_tool_hardening: boolean
  request_jitter_max_ms: number
}>

const claude = conversation('Claude tool hardening', {
  model: models.claude,
  tools: [
    {
      name: 'lookup',
      description: 'Look up a value.',
      schema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
  ],
})

const flash = conversation('main request jitter')

async function withSettings<T>(
  host: keyof typeof hosts,
  settings: RequestSettings,
  check: (
    env: Environment,
    adapter: Awaited<ReturnType<(typeof hosts)[typeof host]>>,
  ) => Promise<T>,
): Promise<T> {
  const env = new Environment()
  try {
    const adapter = await hosts[host](env, settings)
    try {
      return await check(env, adapter)
    } finally {
      await adapter.dispose()
    }
  } finally {
    await env.dispose()
  }
}

for (const host of ['opencode2', 'pi'] as const) {
  test(`${host} disables the Claude tool instruction without removing the tool`, async () => {
    for (const enabled of [true, false]) {
      await withSettings(
        host,
        { claude_tool_hardening: enabled },
        async (env, adapter) => {
          await adapter.run(claude, 'hardening')
          expect(env.wires).toHaveLength(1)
          const request = JSON.stringify(bodyOf(env.wires[0]!).request)
          expect(request).toContain('"name":"lookup"')
          expect(request.includes('CRITICAL TOOL USAGE INSTRUCTIONS:')).toBe(
            enabled,
          )
        },
      )
    }
  })

  test(`${host} applies request jitter before the first physical send`, async () => {
    for (const max of [0, 200]) {
      await withSettings(
        host,
        { request_jitter_max_ms: max },
        async (env, adapter) => {
          // The shared engine draws from Math.random; a fixed draw gives a known wait.
          const random = spyOn(Math, 'random').mockReturnValue(0.5)
          try {
            await env.timed(() => adapter.run(flash, 'jitter'))
            expect(env.physicalSends).toHaveLength(1)
            expect(env.delays).toEqual(max === 0 ? [] : [100])
          } finally {
            random.mockRestore()
          }
        },
      )
    }
  })
}
