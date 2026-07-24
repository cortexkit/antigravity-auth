import { describe, expect, it, mock } from 'bun:test'

import cortexKitPiAntigravityAuth from './index.ts'

describe('Pi Antigravity model catalog', () => {
  it('exposes the live GPT-OSS route but not unsupported image-output chat models', () => {
    const registerProvider = mock()
    cortexKitPiAntigravityAuth({ registerProvider } as never)

    expect(registerProvider).toHaveBeenCalledTimes(1)
    const [, config] = registerProvider.mock.calls[0] as [
      string,
      {
        models: Array<{
          id: string
          reasoning: boolean
          input: Array<string>
          contextWindow: number
          maxTokens: number
        }>
      },
    ]
    const modelIds = config.models.map((model) => model.id)

    expect(modelIds).toContain('antigravity-gemini-3.1-flash-lite')
    expect(modelIds).toContain('antigravity-gemini-3.6-flash')
    expect(modelIds).toContain('antigravity-gpt-oss-120b-medium')
    expect(modelIds).not.toContain('antigravity-gemini-3.1-flash-image')
    const flashLite = config.models.find(
      (model) => model.id === 'antigravity-gemini-3.1-flash-lite',
    )
    expect(flashLite).toMatchObject({
      reasoning: false,
      contextWindow: 1048576,
      maxTokens: 65535,
    })
    expect(flashLite!.input).toEqual(['text'])
    expect(
      config.models.find(
        (model) => model.id === 'antigravity-gemini-3.6-flash',
      ),
    ).toMatchObject({
      reasoning: true,
      contextWindow: 1048576,
      maxTokens: 65536,
    })
    expect(
      config.models.find(
        (model) => model.id === 'antigravity-gpt-oss-120b-medium',
      ),
    ).toMatchObject({
      reasoning: true,
      contextWindow: 131072,
      maxTokens: 32768,
    })
  })
})
