import { afterEach, describe, expect, it } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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

    expect(removeDevSymlink(paths)).toBe(true)

    expect(() => lstatSync(paths.pluginPath)).toThrow()
    expect(lstatSync(unrelatedPath).isFile()).toBe(true)

    const foreignTarget = join(root, 'foreign.js')
    writeFileSync(foreignTarget, 'foreign')
    symlinkSync(foreignTarget, paths.pluginPath)
    expect(() => createDevSymlink(paths)).toThrow()
    expect(removeDevSymlink(paths)).toBe(false)
    expect(readlinkSync(paths.pluginPath)).toBe(foreignTarget)
    expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign')
    rmSync(paths.pluginPath)

    mkdirSync(paths.pluginPath)
    const sentinel = join(paths.pluginPath, 'keep.txt')
    writeFileSync(sentinel, 'keep')
    expect(() => createDevSymlink(paths)).toThrow()
    expect(removeDevSymlink(paths)).toBe(false)
    expect(lstatSync(paths.pluginPath).isDirectory()).toBe(true)
    expect(lstatSync(sentinel).isFile()).toBe(true)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
  })
})
