import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../../opencode/src/plugin/config/index.ts'
import { initializeDebug } from '../../../../opencode/src/plugin/debug.ts'
import {
  createLogger,
  initLogger,
  setRuntimeLogLevel,
} from '../../../../opencode/src/plugin/logger.ts'
import { call, conversation, historySignature, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf, candidate, type Reply, sse, success } from '../fixtures.ts'
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
  keep_thinking: boolean
  thinking_warmup: boolean
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

test('OpenCode 1 log level filters the host log without losing warnings', () => {
  const seen: string[] = []
  initializeDebug({ ...DEFAULT_CONFIG, debug: false, debug_tui: true })
  initLogger({
    app: {
      log: ({ body }) => {
        seen.push(body.message)
      },
    },
  })
  const log = createLogger('settings-proof')
  try {
    setRuntimeLogLevel('info')
    log.debug('hidden at info')
    setRuntimeLogLevel('debug')
    log.debug('shown at debug')
    log.warn('warning')
    expect(seen).toEqual(['shown at debug', 'warning'])
  } finally {
    setRuntimeLogLevel('info')
    initializeDebug(DEFAULT_CONFIG)
    initLogger({})
  }
})

test('OpenCode 2 writes request diagnostics only when enabled and in the location log directory', async () => {
  const dir = await mkdtemp(
    join(process.env.ANTIGRAVITY_TEST_ROOT!, 'ga-debug-settings-'),
  )
  try {
    for (const debug of [false, true]) {
      const env = new Environment()
      const host = await openCode2(env, 'local', flash, {
        debug,
        debug_tui: false,
        log_dir: dir,
      })
      let path: string | undefined
      try {
        expect((await host.run(flash, 'diagnostics')).terminal).toEqual([
          'stop',
        ])
        path = host.runtime.debug.getLogFilePath()
        if (debug) expect(path).toStartWith(`${dir}/`)
        else expect(path).toBeUndefined()
      } finally {
        await host.dispose()
        await env.dispose()
      }
      if (path) expect(await Bun.file(path).text()).toContain(models.flash)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Pi settings independently gate the debug file and debug-level request records', async () => {
  const dir = await mkdtemp(
    join(process.env.ANTIGRAVITY_TEST_ROOT!, 'pi-debug-settings-'),
  )
  try {
    for (const [debug, level] of [
      [false, 'info'],
      [true, 'debug'],
    ] as const) {
      const env = new Environment((_wire, attempt) =>
        attempt === 0 ? { status: 503 } : success,
      )
      const logDir = join(dir, level)
      const host = await piAdapter(env, 'local', false, {
        debug,
        log_level: level,
        log_dir: logDir,
      })
      try {
        expect(
          (await env.timed(() => host.run(flash, 'diagnostics'))).terminal,
        ).toEqual(['stop'])
        const requestLog = Bun.file(join(logDir, 'pi-antigravity.log'))
        expect(await requestLog.text()).toContain('request-send')
        expect((await requestLog.text()).includes('"level":"debug"')).toBe(
          level === 'debug',
        )
        const debugLog = Bun.file(join(logDir, 'pi-antigravity-debug.log'))
        expect(await debugLog.exists()).toBe(debug)
        if (debug) expect(await debugLog.text()).toContain('"event":"request"')
      } finally {
        await host.dispose()
        await env.dispose()
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function withSettings<T>(
  host: keyof typeof hosts,
  settings: RequestSettings,
  check: (
    env: Environment,
    adapter: Awaited<ReturnType<(typeof hosts)[typeof host]>>,
  ) => Promise<T>,
  reply?: ConstructorParameters<typeof Environment>[0],
): Promise<T> {
  const env = new Environment(reply)
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

const toolHistory = {
  ...claude,
  messages: [
    ...claude.messages,
    {
      role: 'assistant' as const,
      parts: [call, { type: 'text' as const, text: 'Four.' }],
    },
    {
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Check again.' }],
    },
  ],
}

const warmupPrompt = 'Warmup request for thinking signature.'

for (const host of ['opencode2', 'pi'] as const) {
  test(`${host} emits a thinking warmup only when preservation and warmup are both enabled`, async () => {
    for (const [keepThinking, warmup, sends] of [
      [false, true, 1],
      [true, false, 1],
      [true, true, 2],
    ] as const) {
      await withSettings(
        host,
        { keep_thinking: keepThinking, thinking_warmup: warmup },
        async (env, adapter) => {
          expect((await adapter.run(toolHistory, 'warmup')).terminal).toEqual([
            'stop',
          ])
          expect(
            env.wires.map((wire) =>
              JSON.stringify(bodyOf(wire).request).includes(warmupPrompt),
            ),
          ).toEqual(sends === 2 ? [true, false] : [false])
        },
      )
    }
  })
}

test('Pi reuses a signed thought only while its signature cache is enabled', async () => {
  for (const enabled of [false, true]) {
    const env = new Environment((_wire, attempt) =>
      attempt === 0
        ? {
            body: sse(
              candidate(
                [
                  {
                    thought: true,
                    text: 'Check the numbers.',
                    thoughtSignature: historySignature,
                  },
                  { text: 'Four.' },
                ],
                'STOP',
              ),
            ),
          }
        : success,
    )
    const pi = await piAdapter(env, 'local', true, {
      keep_thinking: true,
      thinking_warmup: true,
      signature_cache: { enabled },
    })
    try {
      expect((await pi.run(claude, 'signature')).terminal).toEqual(['stop'])
      expect((await pi.run(toolHistory, 'signature')).terminal).toEqual([
        'stop',
      ])
      expect(
        env.wires
          .slice(1)
          .map((wire) =>
            JSON.stringify(bodyOf(wire).request).includes(warmupPrompt),
          ),
      ).toEqual(enabled ? [false] : [true, false])
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  }
})

const quotaLimit: Reply = {
  status: 429,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    error: {
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'QUOTA_EXHAUSTED',
        },
      ],
    },
  }),
}

test('Pi uses the configured wait budget and fallback when a quota reply lacks timing', async () => {
  for (const [cap, fallback, sends, delay] of [
    [2, 8, 1, undefined],
    [10, 8, 2, 8000],
    [10, 6, 2, 6000],
  ] as const) {
    const env = new Environment((_wire, attempt) =>
      attempt === 0 ? quotaLimit : success,
    )
    const pi = await piAdapter(env, 'local', false, {
      max_rate_limit_wait_seconds: cap,
      default_retry_after_seconds: fallback,
    })
    try {
      await env.timed(async () => {
        expect((await pi.run(flash, 'quota-mark')).terminal).toEqual([
          'failure:quota_exhausted',
        ])
        expect((await pi.run(flash, 'quota-wait')).terminal).toEqual(
          sends === 1 ? ['failure:upstream_http'] : ['stop'],
        )
      })
      expect(env.physicalSends).toHaveLength(sends)
      expect(env.delays).toEqual(delay === undefined ? [] : [delay])
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  }
})

test('Pi quiet mode suppresses the rate-limit notice without changing the refusal', async () => {
  for (const quiet of [false, true]) {
    const env = new Environment((_wire, attempt) =>
      attempt === 0 ? quotaLimit : success,
    )
    const pi = await piAdapter(env, 'local', false, {
      quiet_mode: quiet,
      max_rate_limit_wait_seconds: 10,
      default_retry_after_seconds: 6,
    })
    try {
      expect((await env.timed(() => pi.run(flash, 'notice'))).terminal).toEqual(
        ['failure:quota_exhausted'],
      )
      expect(env.physicalSends).toHaveLength(1)
      if (quiet) expect(env.notices).toEqual([])
      else
        expect(env.notices).toContain(
          'Rate limited. Retrying in 1s (attempt 1)...',
        )
    } finally {
      await pi.dispose()
      await env.dispose()
    }
  }
})

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
          // Hold the random draw fixed and observe the timer before the transport runs.
          const random = spyOn(Math, 'random').mockReturnValue(0.5)
          const setTimer = globalThis.setTimeout
          const sendsAtJitter: number[] = []
          const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(((
            callback: () => void,
            delay: number,
            ...args: unknown[]
          ) => {
            if (delay === 100) sendsAtJitter.push(env.physicalSends.length)
            return setTimer(callback, delay, ...args)
          }) as typeof setTimeout)
          try {
            await adapter.run(flash, 'jitter')
            expect(env.physicalSends).toHaveLength(1)
            expect(sendsAtJitter).toEqual(max === 0 ? [] : [0])
          } finally {
            schedule.mockRestore()
            random.mockRestore()
          }
        },
      )
    }
  })
}
