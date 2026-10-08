/**
 * Coordinate builds through the published TUI compiler API in the separately
 * installed tools/common-auth-build toolchain. That API owns TUI emission,
 * output naming and transforms; this script independently checks the graphs.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { parse } from 'jsonc-parser'
import ts from 'typescript'
import { embedCommonAuth, sha256 } from './embed-common-auth'

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const TOOL_ROOT = join(REPO_ROOT, 'tools/common-auth-build')
const LOCK_HASH =
  'c2f8b23860f7438cf825295bf68b4693d5ea117f6bb7c2877783dca6ea50b3f7'
export interface Graph {
  files: string[]
  externals: string[]
}
export interface TuiMap {
  schema: number
  compiler: string
  bun: string
  raw: VariantMap
  runtime: VariantMap
}
interface VariantMap {
  selector: string
  externals: string[]
  files: {
    source: string
    output: string
    bytes: number
    sha256: string
    transform: string
  }[]
}
const portable = (path: string) => path.split('\\').join('/')
const externalLeaves = new Set([
  '@cortexkit/antigravity-auth-core/atomic-write',
  '@cortexkit/antigravity-auth-core/file-lock',
  // The existing RPC client uses fetchWithActiveTimeout for request budgets.
  // Timeout policy belongs to that client/core helper, not the TUI build, so
  // retain this leaf as an external dependency rather than emitting a private copy.
  '@cortexkit/antigravity-auth-core/fetch-timeout',
  'jsonc-parser',
  'xdg-basedir',
  '@opencode-ai/plugin/tui',
  '@opentui/core',
  '@opentui/core/testing',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
])
function checkExternal(specifier: string, tui: boolean, types: boolean) {
  const name = specifier.startsWith('opentui:runtime-module:')
    ? decodeURIComponent(specifier.slice('opentui:runtime-module:'.length))
    : specifier
  if (name.startsWith('node:')) return
  if (
    name.startsWith('@cortexkit/common-auth') ||
    name.includes('common-auth-build') ||
    /^(?:typescript|esbuild|tsx|@babel\/)/.test(name)
  )
    throw new Error(`graph: forbidden compiler/common edge ${specifier}`)
  if (tui && !types && !externalLeaves.has(name))
    throw new Error(`graph: forbidden TUI external ${specifier}`)
}

/**
 * Independently check imports and re-exports, plus import()/require() targets
 * expressed as string literals, const aliases or string concatenations. Refuse
 * unresolved dynamic targets; follow type-only edges only for the type closure.
 */
