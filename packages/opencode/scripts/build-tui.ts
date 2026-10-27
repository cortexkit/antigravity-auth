/**
 * Coordinate builds through the published TUI compiler API in the separately
 * installed tools/common-auth-build toolchain. That API owns TUI emission,
 * output naming and transforms; this script independently checks the graphs.
 */
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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { parse } from 'jsonc-parser'
import ts from 'typescript'

import { embedCommonAuth, sha256 } from './embed-common-auth'
import { type CommandResult, runCommand } from './run-command'

const phaseClockKey = Symbol.for('cortexkit.build-phase-clock')
type PhaseClockHooks = {
  phase: <T>(name: string, action: () => Promise<T>) => Promise<T>
  sync: <T>(name: string, action: () => T) => T
  note: (name: string, detail: string) => void
  child?: <
    T extends Pick<CommandResult, 'pid' | 'status' | 'signal' | 'error'>,
  >(
    command: string,
    argc: number,
    action: () => Promise<T>,
  ) => Promise<T>
}
function phaseClockHooks() {
  return (
    globalThis as typeof globalThis & {
      [key: symbol]: PhaseClockHooks | undefined
    }
  )[phaseClockKey]
}

// Hermetic build fixtures copy this script without repository-root test helpers.
// Tests may install clock hooks; copied builds need no repository-root clock helper.
export function buildPhase<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const hooks = phaseClockHooks()
  return hooks ? hooks.phase(name, action) : action()
}
export function buildSyncPhase<T>(name: string, action: () => T): T {
  const hooks = phaseClockHooks()
  return hooks ? hooks.sync(name, action) : action()
}
export function buildPhaseNote(name: string, detail: string) {
  phaseClockHooks()?.note(name, detail)
}

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const TOOL_ROOT = join(REPO_ROOT, 'tools/common-auth-build')
const LOCK_HASH =
  'f83a5ecd0f5f275db3945099e7a8f18475b70a60d3882ecc013727e301e45f3b'
export const BUNDLE_EXTERNALS = [
  'zod',
  'jsonc-parser',
  '@cortexkit/private-files',
  '@cortexkit/claustrum-client',
  '@cortexkit/subc-client',
]
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

/**
 * One compiled TUI root: a source entry and the raw and runtime trees the
 * private compiler emits for it, with its own map. The OpenCode 1 root is the
 * sidebar/dialog plugin in src/tui.tsx; the GA root is the OpenCode 2 module
 * in src/ga/tui/host-ga.tsx. Both go through the same compiler, so both
 * runtime trees import only the host's registered runtime modules.
 */
export interface TuiRoot {
  readonly name: 'v1' | 'ga'
  readonly entry: string
  readonly raw: string
  readonly runtime: string
  readonly map: string
  readonly rawEntry: string
  readonly runtimeEntry: string
}
export const V1_TUI_ROOT: TuiRoot = {
  name: 'v1',
  entry: 'src/tui.tsx',
  raw: 'src/tui-raw',
  runtime: 'src/tui-compiled',
  map: 'dist/tui-build-map.json',
  rawEntry: 'tui.tsx',
  runtimeEntry: 'tui.js',
}
export const GA_TUI_ROOT: TuiRoot = {
  name: 'ga',
  entry: 'src/ga/tui/host-ga.tsx',
  raw: 'src/tui-ga-raw',
  runtime: 'src/tui-ga-compiled',
  map: 'dist/tui-ga-build-map.json',
  rawEntry: 'host-ga.tsx',
  runtimeEntry: 'host-ga.js',
}
export const TUI_ROOTS: readonly TuiRoot[] = [V1_TUI_ROOT, GA_TUI_ROOT]

/**
 * The GA root reaches only the shared drawer, the host-neutral menu types,
 * the sidebar projection and the shared quota layout: no OpenCode 1 RPC, port
 * file, sidebar file, preferences, file logger, OpenCode 1 adapter or
 * embedded library module.
 */
