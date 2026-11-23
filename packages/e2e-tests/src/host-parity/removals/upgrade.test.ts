import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getAgyNativeModel,
  isRetiredAgyModel,
} from '@cortexkit/antigravity-auth-core'
import { createProtectionStore } from '@cortexkit/antigravity-auth-core/settings'
import {
  gaCatalogModels,
  registerGaModels,
} from '../../../../opencode/src/ga/server/index.ts'
import { applyAntigravityProviderCatalog } from '../../../../opencode/src/plugin/catalog.ts'
import { accountModelList } from '../../../../opencode/src/plugin/command-apply.ts'
import { createAntigravityPlugin } from '../../../../opencode/src/plugin/index.ts'
import type {
  Hooks,
  PluginInput,
} from '../../../../opencode/src/plugin/types.ts'
import { createSettingsRuntime } from '../../../../opencode/src/settings/runtime.ts'
import { createPiModelAccess } from '../../../../pi/src/model-access.ts'
import { Environment } from '../environment.ts'
import { piAdapter } from '../pi-surface.ts'
import { imageModel } from './cases.ts'

async function testDirectory(prefix: string) {
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('Host parity requires the root test preload')
  return mkdtemp(join(root, prefix))
}

test('OpenCode 1 activation supplies no google_search tool', async () => {
  const directory = await testDirectory('removals-open-code1-')
  const previousConfig = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
  let plugin: Hooks | undefined
  try {
    await Bun.write(
      join(directory, 'antigravity.json'),
      JSON.stringify({ background_quota_refresh: false, auto_update: false }),
    )
    const client = {
      app: { log: async () => {} },
      auth: { set: async () => {} },
      tui: { showToast: async () => {} },
    } as unknown as PluginInput['client']
    plugin = await createAntigravityPlugin('google')({
      client,
      directory,
      worktree: directory,
      project: {} as PluginInput['project'],
      serverUrl: new URL('http://localhost:4096'),
      experimental_workspace: { register() {} },
      $: (() => {}) as unknown as PluginInput['$'],
    })
    expect(plugin.tool?.google_search).toBeUndefined()
  } finally {
    await plugin?.dispose?.()
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfig
    await rm(directory, { recursive: true, force: true })
  }
})

test('a persisted googleSearch model option loads, is ignored, and writes to the plugin logger', () => {
  const config = JSON.parse(`{
    "provider": { "google": { "models": { "custom": {
      "options": { "googleSearch": { "mode": "auto" }, "thinkingLevel": "low" },
      "variants": { "high": { "googleSearch": { "mode": "auto" }, "thinkingLevel": "high" } }
    } } } }
  }`)
  const warn = mock(() => {})
  applyAntigravityProviderCatalog(config, 'google', { warn })
  expect(config.provider.google.models.custom).toEqual({
    options: { thinkingLevel: 'low' },
    variants: { high: { thinkingLevel: 'high' } },
  })
  expect(warn).toHaveBeenCalledWith('Ignored removed googleSearch model option')
})

test('image routes are retired rather than present in plugin or native Antigravity definitions', () => {
  for (const id of [
    imageModel,
    'gemini-3.1-flash-image',
    'GEMINI-3-PRO-IMAGE-PREVIEW',
    'gemini-2.5-flash-image',
    'imagen-3.0-generate-002',
  ]) {
    expect(isRetiredAgyModel(id), id).toBe(true)
    expect(getAgyNativeModel(id), id).toBeUndefined()
  }
})

