/**
 * The package's `./server` entry, loaded by both OpenCode host lines.
 *
 * - OpenCode 1 (1.17.13 and later 1.x) prefers a package's `./server` export
 *   over `main`. Its loader reads the default export as a plugin object and,
 *   because the object has a `server` function, runs that function as the
 *   plugin. It does not go on to call the named exports, so the named
 *   `createGaAntigravityPlugin` below is never loaded as a second plugin.
 * - OpenCode 2 (2.0.22 and later) resolves `./server` through its host
 *   resolver and accepts a default export with a string `id` and a `setup`
 *   function. The additional `server` field is ignored there.
 *
 * Both hosts therefore get one plugin from the same default export. Importing
 * this module starts nothing: the OpenCode 1 plugin runs only when the host
 * calls `server`, and OpenCode 2 resources are acquired only in `setup`.
 *
 * The package root (`.`, `main`) remains the plain OpenCode 1 plugin.
 */

import type { Plugin as GaPlugin } from '@opencode/plugin'
import { createGaAntigravityPlugin } from './ga/server/index.ts'
import { AntigravityCLIOAuthPlugin } from './plugin/index.ts'
import type { PluginInput, PluginResult } from './plugin/types.ts'

export type {
  GaPluginOverrides,
  ObserveRawSenderSignal,
} from './ga/server/index.ts'
export { createGaAntigravityPlugin }

/** The default export: an OpenCode 2 plugin that also carries the OpenCode 1 plugin. */
export interface HybridServerPlugin extends GaPlugin.Plugin {
  readonly server: (input: PluginInput) => Promise<PluginResult>
}

const ga = createGaAntigravityPlugin()

const plugin: HybridServerPlugin = {
  id: ga.id,
  setup: ga.setup,
  server: AntigravityCLIOAuthPlugin,
}

export default plugin
