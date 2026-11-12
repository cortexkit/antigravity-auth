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
  type ModelAccessIssue,
  type ModelAccessPolicy,
  PROTECTION_STATE_FILE_NAME,
  type ProtectionInputs,
  type ProtectionSource,
  type ProtectionStore,
  RETIRED_SETTINGS,
  type ResolvedProtection,
  resolveProtection,
  unusableAt,
} from '@cortexkit/antigravity-auth-core/settings'
