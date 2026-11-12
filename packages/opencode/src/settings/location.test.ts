import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettingsLocation } from './location.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'settings-location-'))
  roots.push(root)
  return root
}

describe('settings locations', () => {
  const cases: {
    name: string
    env: Record<string, string>
    separate: boolean
    xdg?: boolean
  }[] = [
    { name: 'default XDG folder', env: {}, separate: false },
    {
      name: 'same XDG config spelling',
      env: { OPENCODE_CONFIG_DIR: '$xdg/opencode' },
      separate: false,
    },
    {
      name: 'normalized XDG spelling',
      env: { OPENCODE_CONFIG_DIR: '$xdg/./opencode' },
      separate: false,
    },
    {
      name: 'different config folder',
      env: { OPENCODE_CONFIG_DIR: '$root/custom' },
      separate: true,
    },
    { name: 'unset XDG default', env: {}, separate: false, xdg: false },
    {
      name: 'same home config folder',
      env: { OPENCODE_CONFIG_DIR: '$home/.config/opencode' },
      separate: false,
      xdg: false,
    },
    {
      name: 'different home config folder',
      env: { OPENCODE_CONFIG_DIR: '$root/custom' },
      separate: true,
      xdg: false,
    },
    {
      name: 'vault override',
      env: { OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: 'relative-vault' },
      separate: true,
    },
    {
      name: 'empty vault override',
      env: { OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: '' },
      separate: false,
    },
    {
      name: 'shared TUI override',
      env: { OPENCODE_TUI_PREFERENCES_FILE: '$root/tui.jsonc' },
      separate: false,
    },
    {
      name: 'absolute opt-in overrides config isolation',
      env: {
        OPENCODE_CONFIG_DIR: '$root/custom',
        OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: '$root/settings.jsonc',
      },
      separate: false,
    },
    {
      name: 'absolute opt-in overrides vault isolation',
      env: {
        OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: 'vault',
        OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: '$root/settings.jsonc',
      },
      separate: false,
    },
    {
      name: 'relative settings override is not opt-in',
      env: {
        OPENCODE_CONFIG_DIR: '$root/custom',
        OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: 'settings.jsonc',
      },
      separate: true,
    },
    {
      name: 'empty settings override is not opt-in',
      env: {
        OPENCODE_CONFIG_DIR: '$root/custom',
        OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: '',
      },
      separate: true,
    },
    {
      name: 'relative settings override uses shared path',
      env: { OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: 'settings.jsonc' },
      separate: false,
    },
  ]
  for (const row of cases) {
    it(row.name, async () => {
      const root = await fixture()
      const home = join(root, 'home')
      const xdg = join(root, 'config')
      const env = Object.fromEntries(
        Object.entries(row.env).map(([key, value]) => [
          key,
          value
            .replaceAll('$root', root)
            .replaceAll('$home', home)
            .replaceAll('$xdg', xdg),
        ]),
      )
      const location = await resolveSettingsLocation({
        host: 'opencode',
        project: join(root, 'project'),
        homedir: home,
        platform: 'linux',
        env: {
          HOME: home,
          ...(row.xdg === false ? {} : { XDG_CONFIG_HOME: xdg }),
          ...env,
        },
      })
      expect(location.separateInstall).toBe(row.separate)
      expect(location.file).toBe(
        env.OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE?.startsWith('/')
          ? env.OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE
          : join(
              row.xdg === false ? join(home, '.config') : xdg,
              'cortexkit',
              'antigravity-auth.jsonc',
            ),
      )
      expect(location.projectFile).toBe(
        join(root, 'project', '.cortexkit', 'antigravity-auth.jsonc'),
      )
    })
  }

  it('compares existing config folders by identity through symlinks in either direction', async () => {
    const root = await fixture()
    const home = join(root, 'home')
    const xdg = join(root, 'config')
    const folder = join(xdg, 'opencode')
    await mkdir(folder, { recursive: true })
    const alias = join(root, 'alias')
    await symlink(folder, alias, 'dir')
    const inputs = {
      host: 'opencode' as const,
      project: root,
      homedir: home,
      platform: process.platform,
    }
    expect(
      (
        await resolveSettingsLocation({
          ...inputs,
          env: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: alias },
        })
      ).separateInstall,
    ).toBe(false)
    const aliasXdg = join(root, 'alias-xdg')
    await symlink(xdg, aliasXdg, 'dir')
    expect(
      (
        await resolveSettingsLocation({
          ...inputs,
          env: { XDG_CONFIG_HOME: aliasXdg, OPENCODE_CONFIG_DIR: folder },
        })
      ).separateInstall,
    ).toBe(false)
    const other = join(root, 'other')
    await mkdir(other)
    const otherAlias = join(root, 'other-alias')
    await symlink(other, otherAlias, 'dir')
    expect(
      (
        await resolveSettingsLocation({
          ...inputs,
          env: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: otherAlias },
        })
      ).separateInstall,
    ).toBe(true)
  })

  it('keeps Pi shared, using its start folder and only the new project path', async () => {
    const root = await fixture()
    for (const override of [
      undefined,
      '',
      'relative.jsonc',
      join(root, 'explicit.jsonc'),
    ]) {
      const location = await resolveSettingsLocation({
        host: 'pi',
        startDirectory: join(root, 'start'),
        homedir: root,
        platform: 'linux',
        env: {
          XDG_CONFIG_HOME: root,
          OPENCODE_CONFIG_DIR: join(root, 'custom'),
          OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: 'vault',
          PI_AGENT_DIR: 'agent',
          PI_ANTIGRAVITY_AUTH_FILE: 'auth',
          OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: override,
        },
      })
      expect(location.separateInstall).toBe(false)
      expect(location.project).toBe(join(root, 'start'))
      expect(location.projectFile).toBe(
        join(root, 'start', '.cortexkit', 'antigravity-auth.jsonc'),
      )
      expect(location.file).toBe(
        override?.startsWith('/')
          ? override
          : join(root, 'cortexkit', 'antigravity-auth.jsonc'),
      )
      expect(location).not.toHaveProperty('legacyProject')
    }
  })

  it('honors Windows absolute overrides and shared config rules', async () => {
    const location = await resolveSettingsLocation({
      host: 'pi',
      startDirectory: 'C:\\project',
      homedir: 'C:\\home',
      platform: 'win32',
      env: { APPDATA: 'C:\\roaming' },
    })
    expect(location.file).toBe('C:\\roaming\\cortexkit\\antigravity-auth.jsonc')
    expect(location.projectFile).toBe(
      'C:\\project\\.cortexkit\\antigravity-auth.jsonc',
    )
    for (const override of [
      'C:\\settings.jsonc',
      '\\\\server\\share\\settings.jsonc',
    ]) {
      expect(
        (
          await resolveSettingsLocation({
            host: 'opencode',
            project: 'C:\\project',
            homedir: 'C:\\home',
            platform: 'win32',
            env: {
              OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE: override,
              OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR: 'vault',
            },
          })
        ).file,
      ).toBe(override)
    }
  })
})
