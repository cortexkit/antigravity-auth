// Re-export shim: constants moved to @cortexkit/antigravity-auth-core.
export * from '@cortexkit/antigravity-auth-core'

// The single `/antigravity` menu. The values live in the TUI's host-api
// module, which has no runtime imports, so the TUI can read them without
// loading the core barrel above; the server reads the same values here.
export {
  ANTIGRAVITY_MENU_COMMAND,
  ANTIGRAVITY_MENU_TITLE,
  MENU_SECTION_SLOTS,
} from './tui/host-api'
