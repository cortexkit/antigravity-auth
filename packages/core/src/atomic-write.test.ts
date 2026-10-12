import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import * as fsp from 'node:fs/promises'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomic-write.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-write-'))
})

afterEach(async () => {
  mock.restore()
  await rm(root, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes pretty-formatted JSON with a trailing newline on POSIX', async () => {
    if (process.platform === 'win32') return

    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { a: 1, b: [2, 3] })

    const content = await readFile(target, 'utf8')
    expect(content).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n')
  })

  it('uses mode 0600 on POSIX', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { value: 'hello' })

    if (process.platform === 'win32') {
      // Windows ignores POSIX mode bits; rely on inherited ACL + readback.
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
        value: 'hello',
      })
      return
    }

    const stats = await stat(target)
    expect((stats.mode & 0o777).toString(8)).toBe('600')
  })

  it('creates parent directories recursively when the target dir does not exist', async () => {
    const target = join(root, 'nested', 'deeper', 'state.json')
    await writeJsonAtomic(target, { nested: true })

    const content = JSON.parse(await readFile(target, 'utf8'))
    expect(content).toEqual({ nested: true })
  })

  it('temp file lives in the same directory as the target and is cleaned up after rename', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { v: 1 })

    const entries = await readdir(root)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
    expect(entries).toContain('state.json')
  })

  it('atomically replaces existing target contents on a second write', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { v: 1 })
    const first = JSON.parse(await readFile(target, 'utf8'))
    expect(first).toEqual({ v: 1 })

    await writeJsonAtomic(target, { v: 2, extra: 'now' })
    const second = JSON.parse(await readFile(target, 'utf8'))
    expect(second).toEqual({ v: 2, extra: 'now' })

    const entries = await readdir(root)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('cleans up the temp file when rename fails and does not fall back to copyFile', async () => {
    // Place a directory at the target path so the rename onto `target` fails
    // with EISDIR on POSIX (and equivalent failure on Windows).
    const target = join(root, 'state.json')
    await mkdir(target, { recursive: true })

    const renameSpy = spyOn(fsp, 'rename').mockImplementation(async () => {
      const err = new Error('forced rename failure') as NodeJS.ErrnoException
      err.code = 'EISDIR'
      throw err
    })
    const copyFileSpy = spyOn(fsp, 'copyFile').mockImplementation(async () => {
      throw new Error('copyFile must NOT be called when rename fails')
    })

    try {
      await expect(writeJsonAtomic(target, { updated: true })).rejects.toThrow(
        'forced rename failure',
      )
      expect(renameSpy).toHaveBeenCalled()
      expect(copyFileSpy).not.toHaveBeenCalled()
      const entries = await readdir(root)
      expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
      // The directory placeholder is still there untouched.
      const targetStat = await stat(target)
      expect(targetStat.isDirectory()).toBe(true)
    } finally {
      renameSpy.mockRestore()
      copyFileSpy.mockRestore()
    }
  })

  it('preserves the prior target contents on a failed rename', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { original: 'yes' })

    const renameSpy = spyOn(fsp, 'rename').mockImplementation(async () => {
      const err = new Error('forced rename failure') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    })
    const copyFileSpy = spyOn(fsp, 'copyFile').mockImplementation(async () => {
      throw new Error('copyFile must NOT be called when rename fails')
    })

    try {
      await expect(writeJsonAtomic(target, { updated: true })).rejects.toThrow()
      const content = JSON.parse(await readFile(target, 'utf8'))
      expect(content).toEqual({ original: 'yes' })
      expect(copyFileSpy).not.toHaveBeenCalled()
    } finally {
      renameSpy.mockRestore()
      copyFileSpy.mockRestore()
    }
  })

  it('cleans up the staged temp file when writeFile fails after a partial write', async () => {
    const target = join(root, 'state.json')

    const writeSpy = spyOn(fsp, 'writeFile').mockImplementation(
      async (filePath) => {
        // First, write the temp path's inode so the partial-write state
        // mirrors a real driver crash: file exists on disk but is incomplete,
        // and the surrounding try/catch is still inside `writeFile`.
        const { writeFileSync } = await import('node:fs')
        writeFileSync(filePath as string, '{"partial":')
        const err = new Error(
          'forced partial-write failure',
        ) as NodeJS.ErrnoException
        err.code = 'EIO'
        throw err
      },
    )
    const renameSpy = spyOn(fsp, 'rename').mockImplementation(async () => {
      throw new Error('rename must NOT be called after writeFile failure')
    })

    try {
      await expect(writeJsonAtomic(target, { value: 1 })).rejects.toThrow(
        'forced partial-write failure',
      )
      expect(writeSpy).toHaveBeenCalled()
      expect(renameSpy).not.toHaveBeenCalled()
      // The partial temp file must be removed in the finally block.
      const entries = await readdir(root)
      expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
    } finally {
      writeSpy.mockRestore()
      renameSpy.mockRestore()
    }
  })

  it('on Windows, atomically replaces the target and reads back cleanly (inherited ACL)', async () => {
    if (process.platform !== 'win32') return

    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { win: true, n: 42 })

    const back = JSON.parse(await readFile(target, 'utf8'))
    expect(back).toEqual({ win: true, n: 42 })

    const entries = await readdir(root)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('serializes deeply nested objects with stable formatting', async () => {
    const target = join(root, 'state.json')
    const payload = {
      top: 1,
      list: [
        { id: 'a', meta: { score: 0.5 } },
        { id: 'b', meta: null },
      ],
      n: null,
    }
    await writeJsonAtomic(target, payload)
    const text = await readFile(target, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(payload)
  })
})