const GA_FORBIDDEN_SOURCE =
  /\/(?:rpc|plugin|antigravity|hooks)\/|\/ga\/(?:server|rpc)\/|\/common-auth-embedded\/(?!quota\/(?:index|codec|format|map|merge|projection)(?:\.d)?\.[jt]s$)|\/(?:sidebar-state|tui-preferences|constants)\.ts$|\/tui\/(?:file-logger|host-v1)\.tsx?$/
/** The only bare packages GA source may import; the host supplies each one. */
const GA_EXTERNALS = new Set([
  'solid-js',
  'solid-js/store',
  '@opentui/core',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
])
const RUNTIME_MODULE = 'opentui:runtime-module:'

/** Applies the GA root's narrower graph policy to an audited graph. */
export function checkGaGraph(
  graph: Graph,
  emitted: 'source' | 'raw' | 'runtime',
  packageRoot: string = PACKAGE_ROOT,
) {
  for (const path of graph.files) {
    const rel = relative(packageRoot, path)
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith('../') ||
      isAbsolute(rel)
    )
      throw new Error(`graph.ga: forbidden GA source ${path}`)
    const candidate = `/${portable(rel)}`
    if (GA_FORBIDDEN_SOURCE.test(candidate))
      throw new Error(`graph.ga: forbidden GA source ${path}`)
  }
  for (const edge of graph.externals) {
    if (emitted === 'runtime') {
      // Emitted runtime code must name host runtime modules, never a package
      // or a development alias the host does not register.
      if (
        !edge.startsWith(RUNTIME_MODULE) ||
        !GA_EXTERNALS.has(decodeURIComponent(edge.slice(RUNTIME_MODULE.length)))
      )
        throw new Error(`graph.ga: runtime edge is not a host module ${edge}`)
    } else if (!GA_EXTERNALS.has(edge))
      throw new Error(`graph.ga: forbidden GA external ${edge}`)
  }
}
const externalLeaves = new Set([
  '@cortexkit/private-files',
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
  {
    tui = true,
    types = false,
    packageRoot = PACKAGE_ROOT,
  }: { tui?: boolean; types?: boolean; packageRoot?: string } = {},
): Promise<Graph> {
  const rootDir = existsSync(packageRoot)
    ? realpathSync(packageRoot)
    : resolve(packageRoot)
  const files = new Set<string>()
  const externals = new Set<string>()
  async function visit(path: string): Promise<void> {
    path = realpathSync(path)
    if (files.has(path)) return
    const candidate = isInsideDirectory(rootDir, path)
      ? `/${portable(relative(rootDir, path))}`
      : portable(path)
    const embedded = candidate.split('/common-auth-embedded/')[1]
    if (
      embedded &&
      !types &&
      !(
        tui
          ? /^(?:rpc\/(?:client|port-file|rpc-client)|logger\/(?:index|engine|capture-sink|redact)|fs\/private-files|quota\/(?:index|codec|format|map|merge|projection))\.js$/
          : /^(?:rpc\/(?:index|client|port-file|rpc-client|rpc-server|server-registry|notifications)|logger\/(?:index|engine|capture-sink|redact)|quota\/(?:index|codec|format|map|merge|projection)|(?:auth-menu|claustrum|commands|fs|routing|setup|store)\/[a-z-]+|util\/any-signal)\.js$/
      ).test(embedded)
    )
      throw new Error(`graph: forbidden TUI source ${path}`)
    if (
      tui &&
      !types &&
      /(?:\/rpc\/(?:index|rpc-server|server-registry)\.[jt]s$|\/plugin\/(?:storage|accounts|account-manager|account-storage|quota|rotation|logger|debug)\.|\/common-auth-embedded\/(?:fs\/(?!private-files\.js$)|store\/)|\/tools\/)/.test(
        candidate,
      )
    )
      throw new Error(`graph: forbidden TUI source ${path}`)
    files.add(path)
    const source = ts.createSourceFile(
      path,
      await buildPhase(`auditGraph.readFile ${path}`, () =>
        readFile(path, 'utf8'),
      ),
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
        await buildPhase(`auditGraph.visit ${target}`, () => visit(target))
      } else {
        if (isAbsolute(specifier) || specifier.startsWith('file:'))
          throw new Error(`graph: absolute import ${specifier}`)
        checkExternal(specifier, tui, types)
        externals.add(specifier)
      }
    }
  }
  await buildPhase(`auditGraph.visit entry ${entry}`, () => visit(entry))
  return { files: [...files].sort(), externals: [...externals].sort() }
}

