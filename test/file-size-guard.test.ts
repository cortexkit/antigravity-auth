import { describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkFileSize, isExempt } from '../scripts/check-file-sizes.ts'
import { runCommand } from './support/run-command.ts'

const lines = (count: number) => `${'line\n'.repeat(count)}`

describe('file size guard', () => {
  test('rejects a new file at the limit and accepts one line below', () => {
    expect(checkFileSize('src/new.ts', lines(5000), {})).toMatchObject({
      kind: 'error',
      count: 5000,
      limit: 5000,
    })
    expect(checkFileSize('src/new.ts', lines(4999), {})).toBeUndefined()
  })

  test('rejects growth of a baselined file', () => {
    expect(
      checkFileSize('src/large.ts', lines(6001), { 'src/large.ts': 6000 }),
    ).toMatchObject({ kind: 'error', count: 6001, limit: 6000 })
  })

  test('notes a shrinking baseline without failing', () => {
    expect(
      checkFileSize('src/large.ts', lines(5999), { 'src/large.ts': 6000 }),
    ).toMatchObject({ kind: 'note', count: 5999, limit: 6000 })
    expect(
      checkFileSize('src/large.ts', lines(4999), { 'src/large.ts': 6000 })
        ?.message,
    ).toContain('remove')
  })

  test('exempts tests, fixture folders, and generated embedded files', () => {
    for (const path of [
      'src/large.test.ts',
      'test/large.ts',
      'src/__fixtures__/large.ts',
      'src/fixtures/large.ts',
      'packages/core/src/common-auth-embedded/large.js',
    ]) {
      expect(isExempt(path)).toBe(true)
      expect(checkFileSize(path, lines(6000), {})).toBeUndefined()
    }
    expect(isExempt('src/test-helper.ts')).toBe(false)
  })

  test('counts newline bytes like wc -l, including an unterminated last line', () => {
    expect(
      checkFileSize('src/new.ts', `${lines(4999)}last line`, {}),
    ).toBeUndefined()
  })
})

test('CLI checks tracked sources and ignores untracked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-size-guard-'))
  try {
    await mkdir(join(root, 'scripts'))
    await copyFile(
      resolve(import.meta.dir, '../scripts/check-file-sizes.ts'),
      join(root, 'scripts/check-file-sizes.ts'),
    )
    await writeFile(join(root, 'scripts/file-size-baseline.json'), '{}')
    await writeFile(join(root, 'tracked.ts'), lines(5000))
    await writeFile(join(root, 'untracked.js'), lines(6000))
    for (const args of [
      ['git', 'init', '-q'],
      ['git', 'add', 'tracked.ts'],
    ]) {
      const result = await runCommand(args, { cwd: root, deadlineMs: 10_000 })
      expect(result.exitCode, result.stderr).toBe(0)
    }
    const run = () =>
      runCommand([process.execPath, 'scripts/check-file-sizes.ts'], {
        cwd: root,
        deadlineMs: 10_000,
      })
    const failure = await run()
    expect(failure.exitCode).toBe(1)
    expect(failure.stderr).toContain('tracked.ts: 5000 lines')
    expect(failure.stderr).not.toContain('untracked.js')
    await writeFile(join(root, 'tracked.ts'), lines(4999))
    const success = await run()
    expect(success.exitCode, success.stderr).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
