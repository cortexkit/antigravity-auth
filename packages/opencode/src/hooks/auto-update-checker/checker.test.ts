import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `findPluginEntry` looks for `opencode.json` under `<project>/.opencode/`.
function writeProjectConfig(projectDir: string, name: string, content: string) {
  const opencodeDir = join(projectDir, '.opencode')
  fs.mkdirSync(opencodeDir, { recursive: true })
  fs.writeFileSync(join(opencodeDir, name), content)
}

describe('isLocalDevMode / getLocalDevPath', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'checker-test-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('returns false when no config files exist', async () => {
    const { isLocalDevMode } = await import('./checker')
    expect(isLocalDevMode(projectDir)).toBe(false)
  })

  it('returns null from getLocalDevPath when no config exists', async () => {
    const { getLocalDevPath } = await import('./checker')
    expect(getLocalDevPath(projectDir)).toBeNull()
  })

  it('returns null when config has no matching file:// plugin entry', async () => {
    const { getLocalDevPath } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.json',
      JSON.stringify({ plugin: ['some-other-plugin@1.0.0'] }),
    )
    expect(getLocalDevPath(projectDir)).toBeNull()
  })

  it('returns path when config contains a file:// entry for the package', async () => {
    const { getLocalDevPath } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.json',
      JSON.stringify({
        plugin: [
          'file:///home/user/@cortexkit/opencode-antigravity-auth/dist/plugin.js',
        ],
      }),
    )
    const result = getLocalDevPath(projectDir)
    expect(result).toContain('@cortexkit/opencode-antigravity-auth')
  })

  it('handles JSONC config with comments and trailing commas', async () => {
    const { getLocalDevPath } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.jsonc',
      `{
        // dev plugin
        "plugin": [
          "file:///home/user/@cortexkit/opencode-antigravity-auth/dist/plugin.js",
        ]
      }`,
    )
    const result = getLocalDevPath(projectDir)
    expect(result).toContain('@cortexkit/opencode-antigravity-auth')
  })

  it('returns null and does not throw when config file is malformed JSON', async () => {
    const { getLocalDevPath } = await import('./checker')
    writeProjectConfig(projectDir, 'opencode.json', '{ not valid json !!!}')
    expect(() => getLocalDevPath(projectDir)).not.toThrow()
    expect(getLocalDevPath(projectDir)).toBeNull()
  })
})

describe('findPluginEntry', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'checker-test-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('returns null when no config files exist', async () => {
    const { findPluginEntry } = await import('./checker')
    expect(findPluginEntry(projectDir)).toBeNull()
  })

  it('returns entry with isPinned=false for bare package name', async () => {
    const { findPluginEntry } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.json',
      JSON.stringify({ plugin: ['@cortexkit/opencode-antigravity-auth'] }),
    )
    const result = findPluginEntry(projectDir)
    expect(result).not.toBeNull()
    expect(result!.isPinned).toBe(false)
    expect(result!.pinnedVersion).toBeNull()
  })

  it('returns entry with isPinned=true for versioned package', async () => {
    const { findPluginEntry } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.json',
      JSON.stringify({
        plugin: ['@cortexkit/opencode-antigravity-auth@1.5.0'],
      }),
    )
    const result = findPluginEntry(projectDir)
    expect(result).not.toBeNull()
    expect(result!.isPinned).toBe(true)
    expect(result!.pinnedVersion).toBe('1.5.0')
  })

  it('returns isPinned=false for @latest entry', async () => {
    const { findPluginEntry } = await import('./checker')
    writeProjectConfig(
      projectDir,
      'opencode.json',
      JSON.stringify({
        plugin: ['@cortexkit/opencode-antigravity-auth@latest'],
      }),
    )
    const result = findPluginEntry(projectDir)
    expect(result).not.toBeNull()
    expect(result!.isPinned).toBe(false)
    expect(result!.pinnedVersion).toBeNull()
  })
})
