/**
 * The one place OpenCode code imports core's settings declaration, its
 * model-access policy and the never-widen protection rules, so their import
 * specifier changes in one line.
 */
export {
  type AccountModels,
  ANTIGRAVITY_SETTINGS,
  type AppliedProtection,
  canonicalModelId,
  compileModelAccess,
  createProtectionStore,
  type Floors,
  knownModelIds,
  type ModelAccessIssue,
  type ModelAccessPolicy,
  normalizeAccountModelList,
  PROTECTION_STATE_FILE_NAME,
  type ProtectionInputs,
  type ProtectionSource,
  type ProtectionStore,
  RETIRED_SETTINGS,
  type ResolvedProtection,
  resolveProtection,
  settingsRefusalText,
  unusableAt,
} from '@cortexkit/antigravity-auth-core/settings'
