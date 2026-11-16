import { describe, expect, it } from 'bun:test'
import { rewriteSystemInstruction } from './harness-identity'

describe('Pi opener rewrite', () => {
  const help = ' Help users inspect files, run commands, and modify code.'
  const served = `You are a coding assistant.${help}`
  for (const [host, opener] of [
    [
      'Pi 1.5.2',
      'You are a coding assistant running inside pi, a coding agent harness.',
    ],
    [
      'Pi-Bolt',
      'You are a coding assistant running inside Pi-Bolt, a build of pi (a coding agent harness) compiled ahead of time.',
    ],
  ]) {
    it(`rewrites the exact ${host} opener to the served form`, () => {
      const input = `${opener}${help}`
      expect(rewriteSystemInstruction(input)).toBe(served)
      expect(rewriteSystemInstruction(input)).toBe(served)
      expect(rewriteSystemInstruction(served)).toBe(served)
    })
  }

  it('preserves near-misses and docs byte for byte', () => {
    for (const input of [
      served,
      'You are a coding assistant running inside pi.js, a coding agent harness.',
      'You are a coding assistant running inside pipeline, a coding agent harness.',
      'You are a coding assistant running inside pi-bolt.js.',
      'You are a coding assistant.\n\n<docs>\nRead the Pi documentation.\n</docs>',
    ]) {
      expect(rewriteSystemInstruction(input)).toBe(input)
    }
    const docs = '\n\n<docs>\nRead the Pi documentation.\n</docs>'
    expect(
      rewriteSystemInstruction(
        `You are a coding assistant running inside pi, a coding agent harness.${help}${docs}`,
      ),
    ).toBe(`${served}${docs}`)
  })
})
