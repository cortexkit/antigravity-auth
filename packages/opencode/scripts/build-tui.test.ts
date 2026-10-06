import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  cp,
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
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as bundle } from 'esbuild'
import ts from 'typescript'
import {
  auditGraph,
  buildLibrary,
  buildTui,
  checkMetafile,
  inventory,
  PACKAGE_ROOT,
  verifyPrerequisites,
  verifySelectors,
} from './build-tui'
import { sha256 } from './embed-common-auth'
import { inspectPack, pack } from './smoke-tui-pack-install'

const repo = resolve(PACKAGE_ROOT, '../..')
let owned: string
let product: string
let serial = 0
async function fixture(full = false) {
  const root = join(owned, `package-${serial++}`)
  await mkdir(join(root, 'src'), { recursive: true })
  const pkg = JSON.parse(
    await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  )
  if (full) {
    for (const name of await readdir(join(PACKAGE_ROOT, 'src'))) {
      if (['tui-raw', 'tui-compiled'].includes(name)) continue
      await cp(join(PACKAGE_ROOT, 'src', name), join(root, 'src', name), {
        recursive: true,
      })
    }
    for (const name of [
      'index.ts',
      'tsconfig.json',
      'tsconfig.build.json',
      'README.md',
      'LICENSE',
    ])
      await cp(join(PACKAGE_ROOT, name), join(root, name))
    const config = ts.readConfigFile(
      join(root, 'tsconfig.json'),
      ts.sys.readFile,
    ).config
    // The copied package config needs the real @types/bun and @types/node declarations.
    // This nested fixture has no ambient-types install, so use their installed worktree copies.
    config.compilerOptions.typeRoots = [join(repo, 'node_modules/@types')]
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config))
  } else
    await writeFile(
      join(root, 'src/tui.tsx'),
      'export default { id: "owned", tui: () => <text>owned</text> }\n',
    )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'owned-tui-build',
      version: '1.0.0',
      type: 'module',
      files: pkg.files,
    }),
  )
  return root
}
async function hashes(root: string, tree: string) {
  return Promise.all(
    (await inventory(join(root, tree))).map(async (path) => [
      path,
      sha256(await readFile(join(root, tree, path))),
    ]),
  )
}
beforeAll(async () => {
  await mkdir(join(PACKAGE_ROOT, 'src/tui-raw'), { recursive: true })
  owned = await mkdtemp(join(PACKAGE_ROOT, 'src/tui-raw/.checks-'))
  await verifyPrerequisites()
  product = await fixture(true)
  await buildTui({ packageRoot: product })
}, 120000)
afterAll(async () => {
  if (owned) await rm(owned, { recursive: true, force: true })
})

test('graph.source', async () => {
  const graph = await auditGraph(join(product, 'src/tui.tsx'))
  expect(graph.files.map((path) => relative(product, path))).toContain(
    'src/sidebar-state.ts',
  )
  for (const external of [
    'jsonc-parser',
    'xdg-basedir',
    '@cortexkit/antigravity-auth-core/atomic-write',
    '@cortexkit/antigravity-auth-core/file-lock',
  ])
    expect(graph.externals).toContain(external)
  const root = await fixture()
  const entry = join(root, 'src/tui.tsx')
  const refusals = [
    ['import "@cortexkit/antigravity-auth-core"', 'forbidden TUI external'],
    ['import "@cortexkit/common-auth/rpc"', 'forbidden compiler/common edge'],
    ['import "typescript"', 'forbidden compiler/common edge'],
    ['const edge = "./missing"; import(edge)', 'missing relative import'],
    ['import(process.env.EDGE)', 'unresolved variable import'],
    ['export * from "./rpc/rpc-server"', 'forbidden TUI source'],
    ['import "./common-auth-embedded/store/index.js"', 'forbidden TUI source'],
  ]
  await mkdir(join(root, 'src/rpc'), { recursive: true })
  await mkdir(join(root, 'src/common-auth-embedded/store'), { recursive: true })
  await writeFile(
    join(root, 'src/rpc/rpc-server.ts'),
    'export const server = 1',
  )
  await writeFile(
    join(root, 'src/common-auth-embedded/store/index.js'),
    'export const store = 1',
  )
  for (const [code, message] of refusals) {
    await writeFile(entry, `${code}\nexport default {}\n`)
    await expect(auditGraph(entry)).rejects.toThrow(message)
  }
  // Import-shaped comments/ordinary strings are not executable edges.
  await writeFile(
    entry,
    '/* import "./absent" */\nconst note = "import(unknown)"; export default note',
  )
  expect((await auditGraph(entry)).files).toHaveLength(1)
})