export async function auditGraph(
  entry: string,
  { tui = true, types = false } = {},
): Promise<Graph> {
  const files = new Set<string>()
  const externals = new Set<string>()
  async function visit(path: string): Promise<void> {
    path = realpathSync(path)
    if (files.has(path)) return
    const embedded = portable(path).split('/common-auth-embedded/')[1]
    if (
      embedded &&
      !types &&
      !(
        tui
          ? /^(?:rpc\/(?:client|port-file|rpc-client)|logger\/(?:index|engine|capture-sink|redact))\.js$/
          : /^(?:rpc\/(?:index|client|port-file|rpc-client|rpc-server|server-registry|notifications)|logger\/(?:index|engine|capture-sink|redact))\.js$/
      ).test(embedded)
    )
      throw new Error(`graph: forbidden TUI source ${path}`)
    if (
      tui &&
      !types &&
      /(?:\/rpc\/(?:index|rpc-server|server-registry)\.[jt]s$|\/plugin\/(?:storage|accounts|account-manager|account-storage|quota|rotation|logger|debug)\.|\/common-auth-embedded\/(?:fs|store)\/|\/tools\/)/.test(
        portable(path),
      )
    )
      throw new Error(`graph: forbidden TUI source ${path}`)
    files.add(path)
    const source = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const constants = new Map<string, ts.Expression>()
    function collect(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
      )
        constants.set(node.name.text, node.initializer)
      ts.forEachChild(node, collect)
    }
    collect(source)
    function literal(
      node: ts.Expression,
      seen = new Set<string>(),
    ): string | undefined {
      if (ts.isStringLiteralLike(node)) return node.text
      if (ts.isIdentifier(node) && !seen.has(node.text)) {
        seen.add(node.text)
        const value = constants.get(node.text)
        if (value) return literal(value, seen)
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = literal(node.left, new Set(seen)),
          right = literal(node.right, new Set(seen))
        if (left !== undefined && right !== undefined) return left + right
      }
      return undefined
    }
    const imports: string[] = []
    function inspect(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const typeOnly =
          clause?.isTypeOnly ||
          (clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((item) => item.isTypeOnly))
        if (types || !typeOnly)
          imports.push((node.moduleSpecifier as ts.StringLiteral).text)
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        (types || !node.isTypeOnly)
      ) {
        const bindings = node.exportClause
        if (
          types ||
          !bindings ||
          !ts.isNamedExports(bindings) ||
          !bindings.elements.every((item) => item.isTypeOnly)
        )
          imports.push((node.moduleSpecifier as ts.StringLiteral).text)
      } else if (
        ts.isImportTypeNode(node) &&
        types &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        imports.push(node.argument.literal.text)
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        const value = node.arguments[0] && literal(node.arguments[0])
        if (value === undefined)
          throw new Error(`graph: unresolved variable import in ${path}`)
        imports.push(value)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        if (/[?#]/.test(specifier))
          throw new Error(`graph: duplicate module identity ${specifier}`)
        const base = resolve(dirname(path), specifier)
        const stem = base.replace(/\.[cm]?jsx?$/, '')
        const candidates = types
          ? [`${stem}.d.ts`, base, `${base}.d.ts`]
          : [base]
        candidates.push(
          `${stem}.ts`,
          `${stem}.tsx`,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.js`,
          join(base, 'index.ts'),
          join(base, 'index.js'),
        )
        const isFile = (candidate: string) =>
          existsSync(candidate) && statSync(candidate).isFile()
        const target =
          candidates.find(
            (candidate) =>
              isFile(candidate) && (!types || candidate.endsWith('.d.ts')),
          ) ?? (types ? candidates.find(isFile) : undefined)
        if (!target)
          throw new Error(
            `graph: missing relative import ${specifier} in ${path}`,
          )
        await visit(target)
      } else {
        if (isAbsolute(specifier) || specifier.startsWith('file:'))
          throw new Error(`graph: absolute import ${specifier}`)
        checkExternal(specifier, tui, types)
        externals.add(specifier)
      }
    }
  }
  await visit(entry)
  return { files: [...files].sort(), externals: [...externals].sort() }
}

export async function verifyPrerequisites(): Promise<void> {
  if (Bun.version !== '1.4.2')
    throw new Error('build.prerequisite_order: requires Bun 1.4.2')
  await embedCommonAuth(REPO_ROOT, true)
  if (sha256(await readFile(join(TOOL_ROOT, 'bun.lock'))) !== LOCK_HASH)
    throw new Error('build.prerequisite_order: private Bun lock mismatch')
  const manifest = JSON.parse(
    await readFile(join(TOOL_ROOT, 'package.json'), 'utf8'),
  )
  const lock = parse(await readFile(join(TOOL_ROOT, 'bun.lock'), 'utf8'))
  if (
    JSON.stringify(manifest.dependencies) !==
    JSON.stringify(lock.workspaces[''].dependencies)
  )
    throw new Error(
      'build.prerequisite_order: private manifest differs from lock',
    )
  for (const [name, entry] of Object.entries(lock.packages) as [
    string,
    unknown[],
  ][]) {
    if (
      name.startsWith('@opentui/core-') &&
      !name.endsWith(`${process.platform}-${process.arch}`)
    )
      continue
    const path = join(
      TOOL_ROOT,
      'node_modules',
      (name.match(/(?:@[^/]+\/)?[^/]+/g) ?? []).join('/node_modules/'),
      'package.json',
    )
    const actual = realpathSync(path)
    if (!actual.startsWith(`${realpathSync(TOOL_ROOT)}/node_modules/`))
      throw new Error(`build.prerequisite_order: private root escaped ${name}`)
    const pkg = JSON.parse(await readFile(actual, 'utf8'))
    const expected =
      name === '@cortexkit/common-auth'
        ? '@cortexkit/common-auth@inputs/cortexkit-common-auth-0.11.6.tgz'
        : `${pkg.name}@${pkg.version}`
    if (entry[0] !== expected)
      throw new Error(
        `build.prerequisite_order: installed lock mismatch ${name}`,
      )
  }
}

export async function checkEmbeddedTypes(): Promise<void> {
  const graph = await auditGraph(
    join(PACKAGE_ROOT, 'src/common-auth-embedded/rpc/client.d.ts'),
    { types: true },
  )
  const roots = (
    await inventory(join(PACKAGE_ROOT, 'src/common-auth-embedded'))
  )
    .filter((path) => path.endsWith('.d.ts'))
    .map((path) => join(PACKAGE_ROOT, 'src/common-auth-embedded', path))
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram(roots, {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module,
      moduleResolution,
      types: ['node'],
      typeRoots: [join(REPO_ROOT, 'node_modules/@types')],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => PACKAGE_ROOT,
          getCanonicalFileName: (name) => name,
          getNewLine: () => '\n',
        }),
      )
  }
  console.log(
    `Embedded declarations: ${roots.length} strict roots in NodeNext/Bundler; client TYPE closure ${graph.files.length} files`,
  )
}

export async function inventory(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory())
      result.push(
        ...(await inventory(join(directory, item.name))).map(
          (path) => `${item.name}/${path}`,
        ),
      )
    else if (item.isFile()) result.push(item.name)
    else throw new Error(`artifact: nonregular ${join(directory, item.name)}`)
  }
  return result.sort()
}

export async function verifySelectors(packageRoot: string): Promise<void> {
  const canonical = await readFile(
    join(REPO_ROOT, 'packages/opencode/src/common-auth-embedded/tui/index.js'),
  )
  for (const tree of ['tui-raw', 'tui-compiled']) {
    if (
      !(await readFile(join(packageRoot, 'src', tree, 'selector.js'))).equals(
        canonical,
      )
    )
      throw new Error(
        `build.selector_inert: ${tree}/selector.js differs from canonical`,
      )
    const graph = await auditGraph(
      join(packageRoot, 'src', tree, tree === 'tui-raw' ? 'tui.tsx' : 'tui.js'),
    )
    if (graph.files.some((path) => path.endsWith('/selector.js')))
      throw new Error('build.selector_inert: imported selector copy')
  }
}

function run(command: string, args: string[], cwd = PACKAGE_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} refused: ${result.error ?? result.stderr ?? result.stdout}`,
    )
  if (result.stdout) process.stdout.write(result.stdout)
}

export async function buildTui({
  packageRoot = PACKAGE_ROOT,
  entry = 'src/tui.tsx',
} = {}): Promise<TuiMap> {
  packageRoot = await admitProductPaths(packageRoot)
  const entryRelative = relative(packageRoot, resolve(packageRoot, entry))
  if (entryRelative.startsWith('..') || isAbsolute(entryRelative))
    throw new Error('build: entry escaped package root')
  const raw = join(packageRoot, 'src/tui-raw'),
    runtime = join(packageRoot, 'src/tui-compiled')
  const mapFile = join(packageRoot, 'dist/tui-build-map.json')
  try {
    await verifyPrerequisites()
    await auditGraph(join(packageRoot, entry))
    await auditGraph(join(packageRoot, entry), { types: true })
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    run(
      process.execPath,
      [
        join(TOOL_ROOT, 'build.mjs'),
        '--package-root',
        resolve(packageRoot),
        '--entry',
        resolve(packageRoot, entry),
        '--raw-dir',
        raw,
        '--runtime-dir',
        runtime,
        '--map',
        mapFile,
      ],
      packageRoot,
    )
    await verifySelectors(packageRoot)
    const map: TuiMap = JSON.parse(await readFile(mapFile, 'utf8'))
    for (const [variant, tree] of [
      [map.raw, raw],
      [map.runtime, runtime],
    ] as const) {
      const outputs = variant.files
        .map((file) => portable(relative(tree, join(packageRoot, file.output))))
        .sort()
      if (JSON.stringify(outputs) !== JSON.stringify(await inventory(tree)))
        throw new Error('graph: emitted inventory mismatch')
      for (const file of variant.files) {
        const bytes = await readFile(join(packageRoot, file.output))
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
          throw new Error(`graph: emitted hash mismatch ${file.output}`)
        if (!file.output.endsWith('/selector.js'))
          await auditGraph(join(packageRoot, file.output))
      }
      for (const edge of variant.externals) checkExternal(edge, true, false)
    }
    return map
  } catch (error) {
    await Promise.all(
      [raw, runtime, mapFile].map((path) =>
        rm(path, { force: true, recursive: true }),
      ),
    )
    throw error
  }
}

export function checkMetafile(meta: {
  inputs: Record<string, unknown>
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>
}) {
  for (const path of Object.keys(meta.inputs)) {
    if (
      /tools\/common-auth-build|node_modules\/@cortexkit\/common-auth|tui-build\//.test(
        portable(path),
      )
    )
      throw new Error(`graph.server_cli: forbidden bundled input ${path}`)
  }
  for (const output of Object.values(meta.outputs))
    for (const edge of output.imports)
      if (edge.external) checkExternal(edge.path, false, false)
}

/** Reject linked output paths and maps outside the generated format before cleanup. These checks do not lock paths against concurrent changes. */
async function admitProductPaths(packageRoot: string) {
  const root = await realpath(packageRoot)
  for (const name of ['src', 'dist', 'src/tui-raw', 'src/tui-compiled']) {
    const info = await lstat(join(root, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      },
    )
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`build: output directory alias refused ${name}`)
  }
  const mapFile = join(root, 'dist/tui-build-map.json')
  const existingMap = await lstat(mapFile).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  if (existingMap) {
    if (
      !existingMap.isFile() ||
      existingMap.isSymbolicLink() ||
      existingMap.nlink !== 1
    )
      throw new Error('build: TUI map must be a regular unaliased file')
    let metadata: unknown
    try {
      metadata = JSON.parse(await readFile(mapFile, 'utf8'))
    } catch {
      throw new Error('build: existing TUI map is not owned generated metadata')
    }
    // Match the producer's schema 1 and compiler marker before allowing map cleanup.
    // Preserve malformed or unrelated files when build admission fails.
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('schema' in metadata) ||
      metadata.schema !== 1 ||
      !('compiler' in metadata) ||
      (metadata.compiler !== '@cortexkit/common-auth/tui-build@0.9.4' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.11.4' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.11.6')
    )
      throw new Error('build: existing TUI map is not owned generated metadata')
  }
  return root
}

