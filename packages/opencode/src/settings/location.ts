import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import {
  isAbsoluteForPlatform,
  settingsFilePath,
} from '@cortexkit/antigravity-auth-core/common-auth/settings'

interface PathInputs {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  readonly homedir: string
}

export type SettingsLocationOptions = PathInputs &
  (
    | { readonly host: 'opencode'; readonly project: string }
    | { readonly host: 'pi'; readonly startDirectory: string }
  )

export interface SettingsLocation {
  readonly file: string
  readonly project: string
  readonly projectFile: string
  readonly separateInstall: boolean
}

async function folderIdentity(
  folder: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const paths = platform === 'win32' ? win32 : posix
  // Missing folders have no real identity yet; compare their resolved spelling.
  try {
    return await realpath(folder)
  } catch {
    return paths.resolve(folder)
  }
}

/** Only computes locations; it never opens, creates or moves settings files. */
export async function resolveSettingsLocation(
  options: SettingsLocationOptions,
): Promise<SettingsLocation> {
  const { env, platform, homedir } = options
  const paths = platform === 'win32' ? win32 : posix
  const override = env.OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE
  const file = settingsFilePath({
    plugin: 'antigravity-auth',
    override,
    env,
    platform,
    homedir,
  })
  let separateInstall = false
  if (
    options.host === 'opencode' &&
    !(override && isAbsoluteForPlatform(override, platform))
  ) {
    // The shared TUI preferences override belongs to every plugin, not to this
    // install. Only the vault override and a non-default host folder isolate it.
    separateInstall = Boolean(env.OPENCODE_ANTIGRAVITY_AUTH_VAULT_DIR)
    if (!separateInstall && env.OPENCODE_CONFIG_DIR) {
      const defaultFolder = paths.join(
        env.XDG_CONFIG_HOME || paths.join(homedir, '.config'),
        'opencode',
      )
      separateInstall =
        (await folderIdentity(env.OPENCODE_CONFIG_DIR, platform)) !==
        (await folderIdentity(defaultFolder, platform))
    }
  }
  // Pi never had legacy project settings. Its caller captures the start folder,
  // not a later cwd, and only this new project path will be used by its handle.
  const project =
    options.host === 'pi' ? options.startDirectory : options.project
  return {
    file,
    project,
    projectFile: paths.join(project, '.cortexkit', 'antigravity-auth.jsonc'),
    separateInstall,
  }
}
