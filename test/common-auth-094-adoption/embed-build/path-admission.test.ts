import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const build = join(repo, 'tools/common-auth-build/build.mjs')
const roots: string[] = []
interface Paths {
  packageRoot: string
  entryFile: string
  rawDir: string
  runtimeDir: string
  mapFile?: string
}
interface Snapshot {
  path: string
  kind: string
  bytes?: number
  sha256?: string
  target?: string
}

async function owned() {
  const root = await mkdtemp(join(here, '.paths-'))
  roots.push(root)
  const packageRoot = join(root, 'package')
  const foreign = join(root, 'foreign')
  for (const path of ['src', 'raw', 'runtime'])
    await mkdir(join(packageRoot, path), { recursive: true })
  await mkdir(join(foreign, 'raw'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'owned-path-build',
      version: '1.0.0',
      type: 'module',
      files: ['raw/', 'runtime/'],
    }),
  )
  await writeFile(
    join(packageRoot, 'src/tui.tsx'),
    "import { value } from './leaf.ts'\nexport const tui = () => <text>{value}</text>\n",
  )
  await writeFile(
    join(packageRoot, 'src/leaf.ts'),
    "export const value: string = 'owned-source'\n",
  )
  await writeFile(
    join(packageRoot, 'src/input.json'),
    '{"authored":"owned-source-data"}\n',
  )
  await writeFile(
    join(packageRoot, 'raw/sentinel'),
    'previous raw output must survive admission refusal\n',
  )
  await writeFile(
    join(packageRoot, 'runtime/sentinel'),
    'previous runtime output must survive admission refusal\n',
  )
  await writeFile(
    join(foreign, 'raw/sentinel'),
    'foreign output must not be written or removed\n',
  )
  const paths: Paths = {
    packageRoot,
    entryFile: join(packageRoot, 'src/tui.tsx'),
    rawDir: join(packageRoot, 'raw'),
    runtimeDir: join(packageRoot, 'runtime'),
    mapFile: join(packageRoot, 'map.json'),
  }
  return { root, foreign, paths }
}

async function snapshot(root: string, prefix = ''): Promise<Snapshot[]> {
  const entries: Snapshot[] = []
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name)
    const label = `${prefix}${name}`
    const info = await lstat(path)
    if (info.isSymbolicLink())
      entries.push({
        path: label,
        kind: 'symlink',
        target: await readlink(path),
      })
    else if (info.isDirectory()) {
      entries.push({ path: label, kind: 'directory' })
      entries.push(...(await snapshot(path, `${label}/`)))
    } else {
      const bytes = await readFile(path)
      entries.push({
        path: label,
        kind: 'file',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  return entries
}

function invoke(cwd: string, paths: Paths) {
  const args = [
    build,
    '--package-root',
    paths.packageRoot,
    '--entry',
    paths.entryFile,
    '--raw-dir',
    paths.rawDir,
    '--runtime-dir',
    paths.runtimeDir,
  ]
  if (paths.mapFile !== undefined) args.push('--map', paths.mapFile)
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, npm_config_offline: 'true' },
  })
}

