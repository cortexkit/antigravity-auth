import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeOperatorConfig } from './writer'

interface Fixture {
  dir: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agy-config-writer-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('writeOperatorConfig', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('writes atomically with fenced lock to the project file when it exists', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(projectPath, JSON.stringify({ debug: true }))

    await writeOperatorConfig({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
      operator: {
        routing: { cli_first: true, quota_style_fallback: false },
        killswitch: { enabled: true, minimum_remaining_percent: 10 },
        log_level: 'debug',
      },
    })

    const persisted = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect(persisted.debug).toBe(true)
    expect((persisted.operator as { log_level?: string }).log_level).toBe(
      'debug',
    )
  })

  it('falls back to the user config when no project file exists', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    const userPath = join(fixture.dir, 'user.json')

    await writeOperatorConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
      operator: {
        routing: { cli_first: false, quota_style_fallback: true },
        killswitch: { enabled: false, minimum_remaining_percent: 5 },
        log_level: 'info',
      },
    })

    const persisted = JSON.parse(readFileSync(userPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect((persisted.operator as { log_level?: string }).log_level).toBe(
      'info',
    )
  })

  it('preserves unknown top-level fields and unrelated keys', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(
      projectPath,
      JSON.stringify({
        $schema: 'https://example.com/schema.json',
        debug: false,
        custom_extension: { nested: 'kept' },
      }),
    )

    await writeOperatorConfig({
      projectConfigPath: projectPath,
      userConfigPath: join(fixture.dir, 'user.json'),
      operator: {
        routing: { cli_first: true, quota_style_fallback: false },
        killswitch: { enabled: false, minimum_remaining_percent: 5 },
        log_level: 'trace',
      },
    })

    const persisted = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect(persisted.$schema).toBe('https://example.com/schema.json')
    expect(persisted.debug).toBe(false)
    expect(persisted.custom_extension).toEqual({ nested: 'kept' })
    expect((persisted.operator as { log_level?: string }).log_level).toBe(
      'trace',
    )
  })

  it('rejects invalid log_level values', async () => {
    await expect(
      writeOperatorConfig({
        projectConfigPath: join(fixture.dir, 'antigravity.json'),
        userConfigPath: join(fixture.dir, 'user.json'),
        operator: {
          routing: { cli_first: false, quota_style_fallback: false },
          killswitch: { enabled: false, minimum_remaining_percent: 5 },
          log_level: 'nonsense' as unknown as 'info',
        },
      }),
    ).rejects.toThrow()
  })

  it('rejects killswitch minimum_remaining_percent outside 0-100', async () => {
    await expect(
      writeOperatorConfig({
        projectConfigPath: join(fixture.dir, 'antigravity.json'),
        userConfigPath: join(fixture.dir, 'user.json'),
        operator: {
          routing: { cli_first: false, quota_style_fallback: false },
          killswitch: {
            enabled: false,
            minimum_remaining_percent: 999,
          },
          log_level: 'info',
        },
      }),
    ).rejects.toThrow()
  })

  it('does not leave tmp files behind on failure', async () => {
    const projectPath = join(fixture.dir, 'antigravity.json')
    writeFileSync(projectPath, '{}')

    await expect(
      writeOperatorConfig({
        projectConfigPath: projectPath,
        userConfigPath: join(fixture.dir, 'user.json'),
        operator: {
          routing: { cli_first: false, quota_style_fallback: false },
          killswitch: { enabled: false, minimum_remaining_percent: 5 },
          log_level: 'no-such-level' as unknown as 'info',
        },
      }),
    ).rejects.toThrow()

    const matches = new Bun.Glob(`${projectPath}.*.tmp`).scanSync({
      cwd: fixture.dir,
    })
    expect([...matches]).toEqual([])
  })
})