for (const [name, tree, entry] of [
  ['graph.raw', 'tui-raw', 'tui.tsx'],
  ['graph.runtime', 'tui-compiled', 'tui.js'],
] as const) {
  test(name, async () => {
    const graph = await auditGraph(join(product, 'src', tree, entry))
    const source = await auditGraph(join(product, 'src/tui.tsx'))
    const map = JSON.parse(
      await readFile(join(product, 'dist/tui-build-map.json'), 'utf8'),
    )
    const variant = tree === 'tui-raw' ? map.raw : map.runtime
    const expected = source.files
      .map((path) => {
        const emitted = variant.files.find(
          (file: { source: string }) => file.source === relative(product, path),
        )
        expect(emitted, `missing emitted source ${path}`).toBeDefined()
        return join(product, emitted.output)
      })
      .sort()
    expect(graph.files).toEqual(expected)
    expect(
      graph.files.every((path) => path.startsWith(join(product, 'src', tree))),
    ).toBe(true)
    expect(graph.files.some((path) => path.endsWith('selector.js'))).toBe(false)
    const path = join(product, 'src', tree, entry)
    const original = await readFile(path)
    try {
      await writeFile(
        path,
        `${original.toString()}\nexport * from "@cortexkit/common-auth/tui-build"\n`,
      )
      await expect(auditGraph(path)).rejects.toThrow(
        'forbidden compiler/common edge',
      )
    } finally {
      await writeFile(path, original)
    }
  })
}

test('graph.tui_client_narrow', async () => {
  const base = join(PACKAGE_ROOT, 'src/common-auth-embedded/rpc')
  const runtime = await auditGraph(join(base, 'client.js'))
  expect(runtime.files.map((path) => relative(base, path))).toEqual([
    'client.js',
    'port-file.js',
    'rpc-client.js',
  ])
  const types = await auditGraph(join(base, 'client.d.ts'), { types: true })
  expect(types.files.map((path) => relative(base, path))).toEqual([
    'client.d.ts',
    'index.d.ts',
    'notifications.d.ts',
    'port-file.d.ts',
    'rpc-client.d.ts',
    'rpc-server.d.ts',
    'server-registry.d.ts',
  ])
  // OpenCode 1's local TUI RPC client may reach only client-side embedded RPC modules.
  // Server declarations in the separate type graph must not pull in a server runtime barrel.
  const source = await auditGraph(join(product, 'src/tui.tsx'))
  const embedded = source.files.filter((path) =>
    path.includes('/common-auth-embedded/rpc/'),
  )
  if (embedded.length)
    expect(
      embedded.map((path) => path.slice(path.lastIndexOf('/rpc/') + 5)),
    ).toEqual(['client.js', 'port-file.js', 'rpc-client.js'])
})

test('graph.server_cli', async () => {
  for (const entry of ['index.ts', 'src/cli.ts']) {
    await auditGraph(join(PACKAGE_ROOT, entry), { tui: false })
    const result = await bundle({
      absWorkingDir: PACKAGE_ROOT,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['zod'],
      write: false,
      metafile: true,
    })
    checkMetafile(result.metafile!)
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        /tui-(raw|compiled)/.test(path),
      ),
    ).toBe(false)
  }
  expect(() =>
    checkMetafile({
      inputs: { 'tools/common-auth-build/tool.js': {} },
      outputs: {},
    }),
  ).toThrow('forbidden bundled input')
  expect(() =>
    checkMetafile({
      inputs: {},
      outputs: {
        'cli.js': {
          imports: [{ path: '@cortexkit/common-auth', external: true }],
        },
      },
    }),
  ).toThrow('forbidden compiler/common edge')
})

test('build.product_two_roots', async () => {
  const second = await fixture(true)
  const link = join(owned, 'linked-product')
  await symlink(second, link, 'dir')
  await buildTui({ packageRoot: link })
  for (const tree of ['src/tui-raw', 'src/tui-compiled']) {
    expect(await hashes(second, tree)).toEqual(await hashes(product, tree))
    for (const path of await inventory(join(second, tree))) {
      const code = await readFile(join(second, tree, path), 'utf8')
      expect(code).not.toContain(PACKAGE_ROOT)
      expect(code).not.toContain(owned)
    }
  }
}, 120000)

