import { describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPhase,
  buildPhaseNote,
  withBuildPhaseClock,
} from '../../../scripts/build-phase-clock.ts'
import {
  assertVaultClientGraph,
  baselineRevision,
  expectedCandidateGraph,
  installResolution,
} from './smoke-tui-pack-install.ts'

const product = '@cortexkit/opencode-antigravity-auth'
const core = '@cortexkit/antigravity-auth-core'
const metadata = { version: '3.0.0', corePin: '3.0.0' }
const installCutoff = new Date('2026-05-14T12:00:00.000Z')

describe('packed vault-client copies', () => {
  const clients = [
    [
      '@cortexkit/claustrum-client',
      '@cortexkit/claustrum-client',
      '0.12.0',
      {},
      {},
    ],
    ['@cortexkit/subc-client', '@cortexkit/subc-client', '0.22.5', {}, {}],
  ]
  it('accepts exactly one locked copy of each client', () => {
    expect(() => assertVaultClientGraph(clients)).not.toThrow()
  })
  it('rejects missing, duplicated or differently versioned clients', () => {
    for (const graph of [
      clients.slice(1),
      [
        ...clients,
        ['nested/subc-client', '@cortexkit/subc-client', '0.22.5', {}, {}],
      ],
      [
        clients[0],
        ['@cortexkit/subc-client', '@cortexkit/subc-client', '0.17.0', {}, {}],
      ],
    ])
      expect(() => assertVaultClientGraph(graph)).toThrow(
        'consumer.vault_clients',
      )
  })
})

describe('historical baseline build', () => {
  it(
    'archives the baseline core revision and bundles against that core',
    async () =>
      withBuildPhaseClock('historical baseline build', 30_000, async () => {
        expect(baselineRevision).toBe(
          '45625093922278e7d8f1f1415df42bbc0ca1883e',
        )

        const workspace = await buildPhase('baseline test.mkdtemp', () =>
          mkdtemp(join(tmpdir(), 'smoke-tui-baseline-')),
        )
        try {
          // The baseline helper uses synchronous children. Run it in a separate Bun
          // process to keep those waits out of the isolated unit-test worker, while
          // preserving the archive/core/bundle assertions below.
          let childPid: number | undefined
          const builderPid = await buildPhase(
            'baseline test.child baseline build',
            () =>
              new Promise<number>((resolve, reject) => {
                const child = execFile(
                  process.execPath,
                  [
                    '-e',
                    `import { baseline } from ${JSON.stringify(import.meta.resolve('./smoke-tui-pack-install.ts'))}; import { withBuildPhaseClock } from ${JSON.stringify(import.meta.resolve('../../../scripts/build-phase-clock.ts'))}; await withBuildPhaseClock('historical baseline child', 30000, () => baseline(${JSON.stringify(workspace)})); console.log(JSON.stringify({ baselineBuilder: process.pid })); process.exit(0);`,
                  ],
                  { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
                  (error, stdout) => {
                    if (error) reject(error)
                    else {
                      try {
                        resolve(JSON.parse(stdout).baselineBuilder)
                      } catch (error) {
                        reject(error)
                      }
                    }
                  },
                )
                childPid = child.pid
                buildPhaseNote(
                  'child spawn baseline builder',
                  JSON.stringify({ pid: child.pid, command: process.execPath }),
                )
                child.once('exit', (status, signal) =>
                  buildPhaseNote(
                    'child exit baseline builder',
                    JSON.stringify({ pid: child.pid, status, signal }),
                  ),
                )
              }),
          )
          expect(builderPid).not.toBe(process.pid)
          if (childPid === undefined)
            throw new Error('baseline builder PID unavailable')
          expect(builderPid).toBe(childPid)
          const packageRoot = join(workspace, 'baseline/packages/opencode')
          const coreRoot = join(workspace, 'baseline/packages/core')
          const coreLink = join(
            packageRoot,
            'node_modules/@cortexkit/antigravity-auth-core',
          )
          expect(
            await buildPhase('baseline test.realpath core link', () =>
              realpath(coreLink),
            ),
          ).toBe(
            await buildPhase('baseline test.realpath archived core', () =>
              realpath(coreRoot),
            ),
          )
          expect(
            JSON.parse(
              await buildPhase('baseline test.readFile core manifest', () =>
                readFile(join(coreRoot, 'package.json'), 'utf8'),
              ),
            ).version,
          ).toBe('2.2.1')

          for (const entry of ['index', 'cli']) {
            const bundle = await buildPhase(
              `baseline test.readFile bundle ${entry}`,
              () => readFile(join(packageRoot, 'dist', `${entry}.js`), 'utf8'),
            )
            expect(bundle).not.toContain('isGeminiArgonModel')
          }
        } finally {
          await buildPhase('baseline test.rm workspace', () =>
            rm(workspace, { force: true, recursive: true }),
          )
        }
      }),
    30_000,
  )
})
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
    {
      [core]: '2.2.1',
      '@cortexkit/claustrum-client': '0.12.0',
      '@cortexkit/private-files': '0.2.1',
      '@cortexkit/subc-client': '0.22.5',
      zod: '^4.0.0',
    },
    {
      '@opencode-ai/plugin': '*',
      '@opencode/plugin': '>=2.0.22',
      typescript: '^5 || ^6',
    },
  ],
  ['zod', 'zod', '4.6.5', {}, {}],
]

