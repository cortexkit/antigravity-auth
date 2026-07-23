/**
 * Smoke test: pack the opencode package, install it into a temp consumer
 * directory through `bun add ./pack.tgz` (so the package export map is
 * actually exercised), and assert the tarball + install shape:
 *
 *   - `package.json` `engines.opencode` pins the host-version range
 *     that `opencode plugin` enforces.
 *   - `package.json` exports `./tui` pointing at `src/tui/entry.mjs`
 *     (the host installer reads this subpath when wiring the TUI
 *     registration into `tui.json`).
 *   - The compiled tree lands at `src/tui-compiled/tui.tsx` (where the
 *     host entry module expects it after a successful virtual runtime
 *     probe).
 *   - The consumer's `node_modules/@cortexkit/opencode-antigravity-auth`
 *     resolves both the server root and the TUI subpath through the
 *     real package export map (`import('@cortexkit/opencode-antigravity-auth/tui')`).
 *
 * Runs only via `bun run smoke:tui`. Use this on every package change
 * that touches `package.json` `exports`, `files`, or `engines` — a
 * broken pack is a broken ship.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../')
const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/opencode')
const CORE_ROOT = resolve(REPO_ROOT, 'packages/core')

interface PackageJson {
  name: string
  version: string
  engines?: Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
}

async function run(): Promise<void> {
  const workspace = createTempWorkspace('agy-smoke-pack')
  const packDir = join(workspace, 'pack')
  const consumerDir = join(workspace, 'consumer')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })
  console.log('[smoke-tui] workspace:', workspace)

  // Pack the core package first — the opencode tarball declares it as a
  // workspace-only dependency, so the consumer's `bun install` cannot
  // resolve it from the npm registry. A tgz over the core's `dist/`
  // gives `bun add` a concrete source it can unpack without the registry.
  const coreTarball = packPackage(CORE_ROOT, packDir)
  console.log('[smoke-tui] core tarball:', coreTarball)

  // The compiled TUI tree is produced by `bun run build:tui`, not by
  // `bun pm pack` itself. Pre-run it so the precompiled tree lands inside
  // the opencode tarball — otherwise the assertion in step 3 fails.
  runScript('bun', ['run', 'build:tui'], PACKAGE_ROOT)

  const opencodeTarball = packPackage(PACKAGE_ROOT, packDir)
  console.log('[smoke-tui] opencode tarball:', opencodeTarball)

  const pkgRaw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')
  const pkg = JSON.parse(pkgRaw) as PackageJson

  // 1) `engines.opencode` must pin the host-version range that
  //    `opencode plugin` enforces at install time.
  const opencodeEngine = pkg.engines?.opencode
  if (typeof opencodeEngine !== 'string' || opencodeEngine.length === 0) {
    throw new Error('package.json is missing engines.opencode metadata')
  }

  // 2) `./tui` must be exposed in the exports map and point at
  //    `tui/entry.mjs` — the host installer reads this subpath to
  //    wire the TUI registration into `tui.json`.
  const tuiExport = pkg.exports?.['./tui']
  if (!tuiExport || typeof tuiExport !== 'object') {
    throw new Error('package.json exports must include "./tui" entry')
  }
  const tuiImport =
    (tuiExport as Record<string, unknown>)['import'] ??
    (tuiExport as Record<string, unknown>)['default']
  if (typeof tuiImport !== 'string') {
    throw new Error('package.json exports["./tui"] must declare an "import"')
  }
  if (!tuiImport.endsWith('tui/entry.mjs')) {
    throw new Error(
      `package.json exports["./tui"] import must point at tui/entry.mjs, got ${tuiImport}`,
    )
  }

  // 3) Inspect the tarball: the source tree, the compiled tree, and the
  //    precompiled entry must all ship.
  const tarballList = runTar(['-tzf', opencodeTarball])
  const requiredFiles = [
    'package/src/tui.tsx',
    'package/src/tui/entry.mjs',
    'package/src/sidebar-state.ts',
    'package/src/tui-compiled/tui.tsx',
  ]
  for (const required of requiredFiles) {
    if (
      !tarballList.some(
        (entry) => entry === required || entry.endsWith(`/${required}`),
      )
    ) {
      throw new Error(
        `tarball missing ${required}; listed (head): ${tarballList.slice(0, 5).join(', ')}`,
      )
    }
  }

  // 4) Install the opencode tarball into a real consumer. The opencode
  //    package declares `@cortexkit/antigravity-auth-core@2.0.0` as a
  //    workspace-only dependency that isn't in the npm registry, so the
  //    consumer's `package.json` overrides core to the local core tarball.
  //    `bun install` follows the export map exactly the way a real host
  //    would — this is the round-trip we actually care about.
  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'antigravity-smoke-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@cortexkit/opencode-antigravity-auth': opencodeTarball,
        },
        overrides: {
          '@cortexkit/antigravity-auth-core': coreTarball,
        },
      },
      null,
      2,
    )}\n`,
  )
  const installOutput = spawnSync('bun', ['install', '--no-save'], {
    cwd: consumerDir,
    encoding: 'utf-8',
  })
  if (installOutput.status !== 0) {
    throw new Error(
      `bun install failed: ${installOutput.stderr || installOutput.stdout}`,
    )
  }

  // 5) Resolve the server root and the TUI subpath through the package
  //    export map (NOT by direct path). The subpath resolution exercises
  //    `package.json#exports["./tui"]` exactly the way a real host would.
  const installedRoot = join(
    consumerDir,
    'node_modules',
    '@cortexkit',
    'opencode-antigravity-auth',
  )
  const serverEntry = join('@cortexkit/opencode-antigravity-auth', '.')
  const serverModule = (await import(serverEntry)) as Record<string, unknown>
  if (
    !serverModule['AntigravityCLIOAuthPlugin'] &&
    !serverModule['GoogleOAuthPlugin']
  ) {
    throw new Error(
      'server root exports neither AntigravityCLIOAuthPlugin nor GoogleOAuthPlugin',
    )
  }

  const tuiEntry = join('@cortexkit/opencode-antigravity-auth', 'tui')
  const tuiModule = (await import(tuiEntry)) as { default?: unknown }
  const tuiDefault = tuiModule.default as
    | { id?: unknown; tui?: unknown }
    | undefined
  if (!tuiDefault || typeof tuiDefault !== 'object') {
    throw new Error('tui subpath default export is not an object')
  }
  if (tuiDefault.id !== 'cortexkit.antigravity-auth') {
    throw new Error(
      `tui subpath default.id expected 'cortexkit.antigravity-auth', got ${String(tuiDefault.id)}`,
    )
  }
  if (typeof tuiDefault.tui !== 'function') {
    throw new Error(
      'tui subpath default.tui must be a function (Solid component)',
    )
  }

  // 6) Cross-check: the entry module's expected compiled entry path must
  //    resolve to a real file on disk in the installed tree. If the
  //    build layout ever drifts (Must 1 class), this assertion catches it
  //    before a host loads the broken path.
  const installedEntry = join(installedRoot, 'src/tui/entry.mjs')
  const entrySrc = readFileSync(installedEntry, 'utf-8')
  const compiledMatch = entrySrc.match(
    /resolve\(ENTRY_DIR,\s*['"]([^'"]+)['"]\)/,
  )
  const compiledRel = compiledMatch?.[1]
  if (!compiledRel) {
    throw new Error(
      `installed entry.mjs does not contain a recognisable compiled-entry path; first 200 chars: ${entrySrc.slice(0, 200)}`,
    )
  }
  const expectedCompiled = resolve(dirname(installedEntry), compiledRel)
  if (!existsSync(expectedCompiled)) {
    throw new Error(
      `compiled entry path referenced by entry.mjs does not resolve to a real file: ${expectedCompiled}`,
    )
  }

  // Suppress the unused-import warning: pathToFileURL is part of the
  // intended public surface for future re-exports.
  void pathToFileURL

  console.log(
    `[smoke-tui] OK — installed via bun add, exports resolve, compiled entry at ${expectedCompiled}`,
  )
}

function packPackage(packageRoot: string, destination: string): string {
  const output = spawnSync(
    'bun',
    ['pm', 'pack', '--destination', destination],
    { cwd: packageRoot, encoding: 'utf-8' },
  )
  if (output.status !== 0) {
    throw new Error(
      `bun pm pack failed for ${packageRoot}: ${output.stderr || output.stdout}`,
    )
  }
  const tail = output.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const tarball = tail
    .reverse()
    .find((line) => line.endsWith('.tgz') && existsSync(line))
  if (!tarball) {
    throw new Error(
      `bun pm pack produced no discoverable tarball for ${packageRoot} (stdout tail: ${tail.slice(0, 3).join(' | ')})`,
    )
  }
  return tarball
}

function runTar(args: string[]): string[] {
  const output = spawnSync('tar', args, { encoding: 'utf-8' })
  if (output.status !== 0) {
    throw new Error(`tar ${args.join(' ')} failed: ${output.stderr}`)
  }
  return output.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function runScript(cmd: string, args: string[], cwd: string): void {
  const output = spawnSync(cmd, args, { cwd, encoding: 'utf-8' })
  if (output.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed in ${cwd}: ${output.stderr || output.stdout}`,
    )
  }
}

function createTempWorkspace(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(root, { recursive: true })
  return root
}

run().catch((error: unknown) => {
  console.error(
    '[smoke-tui] FAIL:',
    error instanceof Error ? error.message : error,
  )
  process.exitCode = 1
})
