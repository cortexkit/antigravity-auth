import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const prefix = 'tools/common-auth-build'
const scratch: string[] = []
async function owned() {
  const directory = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), '.tool-'),
  )
  scratch.push(directory)
  return directory
}
const digest = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
function run(cwd: string, args: string[]) {
  return execFileSync('bun', args, {
    cwd,
    timeout: 120000,
    encoding: 'utf8',
    env: { ...process.env, npm_config_offline: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
afterEach(async () => {
  for (const directory of scratch.splice(0))
    await rm(directory, { recursive: true, force: true })
})

test('build.private_toolchain', async () => {
  expect(run(root, ['--version']).trim()).toBe('1.4.2')
  const target = await owned()
  // Install into a separate directory from the pinned archive and offline cache,
  // without workspace links or registry access.
  for (const path of [
    'package.json',
    'bun.lock',
    'inputs/cortexkit-common-auth-0.12.0.tgz',
  ]) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await cp(join(root, prefix, path), join(target, path))
  }
  const before = digest(await readFile(join(target, 'bun.lock')))
  // Check the lockfile digest before installation to verify all transitive dependency integrity values separately from the install.
  expect(before).toBe(
    '60c2c98c5e5c68a038a487b282f87f06dba1529e30b08ef7f5ca25694a73cb13',
  )
  const installed = run(target, [
    'install',
    '--frozen-lockfile',
    '--offline',
    '--ignore-scripts',
    '--cache-dir',
    process.env.COMMON_AUTH_BUN_CACHE ??
      resolve(dirname(process.execPath), '../install/cache'),
  ])
  expect(installed).toMatch(/\d+ packages? installed|Checked \d+ installs/)
  expect(digest(await readFile(join(target, 'bun.lock')))).toBe(before)
  const manifest = JSON.parse(
    await readFile(join(target, 'package.json'), 'utf8'),
  )
  expect(manifest.dependencies).toEqual({
    '@cortexkit/common-auth': 'file:inputs/cortexkit-common-auth-0.12.0.tgz',
    '@opentui/core': '0.5.14',
    '@opentui/solid': '0.5.14',
    'solid-js': '1.9.12',
    typescript: '6.0.3',
  })
  // Bun parses its own JSONC lockfile; no private dependency is added to the product.
  const lock = JSON.parse(
    run(target, [
      '-e',
      "console.log(JSON.stringify(Bun.JSON5.parse(await Bun.file('bun.lock').text())))",
    ]),
  )
  expect(lock.workspaces[''].dependencies).toEqual(manifest.dependencies)
  for (const [name, entry] of Object.entries(lock.packages) as [
    string,
    (string | Record<string, unknown>)[],
  ][]) {
    const integrity = entry.at(-1)
    expect(typeof integrity).toBe('string')
    expect(String(integrity)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    const packageFile = join(
      target,
      'node_modules',
      (name.match(/(?:@[^/]+\/)?[^/]+/g) ?? []).join('/node_modules/'),
      'package.json',
    )
    if (
      name.startsWith('@opentui/core-') &&
      !name.endsWith(`${process.platform}-${process.arch}`)
    )
      continue
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'))
    expect(entry[0]).toBe(
      name === '@cortexkit/common-auth'
        ? '@cortexkit/common-auth@inputs/cortexkit-common-auth-0.12.0.tgz'
        : `${pkg.name}@${pkg.version}`,
    )
  }
  for (const [name, version] of Object.entries({
    '@cortexkit/common-auth': '0.12.0',
    '@opentui/core': '0.5.14',
    '@opentui/solid': '0.5.14',
    'solid-js': '1.9.12',
    typescript: '6.0.3',
  }))
    expect(
      JSON.parse(
        await readFile(
          join(target, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      ).version,
    ).toBe(version)
  expect(
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).workspaces,
  ).toEqual(['packages/*'])
}, 120000)

test('build.private_public_contract', async () => {
  const target = await owned()
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({
      name: 'owned-public-build',
      version: '1.0.0',
      type: 'module',
      files: ['raw/', 'runtime/'],
    }),
  )
  await writeFile(
    join(target, 'tui.tsx'),
    "import { value } from './leaf.ts'\nexport const tui = () => <text>{value}</text>\n",
  )
  await writeFile(
    join(target, 'leaf.ts'),
    "export const value: string = 'owned'\n",
  )
  const args = [
    join(root, prefix, 'build.mjs'),
    '--package-root',
    target,
    '--entry',
    join(target, 'tui.tsx'),
    '--raw-dir',
    join(target, 'raw'),
    '--runtime-dir',
    join(target, 'runtime'),
    '--map',
    join(target, 'map.json'),
  ]
  const nestedMap = [...args]
  nestedMap[nestedMap.length - 1] = join(target, 'raw/map.json')
  expect(() => run(target, nestedMap)).toThrow(
    'Build map must be outside emitted trees and source entry',
  )
  expect(run(target, args)).toContain(
    'Public TUI build: 3 raw, 3 runtime files',
  )
  expect(await readFile(join(target, 'raw/selector.js'))).toEqual(
    await readFile(
      join(root, 'packages/opencode/src/common-auth-embedded/tui/index.js'),
    ),
  )
  expect(await readFile(join(target, 'runtime/selector.js'))).toEqual(
    await readFile(join(target, 'raw/selector.js')),
  )
  expect(await readFile(join(target, 'raw/tui.tsx'), 'utf8')).toContain(
    '<text>',
  )
  expect(await readFile(join(target, 'runtime/tui.js'), 'utf8')).toContain(
    'opentui:runtime-module:',
  )
  const map = JSON.parse(await readFile(join(target, 'map.json'), 'utf8'))
  expect(map.compiler).toBe('@cortexkit/common-auth/tui-build@0.12.0')
  // Check each manifest record's path, hash and byte count against the emitted
  // regular file itself, rather than crosschecking two self-reported fields.
  for (const tree of [map.raw, map.runtime]) {
    for (const file of tree.files) {
      const emitted = await readFile(join(target, file.output))
      expect(file.bytes).toBe(emitted.length)
      expect(file.sha256).toBe(digest(emitted))
      if (file.transform === 'verbatim-selector') {
        expect(file.source.endsWith('/dist/tui/index.js')).toBe(true)
        expect(emitted).toEqual(await readFile(resolve(target, file.source)))
        expect(emitted).toEqual(
          await readFile(
            join(
              root,
              'packages/opencode/src/common-auth-embedded/tui/index.js',
            ),
          ),
        )
      } else {
        expect(file.source).not.toMatch(/^(?:\/|\.\.)/)
        expect(file.transform).toBe(
          tree === map.raw ? 'public-raw' : 'public-solid-runtime',
        )
        if (file.output.endsWith('/leaf.js')) {
          expect(file.source).toBe('leaf.ts')
          expect(await readFile(join(target, file.source), 'utf8')).toBe(
            "export const value: string = 'owned'\n",
          )
          expect(emitted.toString()).toContain('owned')
          expect(emitted.toString()).not.toContain(': string')
        } else {
          expect(file.source).toBe('tui.tsx')
          expect(await readFile(join(target, file.source), 'utf8')).toContain(
            '<text>',
          )
          expect(emitted.toString()).toContain(
            tree === map.raw ? '<text>' : 'opentui:runtime-module:',
          )
        }
      }
    }
  }
  expect(
    map.raw.files.map((file: { output: string }) => file.output).sort(),
  ).toEqual(['raw/leaf.js', 'raw/selector.js', 'raw/tui.tsx'])
  expect(
    map.runtime.files.map((file: { output: string }) => file.output).sort(),
  ).toEqual(['runtime/leaf.js', 'runtime/selector.js', 'runtime/tui.js'])
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({
      name: 'owned-public-build',
      version: '1.0.0',
      type: 'module',
      files: ['raw/'],
    }),
  )
  expect(() => run(target, args)).toThrow(
    'Published destination differs from emitted',
  )
  await expect(readFile(join(target, 'raw/tui.tsx'))).rejects.toThrow('ENOENT')
  await expect(readFile(join(target, 'runtime/tui.js'))).rejects.toThrow(
    'ENOENT',
  )
  await expect(readFile(join(target, 'map.json'))).rejects.toThrow('ENOENT')
}, 120000)
