/**
 * Two server locations in one process: each keeps its own configuration,
 * logger, debug file, dump switch and operator settings, while signature
 * caching and per-file settings controllers are process-shared with
 * per-location ownership. Every case uses disposable paths under the test
 * root, fake credentials and, where time matters, a deterministic clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  createLogger as createCoreLogger,
  setLogSink,
} from '@cortexkit/antigravity-auth-core'
import {
  createSignatureProcessState,
  type LocationSignatureCache,
  type SignatureProcessState,
} from '../cache'
import {
  createLocationConfig,
  getKeepThinking,
  initRuntimeConfig,
  type SignatureCacheConfig,
} from '../config'
import { DEFAULT_CONFIG } from '../config/schema'
import { createStreamingTransformer } from '../core/streaming/transformer'
import {
  createLocationDebug,
  initializeDebug,
  isDebugEnabled,
  type LocationDebug,
} from '../debug'
import {
  createGeminiDumpState,
  isGeminiDumpEnabled,
  resetGeminiDumpState,
  setGeminiDumpEnabled,
} from '../gemini-dump'
import {
  createLocationLogger,
  createLogger as createLegacyLogger,
  initLogger,
  setRuntimeLogLevel,
} from '../logger'
import type { LocationLogRecord } from '../neutral-types'
import {
  acquireLocationOperatorSettings,
  createOperatorSettingsRegistry,
  type LocationOperatorSettings,
  type OperatorSettingsRegistry,
} from '../operator-settings'

const HOUR_MS = 60 * 60 * 1000
const T0 = 1_700_000_000_000

const SHORT_CACHE: SignatureCacheConfig = {
  enabled: true,
  memory_ttl_seconds: 60,
  disk_ttl_seconds: 3600,
  write_interval_seconds: 600,
}
const LONG_CACHE: SignatureCacheConfig = {
  enabled: true,
  memory_ttl_seconds: 7200,
  disk_ttl_seconds: 172800,
  write_interval_seconds: 600,
}

const ENV_KEYS = [
  'OPENCODE_ANTIGRAVITY_DEBUG',
  'OPENCODE_ANTIGRAVITY_DEBUG_TUI',
  'OPENCODE_ANTIGRAVITY_CONSOLE_LOG',
  'OPENCODE_ANTIGRAVITY_GEMINI_DUMP',
  'OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR',
] as const

let root: string
let savedEnv: Record<string, string | undefined>
const cleanups: Array<() => unknown> = []

beforeEach(() => {
  const base = process.env.ANTIGRAVITY_TEST_ROOT ?? tmpdir()
  root = mkdtempSync(join(base, 'location-state-'))
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(root, { recursive: true, force: true })
})

function makeProject(name: string, config?: Record<string, unknown>): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  if (config) {
    writeFileSync(
      join(dir, '.opencode', 'antigravity.json'),
      JSON.stringify(config),
    )
  }
  return dir
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function debugFor(config: Partial<typeof DEFAULT_CONFIG>): LocationDebug {
  const handle = createLocationDebug({ ...DEFAULT_CONFIG, ...config })
  cleanups.push(() => handle.close())
  return handle
}

// =============================================================================
// Transition contract and module graph
// =============================================================================

describe('OpenCode 1 binding transition contract', () => {
  afterEach(() => {
    initRuntimeConfig(DEFAULT_CONFIG)
    initializeDebug(DEFAULT_CONFIG)
    resetGeminiDumpState()
    setRuntimeLogLevel('debug')
    setLogSink(null)
  })

  it('isolates location capabilities from the module-level OpenCode 1 binding in both directions', () => {
    const dir = makeProject('a', { keep_thinking: false, debug_tui: true })
    const location = createLocationConfig(dir)
    const debug = debugFor(location.config)
    const dump = createGeminiDumpState({ enabled: false })
    const locationRecords: string[] = []
    const logger = createLocationLogger({
      sink: (record) => locationRecords.push(record.message),
      sinkEnabled: debug.isDebugTuiEnabled,
      level: 'error',
    })
    const legacyRecords: string[] = []
    initLogger({
      app: {
        log: ({ body }) => {
          legacyRecords.push(body.message)
          return Promise.resolve()
        },
      },
    })

    // The OpenCode 1 binding changes; the location keeps its own values.
    initRuntimeConfig({ ...DEFAULT_CONFIG, keep_thinking: true })
    initializeDebug({ ...DEFAULT_CONFIG, debug_tui: false })
    setGeminiDumpEnabled(true)
    setRuntimeLogLevel('debug')
    expect(location.keepThinking).toBe(false)
    expect(debug.isDebugTuiEnabled()).toBe(true)
    expect(dump.isEnabled()).toBe(false)
    logger.createLogger('x').warn('location-warn-filtered')
    expect(locationRecords).toEqual([])

    // The location changes; the OpenCode 1 binding keeps its values.
    dump.setEnabled(true)
    dump.setEnabled(false)
    logger.setLevel('debug')
    initializeDebug({ ...DEFAULT_CONFIG, debug_tui: true })
    createLegacyLogger('legacy').info('legacy-info')
    logger.createLogger('x').info('location-info')
    expect(getKeepThinking()).toBe(true)
    expect(isGeminiDumpEnabled()).toBe(true)
    expect(legacyRecords).toEqual(['legacy-info'])
    expect(locationRecords).toEqual(['location-info'])
  })

  it('keeps location modules free of host SDK and plugin types edges', () => {
    const pluginDir = resolve(import.meta.dir, '..')
    const roots = [
      'logger.ts',
      'debug.ts',
      'gemini-dump.ts',
      'cache.ts',
      'operator-settings.ts',
      'config/index.ts',
      'neutral-types.ts',
    ].map((file) => join(pluginDir, file))
    const importPattern =
      /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
    const resolveRelative = (from: string, spec: string): string | null => {
      const base = resolve(dirname(from), spec)
      for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (/\.(ts|js)$/.test(candidate) && existsSync(candidate)) {
          return candidate
        }
      }
      return null
    }
    const seen = new Set<string>()
    const banned: string[] = []
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
        const spec = match[1] ?? ''
        if (spec.startsWith('@opencode-ai/')) banned.push(`${file} -> ${spec}`)
        if (!spec.startsWith('.')) continue
        const target = resolveRelative(file, spec)
        if (!target) continue
        if (target === join(pluginDir, 'types.ts')) {
          banned.push(`${file} -> ${target}`)
        }
        walk(target)
      }
    }
    for (const rootFile of roots) walk(rootFile)

    expect(seen.has(join(pluginDir, 'cache', 'signature-cache.ts'))).toBe(true)
    expect(banned).toEqual([])
  })
})

// =============================================================================
// Configuration
// =============================================================================

describe('location configuration', () => {
  for (const order of [
    ['A', 'B'],
    ['B', 'A'],
  ] as const) {
    it(`loads each location's own file in order ${order.join('→')} without touching the OpenCode 1 binding`, () => {
      const dirs = {
        A: makeProject('a', { keep_thinking: true, debug_tui: true }),
        B: makeProject('b', { keep_thinking: false, debug_tui: false }),
      }
      initRuntimeConfig({ ...DEFAULT_CONFIG, keep_thinking: false })

      const loaded = Object.fromEntries(
        order.map((name) => [name, createLocationConfig(dirs[name])]),
      )

      expect(loaded.A?.keepThinking).toBe(true)
      expect(loaded.A?.config.debug_tui).toBe(true)
      expect(loaded.B?.keepThinking).toBe(false)
      expect(loaded.B?.config.debug_tui).toBe(false)
      expect(loaded.A?.projectConfigPath).toBe(
        join(dirs.A, '.opencode', 'antigravity.json'),
      )
      expect(getKeepThinking()).toBe(false)
    })
  }

  it("sends a location's config warnings only to that location's logger", () => {
    const good = makeProject('good', { keep_thinking: true })
    const bad = makeProject('bad')
    writeFileSync(join(bad, '.opencode', 'antigravity.json'), '{ not json')
    const warnings: Record<string, string[]> = { good: [], bad: [] }

    createLocationConfig(good, {
      logger: { warn: (message) => warnings.good?.push(message) },
    })
    const badConfig = createLocationConfig(bad, {
      logger: { warn: (message) => warnings.bad?.push(message) },
    })

    expect(warnings.good).toEqual([])
    expect(warnings.bad).toEqual(['Invalid JSON in config file'])
    expect(badConfig.keepThinking).toBe(DEFAULT_CONFIG.keep_thinking)
  })
})

// =============================================================================
// Logger, debug and dump
// =============================================================================

describe('location diagnostics', () => {
  it('keeps independent location logger levels, sinks and debug_tui policies', () => {
    const records: Record<'A' | 'B', LocationLogRecord[]> = { A: [], B: [] }
    const debugA = debugFor({ debug_tui: true })
    const debugB = debugFor({ debug_tui: true })
    const loggerA = createLocationLogger({
      sink: (record) => records.A.push(record),
      sinkEnabled: debugA.isDebugTuiEnabled,
      level: 'warn',
    })
    const loggerB = createLocationLogger({
      sink: (record) => records.B.push(record),
      sinkEnabled: debugB.isDebugTuiEnabled,
    })

    // Interleaved calls: each location's level gates only its own records.
    loggerA.createLogger('request').info('a-info')
    loggerB.createLogger('request').info('b-info')
    loggerA.createLogger('request').warn('a-warn')
    loggerB.setLevel('error')
    loggerA.setLevel('debug')
    loggerB.createLogger('request').warn('b-warn-filtered')
    loggerA.createLogger('request').debug('a-debug')

    expect(records.A.map((record) => record.message)).toEqual([
      'a-warn',
      'a-debug',
    ])
    expect(records.B.map((record) => record.message)).toEqual(['b-info'])
    expect(records.A[0]?.service).toBe('antigravity.request')
  })

  it("gates a location's sink by its own debug_tui policy only", () => {
    const records: Record<'A' | 'B', string[]> = { A: [], B: [] }
    const debugA = debugFor({ debug_tui: true })
    const debugB = debugFor({ debug_tui: false })
    createLocationLogger({
      sink: (record) => records.A.push(record.message),
      sinkEnabled: debugA.isDebugTuiEnabled,
    })
      .createLogger('x')
      .info('to-a')
    createLocationLogger({
      sink: (record) => records.B.push(record.message),
      sinkEnabled: debugB.isDebugTuiEnabled,
    })
      .createLogger('x')
      .info('to-b')

    expect(records).toEqual({ A: ['to-a'], B: [] })
  })

  it('keeps the embedded scrubber and provider key policy for location records', () => {
    const records: LocationLogRecord[] = []
    createLocationLogger({
      sink: (record) => records.push(record),
      sinkEnabled: () => true,
    })
      .createLogger('token')
      .warn('refresh failed', {
        refreshToken: 'fake-refresh-token-value',
        projectId: 'fake-project-id-value',
        status: 400,
      })

    const serialized = JSON.stringify(records)
    expect(records).toHaveLength(1)
    expect(records[0]?.extra?.status).toBe(400)
    expect(serialized).not.toContain('fake-refresh-token-value')
    expect(serialized).not.toContain('fake-project-id-value')
  })

  it('never installs the core log sink and routes core records to one location', () => {
    const sentinel: string[] = []
    setLogSink((record) => sentinel.push(record.message))
    cleanups.push(() => setLogSink(null))
    const records: Record<'A' | 'B', string[]> = { A: [], B: [] }

    const loggerA = createLocationLogger({
      sink: (record) => records.A.push(record.message),
      sinkEnabled: () => true,
    })
    createLocationLogger({
      sink: (record) => records.B.push(record.message),
      sinkEnabled: () => true,
    })

    createCoreLogger('rotation').warn('core-record')
    loggerA.coreLogSink({
      service: 'antigravity.account-manager',
      level: 'warn',
      message: 'injected-core-record',
    })

    expect(sentinel).toEqual(['core-record'])
    expect(records).toEqual({ A: ['injected-core-record'], B: [] })
  })

  it('writes debug lines only to the owning location file and closes independently', async () => {
    const sharedDir = join(root, 'logs')
    const debugA = debugFor({ debug: true, log_dir: sharedDir })
    const debugB = debugFor({ debug: true, log_dir: sharedDir })
    const debugC = debugFor({ debug: false })

    expect(debugA.getLogFilePath()).toBeDefined()
    expect(debugB.getLogFilePath()).toBeDefined()
    expect(debugA.getLogFilePath()).not.toBe(debugB.getLogFilePath())
    expect(debugC.isDebugEnabled()).toBe(false)
    expect(isDebugEnabled()).toBe(false)

    debugA.debugLogToFile('line-from-a')
    debugC.debugLogToFile('line-from-c')
    const contextB = debugB.startAntigravityDebugRequest({
      originalUrl: 'https://example.invalid/v1',
      resolvedUrl: 'https://example.invalid/v1',
      body: JSON.stringify({ projectId: 'fake-project-1234567890' }),
      streaming: false,
    })
    expect(contextB?.id).toBe('ANTIGRAVITY-1')

    await debugA.close()
    // A's close leaves B writing.
    debugB.debugLogToFile('line-from-b-after-a-closed')
    debugA.debugLogToFile('dropped-after-close')
    await debugB.close()

    const fileA = readFileSync(debugA.getLogFilePath()!, 'utf8')
    const fileB = readFileSync(debugB.getLogFilePath()!, 'utf8')
    expect(fileA).toContain('line-from-a')
    expect(fileA).not.toContain('line-from-b')
    expect(fileA).not.toContain('dropped-after-close')
    expect(fileB).toContain('line-from-b-after-a-closed')
    expect(fileB).not.toContain('line-from-a')
    expect(fileB).not.toContain('fake-project-1234567890')
    expect(`${fileA}${fileB}`).not.toContain('line-from-c')
  })

  it('keeps gemini dump switches per location with collision-free file ids', () => {
    const dumpDir = join(root, 'dumps')
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = dumpDir
    const dumpA = createGeminiDumpState({ enabled: true })
    const dumpB = createGeminiDumpState()
    const dumpC = createGeminiDumpState({ enabled: true })
    const request = {
      originalUrl: 'https://example.invalid/v1',
      resolvedUrl: 'https://example.invalid/v1',
      body: '{"model":"gemini-3-pro"}',
      streaming: true,
    }

    expect(dumpB.isEnabled()).toBe(false)
    expect(dumpB.dumpRequest(request)).toBeNull()
    const contextA = dumpA.dumpRequest(request)
    const contextC = dumpC.dumpRequest(request)
    dumpA.setEnabled(false)

    expect(contextA).not.toBeNull()
    expect(contextC).not.toBeNull()
    expect(contextA?.id).not.toBe(contextC?.id)
    expect(dumpC.isEnabled()).toBe(true)
    expect(isGeminiDumpEnabled()).toBe(false)
    expect(dumpA.buildStatusSummary()).toContain('Enabled: disabled')
    expect(dumpC.buildStatusSummary()).toContain('Enabled: enabled')
    expect(
      readdirSync(dumpDir).filter((f) => f.endsWith('.meta.json')),
    ).toHaveLength(2)
  })
})

// =============================================================================
// Operator settings
// =============================================================================

describe('location operator settings', () => {
  let registry: OperatorSettingsRegistry
  let userPath: string

  beforeEach(() => {
    registry = createOperatorSettingsRegistry()
    userPath = join(root, 'user', 'antigravity.json')
    mkdirSync(join(root, 'user'), { recursive: true })
  })

  const acquire = (projectDir: string): LocationOperatorSettings => {
    const settings = acquireLocationOperatorSettings({
      projectConfigPath: join(projectDir, '.opencode', 'antigravity.json'),
      userConfigPath: userPath,
      registry,
    })
    cleanups.push(() => settings.dispose())
    return settings
  }

  for (const order of [
    ['A', 'B'],
    ['B', 'A'],
  ] as const) {
    it(`writes only each location's own file with distinct settings files (${order.join('→')})`, async () => {
      writeFileSync(
        userPath,
        JSON.stringify({ operator: { log_level: 'info' }, quiet: true }),
      )
      const userBytes = readFileSync(userPath, 'utf8')
      const dirs = {
        A: makeProject('a', { operator: { log_level: 'debug' }, debug: true }),
        B: makeProject('b', { operator: { log_level: 'warn' } }),
      }
      const settings = Object.fromEntries(
        order.map((name) => [name, acquire(dirs[name])]),
      ) as Record<'A' | 'B', LocationOperatorSettings>

      await settings.A.update((draft) => {
        draft.routing.cli_first = true
      })
      await settings.B.update((draft) => {
        draft.log_level = 'error'
      })

      const fileA = readJson(join(dirs.A, '.opencode', 'antigravity.json'))
      const fileB = readJson(join(dirs.B, '.opencode', 'antigravity.json'))
      expect(fileA.debug).toBe(true)
      expect(fileA.operator).toMatchObject({
        log_level: 'debug',
        routing: { cli_first: true },
      })
      expect(fileB.operator).toMatchObject({
        log_level: 'error',
        routing: { cli_first: false },
      })
      expect(settings.A.get().log_level).toBe('debug')
      expect(settings.B.get().routing.cli_first).toBe(false)
      expect(readFileSync(userPath, 'utf8')).toBe(userBytes)
    })
  }

  it("shares one user-file controller: A's routing reaches B, B's logging keeps it, C's block is unaffected", async () => {
    const settingsA = acquire(makeProject('a'))
    const settingsB = acquire(makeProject('b'))
    const dirC = makeProject('c', { operator: { log_level: 'warn' } })
    const settingsC = acquire(dirC)
    expect(settingsB.get().routing.cli_first).toBe(false)

    await settingsA.update((draft) => {
      draft.routing.cli_first = true
    })
    expect(settingsB.get().routing.cli_first).toBe(true)

    await settingsB.update((draft) => {
      draft.log_level = 'error'
    })
    expect(readJson(userPath).operator).toMatchObject({
      log_level: 'error',
      routing: { cli_first: true },
    })
    expect(settingsC.get().log_level).toBe('warn')
    expect(settingsC.get().routing.cli_first).toBe(false)
    expect(
      readJson(join(dirC, '.opencode', 'antigravity.json')).operator,
    ).toEqual({ log_level: 'warn' })
  })

  it('seeds a block-less project from effective values on first mutation and rebinds', async () => {
    const dirA = makeProject('a', { debug: true })
    const settingsA = acquire(dirA)
    const settingsB = acquire(makeProject('b'))
    const projectPathA = join(dirA, '.opencode', 'antigravity.json')

    await settingsB.update((draft) => {
      draft.routing.cli_first = true
    })
    expect(settingsA.get().routing.cli_first).toBe(true)
    expect(settingsA.sourcePath()).toBe(settingsB.sourcePath())
    const userBytes = readFileSync(userPath, 'utf8')

    await settingsA.update((draft) => {
      draft.log_level = 'error'
    })
    expect(readJson(projectPathA)).toMatchObject({
      debug: true,
      operator: { log_level: 'error', routing: { cli_first: true } },
    })
    expect(readFileSync(userPath, 'utf8')).toBe(userBytes)
    expect(settingsB.get().log_level).toBe('info')
    expect(settingsA.sourcePath()).not.toBe(settingsB.sourcePath())

    await settingsB.update((draft) => {
      draft.routing.quota_style_fallback = true
    })
    expect(settingsA.get().routing.quota_style_fallback).toBe(false)
    expect(settingsB.get().routing.quota_style_fallback).toBe(true)
  })

  it('serializes concurrent updates to one file without losing either', async () => {
    const settingsA = acquire(makeProject('a'))
    const settingsB = acquire(makeProject('b'))

    await Promise.all([
      settingsA.update((draft) => {
        draft.routing.cli_first = true
      }),
      settingsB.update((draft) => {
        draft.routing.quota_style_fallback = true
      }),
    ])

    expect(readJson(userPath).operator).toMatchObject({
      routing: { cli_first: true, quota_style_fallback: true },
    })
  })

  it('keys controllers by canonical path and drops them at the last release', async () => {
    const realDir = makeProject('real')
    const linkDir = join(root, 'link')
    symlinkSync(realDir, linkDir)
    const viaReal = acquireLocationOperatorSettings({
      projectConfigPath: join(realDir, '.opencode', 'antigravity.json'),
      userConfigPath: userPath,
      registry,
    })
    const viaLink = acquireLocationOperatorSettings({
      projectConfigPath: join(
        linkDir,
        '.opencode',
        '..',
        '.opencode',
        'antigravity.json',
      ),
      userConfigPath: join(root, 'user', '.', 'antigravity.json'),
      registry,
    })

    expect(registry.livePaths()).toHaveLength(2)
    await viaReal.dispose()
    expect(registry.livePaths()).toHaveLength(2)
    await viaLink.dispose()
    await viaLink.dispose()
    expect(registry.livePaths()).toEqual([])
    await expect(
      viaReal.update((draft) => {
        draft.log_level = 'error'
      }),
    ).rejects.toThrow('disposed')
    expect(existsSync(userPath)).toBe(false)
  })
})

// =============================================================================
// Signature cache
// =============================================================================

describe('process-shared signature cache', () => {
  let clock: number
  const now = () => clock

  beforeEach(() => {
    clock = T0
  })

  const newState = (): SignatureProcessState =>
    createSignatureProcessState({ now })

  const acquire = (
    state: SignatureProcessState,
    options: { keepThinking: boolean; cache?: SignatureCacheConfig },
    cacheFilePath = join(root, 'signature-cache.json'),
  ): LocationSignatureCache => {
    const handle = state.acquireLocation({
      keepThinking: options.keepThinking,
      signatureCache: options.cache,
      cacheFilePath,
    })
    cleanups.push(() => handle.dispose())
    return handle
  }

  const diskEntries = (
    path = join(root, 'signature-cache.json'),
  ): Record<string, { value: string; timestamp: number }> =>
    (readJson(path).entries ?? {}) as Record<
      string,
      { value: string; timestamp: number }
    >

  it('keep_thinking=false still looks up, extracts and writes hot signatures', async () => {
    const state = newState()
    const disabled = acquire(state, { keepThinking: false, cache: LONG_CACHE })

    expect(disabled.keepThinking).toBe(false)
    expect(disabled.diskCache).toBeNull()

    // Extraction from a stream feeds both this location's SignatureStore
    // (current-session replay) and the thought-text hash lookup.
    const event = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: 'fake reasoning',
                  thoughtSignature: 'sig-x',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    }
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        )
        controller.close()
      },
    })
    const reader = source
      .pipeThrough(
        createStreamingTransformer(
          disabled.signatureStore,
          { onCacheSignature: disabled.cacheSignature },
          { signatureSessionKey: 'session-x', cacheSignatures: true },
        ),
      )
      .getReader()
    while (!(await reader.read()).done) {
      // drain
    }

    expect(disabled.signatureStore.get('session-x')).toEqual({
      text: 'fake reasoning',
      signature: 'sig-x',
    })
    expect(state.hasHotEntry('session-x', 'fake reasoning')).toBe(true)
    expect(disabled.getCachedSignature('session-x', 'fake reasoning')).toBe(
      'sig-x',
    )
    expect(
      disabled.getCachedSignature('session-x', 'other text'),
    ).toBeUndefined()
  })

  for (const order of ['enabled-first', 'disabled-first'] as const) {
    it(`keeps enabled A disk writes and disabled B hot writes (${order})`, () => {
      const state = newState()
      const handles: Record<'A' | 'B', LocationSignatureCache> = {} as never
      const acquireA = () => {
        handles.A = acquire(state, { keepThinking: true, cache: LONG_CACHE })
      }
      const acquireB = () => {
        handles.B = acquire(state, { keepThinking: false, cache: LONG_CACHE })
      }
      if (order === 'enabled-first') {
        acquireA()
        acquireB()
      } else {
        acquireB()
        acquireA()
      }

      handles.A.cacheSignature('session-a', 'thought a', 'sig-a')
      handles.B.cacheSignature('session-b', 'thought b', 'sig-b')

      expect(handles.A.diskCache).not.toBeNull()
      expect(handles.B.diskCache).toBeNull()
      expect(handles.A.diskCache?.getStats().memoryEntries).toBe(1)
      expect(state.hasHotEntry('session-b', 'thought b')).toBe(true)
      // Hot entries are process-shared by session id.
      expect(handles.A.getCachedSignature('session-b', 'thought b')).toBe(
        'sig-b',
      )
    })
  }

  it('lets a hot hit outlive a shorter inner memory TTL under the fixed hour', () => {
    const state = newState()
    const shortOwner = acquire(state, {
      keepThinking: true,
      cache: SHORT_CACHE,
    })
    shortOwner.cacheSignature('session-h', 'hot thought', 'sig-h')

    clock = T0 + 30 * 60 * 1000
    expect(shortOwner.getCachedSignature('session-h', 'hot thought')).toBe(
      'sig-h',
    )

    // Without the hot entry the same lookup goes to the inner cache, whose
    // 60 s TTL rejects the 30-minute-old entry.
    state.clearHot('session-h')
    expect(
      shortOwner.getCachedSignature('session-h', 'hot thought'),
    ).toBeUndefined()
  })

  it('applies the hot gate at exactly one hour', () => {
    const state = newState()
    const memoryOnly = acquire(state, { keepThinking: true })
    memoryOnly.cacheSignature('session-e', 'edge thought', 'sig-e')
    memoryOnly.cacheSignature('session-e', 'past edge', 'sig-p')

    clock = T0 + HOUR_MS
    expect(memoryOnly.getCachedSignature('session-e', 'edge thought')).toBe(
      'sig-e',
    )
    clock = T0 + HOUR_MS + 1
    expect(
      memoryOnly.getCachedSignature('session-e', 'past edge'),
    ).toBeUndefined()
  })

  it("applies each caller's inner TTL to cold entries at the boundary", async () => {
    const warm = newState()
    const writer = acquire(warm, { keepThinking: true, cache: SHORT_CACHE })
    writer.cacheSignature('session-c', 'at boundary', 'sig-at')
    writer.cacheSignature('session-c', 'past boundary', 'sig-past')
    await writer.dispose()

    const cold = newState()
    const reader = acquire(cold, { keepThinking: true, cache: SHORT_CACHE })
    clock = T0 + 60_000
    expect(cold.hasHotEntry('session-c', 'at boundary')).toBe(false)
    expect(reader.getCachedSignature('session-c', 'at boundary')).toBe('sig-at')
    clock = T0 + 60_001
    expect(cold.hasHotEntry('session-c', 'past boundary')).toBe(false)
    expect(
      reader.getCachedSignature('session-c', 'past boundary'),
    ).toBeUndefined()
  })

  it('rejects a cold aged entry for a short-TTL caller while a longer-TTL caller still reads it', async () => {
    const warm = newState()
    const writer = acquire(warm, { keepThinking: true, cache: LONG_CACHE })
    writer.cacheSignature('session-s', 'aged thought', 'sig-aged')
    await writer.dispose()

    const cold = newState()
    const shortOwner = acquire(cold, { keepThinking: true, cache: SHORT_CACHE })
    const longOwner = acquire(cold, { keepThinking: true, cache: LONG_CACHE })
    clock = T0 + 30 * 60 * 1000

    // Prerequisite: a cold lookup, with no hot entry to answer it.
    expect(cold.hasHotEntry('session-s', 'aged thought')).toBe(false)
    expect(
      shortOwner.getCachedSignature('session-s', 'aged thought'),
    ).toBeUndefined()
    expect(cold.hasHotEntry('session-s', 'aged thought')).toBe(false)
    expect(longOwner.getCachedSignature('session-s', 'aged thought')).toBe(
      'sig-aged',
    )
  })

  it('preserves a longer-TTL entry through short-owner flush, pruning and a later join', async () => {
    const path = join(root, 'signature-cache.json')
    const warm = newState()
    const writer = acquire(warm, { keepThinking: true, cache: LONG_CACHE })
    writer.cacheSignature('session-p', 'kept thought', 'sig-kept')
    await writer.dispose()
    const [key] = Object.keys(diskEntries(path))
    expect(key).toBeDefined()

    // The short owner joins first, so the shared instance starts from its
    // configuration; the 90-minute-old entry is past its 1-hour disk TTL
    // but within the long owner's 2-hour memory and 48-hour disk TTLs.
    clock = T0 + 90 * 60 * 1000
    const cold = newState()
    const shortOwner = acquire(cold, { keepThinking: true, cache: SHORT_CACHE })
    const shared = shortOwner.diskCache!
    expect(shared.getTimestamp(key!)).toBeUndefined()

    const longOwner = acquire(cold, { keepThinking: true, cache: LONG_CACHE })
    expect(shared.getTimestamp(key!)).toBe(T0)

    shortOwner.cacheSignature('session-p', 'fresh thought', 'sig-fresh')
    shared.pruneExpired()
    await shared.flush()
    expect(diskEntries(path)[key!]).toEqual({
      value: 'sig-kept',
      timestamp: T0,
    })
    expect(shared.getTimestamp(key!)).toBe(T0)

    const laterOwner = acquire(cold, { keepThinking: true, cache: LONG_CACHE })
    expect(laterOwner.diskCache).toBe(shared)
    expect(shared.getTimestamp(key!)).toBe(T0)
    expect(cold.hasHotEntry('session-p', 'kept thought')).toBe(false)
    expect(longOwner.getCachedSignature('session-p', 'kept thought')).toBe(
      'sig-kept',
    )
  })

  it('keeps the shared disk cache while another enabled owner holds it and shuts down at the last one', async () => {
    const path = join(root, 'signature-cache.json')
    const state = newState()
    const ownerA = acquire(state, { keepThinking: true, cache: LONG_CACHE })
    // A location whose disk cache is disabled owns no persistence.
    const memoryOnly = acquire(state, {
      keepThinking: true,
      cache: { ...LONG_CACHE, enabled: false },
    })
    const ownerC = acquire(state, { keepThinking: true, cache: LONG_CACHE })
    const shared = ownerA.diskCache
    expect(ownerC.diskCache).toBe(shared)
    expect(memoryOnly.diskCache).toBeNull()

    memoryOnly.cacheSignature('session-m', 'memory thought', 'sig-m')
    memoryOnly.signatureStore.set('session-m', {
      text: 'memory thought',
      signature: 'sig-m',
    })
    ownerA.cacheSignature('session-a', 'a thought', 'sig-a')

    await ownerA.dispose()
    await ownerA.dispose()
    expect(state.diskCacheFor(path)).toBe(shared)
    expect(ownerA.getCachedSignature('session-a', 'a thought')).toBeUndefined()
    ownerA.cacheSignature('session-a', 'after dispose', 'sig-late')
    expect(state.hasHotEntry('session-a', 'after dispose')).toBe(false)

    ownerC.cacheSignature('session-c', 'c thought', 'sig-c')
    expect(shared?.getStats().memoryEntries).toBe(2)

    await ownerC.dispose()
    expect(state.diskCacheFor(path)).toBeNull()
    expect(
      Object.values(diskEntries(path))
        .map((entry) => entry.value)
        .sort(),
    ).toEqual(['sig-a', 'sig-c'])

    // The surviving memory-only location keeps its hot entries and store.
    expect(memoryOnly.getCachedSignature('session-m', 'memory thought')).toBe(
      'sig-m',
    )
    expect(memoryOnly.getCachedSignature('session-c', 'c thought')).toBe(
      'sig-c',
    )
    expect(memoryOnly.signatureStore.get('session-m')?.signature).toBe('sig-m')
  })

  it('starts a fresh shared instance from the flushed file after the last owner left', async () => {
    const state = newState()
    const first = acquire(state, { keepThinking: true, cache: LONG_CACHE })
    first.cacheSignature('session-r', 'reload thought', 'sig-r')
    const firstShared = first.diskCache
    await first.dispose()

    state.clearHot()
    const second = acquire(state, { keepThinking: true, cache: LONG_CACHE })
    expect(second.diskCache).not.toBe(firstShared)
    expect(second.getCachedSignature('session-r', 'reload thought')).toBe(
      'sig-r',
    )
  })
})
