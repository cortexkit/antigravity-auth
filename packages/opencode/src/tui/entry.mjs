// Public loadTui detects the virtual host runtime and propagates unrelated import errors.
// Generated selectors are inert inspection copies, not executed loaders; call only the canonical loader.
import { loadTui } from '../common-auth-embedded/tui/index.js'

export default await loadTui({
  rawEntry: new URL('../tui-raw/tui.tsx', import.meta.url).href,
  runtimeEntry: new URL('../tui-compiled/tui.js', import.meta.url).href,
})
