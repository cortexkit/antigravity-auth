import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOperatorSettingsController,
  type OperatorSettings,
} from './operator-settings'

const REFRESH_TOKEN = 'rt-1234567890'

function hashAccountKey(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 12)
}

interface Fixture {
  dir: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agy-operator-settings-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('createOperatorSettingsController', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('returns schema defaults when no config file exists', async () => {
    const controller = createOperatorSettingsController({
      projectConfigPath: join(fixture.dir, 'antigravity.json'),
      userConfigPath: join(fixture.dir, 'user.json'),
    })

    const settings = controller.get()
    expect(settings).toEqual<OperatorSettings>({
      routing: { cli_first: false, quota_style_fallback: false },
      killswitch: { enabled: false, minimum_remaining_percent: 5 },
      log_level: 'info',
    })
    await controller.dispose()
  })

  it('loads persisted operator settings from the project config file', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(
      projectPath,
      JSON.stringify({
        operator: {
          routing: { cli_first: true, quota_style_fallback: true },
          killswitch: {
            enabled: true,
            minimum_remaining_percent: 17,
            accounts: { [hashAccountKey(REFRESH_TOKEN)]: 42 },
          },
          log_level: 'debug',
        },
      }),
    )

    const controller = createOperatorSettingsController({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
    })

    const settings = controller.get()
    expect(settings.routing.cli_first).toBe(true)
    expect(settings.routing.quota_style_fallback).toBe(true)
    expect(settings.killswitch.enabled).toBe(true)
    expect(settings.killswitch.minimum_remaining_percent).toBe(17)
    expect(settings.killswitch.accounts?.[hashAccountKey(REFRESH_TOKEN)]).toBe(
      42,
    )
    expect(settings.log_level).toBe('debug')
    await controller.dispose()
  })

  it('update mutates runtime settings and persists them through the lock-held writer', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    // Pre-create the project config so the writer targets it (per the
    // contract: project first, user fallback).
    writeFileSync(projectPath, '{}')
    const controller = createOperatorSettingsController({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
    })

    await controller.update((draft) => {
      draft.routing.cli_first = true
      draft.killswitch.enabled = true
      draft.killswitch.minimum_remaining_percent = 25
      draft.log_level = 'warn'
    })

    const afterUpdate = controller.get()
    expect(afterUpdate.routing.cli_first).toBe(true)
    expect(afterUpdate.killswitch.enabled).toBe(true)
    expect(afterUpdate.killswitch.minimum_remaining_percent).toBe(25)
    expect(afterUpdate.log_level).toBe('warn')

    const persisted = JSON.parse(readFileSync(projectPath, 'utf-8')) as {
      operator: OperatorSettings
    }
    expect(persisted.operator.routing.cli_first).toBe(true)
    expect(persisted.operator.killswitch.enabled).toBe(true)
    expect(persisted.operator.killswitch.minimum_remaining_percent).toBe(25)
    expect(persisted.operator.log_level).toBe('warn')
    await controller.dispose()
  })

  it('preserves unknown top-level fields across update', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(
      projectPath,
      JSON.stringify({
        $schema: 'https://example.com/schema.json',
        debug: true,
        unrelated_extension_field: { nested: 'kept' },
      }),
    )

    const controller = createOperatorSettingsController({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
    })

    await controller.update((draft) => {
      draft.log_level = 'trace'
    })

    const persisted = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect(persisted.$schema).toBe('https://example.com/schema.json')
    expect(persisted.debug).toBe(true)
    expect(persisted.unrelated_extension_field).toEqual({ nested: 'kept' })
    await controller.dispose()
  })

  it('falls back to the user config path when no project config exists', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    const userPath = join(fixture.dir, 'user.json')
    writeFileSync(
      userPath,
      JSON.stringify({
        operator: { log_level: 'debug' },
      }),
    )

    const controller = createOperatorSettingsController({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
    })

    expect(controller.get().log_level).toBe('debug')
    await controller.update((draft) => {
      draft.log_level = 'trace'
    })

    expect(existsSync(projectPath)).toBe(false)
    const persisted = JSON.parse(readFileSync(userPath, 'utf-8')) as {
      operator: OperatorSettings
    }
    expect(persisted.operator.log_level).toBe('trace')
    await controller.dispose()
  })

  it('idempotent dispose: a second dispose is a no-op', async () => {
    const controller = createOperatorSettingsController({
      projectConfigPath: join(fixture.dir, 'antigravity.json'),
      userConfigPath: join(fixture.dir, 'user.json'),
    })
    await controller.dispose()
    await expect(controller.dispose()).resolves.toBeUndefined()
  })

  it('account keys are derived from sha256(refreshToken).slice(0,12)', async () => {
    const expected = hashAccountKey(REFRESH_TOKEN)
    expect(expected).toHaveLength(12)

    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(projectPath, '{}')
    const controller = createOperatorSettingsController({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
    })

    await controller.update((draft) => {
      draft.killswitch.accounts = {}
      draft.killswitch.accounts[expected] = 50
    })

    const persisted = JSON.parse(readFileSync(projectPath, 'utf-8')) as {
      operator: OperatorSettings
    }
    expect(persisted.operator.killswitch.accounts).toEqual({
      [expected]: 50,
    })
    expect(
      Object.keys(persisted.operator.killswitch.accounts ?? {})[0],
    ).not.toContain(REFRESH_TOKEN)
    await controller.dispose()
  })
})
