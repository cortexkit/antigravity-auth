import {
  lstat,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inputPath,
  productionPin,
  readVerifiedArchive,
  sha256,
  validatePublication,
} from '../../packages/opencode/scripts/embed-common-auth.ts'

const toolRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(toolRoot, '../..')

async function verifiedCompiler() {
  if (typeof Bun === 'undefined' || Bun.version !== '1.4.2')
    throw new Error('TUI compiler requires Bun 1.4.2')
  const archive = readVerifiedArchive(
    await readFile(resolve(repoRoot, inputPath)),
    productionPin,
  )
  validatePublication(archive)
  for (const [name, version] of Object.entries({
    '@cortexkit/common-auth': '0.9.4',
    '@opentui/core': '0.5.14',
    '@opentui/solid': '0.5.14',
    'solid-js': '1.9.12',
    typescript: '6.0.3',
  })) {
    const installed = await realpath(
      resolve(toolRoot, 'node_modules', name, 'package.json'),
    )
    if (!installed.startsWith(`${toolRoot}/node_modules/`))
      throw new Error(`Private tool root escaped: ${name}`)
    if (JSON.parse(await readFile(installed, 'utf8')).version !== version)
      throw new Error(`Private tool version mismatch: ${name}`)
  }
  const producer = resolve(toolRoot, 'node_modules/@cortexkit/common-auth')
  for (const path of [
    'package.json',
    'dist/tui/index.js',
    'dist/tui-build/index.js',
    'dist/tui-build/build-tui.js',
    'dist/tui-build/walker.js',
    'dist/tui-build/publish-list.js',
  ]) {
    if (
      !(await readFile(resolve(producer, path))).equals(
        archive.get(`package/${path}`),
      )
    )
      throw new Error(`Installed producer bytes mismatch: ${path}`)
  }
  return import('@cortexkit/common-auth/tui-build')
}

function destination(packageRoot, path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error(`Build path must be absolute: ${path}`)
  const child = relative(packageRoot, path)
  if (!child || !within(packageRoot, path))
    throw new Error(`Output must be inside package root: ${path}`)
  return resolve(path)
}

function within(parent, path) {
  const child = relative(parent, path)
  return (
    !child ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

async function inspectDestination(packageRoot, path, kind) {
  let current = packageRoot
  const parts = relative(packageRoot, path).split(sep)
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part)
    const info = await lstat(current).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!info) continue
    // Package-root links are resolved once at admission. Descendant links are not
    // output ownership: even an in-package alias can name a handwritten source tree.
    if (info.isSymbolicLink())
      throw new Error(`Build output aliases are not admitted: ${current}`)
    const final = index === parts.length - 1
    if (!(final && kind === 'map') && !info.isDirectory())
      throw new Error(`Build output directory is not a directory: ${current}`)
    if (final && kind === 'map' && (!info.isFile() || info.nlink !== 1))
      throw new Error(`Build map must be a regular unaliased file: ${current}`)
    current = await realpath(current)
    if (!within(packageRoot, current))
      throw new Error(`Resolved output escaped package root: ${current}`)
    if (final && kind === 'map') {
      // Existing maps must have the generated-map format, not unrelated authored content.
      const previous = await readFile(current, 'utf8')
      let map
      try {
        map = JSON.parse(previous)
      } catch {
        throw new Error(`Existing build map is not a generated map: ${current}`)
      }
      if (
        map?.schema !== 1 ||
        map.compiler !== '@cortexkit/common-auth/tui-build@0.9.4'
      )
        throw new Error(`Existing build map is not a generated map: ${current}`)
    }
  }
  return current
}

