/** Fresh npm/Bun packs and real isolated consumers. Never import a consumer package from this repository process. */
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
import sourceManifest from '../package.json'
import {
  auditGraph,
  buildPhase,
  buildPhaseNote,
  checkGaGraph,
  inventory,
  PACKAGE_ROOT,
  TUI_ROOTS,
  verifyPrerequisites,
} from './build-tui'
import { sha256 } from './embed-common-auth'
import { runCommand } from './run-command'

const repo = resolve(PACKAGE_ROOT, '../..')
const productName = '@cortexkit/opencode-antigravity-auth'
const coreName = '@cortexkit/antigravity-auth-core'
export const baselineRevision = '45625093922278e7d8f1f1415df42bbc0ca1883e'
async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const commandEnv =
    command === 'git'
      ? {
          ...env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'safe.directory',
          GIT_CONFIG_VALUE_0: repo,
        }
      : env
  const result = await buildPhase(
    `child spawn: ${command} ${args.join(' ')} (cwd ${cwd})`,
    () =>
      runCommand(command, args, {
        cwd,
        env: commandEnv,
        deadlineMs: 180_000,
        maxBufferBytes: 16 * 1024 * 1024,
      }),
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
    await run(
      'npm',
      ['pack', '--json', '--pack-destination', destination, ...flags],
      root,
    )
  else
    await run(
      'bun',
      ['pm', 'pack', '--destination', destination, ...flags],
      root,
    )
  const names = (await readdir(destination)).filter((path) =>
    path.endsWith('.tgz'),
  )
  requireEqual(names.length, 1, 'pack.paths: fresh pack count')
  return join(destination, names[0]!)
}

export async function inspectPack(tar: string, target: string) {
  await mkdir(target, { recursive: true })
  const listed = (await run('tar', ['-tzf', tar], repo))
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
  await run('tar', ['-xzf', tar, '-C', target], repo)
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

function orderedMap(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function expectedCandidateGraph(
  baselineGraph: readonly unknown[],
  candidateMetadata: { version: string; corePin: string },
): unknown[] {
  let productRows = 0
  const graph = baselineGraph.map((row) => {
    if (!Array.isArray(row) || row[0] !== productName) return row
    productRows++
    const dependencies: unknown = row[3]
    const peers: unknown = row[4]
    if (
      row.length !== 5 ||
      row[1] !== productName ||
      typeof row[2] !== 'string' ||
      !row[2] ||
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies) ||
      !Object.hasOwn(dependencies, coreName) ||
      Object.values(dependencies).some(
        (value) => typeof value !== 'string' || !value,
      ) ||
      !peers ||
      typeof peers !== 'object' ||
      Array.isArray(peers) ||
      Object.values(peers).some(
        (value) => typeof value !== 'string' || !value,
      ) ||
      Object.hasOwn(peers, '@opencode/plugin')
    )
      throw new Error('Unexpected historical product graph row')
    // Compare the historical OpenCode plugin install with the newly packed plugin.
    // Both installs use the newly packed core, which supplies private-files and
    // the vault client's store dependency to the historical baseline too. Only
    // the plugin's version, core pin, private-files and direct vault-client pins,
    // and optional OpenCode 2 peer may differ; all installed package rows stay fixed.
    return [
      row[0],
      row[1],
      candidateMetadata.version,
      orderedMap({
        ...dependencies,
        [coreName]: candidateMetadata.corePin,
        '@cortexkit/private-files': '0.2.1',
        '@cortexkit/claustrum-client': '0.12.0',
        '@cortexkit/subc-client': '0.22.5',
      }),
      orderedMap({ ...peers, '@opencode/plugin': '>=2.0.22' }),
    ]
  })
  if (productRows !== 1)
    throw new Error('Expected one historical product graph row')
  return graph.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )
}