async function refuses(root: string, paths: Paths, message: string) {
  // Directory membership, link targets and every owned source/foreign byte are witnessed.
  // Existing output sentinels make any compiler traversal or catch-cleanup destructive.
  const before = await snapshot(root)
  const result = invoke(root, paths)
  const after = await snapshot(root)
  expect(after).toEqual(before)
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  expect(`${result.stdout}${result.stderr}`).toContain(message)
  expect(result.stdout).not.toContain('Public TUI build:')
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('build.map_source_alias', async () => {
  const { root, paths } = await owned()
  const mapFile = join(paths.packageRoot, 'map-source-alias.json')
  await symlink(paths.entryFile, mapFile)
  await refuses(
    root,
    { ...paths, mapFile },
    'Build output aliases are not admitted',
  )
  const hardMap = join(paths.packageRoot, 'hard-map-source-alias.json')
  await link(join(paths.packageRoot, 'src/leaf.ts'), hardMap)
  await refuses(
    root,
    { ...paths, mapFile: hardMap },
    'Build map must be a regular unaliased file',
  )
  const sourceMap = join(paths.packageRoot, 'src/input.json')
  await refuses(
    root,
    { ...paths, mapFile: sourceMap },
    'Existing build map is not a generated map',
  )
}, 120000)

test('build.output_ancestor_alias', async () => {
  const { root, foreign, paths } = await owned()
  const ancestor = join(paths.packageRoot, 'outside-ancestor')
  await symlink(foreign, ancestor, 'dir')
  await refuses(
    root,
    { ...paths, rawDir: join(ancestor, 'raw') },
    'Build output aliases are not admitted',
  )
  await refuses(
    root,
    { ...paths, runtimeDir: join(ancestor, 'missing/runtime') },
    'Build output aliases are not admitted',
  )
  await refuses(
    root,
    { ...paths, mapFile: join(ancestor, 'missing/map.json') },
    'Build output aliases are not admitted',
  )
}, 120000)

test('build.output_source_alias', async () => {
  const { root, paths } = await owned()
  const alias = join(paths.packageRoot, 'source-output-alias')
  await symlink(join(paths.packageRoot, 'src'), alias, 'dir')
  await refuses(
    root,
    { ...paths, rawDir: alias },
    'Build output aliases are not admitted',
  )
  await refuses(
    root,
    { ...paths, runtimeDir: join(alias, 'missing/runtime') },
    'Build output aliases are not admitted',
  )
  const linkedEntry = join(paths.packageRoot, 'linked-tui.tsx')
  await symlink(paths.entryFile, linkedEntry)
  await refuses(
    root,
    {
      ...paths,
      entryFile: linkedEntry,
      rawDir: join(paths.packageRoot, 'src'),
    },
    'Resolved TUI output cannot contain its source entry',
  )
}, 120000)

test('build.lexical_path_refusals', async () => {
  const { root, foreign, paths } = await owned()
  const invalid: [Paths, string][] = [
    [{ ...paths, packageRoot: 'package' }, 'Build path must be absolute'],
    [{ ...paths, entryFile: 'src/tui.tsx' }, 'Build path must be absolute'],
    [{ ...paths, rawDir: 'raw' }, 'Build path must be absolute'],
    [{ ...paths, runtimeDir: 'runtime' }, 'Build path must be absolute'],
    [{ ...paths, mapFile: 'map.json' }, 'Build path must be absolute'],
    [{ ...paths, rawDir: foreign }, 'Output must be inside package root'],
    [
      { ...paths, runtimeDir: join(foreign, 'raw') },
      'Output must be inside package root',
    ],
    [
      { ...paths, mapFile: join(foreign, 'map.json') },
      'Output must be inside package root',
    ],
    [
      { ...paths, rawDir: paths.packageRoot },
      'Output must be inside package root',
    ],
    [
      { ...paths, runtimeDir: paths.packageRoot },
      'Output must be inside package root',
    ],
    [
      { ...paths, mapFile: paths.packageRoot },
      'Output must be inside package root',
    ],
    [{ ...paths, runtimeDir: paths.rawDir }, 'TUI outputs must be disjoint'],
    [
      { ...paths, runtimeDir: join(paths.rawDir, 'nested') },
      'TUI outputs must be disjoint',
    ],
    [
      { ...paths, rawDir: join(paths.runtimeDir, 'nested') },
      'TUI outputs must be disjoint',
    ],
    [
      { ...paths, rawDir: join(paths.packageRoot, 'src') },
      'TUI output cannot contain its source entry',
    ],
    [
      { ...paths, runtimeDir: paths.entryFile },
      'TUI output cannot contain its source entry',
    ],
    [
      { ...paths, mapFile: paths.entryFile },
      'Build map must be outside emitted trees and source entry',
    ],
    [
      { ...paths, mapFile: join(paths.rawDir, 'nested/map.json') },
      'Build map must be outside emitted trees and source entry',
    ],
    [
      { ...paths, mapFile: paths.runtimeDir },
      'Build map must be outside emitted trees and source entry',
    ],
    [
      { ...paths, rawDir: join(paths.packageRoot, 'src/leaf.ts') },
      'Build output directory is not a directory',
    ],
    [
      { ...paths, mapFile: join(paths.packageRoot, 'src') },
      'Build map must be a regular unaliased file',
    ],
  ]
  for (const [candidate, message] of invalid)
    await refuses(root, candidate, message)
}, 120000)

test('build.symlink_root_equivalence', async () => {
  const { root, paths } = await owned()
  const beforeSource = await snapshot(join(paths.packageRoot, 'src'))
  const real = invoke(root, paths)
  expect(real.status).toBe(0)
  expect(real.stdout).toContain('Public TUI build: 3 raw, 3 runtime files')
  const realRaw = await snapshot(paths.rawDir)
  const realRuntime = await snapshot(paths.runtimeDir)
  const realMap = await readFile(paths.mapFile!)
  const alias = join(root, 'linked-package')
  await symlink(paths.packageRoot, alias, 'dir')
  const linked = invoke(root, {
    packageRoot: alias,
    entryFile: join(alias, 'src/tui.tsx'),
    rawDir: join(alias, 'raw'),
    runtimeDir: join(alias, 'runtime'),
    mapFile: join(alias, 'map.json'),
  })
  expect(linked.status).toBe(0)
  expect(linked.stdout).toContain('Public TUI build: 3 raw, 3 runtime files')
  expect(await snapshot(paths.rawDir)).toEqual(realRaw)
  expect(await snapshot(paths.runtimeDir)).toEqual(realRuntime)
  expect(await readFile(paths.mapFile!)).toEqual(realMap)
  expect(await snapshot(join(paths.packageRoot, 'src'))).toEqual(beforeSource)
  // Reject a package-root alias paired with destinations spelled under the real root.
  const mixed = invoke(root, { ...paths, packageRoot: alias })
  expect(mixed.status).toBe(1)
  expect(`${mixed.stdout}${mixed.stderr}`).toContain(
    'Output must be inside package root',
  )
  expect(await snapshot(join(paths.packageRoot, 'src'))).toEqual(beforeSource)
}, 120000)
