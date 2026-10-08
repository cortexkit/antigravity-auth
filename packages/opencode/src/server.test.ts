// Packs the built OpenCode package and resolves its server entry the way each
// host does, from an installed copy with no workspace source on the path:
// - OpenCode 2: the published `Host.resolve` from @opencode/plugin 2.0.22,
//   both by package name (export map) and by directory (root forwarders);
// - OpenCode 1: its loader prefers `exports["./server"]` over `main`, admits
//   the package by `engines.opencode`, and runs a default export's `server`
//   function as the plugin instead of iterating named exports.
// The package must be built first (`bun run build`); dependencies are linked
// from this repository's installed copies, so nothing is fetched.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Host } from '@opencode/plugin/host'

const packageRoot = resolve(import.meta.dir, '..')
const packageName = '@cortexkit/opencode-antigravity-auth'

/** Bound on one type-check test: one tsc process over the packed types. */
const COMPILER_RUN_MS = 60_000

let root: string
let consumer: string
let installed: string

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    )
}

/** Links a dependency into the consumer from the copy this package resolves. */
function linkDependency(name: string) {
  const require = createRequire(join(packageRoot, 'package.json'))
  const manifest = realpathSync(require.resolve(`${name}/package.json`))
  const target = join(consumer, 'node_modules', name)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(dirname(manifest), target, 'dir')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-server-entry-'))
  consumer = join(root, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'server-entry-consumer', private: true, type: 'module' })}\n`,
  )
  run(
    process.execPath,
    ['pm', 'pack', '--ignore-scripts', '--destination', root, '--quiet'],
    packageRoot,
  )
  const tarball = readdirSync(root).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error('bun pm pack produced no tarball')
  installed = join(consumer, 'node_modules', packageName)
  mkdirSync(installed, { recursive: true })
  run(
    'tar',
    ['-xzf', join(root, tarball), '-C', installed, '--strip-components=1'],
    root,
  )
  const manifest = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8'),
  )
  for (const name of Object.keys(manifest.dependencies)) linkDependency(name)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('packed ./server entry', () => {
  it('resolves through the OpenCode 2 host resolver by name and by directory', () => {
    const byName = Host.resolve({ name: packageName, directory: consumer })
    expect(realpathSync(fileURLToPath(byName.server ?? ''))).toBe(
      realpathSync(join(installed, 'dist/server.js')),
    )
    expect(realpathSync(fileURLToPath(byName.tui ?? ''))).toBe(
      realpathSync(join(installed, 'src/tui/entry.mjs')),
    )
    expect(byName.rpc).toBeUndefined()

    const byDirectory = Host.resolve({ directory: installed })
    expect(realpathSync(fileURLToPath(byDirectory.server ?? ''))).toBe(
      realpathSync(join(installed, 'server.js')),
    )
    expect(realpathSync(fileURLToPath(byDirectory.tui ?? ''))).toBe(
      realpathSync(join(installed, 'tui.js')),
    )
    expect(byDirectory.rpc).toBeUndefined()
  })

  it('serves one hybrid default to both hosts and keeps the root entry plain', async () => {
    const resolved = Host.resolve({ name: packageName, directory: consumer })
    const viaHost = (await Host.load(resolved.server ?? '')) as Record<
      string,
      unknown
    >
    const viaForwarder = (await import(
      pathToFileURL(join(installed, 'server.js')).href
    )) as Record<string, unknown>
    const hybrid = viaHost.default as Record<string, unknown>
    expect(viaForwarder.default).toBe(hybrid)

    // OpenCode 2 decodes `{id, setup}`.
    expect(typeof hybrid.id).toBe('string')
    expect((hybrid.id as string).trim()).not.toBe('')
    expect(typeof hybrid.setup).toBe('function')
    // OpenCode 1 runs `server` and does not go on to the named exports.
    expect(typeof hybrid.server).toBe('function')
    expect(hybrid.tui).toBeUndefined()
    expect(typeof viaHost.createGaAntigravityPlugin).toBe('function')
    expect(hybrid).not.toBe(viaHost.createGaAntigravityPlugin)

    const manifest = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf8'),
    )
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './server',
      './tui',
    ])
    expect(manifest.main).toBe('./dist/index.js')
    const plain = (await import(
      pathToFileURL(join(installed, manifest.main)).href
    )) as Record<string, unknown>
    expect(typeof plain.AntigravityCLIOAuthPlugin).toBe('function')
    expect(plain.default).toBeUndefined()
  })

  it.each([
    ['NodeNext', { module: 'NodeNext', moduleResolution: 'NodeNext' }],
    ['Bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
  ] as const)(
    'type-checks the published server declarations under %s with library checking on',
    (label, resolution) => {
      // Type-only packages the declarations name: both host SDKs, Node types
      // and the JSON Schema types the GA SDK's provider package needs.
      for (const name of [
        '@opencode/plugin',
        '@opencode-ai/plugin',
        '@opencode-ai/sdk',
        '@types/node',
        '@types/json-schema',
      ])
        if (!existsSync(join(consumer, 'node_modules', name)))
          linkDependency(name)
      writeFileSync(
        join(consumer, 'server-consumer.ts'),
        `import plugin, {
  createGaAntigravityPlugin,
  type GaPluginOverrides,
} from '${packageName}/server'
import type { Plugin } from '@opencode/plugin'

const ga: Plugin.Plugin = plugin
const observe: NonNullable<GaPluginOverrides['observeRawSenderSignal']> = () => undefined
export const made: Plugin.Plugin = createGaAntigravityPlugin({ observeRawSenderSignal: observe })
export const v1: typeof plugin.server = plugin.server
export { ga }
`,
      )
      const config = `tsconfig.server.${label}.json`
      writeFileSync(
        join(consumer, config),
        `${JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            ...resolution,
            lib: ['ESNext', 'DOM', 'DOM.Iterable'],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ['node'],
          },
          files: ['server-consumer.ts'],
        })}\n`,
      )
      const tsc = createRequire(join(packageRoot, 'package.json')).resolve(
        'typescript/bin/tsc',
      )
      run(process.execPath, [tsc, '-p', config], consumer)
    },
    // A full strict compiler run over the published declarations, as a separate
    // process, takes several seconds; Bun's default 5 s test limit is too short.
    COMPILER_RUN_MS,
  )

  it('admits both host lines by engines.opencode', () => {
    const manifest = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf8'),
    )
    const range: string = manifest.engines.opencode
    for (const version of ['1.17.13', '1.99.0', '2.0.22', '2.5.0'])
      expect(Bun.semver.satisfies(version, range)).toBe(true)
    for (const version of ['1.17.12', '2.0.0', '2.0.21'])
      expect(Bun.semver.satisfies(version, range)).toBe(false)
  })
})
