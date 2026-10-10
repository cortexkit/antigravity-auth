import { describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent'

import cortexKitPiAntigravityAuth from './index.ts'

describe('Pi Antigravity model catalog', () => {
  it('exposes the live GPT-OSS route but not unsupported image-output chat models', () => {
    const registerProvider = mock()
    cortexKitPiAntigravityAuth({ registerProvider } as never)

    expect(registerProvider).toHaveBeenCalledTimes(1)
    const [providerId, config] = registerProvider.mock.calls[0] as [
      string,
      {
        models: Array<{
          id: string
          reasoning: boolean
          contextWindow: number
          maxTokens: number
        }>
      },
    ]
    expect(providerId).toBe('google')
    const modelIds = config.models.map((model) => model.id)

    expect(modelIds).toContain('antigravity-gemini-3.6-flash')
    expect(modelIds).toContain('antigravity-gemini-3.7-flash')
    expect(modelIds).toContain('antigravity-gemini-3.8-flash')
    expect(modelIds).toContain('antigravity-gpt-oss-120b-medium')
    expect(modelIds).not.toContain('antigravity-gemini-3.1-flash-image')
    expect(modelIds).not.toContain('antigravity-gemini-3.8-flash-cyber')
    expect(
      config.models.find(
        (model) => model.id === 'antigravity-gemini-3.8-flash',
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

it('replaces the native Google catalog and reads only the google OAuth credential in the real Pi registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-pi-provider-'))
  try {
    const authPath = join(directory, 'auth.json')
    const credentials = JSON.stringify({
      google: {
        type: 'oauth',
        access: 'synthetic-google-access',
        refresh: 'synthetic-google-refresh|synthetic-project',
        expires: Date.now() + 3_600_000,
      },
      'google-antigravity': {
        type: 'oauth',
        access: 'synthetic-old-provider-access',
        refresh: 'synthetic-old-provider-refresh|synthetic-old-project',
        expires: Date.now() + 3_600_000,
      },
    })
    await writeFile(authPath, credentials, { mode: 0o600 })
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    const registry = new ModelRegistry(runtime)
    const nativeGoogle = registry
      .getAll()
      .filter((model) => model.provider === 'google')
    expect(nativeGoogle.length).toBeGreaterThan(0)
    expect(
      nativeGoogle.some((model) => !model.id.startsWith('antigravity-')),
    ).toBe(true)

    const registerProvider: ExtensionAPI['registerProvider'] =
      registry.registerProvider.bind(registry)
    cortexKitPiAntigravityAuth({ registerProvider } as never)

    const models = registry
      .getAll()
      .filter((model) => model.provider === 'google')
    expect(models).toHaveLength(8)
    expect(models.every((model) => model.id.startsWith('antigravity-'))).toBe(
      true,
    )
    expect(
      registry.find('google', 'antigravity-gemini-3.8-flash'),
    ).toBeDefined()
    expect(
      registry.find('google-antigravity', 'antigravity-gemini-3.8-flash'),
    ).toBeUndefined()
    expect(registry.getRegisteredProviderIds()).toEqual(['google'])
    expect(
      registry.getRegisteredProviderConfig('google')?.streamSimple,
    ).toBeDefined()
    expect((await registry.getProviderAuth('google'))?.auth.apiKey).toBe(
      'synthetic-google-access',
    )
    expect(await readFile(authPath, 'utf8')).toBe(credentials)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