test('OpenCode catalog contributions have no image output but keep image input and the native Google entry', () => {
  const config: {
    provider: {
      google: {
        models: Record<
          string,
          { modalities: { input: string[]; output: string[] } }
        >
      }
    }
  } = {
    provider: { google: { models: {} } },
  }
  applyAntigravityProviderCatalog(config, 'google')
  expect(Object.keys(config.provider.google.models)).not.toContain(imageModel)
  for (const { modalities } of Object.values(config.provider.google.models)) {
    expect(modalities.input).toContain('image')
    expect(modalities.output).not.toContain('image')
  }

  const catalog = gaCatalogModels()
  expect([...catalog.keys()]).not.toContain(imageModel)
  const sample = [...catalog.values()][0]!
  const nativeId = 'gemini-3.1-flash-image' as typeof sample.id
  const nativeImage = {
    ...sample,
    id: nativeId,
    modelID: nativeId,
    capabilities: {
      ...sample.capabilities,
      output: ['image'] as Array<'image'>,
    },
  }
  const set = mock(
    (_provider: string, _models: readonly (typeof sample)[]) => {},
  )
  registerGaModels(
    {
      get: () => ({ models: new Map([[nativeId, nativeImage]]) }),
      models: { set },
    },
    catalog,
  )
  expect(set.mock.calls[0]?.[0]).toBe('google')
  expect(set.mock.calls[0]?.[1]?.find(({ id }) => id === nativeId)).toBe(
    nativeImage,
  )
  for (const model of catalog.values()) {
    expect(model.capabilities.input).toContain('image')
    expect(model.capabilities.output).not.toContain('image')
  }
})

test('Pi contributes text-output models with image input, not image-generation models', async () => {
  const environment = new Environment()
  const pi = await piAdapter(environment, 'local', false)
  try {
    const { models } = await pi.activate()
    expect(models?.length).toBeGreaterThan(0)
    expect(models?.map(({ id }) => id)).not.toContain(imageModel)
    for (const model of models ?? []) expect(model.input).toContain('image')
  } finally {
    await pi.dispose()
    await environment.dispose()
  }
})

const retired = 'gemini-3.1-flash-image'
const remaining = 'gemini-4-carbon'
const excluded = 'gemini-4-argon'
const lists = { mixed: [remaining, retired], 'retired-only': [retired] }

function assertAccountRestriction(
  allows: (id: string, model: string) => boolean,
) {
  expect(allows('mixed', remaining)).toBe(true)
  expect(allows('mixed', retired)).toBe(false)
  expect(allows('mixed', excluded)).toBe(false)
  expect(allows('retired-only', remaining)).toBe(false)
  expect(allows('retired-only', retired)).toBe(false)
  expect(allows('unrestricted', excluded)).toBe(true)
}

test('OpenCode ignores and logs retired account_models members without widening access', async () => {
  const directory = await testDirectory('removals-open-code-settings-')
  const file = join(directory, 'antigravity-auth.jsonc')
  const warn = mock((_message: string) => {})
  const runtime = createSettingsRuntime({
    file,
    separateInstall: false,
    legacyUserFile: join(directory, 'antigravity.json'),
    protection: createProtectionStore(join(directory, 'protection.json')),
    log: { warn, info() {} },
  })
  try {
    await Bun.write(
      file,
      JSON.stringify({ schema_version: 1, account_models: lists }),
    )
    const legacy = () => {
      throw new Error('The shared settings file must be used')
    }
    const project = await runtime.openProject(directory, {
      config: legacy,
      operator: legacy,
    })
    assertAccountRestriction(project.modelAccess().allows)
    expect(accountModelList(project, 'mixed')).toEqual([remaining])
    expect(accountModelList(project, 'retired-only')).toEqual([])
    expect(warn.mock.calls.map(([message]) => message).join('\n')).toContain(
      retired,
    )
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Pi ignores and logs retired account_models members without widening access', async () => {
  const directory = await testDirectory('removals-pi-settings-')
  const file = join(directory, 'antigravity-auth.jsonc')
  const warn = mock((_message: string) => {})
  const access = createPiModelAccess({
    file,
    statePath: join(directory, 'protection.json'),
    log: { warn, info() {} },
  })
  try {
    await Bun.write(
      file,
      JSON.stringify({ schema_version: 1, account_models: lists }),
    )
    await access.ready()
    assertAccountRestriction(access.policy().allows)
    expect(access.list('mixed')).toEqual([remaining])
    expect(access.list('retired-only')).toEqual([])
    expect(warn.mock.calls.map(([message]) => message).join('\n')).toContain(
      retired,
    )
  } finally {
    await access.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
