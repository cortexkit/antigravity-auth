import { describe, expect, it } from 'bun:test'
import { expectedCandidateGraph } from './smoke-tui-pack-install.ts'

const product = '@cortexkit/opencode-antigravity-auth'
const core = '@cortexkit/antigravity-auth-core'
const metadata = { version: '3.0.0', corePin: '3.0.0' }
const baseline = () => [
  [
    product,
    product,
    '2.2.1',
    { [core]: '2.2.1', zod: '^4.0.0' },
    { '@opencode-ai/plugin': '*', typescript: '^5 || ^6' },
  ],
  ['zod', 'zod', '4.6.5', {}, {}],
]
const candidate = () => [
  [
    product,
    product,
    '2.2.1',
    { [core]: '2.2.1', zod: '^4.0.0' },
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
    expect(
      expectedCandidateGraph(graph, { version: '2.2.1', corePin: '2.2.1' }),
    ).toEqual(candidate())
    expect(
      JSON.stringify(
        expectedCandidateGraph(graph, { version: '2.2.1', corePin: '2.2.1' }),
      ),
    ).toBe(JSON.stringify(candidate()))
    expect(JSON.stringify(graph)).toBe(before)
  })

  it.each([
    'typescript',
    '@opencode/plugin',
    '@cortexkit/common-auth',
    '@cortexkit/subc-client',
  ])('rejects an unexpected installed package: %s', (name) => {
    const changed = [...candidate(), [name, name, '1.0.0', {}, {}]]
    expect(
      expectedCandidateGraph(baseline(), {
        version: '2.2.1',
        corePin: '2.2.1',
      }),
    ).not.toEqual(changed)
  })

  it('preserves dependency versions and every existing peer declaration', () => {
    for (const changed of [
      [
        [
          product,
          product,
          '2.2.1',
          { [core]: '2.2.1', zod: '*' },
          candidate()[0]?.[4],
        ],
        candidate()[1],
      ],
      [
        [
          product,
          product,
          '2.2.1',
          { [core]: '2.2.1', zod: '^4.0.0' },
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
          { [core]: '2.2.1', zod: '^4.0.0' },
          {
            '@opencode-ai/plugin': '*',
            '@opencode/plugin': '*',
            typescript: '^5 || ^6',
          },
        ],
        candidate()[1],
      ],
    ])
      expect(
        expectedCandidateGraph(baseline(), {
          version: '2.2.1',
          corePin: '2.2.1',
        }),
      ).not.toEqual(changed)
  })

  it('updates only historical product version and core pin from candidate metadata', () => {
    const graph = baseline()
    const before = JSON.stringify(graph)
    const current = [
      [
        product,
        product,
        '3.0.0',
        { [core]: '3.0.0', zod: '^4.0.0' },
        {
          '@opencode-ai/plugin': '*',
          '@opencode/plugin': '>=2.0.22',
          typescript: '^5 || ^6',
        },
      ],
      ['zod', 'zod', '4.6.5', {}, {}],
    ]
    expect(expectedCandidateGraph(graph, metadata)).toEqual(current)
    expect(JSON.stringify(expectedCandidateGraph(graph, metadata))).toBe(
      JSON.stringify(current),
    )
    expect(JSON.stringify(graph)).toBe(before)
  })

  it.each([
    [
      'product version',
      [
        product,
        product,
        '2.2.1',
        { [core]: '3.0.0', zod: '^4.0.0' },
        candidate()[0]?.[4],
      ],
    ],
    [
      'core pin',
      [
        product,
        product,
        '3.0.0',
        { [core]: '2.2.1', zod: '^4.0.0' },
        candidate()[0]?.[4],
      ],
    ],
    [
      'product dependency',
      [
        product,
        product,
        '3.0.0',
        { [core]: '3.0.0', zod: '*' },
        candidate()[0]?.[4],
      ],
    ],
    [
      'extra SDK peer',
      [
        product,
        product,
        '3.0.0',
        { [core]: '3.0.0', zod: '^4.0.0' },
        { ...(candidate()[0]?.[4] as object), '@opencode-ai/sdk': '*' },
      ],
    ],
  ])('rejects wrong candidate %s', (_field, row) => {
    expect(expectedCandidateGraph(baseline(), metadata)).not.toEqual([
      row,
      candidate()[1],
    ])
  })

  it('uses the core pin independently of the product version', () => {
    const expected = [
      [
        product,
        product,
        '3.0.0',
        { [core]: '3.0.1', zod: '^4.0.0' },
        candidate()[0]?.[4],
      ],
      candidate()[1],
    ]
    expect(
      expectedCandidateGraph(baseline(), {
        version: '3.0.0',
        corePin: '3.0.1',
      }),
    ).toEqual(expected)
  })

  it('rejects a wrong installed core version', () => {
    const graph = [...baseline(), [core, core, '3.0.0', {}, {}]]
    const changed = [
      [core, core, '2.2.1', {}, {}],
      [
        product,
        product,
        '3.0.0',
        { [core]: '3.0.0', zod: '^4.0.0' },
        candidate()[0]?.[4],
      ],
      candidate()[1],
    ]
    expect(expectedCandidateGraph(graph, metadata)).not.toEqual(changed)
  })

  it.each([
    ['version', ['zod', 'zod', '0.0.0', {}, {}]],
    ['dependency', ['zod', 'zod', '4.6.5', { unexpected: '*' }, {}]],
  ])('rejects an altered non-product %s', (_field, row) => {
    const current = [
      product,
      product,
      '3.0.0',
      { [core]: '3.0.0', zod: '^4.0.0' },
      candidate()[0]?.[4],
    ]
    expect(expectedCandidateGraph(baseline(), metadata)).not.toEqual([
      current,
      row,
    ])
  })

  it.each([
    [
      'identity',
      [product, 'another-package', '2.2.1', { [core]: '2.2.1' }, {}],
    ],
    ['version', [product, product, null, { [core]: '2.2.1' }, {}]],
    ['empty version', [product, product, '', { [core]: '2.2.1' }, {}]],
    ['dependencies', [product, product, '2.2.1', null, {}]],
    ['array dependencies', [product, product, '2.2.1', [], {}]],
    ['missing core pin', [product, product, '2.2.1', { zod: '^4.0.0' }, {}]],
    ['core pin', [product, product, '2.2.1', { [core]: null }, {}]],
    ['empty core pin', [product, product, '2.2.1', { [core]: '' }, {}]],
    [
      'dependency value',
      [product, product, '2.2.1', { [core]: '2.2.1', zod: null }, {}],
    ],
    ['array peers', [product, product, '2.2.1', { [core]: '2.2.1' }, []]],
    [
      'peer value',
      [product, product, '2.2.1', { [core]: '2.2.1' }, { typescript: null }],
    ],
    ['extra field', [...baseline()[0]!, 'unexpected']],
  ])('refuses a malformed historical product %s', (_field, row) => {
    expect(() => expectedCandidateGraph([row], metadata)).toThrow(
      'Unexpected historical product graph row',
    )
  })

  it('refuses missing, duplicate, malformed or already updated baseline rows', () => {
    expect(() => expectedCandidateGraph([], metadata)).toThrow(
      'Expected one historical product graph row',
    )
    expect(() =>
      expectedCandidateGraph([...baseline(), baseline()[0]], metadata),
    ).toThrow('Expected one historical product graph row')
    expect(() =>
      expectedCandidateGraph([[product, product, '2.2.1', {}, null]], metadata),
    ).toThrow('Unexpected historical product graph row')
    expect(() => expectedCandidateGraph(candidate(), metadata)).toThrow(
      'Unexpected historical product graph row',
    )
  })
})
