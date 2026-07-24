// Host-aware loader for the Antigravity TUI.
//
// Production OpenTUI hosts compile plugin source through
// `@opentui/solid/scripts/solid-transform` and resolve module imports
// through a virtual runtime module identifier:
//
//   opentui:runtime-module:<encodeURIComponent('@opentui/solid')>
//
// When the host has installed that virtual resolver, importing via it gives
// back the transformed runtime that the host's precompiler emitted; otherwise
// Bun resolves `@opentui/solid` to the node-exported JS and the host's
// pre-built `../tui-compiled/tui.tsx` file (which already references those
// virtual modules in its import graph) lines up correctly.
//
// Two import paths are tried, in order:
//
//   1. `../tui-compiled/tui.tsx` — the precompiled, virtual-runtime-aware
//      bundle. Resolved successfully by hosts that ship a runtime module
//      resolver + the precompiled tree.
//   2. `../tui.tsx` — the dev fallback. Local development with raw TSX
//      runs through `@opentui/solid/preload`, which installs the Solid
//      transform plugin so the same `/** @jsxImportSource @opentui/solid */`
//      pragma is honoured on the fly.
//
// Errors raised while probing for the runtime module that indicate "module
// not found" are swallowed and the compiled tree is attempted next. Any
// other error (syntax error, runtime error in the compiled file, etc.) is
// re-thrown — those are real bugs, not configuration mismatches.

import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RUNTIME_MODULE_ID = `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`
const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const COMPILED_ENTRY = pathToFileURL(
  resolve(ENTRY_DIR, '../tui-compiled/tui.tsx'),
).href
const RAW_ENTRY = pathToFileURL(resolve(ENTRY_DIR, '../tui.tsx')).href

function isMissingModuleError(error) {
  if (!error) return false
  const code =
    typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
    return true
  const message = typeof error.message === 'string' ? error.message : ''
  return /cannot find module|module not found|ENOENT/i.test(message)
}

async function probeVirtualRuntime() {
  try {
    await import(RUNTIME_MODULE_ID)
    return true
  } catch (error) {
    if (isMissingModuleError(error)) return false
    throw error
  }
}

async function importWithFallback() {
  const compiledAvailable = await probeVirtualRuntime()
  if (compiledAvailable) {
    return import(COMPILED_ENTRY)
  }
  return import(RAW_ENTRY)
}

const mod = await importWithFallback()

// Pass the wrapped plugin shape through unchanged. `tui.tsx` exports the
// fleet-shape `{ id, tui }` wrapper as its default export; this file just
// selects between the precompiled and the dev-TSX entry, it does not
// re-wrap.
export default mod?.default ?? mod?.tui ?? mod
