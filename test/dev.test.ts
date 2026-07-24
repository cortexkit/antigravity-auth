import { afterEach, describe, expect, it } from 'bun:test'
import {
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDevSymlink,
  removeDevSymlink,
  resolveDevPaths,
} from '../scripts/dev.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('development plugin symlink', () => {
  it('resolves the plugin path and relative bundle target from a project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'antigravity-dev-'))
    temporaryRoots.push(root)

    const paths = resolveDevPaths(root)

    expect(paths.pluginPath).toBe(
      join(root, '.opencode', 'plugins', 'antigravity-auth.js'),
    )
    expect(paths.targetPath).toBe(
      join(root, 'packages', 'opencode', 'dist', 'index.js'),
    )
    expect(paths.relativeTarget).toBe('../../packages/opencode/dist/index.js')
  })

  it('creates and removes only the known development symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'antigravity-dev-'))
    temporaryRoots.push(root)
    const paths = resolveDevPaths(root)
    const unrelatedPath = join(root, '.opencode', 'plugins', 'keep.txt')

    createDevSymlink(paths)
    writeFileSync(unrelatedPath, 'keep')

    expect(lstatSync(paths.pluginPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(paths.pluginPath)).toBe(paths.relativeTarget)

    removeDevSymlink(paths)

    expect(() => lstatSync(paths.pluginPath)).toThrow()
    expect(lstatSync(unrelatedPath).isFile()).toBe(true)
  })
})
