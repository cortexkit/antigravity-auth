import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityMenuRefusal } from '@cortexkit/antigravity-auth-core'
import { withLock } from '@cortexkit/antigravity-auth-core/common-auth/fs'
import {
  type openSettings,
  openSettings as realOpenSettings,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'

import { getProjectConfigPath, loadConfig } from '../plugin/config/loader'
import { accountKeyForRefreshToken } from '../plugin/killswitch'
import { createOperatorSettingsController } from '../plugin/operator-settings'
import { floorKeyTableFromRows } from './legacy'
import { createProtectionStore } from './protection'
import {
  type AntigravitySettingsRuntime,
  createSettingsRuntime,
  type SettingsRuntimeOptions,
} from './runtime'

const roots: string[] = []
const runtimes: AntigravitySettingsRuntime[] = []
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const silent = { warn() {}, info() {} }

interface Fixture {
  readonly root: string
  readonly file: string
  readonly legacyUserFile: string
  readonly project: string
  readonly statePath: string
  runtime(options?: Partial<SettingsRuntimeOptions>): AntigravitySettingsRuntime
  open(
    runtime: AntigravitySettingsRuntime,
  ): ReturnType<AntigravitySettingsRuntime['openProject']>
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'settings-runtime-'))
  roots.push(root)
  const configDir = join(root, 'opencode')
  const project = join(root, 'project')
  await mkdir(configDir, { recursive: true })
  await mkdir(project, { recursive: true })
  // The old loader finds the user antigravity.json through this folder.
  process.env.OPENCODE_CONFIG_DIR = configDir
  const file = join(root, 'cortexkit', 'antigravity-auth.jsonc')
  const legacyUserFile = join(configDir, 'antigravity.json')
  const statePath = join(root, 'state', 'settings-protection.json')
  return {
    root,
    file,
    legacyUserFile,
    project,
    statePath,
    runtime(options = {}) {
      const runtime = createSettingsRuntime({
        file,
        separateInstall: false,
        legacyUserFile,
        log: silent,
        fence: async () => true,
        protection: createProtectionStore(statePath),
        moveReportPath: join(root, 'state', 'settings-move-report.json'),
        retryDelaysMs: [60_000],
        ...options,
      })
      runtimes.push(runtime)
      return runtime
    },
    open(runtime) {
      return runtime.openProject(project, {
        config: () => loadConfig(project),
        operator: () =>
          createOperatorSettingsController({
            projectConfigPath: getProjectConfigPath(project),
            userConfigPath: legacyUserFile,
          }),
      })
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function moved(runtime: AntigravitySettingsRuntime): Promise<void> {
  runtime.startMove()
  await runtime.settled()
}

describe('settings before and after the one-time move', () => {
  it('applies each old value the same way before and after the move', async () => {
    const f = await fixture()
    const legacy = `${JSON.stringify({
      quiet_mode: true,
      account_selection_strategy: 'sticky',
      max_account_switches: 3,
      signature_cache: { enabled: false },
      soft_quota_cache_ttl_minutes: 15,
      operator: {
        log_level: 'debug',
        killswitch: { enabled: true, minimum_remaining_percent: 12 },
      },
    })}\n`
    await writeFile(f.legacyUserFile, legacy)
    const runtime = f.runtime()
    const settings = await f.open(runtime)
    const expectations = (label: string) => {
      expect([label, settings.config.quiet_mode]).toEqual([label, true])
      expect(settings.config.account_selection_strategy).toBe('sticky')
      expect(settings.config.max_account_switches).toBe(3)
      expect(settings.config.soft_quota_cache_ttl_minutes).toBe(15)
      expect(settings.config.signature_cache?.enabled).toBe(false)
      // Values the old file never wrote stay at their defaults.
      expect(settings.config.scheduling_mode).toBe('cache_first')
      expect(settings.operator.get().log_level).toBe('debug')
      expect(settings.operator.get().killswitch).toMatchObject({
        enabled: true,
        minimum_remaining_percent: 12,
      })
    }
    expect(settings.mode()).toBe('legacy')
    expectations('before')
    await moved(runtime)
    expect(settings.mode()).toBe('shared')
    expectations('after')
    expect(settings.operator.floorKeying()).toBe('stable')
    expect(settings.configuredIn()).toBe('antigravity-auth.jsonc')
    // The source stays byte-identical and gets a note naming the target.
    expect(await readFile(f.legacyUserFile, 'utf8')).toBe(legacy)
    expect(
      await readFile(`${f.legacyUserFile}.MOVED_READPLEASE`, 'utf8'),
    ).toContain(f.file)
  })

  it('keeps the operator block when the old loader rejected the top level', async () => {
    const f = await fixture()
    await writeFile(
      f.legacyUserFile,
      JSON.stringify({
        quiet_mode: true,
        max_account_switches: 9999,
        operator: { log_level: 'warn' },
      }),
    )
    const runtime = f.runtime()
    const settings = await f.open(runtime)
    expect(settings.config.quiet_mode).toBe(false)
    expect(settings.operator.get().log_level).toBe('warn')
    await moved(runtime)
    expect(settings.mode()).toBe('shared')
    expect(settings.config.quiet_mode).toBe(false)
    expect(settings.config.max_account_switches).toBe(10)
    expect(settings.operator.get().log_level).toBe('warn')
    const lines = await settings.diagnosticsNotices()
    expect(lines).toContain(
      'quiet_mode was not moved: antigravity.json failed validation, so it was not in effect.',
    )
  })

  it('re-keys floors by row id and reports the ones it cannot place', async () => {
    const f = await fixture()
    const keyA = accountKeyForRefreshToken('token-a')
    const keyGone = accountKeyForRefreshToken('token-gone')
    await writeFile(
      f.legacyUserFile,
      JSON.stringify({
        operator: {
          killswitch: { accounts: { [keyA]: 40, [keyGone]: 20, 'idx-3': 9 } },
        },
      }),
    )
    // The rows are read once, before the move; the mapping runs under the
    // operator lock and must never reach the account store.
    let armed = false
    const repository = {
      read() {
        if (armed) throw new Error('the move mapping read the account store')
        return [
          { ref: { id: 'row-a' }, credential: { refreshToken: 'token-a' } },
        ]
      },
    }
    const runtime = f.runtime({
      floorKeys: async () => {
        const table = floorKeyTableFromRows(repository.read())
        armed = true
        return table
      },
    })
    const settings = await f.open(runtime)
    await moved(runtime)
    expect(settings.mode()).toBe('shared')
    expect(settings.operator.get().killswitch.accounts).toEqual({ 'row-a': 40 })
    expect(settings.limitsNotices()).toEqual([
      'An account limit was set for an account that is no longer in your store; it was not moved.',
      'An account limit set by roster position (idx-3) was not moved; set it again from Limits.',
    ])
    const target = await readFile(f.file, 'utf8')
    expect(target).not.toContain(keyA)
    expect(target).not.toContain(keyGone)
  })

  it('keeps the old files while the version fence is closed', async () => {
    const f = await fixture()
    await writeFile(f.legacyUserFile, JSON.stringify({ quiet_mode: true }))
    const runtime = f.runtime({ fence: async () => false })
    const settings = await f.open(runtime)
    await moved(runtime)
    expect(settings.mode()).toBe('legacy')
    expect(await exists(f.file)).toBe(false)
    expect(settings.config.quiet_mode).toBe(true)
    expect(settings.operator.floorKeying()).toBe('refresh-token-hash')
    expect(await settings.diagnosticsNotices()).toEqual([
      `Settings are still read from antigravity.json: an older antigravity-auth is still running. Restart OpenCode after updating to finish the move. They move to ${f.file}.`,
    ])
  })

  it('keeps the old files when the move is busy or fails', async () => {
    for (const outcome of ['busy', 'failed'] as const) {
      const f = await fixture()
      await writeFile(f.legacyUserFile, JSON.stringify({ quiet_mode: true }))
      const runtime = f.runtime({
        move: async () => {
          if (outcome === 'failed') throw new Error('synthetic move failure')
          return {
            outcome,
            unmapped: [],
            differing: [],
            noteFailures: [],
            postPublishFailures: [],
          }
        },
      })
      const settings = await f.open(runtime)
      await moved(runtime)
      expect([outcome, settings.mode()]).toEqual([outcome, 'legacy'])
      expect(settings.config.quiet_mode).toBe(true)
      expect(await exists(f.file)).toBe(false)
    }
  })

  it('waits for an operator writer holding the old file lock', async () => {
    const f = await fixture()
    await writeFile(f.legacyUserFile, JSON.stringify({ quiet_mode: true }))
    const runtime = f.runtime()
    const settings = await f.open(runtime)
    let releasedAt = 0
    let held!: () => void
    const holding = new Promise<void>((resolve) => {
      held = resolve
    })
    const writer = withLock(
      f.legacyUserFile,
      { name: 'antigravity-operator', ttlMs: 5_000, timeoutMs: 5_000 },
      async () => {
        held()
        await new Promise((resolve) => setTimeout(resolve, 400))
        // The writer's change lands before the move reads the file.
        await writeFile(
          f.legacyUserFile,
          JSON.stringify({ quiet_mode: true, debug: true }),
        )
        releasedAt = Date.now()
      },
    )
    await holding
    await moved(runtime)
    await writer
    expect(settings.mode()).toBe('shared')
    expect((await stat(f.file)).mtimeMs).toBeGreaterThanOrEqual(releasedAt - 5)
    expect(await readFile(f.file, 'utf8')).toContain('"debug": true')
  })

  it('reads a target that already exists and names the settings left behind', async () => {
    const f = await fixture()
    await writeFile(
      f.legacyUserFile,
      JSON.stringify({ quiet_mode: true, operator: { log_level: 'debug' } }),
    )
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1, "debug_tui": true }\n')
    const runtime = f.runtime()
    const settings = await f.open(runtime)
    expect(settings.mode()).toBe('shared')
    expect(settings.config.quiet_mode).toBe(false)
    expect(settings.config.debug_tui).toBe(true)
    expect(await settings.diagnosticsNotices()).toContain(
      `${f.legacyUserFile} was not moved, because ${f.file} already existed. These settings are only in the old file and are not in effect: quiet_mode, log_level.`,
    )
    // Nothing is copied automatically.
    expect(await readFile(f.file, 'utf8')).not.toContain('quiet_mode')
  })

  it('names no settings left behind once a note names the target', async () => {
    const f = await fixture()
    await writeFile(f.legacyUserFile, JSON.stringify({ quiet_mode: true }))
    await writeFile(
      `${f.legacyUserFile}.MOVED_READPLEASE`,
      `Settings moved to ${f.file}.\n`,
    )
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1 }\n')
    const settings = await f.open(f.runtime())
    const lines = await settings.diagnosticsNotices()
    expect(lines.some((line) => line.includes('was not moved, because'))).toBe(
      false,
    )
  })

  it('never opens the shared file for a separate install', async () => {
    const f = await fixture()
    await writeFile(f.legacyUserFile, JSON.stringify({ quiet_mode: true }))
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1, "quiet_mode": false }\n')
    const runtime = f.runtime({
      separateInstall: true,
      open: (() => {
        throw new Error('a separate install opened the shared file')
      }) as typeof openSettings,
    })
    const settings = await f.open(runtime)
    await moved(runtime)
    await settings.refresh()
    expect(settings.mode()).toBe('legacy')
    expect(settings.config.quiet_mode).toBe(true)
    expect(settings.configuredIn()).toBe('antigravity.json')
    expect(await settings.diagnosticsNotices()).toEqual([])
    await settings.operator.update((draft) => {
      draft.log_level = 'trace'
    })
    expect(
      JSON.parse(await readFile(f.legacyUserFile, 'utf8')).operator.log_level,
    ).toBe('trace')
  })
})

