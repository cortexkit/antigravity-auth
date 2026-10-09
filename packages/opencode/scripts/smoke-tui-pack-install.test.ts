import { describe, expect, it } from 'bun:test'
import { expectedCandidateGraph } from './smoke-tui-pack-install.ts'

const product = '@cortexkit/opencode-antigravity-auth'
const baseline = () => [
  [
    product,
    product,
    '2.2.1',
    { zod: '^4.0.0' },
    { '@opencode-ai/plugin': '*', typescript: '^5 || ^6' },
  ],
  ['zod', 'zod', '4.6.5', {}, {}],
]
const candidate = () => [
  [
    product,
    product,
    '2.2.1',
    { zod: '^4.0.0' },
    {
      '@opencode-ai/plugin': '*',
      '@opencode/plugin': '>=2.0.22',
      typescript: '^5 || ^6',
    },
  ],
  ['zod', 'zod', '4.6.5', {}, {}],
]

describe('packed consumer graph comparison', () => {
  it('admits only the new OpenCode 2 peer declaration without mutating the baseline', () => {
    const graph = baseline()
    const before = JSON.stringify(graph)
    expect(expectedCandidateGraph(graph)).toEqual(candidate())
    expect(JSON.stringify(expectedCandidateGraph(graph))).toBe(
      JSON.stringify(candidate()),
    )
    expect(JSON.stringify(graph)).toBe(before)
  })

  it.each([
    'typescript',
    '@opencode/plugin',
    '@cortexkit/common-auth',
    '@cortexkit/subc-client',
  ])('rejects an unexpected installed package: %s', (name) => {
    const changed = [...candidate(), [name, name, '1.0.0', {}, {}]]
    expect(expectedCandidateGraph(baseline())).not.toEqual(changed)
  })

  it('preserves dependency versions and every existing peer declaration', () => {
    for (const changed of [
      [
        [product, product, '2.2.1', { zod: '*' }, candidate()[0]?.[4]],
        candidate()[1],
      ],
      [
        [
          product,
          product,
          '2.2.1',
          { zod: '^4.0.0' },
          {
            '@opencode-ai/plugin': '*',
            '@opencode/plugin': '>=2.0.22',
            typescript: '*',
          },
        ],
        candidate()[1],
      ],
      [
        [
          product,
          product,
          '2.2.1',
          { zod: '^4.0.0' },
          {
            '@opencode-ai/plugin': '*',
            '@opencode/plugin': '*',
            typescript: '^5 || ^6',
          },
        ],
        candidate()[1],
      ],
    ])
      expect(expectedCandidateGraph(baseline())).not.toEqual(changed)
  })

  it('refuses missing, duplicate, malformed or already updated baseline rows', () => {
    expect(() => expectedCandidateGraph([])).toThrow(
      'Expected one historical product graph row',
    )
    expect(() =>
      expectedCandidateGraph([...baseline(), baseline()[0]]),
    ).toThrow('Expected one historical product graph row')
    expect(() =>
      expectedCandidateGraph([[product, product, '2.2.1', {}, null]]),
    ).toThrow('Unexpected historical product graph row')
    expect(() => expectedCandidateGraph(candidate())).toThrow(
      'Unexpected historical product graph row',
    )
  })
})