// Compares with path.relative so the check also holds for Windows separators
// and drive-letter paths, not only POSIX `/`.
function isInsideDirectory(directory: string, path: string): boolean {
  const inside = relative(directory, path)
  return (
    inside !== '' &&
    inside !== '..' &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside)
  )
}

export async function verifyPrerequisites(): Promise<void> {
  if (Bun.version !== '1.4.2')
    throw new Error('build.prerequisite_order: requires Bun 1.4.2')
  await buildPhase('prerequisites.embedCommonAuth check', () =>
    embedCommonAuth(REPO_ROOT, true),
  )
  if (
    sha256(
      await buildPhase('prerequisites.readFile lock bytes', () =>
        readFile(join(TOOL_ROOT, 'bun.lock')),
      ),
    ) !== LOCK_HASH
  )
    throw new Error('build.prerequisite_order: private Bun lock mismatch')
  const manifest = JSON.parse(
    await buildPhase('prerequisites.readFile manifest', () =>
      readFile(join(TOOL_ROOT, 'package.json'), 'utf8'),
    ),
  )
  const lock = parse(
    await buildPhase('prerequisites.readFile lock text', () =>
      readFile(join(TOOL_ROOT, 'bun.lock'), 'utf8'),
    ),
  )
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
    if (
      !isInsideDirectory(join(realpathSync(TOOL_ROOT), 'node_modules'), actual)
    )
      throw new Error(`build.prerequisite_order: private root escaped ${name}`)
    const pkg = JSON.parse(
      await buildPhase(`prerequisites.readFile ${actual}`, () =>
        readFile(actual, 'utf8'),
      ),
    )
    const expected =
      name === '@cortexkit/common-auth'
        ? '@cortexkit/common-auth@inputs/cortexkit-common-auth-0.24.0.tgz'
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
  for (const item of await buildPhase(`inventory.readdir ${directory}`, () =>
    readdir(directory, { withFileTypes: true }),
  )) {
    if (item.isDirectory())
      result.push(
        ...(
          await buildPhase(`inventory.descend ${item.name}`, () =>
            inventory(join(directory, item.name)),
          )
        ).map((path) => `${item.name}/${path}`),
      )
    else if (item.isFile()) result.push(item.name)
    else throw new Error(`artifact: nonregular ${join(directory, item.name)}`)
  }
  return result.sort()
}

export async function verifySelectors(
  packageRoot: string,
  root: TuiRoot = V1_TUI_ROOT,
): Promise<void> {
  const canonical = await buildPhase('selectors.readFile canonical', () =>
    readFile(
      join(
        REPO_ROOT,
        'packages/opencode/src/common-auth-embedded/tui/index.js',
      ),
    ),
  )
  for (const [tree, entry] of [
    [root.raw, root.rawEntry],
    [root.runtime, root.runtimeEntry],
  ] as const) {
    if (
      !(
        await buildPhase(`selectors.readFile ${tree}/selector.js`, () =>
          readFile(join(packageRoot, tree, 'selector.js')),
        )
      ).equals(canonical)
    )
      throw new Error(
        `build.selector_inert: ${tree.slice('src/'.length)}/selector.js differs from canonical`,
      )
    const graph = await buildPhase(
      `selectors.auditGraph ${tree}/${entry}`,
      () => auditGraph(join(packageRoot, tree, entry), { packageRoot }),
    )
    if (graph.files.some((path) => path.endsWith('/selector.js')))
      throw new Error('build.selector_inert: imported selector copy')
  }
}