describe('project settings', () => {
  it('applies allowed keys from an old project file and names the user-only ones', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1 }\n')
    await mkdir(join(f.project, '.opencode'))
    await writeFile(
      getProjectConfigPath(f.project),
      JSON.stringify({
        quiet_mode: true,
        background_quota_refresh: false,
        tool_id_recovery: false,
        operator: { killswitch: { enabled: true } },
      }),
    )
    const settings = await f.open(f.runtime())
    expect(settings.config.quiet_mode).toBe(true)
    expect(settings.config.background_quota_refresh).toBe(true)
    expect(settings.operator.get().killswitch.enabled).toBe(false)
    const lines = await settings.diagnosticsNotices()
    expect(lines).toContain(
      'The project file .opencode/antigravity.json sets background_quota_refresh, which only the user settings file can set; it is ignored.',
    )
    expect(lines).toContain(
      'The project file .opencode/antigravity.json sets killswitch, which only the user settings file can set; it is ignored.',
    )
    expect(lines).toContain(
      'The project file .opencode/antigravity.json sets tool_id_recovery, which is retired; it is ignored.',
    )
  })
})

describe('menu writes', () => {
  it('writes the user file and keeps its comments', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(
      f.file,
      '// mine\n{\n  "schema_version": 1,\n  // keep me\n  "quiet_mode": true\n}\n',
    )
    const settings = await f.open(f.runtime())
    await settings.operator.update((draft) => {
      draft.killswitch.enabled = true
      draft.killswitch.minimum_remaining_percent = 30
      draft.killswitch.accounts = { 'row-a': 50 }
      draft.log_level = 'debug'
    })
    const text = await readFile(f.file, 'utf8')
    expect(text).toContain('// mine')
    expect(text).toContain('// keep me')
    expect(settings.operator.get()).toEqual({
      killswitch: {
        enabled: true,
        minimum_remaining_percent: 30,
        accounts: { 'row-a': 50 },
      },
      log_level: 'debug',
    })
    await settings.operator.update((draft) => {
      draft.killswitch.accounts = {}
    })
    expect(settings.operator.get().killswitch.accounts).toEqual({})
    expect(await readFile(f.file, 'utf8')).not.toContain('row-a')
  })

  it('refuses a write to an unparseable file with fixed text', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1, ')
    const settings = await f.open(f.runtime())
    let refusal: unknown
    try {
      await settings.operator.update((draft) => {
        draft.log_level = 'trace'
      })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(AntigravityMenuRefusal)
    expect((refusal as AntigravityMenuRefusal).code).toBe(
      'settings-unparseable',
    )
    expect((refusal as AntigravityMenuRefusal).text).toBe(
      `The settings file couldn't be read, so nothing was changed. Fix or remove ${f.file}.`,
    )
    expect(await readFile(f.file, 'utf8')).toBe('{ "schema_version": 1, ')
  })
})

