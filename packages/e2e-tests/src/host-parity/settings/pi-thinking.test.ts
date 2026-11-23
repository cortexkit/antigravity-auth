import { expect, test } from 'bun:test'
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai'
import { conversation } from '../cases.ts'
import { Environment } from '../environment.ts'
import { bodyOf } from '../fixtures.ts'
import { piAdapter, piContext } from '../pi-surface.ts'

type Provider = Awaited<
  ReturnType<Awaited<ReturnType<typeof piAdapter>>['activate']>
>

function registeredModel(provider: Provider, id: string) {
  const definition = provider.models?.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`Pi did not register ${id}`)
  return {
    ...definition,
    api: 'google-generative-ai',
    provider: 'google',
    baseUrl: provider.baseUrl,
  } as Model<'google-generative-ai'>
}

for (const id of [
  'antigravity-gemini-4-neon',
  'antigravity-gemini-4-hydrogen',
]) {
  test(`Pi's registered ${id} picker exposes XHigh and sends numeric 100`, async () => {
    const environment = new Environment()
    const pi = await piAdapter(environment, 'local', true)
    try {
      const provider = await pi.activate()
      const model = registeredModel(provider, id)
      expect(getSupportedThinkingLevels(model)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
      ])
      const streamSimple = provider.streamSimple!
      const context = piContext(
        conversation('registered-thinking', { model: id }),
        true,
      ) as Parameters<typeof streamSimple>[1]
      const auth = (await Bun.file(pi.nativeAuthPath).json()).google
      const apiKey = provider.oauth!.getApiKey(auth)
      for (const level of ['low', 'medium', 'high', 'xhigh'] as const) {
        const resolved = clampThinkingLevel(model, level)
        expect(resolved).toBe(level)
        const stream = streamSimple(model, context, {
          apiKey,
          reasoning: level === resolved ? resolved : undefined,
        })
        expect((await stream.result()).stopReason).toBe('stop')
      }
      expect(
        environment.wires.map(
          (wire) =>
            (
              bodyOf(wire).request as {
                generationConfig: { thinkingConfig: unknown }
              }
            ).generationConfig.thinkingConfig,
        ),
      ).toEqual([
        { includeThoughts: true, thinkingLevel: 'LOW' },
        { includeThoughts: true, thinkingLevel: 'MEDIUM' },
        { includeThoughts: true, thinkingLevel: 'HIGH' },
        { includeThoughts: true, thinkingLevel: 100 },
      ])
    } finally {
      await pi.dispose()
      await environment.dispose()
    }
  })
}

test("Pi's registered fixed-tier GPT-OSS picker offers no levels", async () => {
  const environment = new Environment()
  const pi = await piAdapter(environment, 'local', true)
  try {
    const provider = await pi.activate()
    const model = registeredModel(provider, 'antigravity-gpt-oss-120b-medium')
    expect(getSupportedThinkingLevels(model)).toEqual([])
    expect(clampThinkingLevel(model, 'xhigh')).toBe('off')
    const streamSimple = provider.streamSimple!
    const context = piContext(
      conversation('fixed-thinking', { model: model.id }),
      true,
    ) as Parameters<typeof streamSimple>[1]
    const auth = (await Bun.file(pi.nativeAuthPath).json()).google
    const stream = streamSimple(model, context, {
      apiKey: provider.oauth!.getApiKey(auth),
    })
    expect((await stream.result()).stopReason).toBe('stop')
    expect(environment.physicalSends.map(({ model }) => model)).toEqual([
      'gpt-oss-120b-medium',
    ])
  } finally {
    await pi.dispose()
    await environment.dispose()
  }
})
