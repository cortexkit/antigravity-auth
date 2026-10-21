import { expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'

it('live preload puts ordinary test roots on tmpfs only with opt-in', () => {
  expect(Bun.main).toBe(import.meta.path)
  const root = process.env.ANTIGRAVITY_TEST_ROOT
  if (!root) throw new Error('preload did not create a test root')
  if (process.env.ANTIGRAVITY_TEST_TMPFS === '1') {
    expect(dirname(root)).toBe('/dev/shm')
    expect(tmpdir()).toBe(root)
  } else {
    expect(dirname(root)).toBe(tmpdir())
  }
})