async function admitBuildPaths({
  packageRoot,
  entryFile,
  rawDir,
  runtimeDir,
  mapFile,
}) {
  for (const path of [packageRoot, entryFile]) {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error(`Build path must be absolute: ${path}`)
  }
  packageRoot = resolve(packageRoot)
  entryFile = resolve(entryFile)
  rawDir = destination(packageRoot, rawDir)
  runtimeDir = destination(packageRoot, runtimeDir)
  if (mapFile !== undefined) mapFile = destination(packageRoot, mapFile)
  if (within(rawDir, runtimeDir) || within(runtimeDir, rawDir))
    throw new Error('TUI outputs must be disjoint')
  if (within(rawDir, entryFile) || within(runtimeDir, entryFile))
    throw new Error('TUI output cannot contain its source entry')
  if (mapFile) {
    if (
      within(rawDir, mapFile) ||
      within(runtimeDir, mapFile) ||
      mapFile === entryFile
    )
      throw new Error(
        'Build map must be outside emitted trees and source entry',
      )
  }

  const root = await realpath(packageRoot)
  if (!(await stat(root)).isDirectory())
    throw new Error('Package root must be a directory')
  const entry = await realpath(entryFile)
  if (!(await stat(entry)).isFile())
    throw new Error('Source entry must be a regular file')
  const translate = (path) => resolve(root, relative(packageRoot, path))
  const raw = await inspectDestination(root, translate(rawDir), 'directory')
  const runtime = await inspectDestination(
    root,
    translate(runtimeDir),
    'directory',
  )
  const map =
    mapFile === undefined
      ? undefined
      : await inspectDestination(root, translate(mapFile), 'map')
  if (within(raw, runtime) || within(runtime, raw))
    throw new Error('Resolved TUI outputs must be disjoint')
  if (within(raw, entry) || within(runtime, entry))
    throw new Error('Resolved TUI output cannot contain its source entry')
  if (
    map !== undefined &&
    (within(raw, map) || within(runtime, map) || map === entry)
  )
    throw new Error(
      'Resolved build map must be outside emitted trees and source entry',
    )
  return {
    packageRoot: root,
    entryFile: entry,
    rawDir: raw,
    runtimeDir: runtime,
    mapFile: map,
  }
}

/** Orchestration only: all graph traversal, naming and transforms are public API calls. */
export async function buildCommonAuthTui(options) {
  // This is a static filesystem preflight, not a lock against concurrent changes.
  // Admission failures cannot enter the compiler, write outputs or run failure cleanup.
  const { packageRoot, entryFile, rawDir, runtimeDir, mapFile } =
    await admitBuildPaths(options)
  try {
    const { buildTui, loadSolidTransform, assertEmittedPublishList } =
      await verifiedCompiler()
    // The public publish-list assertion invokes npm pack locally; disallow acquisition there too.
    process.env.npm_config_offline = 'true'
    const raw = await buildTui(entryFile, 'raw', rawDir, { inline: [] })
    const runtime = await buildTui(entryFile, 'runtime', runtimeDir, {
      inline: [],
      loadSolidTransform,
    })
    await assertEmittedPublishList(packageRoot, rawDir, raw.emitted)
    await assertEmittedPublishList(packageRoot, runtimeDir, runtime.emitted)
    const portable = (path) => relative(packageRoot, path).split('\\').join('/')
    const describe = async (result, dir) => ({
      selector: result.selector,
      externals: [...result.externals].sort(),
      files: await Promise.all(
        result.emitted.map(async (path, index) => ({
          source: portable(result.sources[index]),
          output: portable(resolve(dir, path)),
          bytes: (await readFile(resolve(dir, path))).length,
          sha256: sha256(await readFile(resolve(dir, path))),
          transform:
            path === result.selector
              ? 'verbatim-selector'
              : dir === rawDir
                ? 'public-raw'
                : 'public-solid-runtime',
        })),
      ),
    })
    const map = {
      schema: 1,
      compiler: '@cortexkit/common-auth/tui-build@0.9.4',
      bun: Bun.version,
      raw: await describe(raw, rawDir),
      runtime: await describe(runtime, runtimeDir),
    }
    if (mapFile) await writeFile(mapFile, `${JSON.stringify(map, null, 2)}\n`)
    return map
  } catch (error) {
    // A partial raw tree or previous runtime tree must never masquerade as a fresh build.
    await Promise.all(
      [rawDir, runtimeDir, ...(mapFile ? [mapFile] : [])].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    )
    throw error
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const options = {}
  const names = {
    '--package-root': 'packageRoot',
    '--entry': 'entryFile',
    '--raw-dir': 'rawDir',
    '--runtime-dir': 'runtimeDir',
    '--map': 'mapFile',
  }
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]]
    if (!name || !args[index + 1] || options[name])
      throw new Error(
        'Expected unique --package-root, --entry, --raw-dir, --runtime-dir and optional --map absolute paths',
      )
    options[name] = args[index + 1]
  }
  for (const name of ['packageRoot', 'entryFile', 'rawDir', 'runtimeDir']) {
    if (!options[name]) throw new Error(`Missing build argument: ${name}`)
  }
  const result = await buildCommonAuthTui(options)
  console.log(
    `Public TUI build: ${result.raw.files.length} raw, ${result.runtime.files.length} runtime files`,
  )
}