describe('packed consumer graph comparison', () => {
  it('admits exact private-files and vault-client pins plus the OpenCode 2 peer without mutating the baseline', () => {
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

  it('preserves the fresh core store graph without admitting unrelated additions', () => {
    const store = [
      '@cortexkit/store',
      '@cortexkit/store',
      '0.2.2',
      { '@cortexkit/private-files': '^0.2.1' },
      {},
    ]
    const backend = [
      '@cortexkit/private-files',
      '@cortexkit/private-files',
      '0.1.0',
      {},
      {},
    ]
    const base = [...baseline(), store, backend]
    const expected = [...candidate(), store, backend].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    )
    const actual = expectedCandidateGraph(base, {
      version: '2.2.1',
      corePin: '2.2.1',
    })
    expect(actual).toEqual(expected)
  })

  it('updates only historical product version and core pin from candidate metadata', () => {
    const graph = baseline()
    const before = JSON.stringify(graph)
    const current = [
      [
        product,
        product,
        '3.0.0',
        {
          [core]: '3.0.0',
          '@cortexkit/claustrum-client': '0.12.0',
          '@cortexkit/private-files': '0.2.1',
          '@cortexkit/subc-client': '0.22.5',
          zod: '^4.0.0',
        },
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

  it('uses the core pin independently of the product version', () => {
    const expected = [
      [
        product,
        product,
        '3.0.0',
        {
          [core]: '3.0.1',
          '@cortexkit/claustrum-client': '0.12.0',
          '@cortexkit/private-files': '0.2.1',
          '@cortexkit/subc-client': '0.22.5',
          zod: '^4.0.0',
        },
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

  it.each([
    [
      'identity',
      [product, 'another-package', '2.2.1', { [core]: '2.2.1' }, {}],
    ],
    ['version', [product, product, null, { [core]: '2.2.1' }, {}]],
    ['empty version', [product, product, '', { [core]: '2.2.1' }, {}]],
    ['dependencies', [product, product, '2.2.1', null, {}]],
    ['array dependencies', [product, product, '2.2.1', [], {}]],
    [
      'missing core pin',
      [
        product,
        product,
        '2.2.1',
        {
          '@cortexkit/claustrum-client': '0.12.0',
          '@cortexkit/private-files': '0.2.1',
          '@cortexkit/subc-client': '0.22.5',
          zod: '^4.0.0',
        },
        {},
      ],
    ],
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

describe('packed install resolution cutoff', () => {
  it('pins baseline and candidate npm install environments to the run cutoff', () => {
    const baseline = installResolution(
      'npm',
      installCutoff,
      installCutoff.getTime() + 2_500,
    )
    const candidate = installResolution(
      'npm',
      installCutoff,
      installCutoff.getTime() + 7_500,
    )

    expect(baseline.env.npm_config_before).toBe(installCutoff.toISOString())
    expect(candidate.env.npm_config_before).toBe(installCutoff.toISOString())
  })

  it('derives each Bun install minimum age from the same cutoff with one safe second', () => {
    const baseline = installResolution(
      'bun',
      installCutoff,
      installCutoff.getTime() + 2_500,
    )
    const candidate = installResolution(
      'bun',
      installCutoff,
      installCutoff.getTime() + 7_500,
    )

    expect(baseline.args).toContain('--minimum-release-age=4')
    expect(candidate.args).toContain('--minimum-release-age=9')
  })
})