describe('writeJsonAtomic beforeRename guard', () => {
  it('runs the guard after the temp file is fully staged and before the target is replaced', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { original: true })
    const originalBytes = await readFile(target, 'utf8')

    const seen: Array<{
      tempPath: string
      tempContent: string
      targetContent: string
    }> = []
    await writeJsonAtomic(
      target,
      { next: 1 },
      {
        beforeRename: async (tempPath) => {
          seen.push({
            tempPath,
            tempContent: await readFile(tempPath, 'utf8'),
            targetContent: await readFile(target, 'utf8'),
          })
        },
      },
    )

    expect(seen).toHaveLength(1)
    const [call] = seen
    // The staged file sits next to the target and already holds the exact
    // serialized payload; the target has not been touched yet.
    expect(call?.tempPath.startsWith(`${target}.`)).toBe(true)
    expect(call?.tempPath.endsWith('.tmp')).toBe(true)
    expect(call?.tempContent).toBe('{\n  "next": 1\n}\n')
    expect(call?.targetContent).toBe(originalBytes)
    // A guard that resolves lets the write land normally.
    expect(await readFile(target, 'utf8')).toBe('{\n  "next": 1\n}\n')
    const entries = await readdir(root)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('rejects with the guard error, removes the staged temp file, and keeps the target byte-identical', async () => {
    const target = join(root, 'state.json')
    await writeJsonAtomic(target, { original: 'keep-me' })
    const originalBytes = await readFile(target)

    const renameSpy = spyOn(fsp, 'rename')
    let stagedPath: string | undefined
    try {
      await expect(
        writeJsonAtomic(
          target,
          { replaced: true },
          {
            beforeRename: async (tempPath) => {
              stagedPath = tempPath
              // Prove the temp file really existed when the guard ran, so
              // the post-rejection absence below is the cleanup's doing.
              await stat(tempPath)
              throw new Error('lease lost before rename')
            },
          },
        ),
      ).rejects.toThrow('lease lost before rename')

      expect(stagedPath).toBeDefined()
      expect(renameSpy).not.toHaveBeenCalled()
      expect(Buffer.compare(await readFile(target), originalBytes)).toBe(0)
      const entries = await readdir(root)
      expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
      expect(entries).toEqual(['state.json'])
    } finally {
      renameSpy.mockRestore()
    }
  })
})

describe('chmod helper behavior', () => {
  it('chmod 0o600 on an existing file tightens POSIX permissions without altering content', async () => {
    if (process.platform === 'win32') return

    const target = join(root, 'state.json')
    await writeFile(target, '{"x":1}\n', { encoding: 'utf8' })

    await chmod(target, 0o644)
    let stats = await stat(target)
    expect((stats.mode & 0o777).toString(8)).toBe('644')

    await writeJsonAtomic(target, { x: 1 })
    stats = await stat(target)
    expect((stats.mode & 0o777).toString(8)).toBe('600')
  })
})
