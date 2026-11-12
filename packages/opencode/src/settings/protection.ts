/**
 * OpenCode's never-widen state for protection settings. The rules live in
 * core (`@cortexkit/antigravity-auth-core/settings`) so Pi applies the same
 * ones; this module only places OpenCode's state file in its state home.
 */

import { join } from 'node:path'

import { pluginStateDir } from '../runtime-paths'
import {
  createProtectionStore as createCoreProtectionStore,
  PROTECTION_STATE_FILE_NAME,
  type ProtectionStore,
} from './core-settings'

export {
  type AppliedProtection,
  type Floors,
  PROTECTION_STATE_FILE_NAME,
  type ProtectionInputs,
  type ProtectionSource,
  type ProtectionStore,
  type ResolvedProtection,
  resolveProtection,
  unusableAt,
} from './core-settings'

export function defaultProtectionStatePath(): string {
  return join(pluginStateDir(), PROTECTION_STATE_FILE_NAME)
}

/** An owner-only JSON file in the plugin's state folder. */
export function createProtectionStore(
  path = defaultProtectionStatePath(),
): ProtectionStore {
  return createCoreProtectionStore(path)
}
