import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { Host } from '@opencode-ai/plugin/host'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
describe('OpenCode 2 package manifest', () => {
  it('resolves a local checkout without an npm package name', () => {
    const entrypoints = Host.resolve({ directory: packageRoot })
    expect(entrypoints.server).toBe(
      new URL('../server.js', import.meta.url).href,
    )
  })

  it('resolves the built server entry through the real host resolver', () => {
    const entrypoints = Host.resolve({
      directory: packageRoot,
      name: '@cortexkit/opencode-v2-antigravity-auth',
    })

    expect(entrypoints.server).toBe(
      new URL('../dist/plugin.js', import.meta.url).href,
    )
    expect(fileURLToPath(entrypoints.server!)).toStartWith(packageRoot)
    expect(entrypoints.tui).toBe(
      new URL('../dist/tui.js', import.meta.url).href,
    )
    expect(entrypoints.rpc).toBe(
      new URL('../dist/rpc.js', import.meta.url).href,
    )
  })
})
