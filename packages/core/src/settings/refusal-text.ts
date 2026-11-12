import { dirname } from 'node:path'

import type { SettingsRefusalCode } from '../common-auth-embedded/settings/index.js'

/**
 * Fixed menu text for a settings write the library refused. Every host shows
 * the same words; the text names the file but never carries the error.
 */
export function settingsRefusalText(
  code: SettingsRefusalCode,
  file: string,
): string {
  switch (code) {
    case 'settings-unparseable':
      return `The settings file couldn't be read, so nothing was changed. Fix or remove ${file}.`
    case 'settings-newer-version':
      return `The settings file is from a newer version of antigravity-auth, so nothing was changed. Update antigravity-auth or edit ${file} by hand.`
    case 'settings-invalid-value':
      return `That value can't be saved in the settings file, so nothing was changed. Check ${file}.`
    case 'settings-busy':
      return 'The settings file is being changed by another process, so nothing was changed. Try again.'
    case 'settings-unavailable':
      return `The settings file can't be written, so nothing was changed. Check that ${dirname(file)} is writable.`
  }
}