test('build.public_faults', async () => {
  const root = await fixture()
  await buildTui({ packageRoot: root })
  await rm(join(root, 'src/tui.tsx'))
  await expect(buildTui({ packageRoot: root })).rejects.toThrow()
  expect(await inventory(join(root, 'src'))).toEqual([])
  await writeFile(
    join(root, 'src/tui.tsx'),
    'export default () => <text>broken',
  )
  await expect(buildTui({ packageRoot: root })).rejects.toThrow()
  expect(await inventory(join(root, 'src'))).toEqual(['tui.tsx'])
  await writeFile(
    join(root, 'src/tui.tsx'),
    'export default () => <text>valid</text>',
  )
  // Omit the runtime tree from published files so their comparison deliberately fails
  // only after both raw and runtime compiler variants ran; both trees must then be removed.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'owned-refusal',
      version: '1.0.0',
      files: ['src/tui-raw/'],
    }),
  )
  await expect(buildTui({ packageRoot: root })).rejects.toThrow(
    'Published destination differs from emitted',
  )
  expect(await inventory(join(root, 'src'))).toEqual(['tui.tsx'])
}, 120000)

test('build.stale_removal', async () => {
  const root = await fixture()
  await buildTui({ packageRoot: root })
  for (const tree of ['tui-raw', 'tui-compiled'])
    await writeFile(join(root, 'src', tree, 'stale.js'), 'old artifact')
  await buildTui({ packageRoot: root })
  for (const tree of ['tui-raw', 'tui-compiled'])
    expect(await inventory(join(root, 'src', tree))).not.toContain('stale.js')
}, 120000)

test('build.map_admission_preserves_unowned', async () => {
  async function mapSnapshot(path: string) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!info) return { kind: 'missing' }
    if (info.isSymbolicLink())
      return {
        kind: 'symlink',
        target: await readlink(path),
        bytes: (await readFile(path)).toString('hex'),
      }
    if (info.isDirectory())
      return {
        kind: 'directory',
        files: await hashes(dirname(path), 'tui-build-map.json'),
      }
    return {
      kind: 'file',
      links: info.nlink,
      bytes: (await readFile(path)).toString('hex'),
    }
  }
  for (const kind of [
    'unrelated',
    'malformed',
    'wrong-schema',
    'wrong-compiler',
    'symlink',
    'hardlink',
    'directory',
  ]) {
    const root = await fixture()
    for (const tree of ['src/tui-raw', 'src/tui-compiled']) {
      await mkdir(join(root, tree), { recursive: true })
      await writeFile(
        join(root, tree, 'canary.js'),
        `export default ${JSON.stringify(tree)}\n`,
      )
    }
    await mkdir(join(root, 'dist'))
    const map = join(root, 'dist/tui-build-map.json')
    const valid = JSON.stringify({
      schema: 1,
      compiler: '@cortexkit/common-auth/tui-build@0.9.4',
    })
    if (kind === 'directory') {
      await mkdir(map)
      await writeFile(
        join(map, 'canary.json'),
        '{"owned":"directory content"}\n',
      )
    } else if (kind === 'symlink' || kind === 'hardlink') {
      const anchor = join(root, 'dist/map-anchor.json')
      await writeFile(anchor, valid)
      if (kind === 'symlink') await symlink(anchor, map)
      else await link(anchor, map)
    } else
      await writeFile(
        map,
        kind === 'malformed'
          ? 'unrelated non-JSON bytes\n'
          : JSON.stringify(
              kind === 'unrelated'
                ? { owned: 'unrelated content' }
                : kind === 'wrong-schema'
                  ? {
                      schema: 2,
                      compiler: '@cortexkit/common-auth/tui-build@0.9.4',
                    }
                  : { schema: 1, compiler: 'unrelated-compiler' },
            ),
      )
    const beforeMap = await mapSnapshot(map)
    const beforeRaw = await hashes(root, 'src/tui-raw')
    const beforeRuntime = await hashes(root, 'src/tui-compiled')
    await expect(buildTui({ packageRoot: root })).rejects.toThrow()
    expect(
      await mapSnapshot(map),
      `unowned map bytes survive admission refusal: ${kind}`,
    ).toEqual(beforeMap)
    expect(
      await hashes(root, 'src/tui-raw'),
      `raw canary preserved: ${kind}`,
    ).toEqual(beforeRaw)
    expect(
      await hashes(root, 'src/tui-compiled'),
      `runtime canary preserved: ${kind}`,
    ).toEqual(beforeRuntime)
  }
}, 120000)

