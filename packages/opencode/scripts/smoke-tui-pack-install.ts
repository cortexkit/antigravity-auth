/** Fresh npm/Bun packs and real isolated consumers. Never import a consumer package from this repository process. */
import { spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { build as bundle } from 'esbuild'
import {
  auditGraph,
  checkGaGraph,
  inventory,
  PACKAGE_ROOT,
  TUI_ROOTS,
  verifyPrerequisites,
} from './build-tui'
import { sha256 } from './embed-common-auth'

const repo = resolve(PACKAGE_ROOT, '../..')
const productName = '@cortexkit/opencode-antigravity-auth'
const baselineRevision = '45625093922278e7d8f1f1415df42bbc0ca1883e'
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    )
  return result.stdout
}
function requireEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    )
}

export async function pack(
  root: string,
  destination: string,
  manager: 'npm' | 'bun',
  scripts: boolean,
) {
  await mkdir(destination, { recursive: true })
  const flags = scripts ? [] : ['--ignore-scripts']
  // The destination starts empty; a successful command cannot discover an old tarball.
  if (manager === 'npm')
    run(
      'npm',
      ['pack', '--json', '--pack-destination', destination, ...flags],
      root,
    )
  else run('bun', ['pm', 'pack', '--destination', destination, ...flags], root)
  const names = (await readdir(destination)).filter((path) =>
    path.endsWith('.tgz'),
  )
  requireEqual(names.length, 1, 'pack.paths: fresh pack count')
  return join(destination, names[0]!)
}

export async function inspectPack(tar: string, target: string) {
  await mkdir(target, { recursive: true })
  const listed = run('tar', ['-tzf', tar], repo)
    .trim()
    .split('\n')
    .filter((path) => !path.endsWith('/'))
    .sort()
  if (new Set(listed).size !== listed.length)
    throw new Error('pack.paths: duplicate tar entry')
  if (
    listed.some(
      (path) => path.startsWith('package/tools/') || path.endsWith('.tgz'),
    )
  )
    throw new Error('pack.repository_input_excluded: private input shipped')
  run('tar', ['-xzf', tar, '-C', target], repo)
  const root = join(target, 'package')
  const required = new Set([
    'src/tui/entry.mjs',
    'src/tui/entry.d.mts',
    'src/sidebar-state.ts',
    'src/tui-preferences.ts',
    'src/tui-raw/tui.tsx',
    'src/tui-compiled/tui.js',
    'src/tui-raw/selector.js',
    'src/tui-compiled/selector.js',
    'dist/index.d.ts',
    'dist/src/tui.d.ts',
    'dist/index.meta.json',
    'dist/cli.meta.json',
    'src/common-auth-embedded/NOTICE.txt',
    'dist/src/common-auth-embedded/NOTICE.txt',
  ])
  // Check the 24 published JS/d.ts payloads against reference SHA256 values from the
  // archive-verified canonical manifest, not hashes computed from this pack. Require
  // the notice and manifest too, and compare complete inventories rather than subsets.
  const manifest = JSON.parse(
    await readFile(
      join(PACKAGE_ROOT, 'src/common-auth-embedded/source-output.json'),
      'utf8',
    ),
  )
  const canonical = [
    ...manifest.files.map((file: { output: string }) => file.output),
    'NOTICE.txt',
    'source-output.json',
  ].sort()
  for (const prefix of [
    'src/common-auth-embedded',
    'dist/src/common-auth-embedded',
  ]) {
    requireEqual(
      await inventory(join(root, prefix)),
      canonical,
      `pack.paths: ${prefix}`,
    )
    for (const file of manifest.files) {
      required.add(`${prefix}/${file.output}`)
      requireEqual(
        sha256(await readFile(join(root, prefix, file.output))),
        file.outputSha256,
        `pack.copy_order: ${prefix}/${file.output}`,
      )
    }
    requireEqual(
      sha256(await readFile(join(root, prefix, 'NOTICE.txt'))),
      manifest.notice.sha256,
      `pack.paths: ${prefix}/NOTICE.txt`,
    )
  }
  // Every TUI root ships both trees exactly as its own map lists them.
  for (const tuiRoot of TUI_ROOTS) {
    const map = JSON.parse(await readFile(join(root, tuiRoot.map), 'utf8'))
    required.add(join(tuiRoot.raw, tuiRoot.rawEntry))
    required.add(join(tuiRoot.runtime, tuiRoot.runtimeEntry))
    for (const [variant, prefix, entry, kind] of [
      [map.raw, tuiRoot.raw, tuiRoot.rawEntry, 'raw'],
      [map.runtime, tuiRoot.runtime, tuiRoot.runtimeEntry, 'runtime'],
    ] as const) {
      const expected = variant.files
        .map((file: { output: string }) =>
          relative(prefix, file.output).split('\\').join('/'),
        )
        .sort()
      requireEqual(
        await inventory(join(root, prefix)),
        expected,
        `pack.regeneration_paths: ${prefix}`,
      )
      for (const file of variant.files) {
        required.add(file.output)
        requireEqual(
          sha256(await readFile(join(root, file.output))),
          file.sha256,
          `pack.paths: ${file.output}`,
        )
      }
      const graph = await auditGraph(join(root, prefix, entry))
      if (tuiRoot.name === 'ga') checkGaGraph(graph, kind)
      requireEqual(
        await readFile(join(root, prefix, 'selector.js'), 'utf8'),
        await readFile(
          join(root, 'src/common-auth-embedded/tui/index.js'),
          'utf8',
        ),
        'build.selector_inert',
      )
    }
  }
  for (const path of required)
    if (!listed.includes(`package/${path}`))
      throw new Error(`pack.paths: missing ${path}`)
  for (const entry of ['dist/index.d.ts', 'dist/src/tui.d.ts'])
    await auditGraph(join(root, entry), { tui: false, types: true })
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  for (const value of [
    'Bun 1.4.2',
    'bun run --cwd packages/opencode build:tui',
    'src/tui-raw/tui.tsx',
    'src/tui-compiled/tui.js',
  ]) {
    if (!readme.includes(value))
      throw new Error(`pack.paths: README missing ${value}`)
  }
  for (const path of await inventory(root))
    if (/\.(md|txt)$/.test(path)) {
      const document = await readFile(join(root, path), 'utf8')
      if (
        /bunx tsx|dist\/src\/tui-compiled|tui-compiled\/tui\.tsx/.test(document)
      )
        throw new Error(`pack.paths: removed target in ${path}`)
    }
  return root
}

