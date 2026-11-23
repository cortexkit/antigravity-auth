import { expect, spyOn, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../../../../opencode/src/plugin/config/index.ts'
import { conversation, historySignature, models } from '../cases.ts'
import { Environment } from '../environment.ts'
import { candidate, sse } from '../fixtures.ts'
import { openCode1, openCode2 } from '../open-code.ts'

const main = conversation('location-thinking', { model: models.flash })
const thought = 'Check the arithmetic before answering.'
const response = () => ({
  body: sse(
    candidate(
      [
        { text: thought, thought: true, thoughtSignature: historySignature },
        { text: 'Four.' },
      ],
      'STOP',
    ),
  ),
})

const cacheConfig = {
  ...DEFAULT_CONFIG.signature_cache!,
  enabled: true,
}

const session = 'colliding-location-session'

test('OpenCode 2 shows thinking once in each location even when host session ids collide', async () => {
  const environment = new Environment(response)
  const locations: Awaited<ReturnType<typeof openCode2>>[] = []
  try {
    const a = await openCode2(environment, 'local', main, {
      keep_thinking: true,
      signature_cache: cacheConfig,
      debug: false,
      debug_tui: false,
    })
    locations.push(a)
    const b = await openCode2(environment, 'local', main, {
      keep_thinking: false,
      signature_cache: { ...cacheConfig, enabled: false },
      debug: true,
      debug_tui: true,
    })
    locations.push(b)
    const cached = spyOn(a.runtime.signatures, 'cacheSignature')
    const first = await a.run(main, session)
    const saved = cached.mock.calls.find(([, text]) => text.includes(thought))
    const crossed =
      saved && b.runtime.signatures.getCachedSignature(saved[0], saved[1])
    const second = await b.run(main, session)
    expect(first.thinking).toContain(thought)
    expect(second.thinking).toContain(thought)
    expect(first.thinking).toContain('[Thinking preserved]')
    expect(first.thinking).not.toContain('[opencode-antigravity-auth debug]')
    expect(second.thinking).toContain('[opencode-antigravity-auth debug]')
    expect(second.thinking).not.toContain('[Thinking preserved]')
    expect(saved).toBeDefined()
    const [signatureSession, cachedText] = saved!
    expect(
      a.runtime.signatures.getCachedSignature(signatureSession, cachedText),
    ).toBe(historySignature)
    expect(
      a.runtime.signatures.diskCache?.getStats().memoryEntries,
    ).toBeGreaterThan(0)
    expect(b.runtime.signatures.diskCache).toBeNull()
    expect(crossed).toBeUndefined()
    expect((await a.run(main, session)).thinking).not.toContain(thought)
    expect((await b.run(main, session)).thinking).not.toContain(thought)
  } finally {
    for (const location of locations.reverse()) await location.dispose()
    await environment.dispose()
  }
})

test('OpenCode 1 still shows identical thinking once per interceptor session', async () => {
  const environment = new Environment(response)
  const host = await openCode1(environment, 'local', main)
  try {
    expect((await host.run(main, 'control-a')).thinking).toContain(thought)
    expect((await host.run(main, 'control-a')).thinking).not.toContain(thought)
    expect((await host.run(main, 'control-b')).thinking).toContain(thought)
  } finally {
    await host.dispose()
    await environment.dispose()
  }
})

test('OpenCode 2 repository account manager uses configured health scores and token buckets', async () => {
  const environment = new Environment(response)
  const host = await openCode2(environment, 'local', main, {
    account_selection_strategy: 'hybrid',
    health_score: {
      ...DEFAULT_CONFIG.health_score!,
      initial: 53,
      success_reward: 7,
    },
    token_bucket: {
      max_tokens: 13,
      initial_tokens: 4,
      regeneration_rate_per_minute: 0.1,
    },
  })
  try {
    const manager = host.accounts.current!
    const row = manager.getAccounts()[0]!
    expect(manager.healthTracker.getScore(row.index)).toBe(53)
    expect(manager.tokenTracker.getTokens(row.index)).toBe(4)
    expect((await host.run(main, 'tracker-test')).text).toBe('Four.')
    expect(manager.healthTracker.getScore(row.index)).toBe(60)
    expect(manager.tokenTracker.getTokens(row.index)).toBe(3)
  } finally {
    await host.dispose()
    await environment.dispose()
  }
})