async function run(command: string, args: string[], cwd = PACKAGE_ROOT) {
  const execute = () => runCommand(command, args, { cwd, deadlineMs: 120_000 })
  const observe = phaseClockHooks()?.child
  const result = await buildPhase(
    `child spawn: ${command} ${args.join(' ')} (cwd ${cwd})`,
    () => (observe ? observe(command, args.length, execute) : execute()),
  )
  buildPhaseNote(
    'child exit',
    JSON.stringify({
      command,
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      error: String(result.error ?? ''),
    }),
  )
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} refused: ${result.error ?? result.stderr ?? result.stdout}`,
    )
  if (result.stdout) process.stdout.write(result.stdout)
}

export async function buildTui({
  packageRoot = PACKAGE_ROOT,
  root = V1_TUI_ROOT,
}: {
  packageRoot?: string
  root?: TuiRoot
} = {}): Promise<TuiMap> {
  packageRoot = await buildPhase('buildTui.admitProductPaths', () =>
    admitProductPaths(packageRoot),
  )
  const entry = root.entry
  const entryRelative = relative(packageRoot, resolve(packageRoot, entry))
  if (entryRelative.startsWith('..') || isAbsolute(entryRelative))
    throw new Error('build: entry escaped package root')
  const raw = join(packageRoot, root.raw),
    runtime = join(packageRoot, root.runtime)
  const mapFile = join(packageRoot, root.map)
  const ga = root.name === 'ga'
  try {
    await buildPhase('buildTui.verifyPrerequisites', () =>
      verifyPrerequisites(),
    )
    const source = await buildPhase(`buildTui.auditGraph source ${entry}`, () =>
      auditGraph(join(packageRoot, entry), { packageRoot }),
    )
    const types = await buildPhase(`buildTui.auditGraph types ${entry}`, () =>
      auditGraph(join(packageRoot, entry), { types: true, packageRoot }),
    )
    if (ga) {
      checkGaGraph(source, 'source', packageRoot)
      checkGaGraph(types, 'source', packageRoot)
    }
    await buildPhase('buildTui.mkdir dist', () =>
      mkdir(join(packageRoot, 'dist'), { recursive: true }),
    )
    await run(
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
    await buildPhase('buildTui.verifySelectors', () =>
      verifySelectors(packageRoot, root),
    )
    const map: TuiMap = JSON.parse(
      await buildPhase(`buildTui.readFile ${root.map}`, () =>
        readFile(mapFile, 'utf8'),
      ),
    )
    for (const [variant, tree] of [
      [map.raw, raw],
      [map.runtime, runtime],
    ] as const) {
      const outputs = variant.files
        .map((file) => portable(relative(tree, join(packageRoot, file.output))))
        .sort()
      if (
        JSON.stringify(outputs) !==
        JSON.stringify(
          await buildPhase(`buildTui.inventory ${tree}`, () => inventory(tree)),
        )
      )
        throw new Error('graph: emitted inventory mismatch')
      for (const file of variant.files) {
        const bytes = await buildPhase(`buildTui.readFile ${file.output}`, () =>
          readFile(join(packageRoot, file.output)),
        )
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
          throw new Error(`graph: emitted hash mismatch ${file.output}`)
        if (!file.output.endsWith('/selector.js')) {
          const emitted = await buildPhase(
            `buildTui.auditGraph emitted ${file.output}`,
            () => auditGraph(join(packageRoot, file.output), { packageRoot }),
          )
          if (ga)
            checkGaGraph(
              emitted,
              variant === map.raw ? 'raw' : 'runtime',
              packageRoot,
            )
        }
      }
      for (const edge of variant.externals) checkExternal(edge, true, false)
    }
    return map
  } catch (error) {
    await buildPhase('buildTui.failure cleanup', () =>
      Promise.all(
        [raw, runtime, mapFile].map((path) =>
          buildPhase(`buildTui.rm ${path}`, () =>
            rm(path, { force: true, recursive: true }),
          ),
        ),
      ),
    )
    throw error
  }
}

/**
 * Builds every TUI root in order. A failure in any root removes the outputs
 * of all roots, so a package never ships one host's tree without the other's.
 */
export async function buildTuiRoots({
  packageRoot = PACKAGE_ROOT,
} = {}): Promise<Record<TuiRoot['name'], TuiMap>> {
  const maps = {} as Record<TuiRoot['name'], TuiMap>
  // Admission runs before the try: a refused (unowned or aliased) output path
  // must survive, so cleanup only follows a build that was admitted.
  const admitted = await buildPhase('buildTuiRoots.admitProductPaths', () =>
    admitProductPaths(packageRoot),
  )
  try {
    for (const root of TUI_ROOTS)
      maps[root.name] = await buildPhase(`buildTuiRoots.${root.name}`, () =>
        buildTui({ packageRoot: admitted, root }),
      )
    return maps
  } catch (error) {
    await buildPhase('buildTuiRoots.failure cleanup', () =>
      Promise.all(
        TUI_ROOTS.flatMap((root) => [root.raw, root.runtime, root.map]).map(
          (path) =>
            buildPhase(`buildTuiRoots.rm ${path}`, () =>
              rm(join(admitted, path), { recursive: true, force: true }),
            ),
        ),
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
      /tools\/common-auth-build|node_modules\/@cortexkit\/(?:common-auth|private-files)|tui-build\//.test(
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
  const root = await buildPhase(`admission.realpath ${packageRoot}`, () =>
    realpath(packageRoot),
  )
  for (const name of [
    'src',
    'dist',
    ...TUI_ROOTS.flatMap((root) => [root.raw, root.runtime]),
  ]) {
    const info = await buildPhase(`admission.lstat ${name}`, () =>
      lstat(join(root, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      }),
    )
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`build: output directory alias refused ${name}`)
  }
  for (const tuiRoot of TUI_ROOTS)
    await buildPhase(`admission.map ${tuiRoot.map}`, () =>
      admitExistingMap(join(root, tuiRoot.map)),
    )
  return root
}

async function admitExistingMap(mapFile: string) {
  const existingMap = await buildPhase(`admission.lstat map ${mapFile}`, () =>
    lstat(mapFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    }),
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
      metadata = JSON.parse(
        await buildPhase(`admission.readFile map ${mapFile}`, () =>
          readFile(mapFile, 'utf8'),
        ),
      )
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
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.13.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.14.1' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.14.2' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.15.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.16.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.19.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.21.1' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.22.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.23.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.24.0' &&
        metadata.compiler !== '@cortexkit/common-auth/tui-build@0.11.6')
    )
      throw new Error('build: existing TUI map is not owned generated metadata')
  }
}

export async function buildLibrary(packageRoot = PACKAGE_ROOT) {
  packageRoot = await admitProductPaths(packageRoot)
  try {
    await verifyPrerequisites()
    await checkEmbeddedTypes()
    await rm(join(packageRoot, 'dist'), { recursive: true, force: true })
    await run(
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
    // The root export's declarations keep source specifiers (`./x.ts`,
    // `./dir`) that installed packages cannot resolve; rewrite them to the
    // compiled `.js` paths here, so every build of this tree is finalized.
    await run(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/finalize-declaration-specifiers.ts'),
        'dist',
        '.',
      ],
      packageRoot,
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
        external: BUNDLE_EXTERNALS,
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
    await run('chmod', ['0755', 'dist/cli.js'], packageRoot)
    await buildTuiRoots({ packageRoot })
    console.log(
      'Product build: tsc, canonical copy, 2 audited bundles, raw/runtime TUI for OpenCode 1 and GA',
    )
  } catch (error) {
    await Promise.all(
      ['dist', ...TUI_ROOTS.flatMap((root) => [root.raw, root.runtime])].map(
        (path) => rm(join(packageRoot, path), { recursive: true, force: true }),
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
  else await buildTuiRoots()
}
