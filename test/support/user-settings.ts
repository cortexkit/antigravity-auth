/**
 * Tests that configure the plugin write its user settings file,
 * `antigravity-auth.jsonc`, before the plugin starts. The file then exists
 * at start, so the plugin reads it from the first request and never
 * switches files mid-test. User-only settings (anything that sends
 * traffic, chooses accounts or protects quota) are ignored in a project
 * file, so they belong here.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** The user settings file the plugin reads under this environment (POSIX). */
export function userSettingsFile(env: Env = process.env): string {
  const override = env.OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE
  if (override && isAbsolute(override)) return override
  const xdg = env.XDG_CONFIG_HOME
  const base =
    xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), '.config')
  return join(base, 'cortexkit', 'antigravity-auth.jsonc')
}

/**
 * Replace the user settings file with these settings, by their names in
 * `antigravity-auth.jsonc`, and return its path.
 */
export function writeUserSettings(
  settings: Readonly<Record<string, unknown>>,
  options: { readonly env?: Env; readonly file?: string } = {},
): string {
  const file = options.file ?? userSettingsFile(options.env)
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(
    file,
    `${JSON.stringify({ schema_version: 1, ...settings }, null, 2)}\n`,
  )
  return file
}
