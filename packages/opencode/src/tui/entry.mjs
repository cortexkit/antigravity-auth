// The package's `./tui` entry for both hosts: `{ id, tui, setup }`.
// OpenCode 1 calls `tui(api, options, meta)`; OpenCode 2 (GA) calls
// `setup(context)`. Importing this module loads neither UI: each arm loads
// its own compiled root on first call, so the OpenCode 1 renderer never
// starts inside GA and the GA one never starts inside OpenCode 1.
// The public loadTui picks the compiled root when the host registers its
// runtime modules and the raw source otherwise (development only), and
// propagates every unrelated import error, so a missing installed root
// fails with ERR_MODULE_NOT_FOUND instead of falling back.
import { loadTui } from '../common-auth-embedded/tui/index.js'

const ID = 'cortexkit.antigravity-auth'

let v1Root
let gaRoot

function loadV1() {
  v1Root ??= loadTui({
    rawEntry: new URL('../tui-raw/tui.tsx', import.meta.url).href,
    runtimeEntry: new URL('../tui-compiled/tui.js', import.meta.url).href,
  })
  return v1Root
}

// The plugin version for the OpenCode 2 sidebar header, passed to the GA
// setup. The GA root may use no Node built-in (the TUI build refuses one),
// so it cannot read package.json; this entry can. Read lazily on setup, so
// importing the entry stays inert, and never fatal: without a version the
// header just leaves it out.
async function packageVersion() {
  try {
    const manifest = await import('../../package.json', {
      with: { type: 'json' },
    })
    const version = manifest.default?.version
    return typeof version === 'string' ? version : ''
  } catch {
    return ''
  }
}

function loadGa() {
  gaRoot ??= loadTui({
    rawEntry: new URL('../tui-ga-raw/host-ga.tsx', import.meta.url).href,
    runtimeEntry: new URL('../tui-ga-compiled/host-ga.js', import.meta.url)
      .href,
  })
  return gaRoot
}

export default {
  id: ID,
  async tui(api, options, meta) {
    return (await loadV1()).tui(api, options, meta)
  },
  async setup(context) {
    const [root, version] = await Promise.all([loadGa(), packageVersion()])
    return root.setup(context, { version })
  },
}