test('build.map_admission_valid_generated', async () => {
  const root = await fixture()
  await buildTui({ packageRoot: root })
  const map = join(root, 'dist/tui-build-map.json')
  const raw = await hashes(root, 'src/tui-raw')
  const runtime = await hashes(root, 'src/tui-compiled')
  const generated = await readFile(map)
  await writeFile(join(root, 'src/tui-raw/stale.js'), 'previous raw output')
  await writeFile(
    join(root, 'src/tui-compiled/stale.js'),
    'previous runtime output',
  )
  await buildTui({ packageRoot: root })
  expect(await hashes(root, 'src/tui-raw')).toEqual(raw)
  expect(await hashes(root, 'src/tui-compiled')).toEqual(runtime)
  expect(await readFile(map)).toEqual(generated)
  await rm(join(root, 'src/tui.tsx'))
  await expect(buildTui({ packageRoot: root })).rejects.toThrow()
  expect(await inventory(join(root, 'src'))).toEqual([])
  await expect(readFile(map)).rejects.toThrow('ENOENT')
}, 120000)

test('build.selector_inert', async () => {
  await verifySelectors(product)
  const entry = await readFile(join(PACKAGE_ROOT, 'src/tui/entry.mjs'), 'utf8')
  const ast = ts.createSourceFile(
    'entry.mjs',
    entry,
    ts.ScriptTarget.Latest,
    true,
  )
  const imports = ast.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text)
  expect(imports).toEqual(['../common-auth-embedded/tui/index.js'])
  expect(entry).toContain("new URL('../tui-raw/tui.tsx', import.meta.url).href")
  expect(entry).toContain(
    "new URL('../tui-compiled/tui.js', import.meta.url).href",
  )
  expect(entry).toContain('export default await loadTui(')
  expect(entry).not.toContain('mod.tui')
  const copy = join(product, 'src/tui-raw/selector.js')
  const bytes = await readFile(copy)
  try {
    await writeFile(copy, '// altered selector fixture\n')
    await expect(verifySelectors(product)).rejects.toThrow(
      'differs from canonical',
    )
  } finally {
    await writeFile(copy, bytes)
  }
})

test('build.prerequisite_order', async () => {
  for (const path of ['package.json', 'packages/opencode/package.json']) {
    const pkg = JSON.parse(await readFile(join(repo, path), 'utf8'))
    for (const name of [
      'typecheck',
      'test',
      'lint',
      'format',
      'format:check',
      'build',
      'build:tui',
      'prepublishOnly',
      'smoke:tui',
    ])
      expect(
        pkg.scripts[name],
        `build.prerequisite_order: missing ${path} ${name}`,
      ).toStartWith('bun run embed:check && ')
    if (path === 'package.json')
      expect(pkg.scripts['test:e2e:opencode-v2:local']).not.toContain(
        'embed:check',
      )
  }
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'scripts/release.sh',
  ]) {
    const code = await readFile(join(repo, path), 'utf8')
    expect(code).toContain('1.4.2')
    expect(code).toContain(
      'bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts',
    )
    expect(code.indexOf('bun run embed:check')).toBeLessThan(
      code.indexOf('bun run typecheck'),
    )
  }
  for (const path of [
    'packages/opencode/tsconfig.json',
    'packages/opencode/tsconfig.build.json',
    'tsconfig.scripts.json',
  ]) {
    const cfg = ts.readConfigFile(join(repo, path), ts.sys.readFile).config
    const parsed = ts.parseJsonConfigFileContent(
      cfg,
      ts.sys,
      dirname(join(repo, path)),
    )
    expect(
      parsed.fileNames.some((path) => /\/tui-(raw|compiled)\//.test(path)),
    ).toBe(false)
    expect(
      parsed.fileNames.some((path) =>
        /\/common-auth-embedded\/.*\.js$/.test(path),
      ),
    ).toBe(false)
  }
})

