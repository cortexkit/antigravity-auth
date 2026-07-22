/**
 * TUI-only color helpers.
 *
 * The OpenCode plugin owns a richer `plugin/ui/ansi.ts` for CLI prompts
 * (raw ANSI escape codes), but OpenTUI's `fg` / `bg` props consume either
 * hex strings (`"#22c55e"`) or named colors (`"red"`). Mixing the two
 * breaks the sidebar with `Invalid hex color: <esc>[32m, defaulting to
 * magenta` warnings — and a warning is a console write, which is exactly
 * what the sidebar must NEVER do inside the render path.
 *
 * Keeping these constants local to the TUI makes the boundary explicit and
 * lets us ship exactly the codes the panel uses.
 */

export const ANSI = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  dim: '#6b7280',
  reset: 'default',
} as const
