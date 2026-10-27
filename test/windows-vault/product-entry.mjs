// Expose the production plugin factory and custody manager to the CI bundle;
// only the daemon is a test fixture, not enrollment or request execution.

export { startMenuVaultFixture } from '../../packages/opencode/src/plugin/__fixtures__/vault-menu-daemon.test.ts'
export { createAntigravityPlugin } from '../../packages/opencode/src/plugin/index.ts'
export { createOpenCodeVaultCustody } from '../../packages/opencode/src/plugin/vault-custody.ts'
// The one-time move of the vault files to the state home, for layout-move.mjs.
export { prepareRuntimeLayout } from '../../packages/opencode/src/runtime-layout.ts'
export {
  getVaultDir,
  runtimeLayoutLocation,
} from '../../packages/opencode/src/runtime-paths.ts'
