import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { canonicalizeOwnedPath } from './loader'

describe('canonicalizeOwnedPath', () => {
  let root: string
  const realpathSync = fs.realpathSync
  let realpathSpy:
    | ReturnType<typeof spyOn<typeof fs, 'realpathSync'>>
    | undefined

  beforeEach(() => {
    root = realpathSync(fs.mkdtempSync(join(tmpdir(), 'owned-path-')))
  })

  afterEach(() => {
    realpathSpy?.mockRestore()
    realpathSpy = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  function deletedRealpath(file: string) {
    const replacement = Object.assign(
      (...args: [fs.PathLike, unknown?]) => {
        if (args[0] === file) return `${file} (deleted)`
        return Reflect.apply(realpathSync, fs, args)
      },
      { native: realpathSync.native },
    )
    realpathSpy = spyOn(fs, 'realpathSync').mockImplementation(replacement)
  }

  it('ignores a deleted-inode realpath result during a settings replacement', () => {
    const file = join(root, 'settings.jsonc')
    fs.writeFileSync(file, '{}')
    deletedRealpath(file)

    expect(canonicalizeOwnedPath(file)).toBe(file)
    expect(realpathSpy).not.toHaveBeenCalledWith(file)
  })

  it('shares a symlinked settings file key with its target during replacement', () => {
    const target = join(root, 'settings.jsonc')
    const alias = join(root, 'alias.jsonc')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync('settings.jsonc', alias)
    deletedRealpath(alias)

    expect(canonicalizeOwnedPath(alias)).toBe(canonicalizeOwnedPath(target))
    expect(canonicalizeOwnedPath(alias)).toBe(target)
    expect(realpathSpy).not.toHaveBeenCalledWith(alias)
  })

  it('normalizes relative paths and dot segments through symlinked folders', () => {
    const folder = join(root, 'real')
    const alias = join(root, 'alias')
    fs.mkdirSync(folder)
    fs.symlinkSync(folder, alias, 'dir')
    fs.writeFileSync(join(folder, 'settings.jsonc'), '{}')

    expect(
      canonicalizeOwnedPath(
        `${relative(process.cwd(), alias)}/../alias/settings.jsonc`,
      ),
    ).toBe(join(folder, 'settings.jsonc'))
  })

  it('resolves the nearest existing ancestor for a missing file and folders', () => {
    const alias = join(root, 'alias')
    const folder = join(root, 'real')
    fs.mkdirSync(folder)
    fs.symlinkSync(folder, alias, 'dir')

    expect(canonicalizeOwnedPath(join(alias, 'settings.jsonc'))).toBe(
      join(folder, 'settings.jsonc'),
    )
    expect(
      canonicalizeOwnedPath(join(alias, 'missing', 'settings.jsonc')),
    ).toBe(join(folder, 'missing', 'settings.jsonc'))
  })

  for (const kind of ['dangling link', 'symlink loop'] as const) {
    it(`keeps the lexical file name for a ${kind} without using a deleted-inode path`, () => {
      const folder = join(root, 'real')
      const alias = join(root, 'alias')
      fs.mkdirSync(folder)
      fs.symlinkSync(folder, alias, 'dir')
      const file = join(alias, 'settings.jsonc')
      fs.symlinkSync(
        kind === 'dangling link' ? 'missing.jsonc' : 'settings.jsonc',
        file,
      )
      deletedRealpath(file)

      expect(canonicalizeOwnedPath(file)).toBe(join(folder, 'settings.jsonc'))
      expect(dirname(canonicalizeOwnedPath(file))).toBe(folder)
      expect(realpathSpy).not.toHaveBeenCalledWith(file)
    })
  }
})