export async function buildLibrary(packageRoot = PACKAGE_ROOT) {
  packageRoot = await admitProductPaths(packageRoot)
  try {
    await verifyPrerequisites()
    await checkEmbeddedTypes()
    await rm(join(packageRoot, 'dist'), { recursive: true, force: true })
    run(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.build.json',
      ],
      packageRoot,
    )
    // tsc must finish before copying supplied declarations: it must not emit inferred JS facades over them.
    await cp(
      join(packageRoot, 'src/common-auth-embedded'),
      join(packageRoot, 'dist/src/common-auth-embedded'),
      { recursive: true },
    )
    for (const [entry, name] of [
      ['index.ts', 'index'],
      ['src/cli.ts', 'cli'],
    ] as const) {
      await auditGraph(join(packageRoot, entry), { tui: false })
      const result = await bundle({
        absWorkingDir: packageRoot,
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['zod'],
        outfile: `dist/${name}.js`,
        sourcemap: true,
        metafile: true,
        banner: name === 'cli' ? { js: '#!/usr/bin/env node' } : undefined,
      })
      checkMetafile(result.metafile!)
      await Bun.write(
        join(packageRoot, `dist/${name}.meta.json`),
        `${JSON.stringify(result.metafile, null, 2)}\n`,
      )
    }
    run('chmod', ['0755', 'dist/cli.js'], packageRoot)
    await buildTui({ packageRoot })
    console.log(
      'Product build: tsc, canonical copy, 2 audited bundles, raw/runtime TUI',
    )
  } catch (error) {
    await Promise.all(
      ['dist', 'src/tui-raw', 'src/tui-compiled'].map((path) =>
        rm(join(packageRoot, path), { recursive: true, force: true }),
      ),
    )
    throw error
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (
    args.length > 1 ||
    (args[0] && !['--check', '--types', '--library'].includes(args[0]))
  )
    throw new Error('Usage: bun build-tui.ts [--check|--types|--library]')
  if (args[0] === '--check') {
    await verifyPrerequisites()
    console.log('Embedding and private Bun-lock roots verified (Bun 1.4.2)')
  } else if (args[0] === '--types') {
    await verifyPrerequisites()
    await checkEmbeddedTypes()
  } else if (args[0] === '--library') await buildLibrary()
  else await buildTui()
}