describe('reads off the request path', () => {
  it('serves configuration, operator values and model access without reading files', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(
      f.file,
      '{ "schema_version": 1, "quiet_mode": true, "account_models": { "row-a": ["gemini-4-carbon"] } }\n',
    )
    const calls = { read: 0, get: 0 }
    const counting = ((definition, options) => {
      const handle = realOpenSettings(definition, options)
      return {
        ...handle,
        read: (...args: Parameters<typeof handle.read>) => {
          calls.read++
          return handle.read(...args)
        },
        get: ((...args: Parameters<typeof handle.get>) => {
          calls.get++
          return handle.get(...args)
        }) as typeof handle.get,
        report: () => handle.report(),
        update: (...args: Parameters<typeof handle.update>) =>
          handle.update(...args),
        watch: (listener: () => void) => handle.watch(listener),
      }
    }) as typeof openSettings
    const settings = await f.open(f.runtime({ open: counting }))
    const before = { ...calls }
    expect(before.get).toBeGreaterThan(0)
    for (let i = 0; i < 100; i++) {
      expect(settings.config.quiet_mode).toBe(true)
      expect(settings.operator.get().log_level).toBe('info')
      expect(settings.operator.floorKeying()).toBe('stable')
      expect(
        settings.modelAccess().allows('row-a', 'gemini-4-carbon-high'),
      ).toBe(true)
    }
    expect(calls).toEqual(before)
  })
})