async function installedGraph(root: string, prefix = ''): Promise<unknown[]> {
  const graph: unknown[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name),
      name = `${prefix}${entry.name}`
    if (entry.name.startsWith('@'))
      graph.push(...(await installedGraph(path, `${name}/`)))
    else {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
      graph.push([
        name,
        pkg.name,
        pkg.version,
        pkg.dependencies ?? {},
        pkg.peerDependencies ?? {},
      ])
      const nested = join(path, 'node_modules')
      try {
        graph.push(...(await installedGraph(nested, `${name}/node_modules/`)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return graph.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )
}

async function baseline(workspace: string) {
  const root = join(workspace, 'baseline')
  await mkdir(root)
  const archive = join(root, 'source.tar')
  run(
    'git',
    ['archive', baselineRevision, 'packages/opencode', '-o', archive],
    repo,
  )
  run('tar', ['-xf', archive, '-C', root], repo)
  const packageRoot = join(root, 'packages/opencode')
  // Reuse compiler dependency links only while building the archived baseline.
  // The installed consumers below are separate fresh-tar installs with no workspace links.
  await symlink(
    join(PACKAGE_ROOT, 'node_modules'),
    join(packageRoot, 'node_modules'),
    'dir',
  )
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  run(
    join(repo, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.build.json'],
    packageRoot,
  )
  for (const [entry, name] of [
    ['index.ts', 'index'],
    ['src/cli.ts', 'cli'],
  ] as const)
    await bundle({
      absWorkingDir: packageRoot,
      entryPoints: [entry],
      outfile: `dist/${name}.js`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['zod'],
      banner: name === 'cli' ? { js: '#!/usr/bin/env node' } : undefined,
    })
  run('bun', ['scripts/build-tui.ts'], packageRoot)
  return packageRoot
}

async function install(
  workspace: string,
  name: string,
  tar: string,
  core: string,
  manager: 'npm' | 'bun',
  ui: boolean,
  scripts: boolean,
) {
  const root = join(workspace, name)
  await mkdir(root)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'owned-pack-consumer',
      private: true,
      type: 'module',
      dependencies: {
        [productName]: tar,
        ...(ui
          ? {
              '@opentui/core': '0.4.5',
              '@opentui/keymap': '0.4.5',
              '@opentui/solid': '0.4.5',
              'solid-js': '1.9.12',
            }
          : {}),
      },
      overrides: { '@cortexkit/antigravity-auth-core': core },
    }),
  )
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    BUN_INSTALL_CACHE_DIR:
      process.env.BUN_INSTALL_CACHE_DIR ??
      resolve(dirname(process.execPath), '../install/cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  await mkdir(env.HOME, { recursive: true })
  run(manager, ['install', ...(scripts ? [] : ['--ignore-scripts'])], root, env)
  const installed = join(root, 'node_modules', productName)
  if ((await realpath(installed)) !== installed)
    throw new Error('consumer.installed_resolution: workspace link')
  const graph = await installedGraph(join(root, 'node_modules'))
  if (JSON.stringify(graph).includes('@cortexkit/common-auth'))
    throw new Error('consumer.cli_lean: common/tool runtime dependency')
  const probe = join(root, 'probe.mjs')
  await writeFile(
    probe,
    `import assert from 'node:assert/strict';
import { realpathSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(installed)};
const pkg = JSON.parse(readFileSync(root + '/package.json'));
assert.equal(import.meta.resolve(${JSON.stringify(productName)}), pathToFileURL(root + '/' + pkg.exports['.'].import).href);
assert.equal(import.meta.resolve(${JSON.stringify(`${productName}/tui`)}), pathToFileURL(root + '/' + pkg.exports['./tui'].import).href);
assert.equal(realpathSync(root), root);
const server = await import(${JSON.stringify(productName)});
assert.equal(typeof server.AntigravityCLIOAuthPlugin, 'function');
assert.equal(typeof server.GoogleOAuthPlugin, 'function');
${
  ui
    ? `const { default: tui } = await import(${JSON.stringify(`${productName}/tui`)});
assert.equal(tui.id, 'cortexkit.antigravity-auth'); assert.equal(typeof tui.tui, 'function');
assert.deepEqual(Object.keys(tui).sort(), ['id', 'setup', 'tui']); assert.equal(typeof tui.setup, 'function');
assert.equal(pkg.exports['./tui'].types, './src/tui/entry.d.mts');`
    : ''
}
console.log('consumer.installed_resolution: 5 checks${ui ? '; consumer.ui045: 5 checks' : ''}');
`,
  )
  const args = ui ? ['--preload', '@opentui/solid/preload', probe] : [probe]
  const output = run('bun', args, root, env)
  if (!output.includes('consumer.installed_resolution: 5 checks'))
    throw new Error('consumer.installed_resolution: absent child witness')
  // Run Node import and CLI probes from the consumer, with its isolated HOME,
  // XDG_CONFIG_HOME and XDG_STATE_HOME; never resolve repository packages or use real user state.
  await writeFile(
    join(root, 'node-probe.mjs'),
    `import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
assert.equal(import.meta.resolve(${JSON.stringify(productName)}), pathToFileURL(${JSON.stringify(join(installed, 'dist/index.js'))}).href);
assert.equal(typeof (await import(${JSON.stringify(productName)})).GoogleOAuthPlugin, 'function'); console.log('Node installed imports: 2 checks');`,
  )
  run('node', [join(root, 'node-probe.mjs')], root, env)
  const cli = run('node', [join(installed, 'dist/cli.js'), '--help'], root, env)
  if (!cli.includes('antigravity-auth'))
    throw new Error('consumer.cli_lean: CLI help witness absent')
  return { installed, graph }
}

async function main() {
  await verifyPrerequisites()
  run('bun', ['run', '--cwd', 'packages/core', 'build'], repo)
  run('bun', ['run', 'build'], PACKAGE_ROOT)
  const workspace = await mkdtemp(join(repo, '.tui-pack-'))
  try {
    const core = await pack(
      join(repo, 'packages/core'),
      join(workspace, 'core-pack'),
      'npm',
      false,
    )
    const baseRoot = await baseline(workspace)
    const baseTar = await pack(
      baseRoot,
      join(workspace, 'baseline-pack'),
      'npm',
      false,
    )
    let observations = 0
    for (const manager of ['npm', 'bun'] as const) {
      const baselines = new Map<boolean, unknown[]>()
      for (const ui of [false, true]) {
        const base = await install(
          workspace,
          `baseline-${manager}-${ui}`,
          baseTar,
          core,
          manager,
          ui,
          false,
        )
        baselines.set(ui, base.graph)
      }
      for (const scripts of [true, false]) {
        const tar = await pack(
          PACKAGE_ROOT,
          join(workspace, `pack-${manager}-${scripts}`),
          manager,
          scripts,
        )
        const packedRoot = await inspectPack(
          tar,
          join(workspace, `inspect-${manager}-${scripts}`),
        )
        for (const ui of [false, true]) {
          const consumer = await install(
            workspace,
            `product-${manager}-${scripts}-${ui}`,
            tar,
            core,
            manager,
            ui,
            scripts,
          )
          requireEqual(
            consumer.graph,
            baselines.get(ui),
            `consumer.cli_lean: ${manager}/${scripts}/${ui} full baseline graph delta`,
          )
          const packed = await inventory(packedRoot)
          requireEqual(
            await inventory(consumer.installed),
            packed,
            `pack.paths: ${manager} installed inventory`,
          )
          for (const path of packed)
            requireEqual(
              sha256(await readFile(join(consumer.installed, path))),
              sha256(await readFile(join(packedRoot, path))),
              `pack.paths: installed ${path}`,
            )
          observations++
        }
      }
    }
    console.log(
      `smoke-tui: pack.paths, pack.copy_order, pack.regeneration_paths, pack.repository_input_excluded, consumer.ui045, consumer.cli_lean, consumer.installed_resolution passed; 4 fresh packs, ${observations} product and 4 baseline consumers`,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
if (import.meta.main) await main()
