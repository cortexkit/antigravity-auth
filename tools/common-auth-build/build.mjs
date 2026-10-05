import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  if (!isAbsolute(path)) throw new Error(`Build path must be absolute: ${path}`)
  const child = relative(packageRoot, path)
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new Error(`Output must be inside package root: ${path}`)
  return path
}

function within(parent, path) {
  const child = relative(parent, path)
  return (
    !child ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

/** Orchestration only: all graph traversal, naming and transforms are public API calls. */
export async function buildCommonAuthTui({
  packageRoot,
  entryFile,
  rawDir,
  runtimeDir,
  mapFile,
}) {
  for (const path of [packageRoot, entryFile]) {
    if (!isAbsolute(path))
      throw new Error(`Build path must be absolute: ${path}`)
  }
  destination(packageRoot, rawDir)
  destination(packageRoot, runtimeDir)
  if (within(rawDir, runtimeDir) || within(runtimeDir, rawDir))
    throw new Error('TUI outputs must be disjoint')
  if (within(rawDir, entryFile) || within(runtimeDir, entryFile))
    throw new Error('TUI output cannot contain its source entry')
  if (mapFile) {
    destination(packageRoot, mapFile)
    if (
      within(rawDir, mapFile) ||
      within(runtimeDir, mapFile) ||
      mapFile === entryFile
    )
      throw new Error(
        'Build map must be outside emitted trees and source entry',
      )
  }
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