describe('watcher refresh', () => {
  it('applies a changed file to the live configuration and operator values', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, '{ "schema_version": 1, "quiet_mode": false }\n')
    const settings = await f.open(f.runtime())
    let changes = 0
    settings.onChange(() => changes++)
    await writeFile(
      f.file,
      '{ "schema_version": 1, "quiet_mode": true, "log_level": "warn" }\n',
    )
    const deadline = Date.now() + 10_000
    while (settings.config.quiet_mode !== true && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settings.config.quiet_mode).toBe(true)
    expect(settings.operator.get().log_level).toBe('warn')
    expect(changes).toBeGreaterThan(0)
  })
})

describe('protection settings never widen', () => {
  const unusable =
    '{ "schema_version": 1, "account_models": { "row-a": "gemini-4-carbon" }, "killswitch": { "accounts": { "row-a": "high" } } }\n'

  it('takes the most restrictive reading at start with nothing persisted', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(f.file, unusable)
    const settings = await f.open(f.runtime())
    expect(settings.modelAccess().allows('row-a', 'gemini-4-carbon')).toBe(
      false,
    )
    expect(settings.modelAccess().allows('row-b', 'gemini-3.8-flash')).toBe(
      false,
    )
    expect(settings.operator.get().killswitch.accounts).toEqual({})
    const lines = await settings.diagnosticsNotices()
    expect(lines).toContain(
      "account_models in antigravity-auth.jsonc can't be used and no earlier value is known, so no account serves until it is fixed.",
    )
    expect(lines).toContain(
      "The per-account quota floors in antigravity-auth.jsonc can't be used; every account uses the global floor until they are fixed.",
    )
  })

  it('uses the persisted last applied values at start', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(
      f.file,
      '{ "schema_version": 1, "account_models": { "row-a": ["gemini-4-carbon"] }, "killswitch": { "accounts": { "row-a": 40 } } }\n',
    )
    const first = await f.open(f.runtime())
    expect(first.modelAccess().allows('row-a', 'gemini-4-carbon')).toBe(true)
    await first.release()
    await runtimes.pop()?.dispose()
    // Persisted runtime state is owner-only.
    expect((await stat(f.statePath)).mode & 0o777).toBe(0o600)

    await writeFile(f.file, unusable)
    const settings = await f.open(f.runtime())
    const access = settings.modelAccess()
    expect(access.allows('row-a', 'gemini-4-carbon')).toBe(true)
    expect(access.allows('row-a', 'gemini-3.8-flash')).toBe(false)
    expect(access.allows('row-b', 'gemini-3.8-flash')).toBe(true)
    expect(settings.operator.get().killswitch.accounts).toEqual({ 'row-a': 40 })
    expect(await settings.diagnosticsNotices()).toContain(
      "account_models in antigravity-auth.jsonc can't be used; the last applied value stays in force until it is fixed.",
    )
  })

  it('keeps the last applied values while running', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(
      f.file,
      '{ "schema_version": 1, "account_models": { "row-a": ["gemini-4-carbon"] }, "killswitch": { "accounts": { "row-a": 40 } } }\n',
    )
    const settings = await f.open(f.runtime())
    await writeFile(f.file, unusable)
    await settings.refresh()
    expect(settings.modelAccess().allows('row-a', 'gemini-3.8-flash')).toBe(
      false,
    )
    expect(settings.modelAccess().allows('row-a', 'gemini-4-carbon')).toBe(true)
    expect(settings.operator.get().killswitch.accounts).toEqual({ 'row-a': 40 })
  })

  it('treats an empty model list as unusable, never as unrestricted', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'cortexkit'))
    await writeFile(
      f.file,
      '{ "schema_version": 1, "account_models": { "row-a": [] } }\n',
    )
    const settings = await f.open(f.runtime())
    expect(settings.modelAccess().allows('row-a', 'gemini-4-carbon')).toBe(
      false,
    )
  })
})