export function assertVaultClientGraph(graph: readonly unknown[]): void {
  for (const [name, version] of [
    ['@cortexkit/claustrum-client', '0.12.0'],
    ['@cortexkit/subc-client', '0.22.5'],
  ]) {
    const rows = graph.filter((row) => Array.isArray(row) && row[1] === name)
    if (rows.length !== 1 || !Array.isArray(rows[0]) || rows[0][2] !== version)
      throw new Error(`consumer.vault_clients: expected one ${name}@${version}`)
  }
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
        orderedMap(pkg.dependencies ?? {}),
        orderedMap(pkg.peerDependencies ?? {}),
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

export async function baseline(workspace: string) {
  const root = join(workspace, 'baseline')
  await buildPhase('baseline.mkdir', () => mkdir(root))
  const archive = join(root, 'source.tar')
  await run(
    'git',
    [
      'archive',
      baselineRevision,
      'packages/opencode',
      'packages/core',
      '-o',
      archive,
    ],
    repo,
  )
  await run('tar', ['-xf', archive, '-C', root], repo)
  const packageRoot = join(root, 'packages/opencode')
  const coreRoot = join(root, 'packages/core')
  await buildPhase('baseline.link core dependencies', () =>
    symlink(
      join(repo, 'packages/core/node_modules'),
      join(coreRoot, 'node_modules'),
      'dir',
    ),
  )
  await buildPhase('baseline.link root dependencies', () =>
    symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir'),
  )
  await run(
    join(repo, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.build.json'],
    coreRoot,
  )

  // Reuse compiler dependency links only while building the archived baseline.
  // The installed consumers below are separate fresh-tar installs with no workspace links.
  // Keep this overlay private so selecting the archived core never changes the
  // current workspace's node_modules links.
  const packageModules = join(packageRoot, 'node_modules')
  const currentPackageModules = join(PACKAGE_ROOT, 'node_modules')
  await buildPhase('baseline.mkdir dependency overlay', () =>
    mkdir(packageModules),
  )
  for (const name of await buildPhase(
    'baseline.readdir current dependencies',
    () => readdir(currentPackageModules),
  )) {
    const source = join(currentPackageModules, name)
    const target = join(packageModules, name)
    if (name !== '@cortexkit') {
      await buildPhase(`baseline.link dependency ${name}`, () =>
        symlink(source, target, 'dir'),
      )
      continue
    }

    await buildPhase(`baseline.mkdir scope ${name}`, () => mkdir(target))
    for (const scopedName of await buildPhase(
      `baseline.readdir scope ${name}`,
      () => readdir(source),
    ))
      await buildPhase(`baseline.link dependency ${name}/${scopedName}`, () =>
        symlink(
          scopedName === 'antigravity-auth-core'
            ? coreRoot
            : join(source, scopedName),
          join(target, scopedName),
          'dir',
        ),
      )
  }

  await run(
    join(repo, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.build.json'],
    packageRoot,
  )
  for (const [entry, name] of [
    ['index.ts', 'index'],
    ['src/cli.ts', 'cli'],
  ] as const)
    await buildPhase(`baseline.esbuild ${entry}`, () =>
      bundle({
        absWorkingDir: packageRoot,
        entryPoints: [entry],
        outfile: `dist/${name}.js`,
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['zod'],
        banner: name === 'cli' ? { js: '#!/usr/bin/env node' } : undefined,
      }),
    )
  await run('bun', ['scripts/build-tui.ts'], packageRoot)
  return packageRoot
}

/**
 * What the installed `./tui` entry must export. The baseline is the last
 * release before the unified menu, whose entry is the OpenCode 1 module
 * `{ id, tui }`. The candidate is this package's hybrid entry
 * `{ id, tui, setup }`, typed by `src/tui/entry.d.mts`.
 */
export type TuiContract = 'baseline' | 'candidate'

const UI_CHECKS: Record<TuiContract, number> = { baseline: 3, candidate: 5 }

/**
 * The probe each consumer runs from its own directory against its installed
 * package: package-root and `./tui` resolution, the server factories, and
 * with `ui` the `./tui` default export checked against `contract`.
 */
export function consumerProbe(options: {
  installed: string
  ui: boolean
  contract: TuiContract
}): string {
  const { installed, ui, contract } = options
  const tuiChecks =
    contract === 'baseline'
      ? `assert.deepEqual(Object.keys(tui).sort(), ['id', 'tui']);`
      : `assert.deepEqual(Object.keys(tui).sort(), ['id', 'setup', 'tui']); assert.equal(typeof tui.setup, 'function');
assert.equal(pkg.exports['./tui'].types, './src/tui/entry.d.mts');`
  return `import assert from 'node:assert/strict';
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
${tuiChecks}`
    : ''
}
console.log(${JSON.stringify(consumerWitness(ui, contract))});
`
}

/** The line a consumer probe prints after every assertion passed. */
export function consumerWitness(ui: boolean, contract: TuiContract): string {
  return `consumer.installed_resolution: 5 checks${ui ? `; consumer.ui045: ${UI_CHECKS[contract]} ${contract} checks` : ''}`
}

/** Resolve and exercise the POSIX backend from each installed server package, not the workspace. */
export function privateFilesProbe(): string {
  return `if (process.platform === 'linux') {
const productEntry = import.meta.resolve(${JSON.stringify(productName)});
const coreEntry = import.meta.resolve(${JSON.stringify(coreName)}, productEntry);
for (const entry of [coreEntry, productEntry]) {
  const backendUrl = import.meta.resolve('@cortexkit/private-files', entry);
  const backendPath = fileURLToPath(backendUrl);
  assert.ok(backendPath.startsWith(realpathSync('./node_modules') + sep));
  const backend = await import(backendUrl);
  assert.equal((await backend.verifySafeParent(process.env.HOME)).ok, true);
}
console.log('Linux packed core/opencode private-files: 4 checks');
}`
}

export function installResolution(
  manager: 'npm' | 'bun',
  cutoff: Date,
  now = Date.now(),
) {
  const age = Math.ceil(Math.max(0, now - cutoff.getTime()) / 1000) + 1
  const args = manager === 'bun' ? [`--minimum-release-age=${age}`] : []
  const env =
    manager === 'npm' ? { npm_config_before: cutoff.toISOString() } : {}
  return { args, env }
}

async function install(
  workspace: string,
  name: string,
  tar: string,
  core: string,
  manager: 'npm' | 'bun',
  ui: boolean,
  scripts: boolean,
  contract: TuiContract,
  cutoff: Date,
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
  const resolution = installResolution(manager, cutoff)
  await mkdir(env.HOME, { recursive: true })
  await run(
    manager,
    ['install', ...resolution.args, ...(scripts ? [] : ['--ignore-scripts'])],
    root,
    { ...env, ...resolution.env },
  )
  const installed = join(root, 'node_modules', productName)
  if ((await realpath(installed)) !== installed)
    throw new Error('consumer.installed_resolution: workspace link')
  const graph = await installedGraph(join(root, 'node_modules'))
  if (JSON.stringify(graph).includes('@cortexkit/common-auth'))
    throw new Error('consumer.cli_lean: common/tool runtime dependency')
  if (contract === 'candidate') assertVaultClientGraph(graph)
  const probe = join(root, 'probe.mjs')
  await writeFile(probe, consumerProbe({ installed, ui, contract }))
  const args = ui ? ['--preload', '@opentui/solid/preload', probe] : [probe]
  const output = await run('bun', args, root, env)
  if (!output.includes(consumerWitness(ui, contract)))
    throw new Error('consumer.installed_resolution: absent child witness')
  // Run Node import and CLI probes from the consumer, with its isolated HOME,
  // XDG_CONFIG_HOME and XDG_STATE_HOME; never resolve repository packages or use real user state.
  await writeFile(
    join(root, 'node-probe.mjs'),
    `import assert from 'node:assert/strict'; import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs'; import { sep } from 'node:path';
assert.equal(import.meta.resolve(${JSON.stringify(productName)}), pathToFileURL(${JSON.stringify(join(installed, 'dist/index.js'))}).href);
assert.equal(typeof (await import(${JSON.stringify(productName)})).GoogleOAuthPlugin, 'function'); console.log('Node installed imports: 2 checks');
${contract === 'candidate' ? privateFilesProbe() : ''}`,
  )
  const nodeOutput = await run(
    'node',
    ['--experimental-import-meta-resolve', join(root, 'node-probe.mjs')],
    root,
    env,
  )
  if (
    contract === 'candidate' &&
    process.platform === 'linux' &&
    !nodeOutput.includes('Linux packed core/opencode private-files: 4 checks')
  )
    throw new Error('consumer.private_files: absent Linux runtime witness')
  const cli = await run(
    'node',
    [join(installed, 'dist/cli.js'), '--help'],
    root,
    env,
  )
  if (!cli.includes('antigravity-auth'))
    throw new Error('consumer.cli_lean: CLI help witness absent')
  if (contract === 'candidate') {
    const config = join(env.XDG_CONFIG_HOME, 'opencode')
    const pi = join(root, 'pi-profile')
    await mkdir(config, { recursive: true, mode: 0o700 })
    const before = await readdir(config)
    const planned = await run(
      'node',
      [
        join(root, 'node_modules/.bin/antigravity-auth'),
        'setup',
        '--yes',
        '--dry-run',
        '--opencode=1',
        '--no-claustrum',
      ],
      root,
      {
        ...env,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: join(root, 'setup-opencode.db'),
        PI_AGENT_DIR: pi,
        PI_CODING_AGENT_DIR: pi,
        PI_ANTIGRAVITY_AUTH_FILE: join(pi, 'antigravity-accounts.json'),
        SUBC_CONNECTION_FILE: join(root, 'absent-vault-connection.json'),
        CLAUSTRUM_SUBC_CONNECTION: join(root, 'absent-vault-connection.json'),
      },
    )
    if (
      !planned.includes(
        'Dry run: no registrations, enrollment, sign-in or migration',
      ) ||
      !planned.includes(`${productName}@${sourceManifest.version}`) ||
      JSON.stringify(await readdir(config)) !== JSON.stringify(before)
    )
      throw new Error(
        'consumer.cli_setup: installed setup preview missing or wrote configuration',
      )
  }
  return { installed, graph }
}

async function main() {
  const cutoff = new Date()
  await verifyPrerequisites()
  await run('bun', ['run', '--cwd', 'packages/core', 'build'], repo)
  await run('bun', ['run', 'build'], PACKAGE_ROOT)
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
          'baseline',
          cutoff,
        )
        baselines.set(
          ui,
          expectedCandidateGraph(base.graph, {
            version: sourceManifest.version,
            corePin: sourceManifest.dependencies[coreName],
          }),
        )
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
            'candidate',
            cutoff,
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
