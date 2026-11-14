import { describe, expect, it } from 'bun:test'
import realPrompts from '../../../test-fixtures/harness-identities.json'
import * as core from './index.ts'

describe('harness identity rewrite', () => {
  const rows = [
    ...realPrompts.map(({ input, output }) => [input, output] as const),
    ['You are opencode.', 'You are a coding assistant.'],
    ['You are OpenCode!', 'You are a coding assistant!'],
    ['You are OpenCode; help', 'You are a coding assistant; help'],
    ['You are OpenCode: help', 'You are a coding assistant: help'],
    ['You are OpenCode\nHelp', 'You are a coding assistant\nHelp'],
    ['You are OpenCode', 'You are a coding assistant'],
    [
      'if OpenCode honestly cannot help',
      'if the assistant honestly cannot help',
    ],
    [
      'running inside opencode, a coding agent harness',
      'running inside your development environment',
    ],
    [
      'running inside opencode.',
      'running inside your development environment.',
    ],
    [
      'Keep this.\n\nSee github.com/anomalyco/opencode for feedback.\n\nKeep that.',
      'Keep this.\n\nKeep that.',
    ],
    ['See github.com/sst/opencode\n\nKeep this.', 'Keep this.'],
    [
      'Keep this.\n\nSee opencode.ai/docs\n\n\nKeep that.',
      'Keep this.\n\nKeep that.',
    ],
    [
      'You are a coding assistant running inside pi, a coding agent harness. Help users…',
      'You are a coding assistant running inside your development environment. Help users…',
    ],
    [
      'You are a coding assistant running inside pi.',
      'You are a coding assistant running inside your development environment.',
    ],
    [
      '…running inside pi. Help users…',
      '…running inside your development environment. Help users…',
    ],
    [
      'You are a coding assistant running inside Pi-Bolt, a build of pi (a coding agent harness) compiled ahead of time. Help users.',
      'You are a coding assistant running inside your development environment. Help users.',
    ],
    ['RUNNING INSIDE PI', 'running inside your development environment'],
    ['running inside pi!', 'running inside your development environment!'],
    [
      'running inside pi now',
      'running inside your development environment now',
    ],
  ] as const
  for (const [input, output] of rows) {
    it(`rewrites ${input} deterministically and idempotently`, () => {
      expect(core.rewriteHarnessIdentity(input)).toBe(output)
      expect(core.rewriteHarnessIdentity(input)).toBe(output)
      expect(core.rewriteHarnessIdentity(output)).toBe(output)
    })
  }
  for (const input of [
    'running inside your development environment',
    'running inside a coding agent harness',
    'You are a coding assistant. The project is called pi.',
    'running inside pi.js',
    'running inside pi-bolt.js',
    'running inside pipeline',
    'running inside pip',
    'pi.js',
    'pi-bolt.js',
    'pipeline',
    '~/.config/opencode',
    '.opencode/',
    'https://example.com/opencode',
    'You are opencode.js',
    'You are opencodex',
    'running inside opencode.js',
    'running inside pi-bolt',
    'If OpenCode honestly',
    'if opencode honestly',
    'https://OPENCODE.AI/docs',
  ]) {
    it(`preserves the near miss ${input} byte for byte`, () => {
      expect(core.rewriteHarnessIdentity(input)).toBe(input)
    })
  }
  it('does not mutate instruction parts or mistake blank-line normalisation for an identity', () => {
    const input = {
      role: 'system',
      parts: [
        { text: 'running inside pi.', cache_control: { type: 'ephemeral' } },
        { inlineData: { data: 'running inside pi' } },
      ],
    }
    expect(core.rewriteSystemInstruction(input)).toEqual({
      ...input,
      parts: [
        {
          ...input.parts[0],
          text: 'running inside your development environment.',
        },
        input.parts[1],
      ],
    })
    expect(input.parts[0]!.text).toBe('running inside pi.')
    expect(core.systemInstructionHasHarnessIdentity(input)).toBe(true)
    expect(
      core.systemInstructionHasHarnessIdentity({
        parts: [{ text: 'Neutral\n\n\nNeutral' }],
      }),
    ).toBe(false)
  })
})
