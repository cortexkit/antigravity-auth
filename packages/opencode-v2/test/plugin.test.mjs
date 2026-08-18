// Smoke test for the OpenCode 2.x host adapter: the plugin module must load
// (which imports the shared core) and expose the documented plugin contract.
import { describe, expect, test } from 'bun:test'

describe('opencode-v2-antigravity-auth plugin entry', () => {
  test('exports the plugin contract shape', async () => {
    // Dynamic import: the plugin module starts with a top-level `await import`
    // of the shared core, which does not mix well with a static import binding
    // under the test runner.
    const { default: plugin } = await import('../src/plugin.mjs')
    expect(plugin).toBeTypeOf('object')
    expect(plugin.id).toBe('local.antigravity')
    expect(plugin.setup).toBeTypeOf('function')
  })
})