test('identity.distinct_sources', async () => {
  const root = await fixture()
  for (const name of ['a', 'b']) {
    await mkdir(join(root, name))
    await writeFile(
      join(root, name, 'counter.ts'),
      'let counter = 0; export const next = () => ++counter\n',
    )
  }
  await writeFile(
    join(root, 'src/tui.tsx'),
    'import { next as a } from "../a/counter"; import { next as b } from "../b/counter"; export default () => [a(), b()]\n',
  )
  const program = ts.createProgram([join(root, 'src/tui.tsx')], {
    outDir: join(root, 'tsc'),
    rootDir: root,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
    skipLibCheck: false,
  })
  expect(ts.getPreEmitDiagnostics(program)).toHaveLength(0)
  expect(program.emit().emitSkipped).toBe(false)
  await buildTui({ packageRoot: root })
  for (const domain of ['server', 'cli'])
    await bundle({
      entryPoints: [join(root, 'src/tui.tsx')],
      outfile: join(root, `${domain}.js`),
      bundle: true,
      platform: 'node',
      format: 'esm',
    })
  for (const entry of [
    'src/tui.tsx',
    'tsc/src/tui.js',
    'server.js',
    'cli.js',
    'src/tui-raw/tui.tsx',
    'src/tui-compiled/tui.js',
  ]) {
    const mod = await import(pathToFileURL(join(root, entry)).href)
    expect(mod.default(), entry).toEqual([1, 1])
    expect(mod.default(), entry).toEqual([2, 2])
  }
  for (const tree of ['tui-raw', 'tui-compiled'])
    expect(
      (await inventory(join(root, 'src', tree))).filter((path) =>
        path.endsWith('-counter.js'),
      ),
    ).toHaveLength(2)
}, 120000)

test('pack.paths', async () => {
  await buildLibrary(product)
  const tar = await pack(product, join(owned, `tar-${serial++}`), 'npm', false)
  await inspectPack(tar, join(owned, `inspect-${serial++}`))
  const pkgPath = join(product, 'package.json'),
    original = await readFile(pkgPath)
  const pkg = JSON.parse(original.toString())
  pkg.files = pkg.files.filter((path: string) => path !== 'src/tui-raw/')
  try {
    await writeFile(pkgPath, JSON.stringify(pkg))
    const omitted = await pack(
      product,
      join(owned, `tar-${serial++}`),
      'npm',
      false,
    )
    await expect(
      inspectPack(omitted, join(owned, `inspect-${serial++}`)),
    ).rejects.toThrow('src/tui-raw')
  } finally {
    await writeFile(pkgPath, original)
  }
}, 120000)

test('pack.copy_order', async () => {
  const path = join(product, 'dist/src/common-auth-embedded/rpc/client.d.ts')
  const original = await readFile(path)
  try {
    await writeFile(path, 'export declare const wrongInferredFacade: boolean\n')
    const tar = await pack(
      product,
      join(owned, `tar-${serial++}`),
      'npm',
      false,
    )
    await expect(
      inspectPack(tar, join(owned, `inspect-${serial++}`)),
    ).rejects.toThrow(
      'pack.copy_order: dist/src/common-auth-embedded/rpc/client.d.ts',
    )
  } finally {
    await writeFile(path, original)
  }
}, 120000)

test('pack.regeneration_paths', async () => {
  const stale = join(product, 'src/tui-raw/stale.js')
  try {
    await writeFile(stale, 'old artifact')
    const tar = await pack(
      product,
      join(owned, `tar-${serial++}`),
      'npm',
      false,
    )
    await expect(
      inspectPack(tar, join(owned, `inspect-${serial++}`)),
    ).rejects.toThrow('pack.regeneration_paths: src/tui-raw')
  } finally {
    await rm(stale)
  }
}, 120000)

test('pack.repository_input_excluded', async () => {
  const path = join(product, 'tools/common-auth-build/inputs')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'fixture.tgz'), 'repository-only fixture')
  const pkgPath = join(product, 'package.json'),
    original = await readFile(pkgPath)
  const pkg = JSON.parse(original.toString())
  pkg.files.push('tools/')
  try {
    await writeFile(pkgPath, JSON.stringify(pkg))
    const tar = await pack(
      product,
      join(owned, `tar-${serial++}`),
      'bun',
      false,
    )
    await expect(
      inspectPack(tar, join(owned, `inspect-${serial++}`)),
    ).rejects.toThrow('pack.repository_input_excluded: private input shipped')
  } finally {
    await writeFile(pkgPath, original)
    await rm(join(product, 'tools'), { recursive: true, force: true })
  }
}, 120000)
