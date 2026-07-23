/**
 * Precompile the OpenTUI sidebar tree.
 *
 * Production hosts load package code through `@opentui/solid/scripts/solid-transform`
 * and resolve OpenTUI/Solid imports via virtual runtime-module specifiers
 * (`opentui:runtime-module:<encodeURIComponent('@opentui/solid')>` etc.). This
 * script:
 *
 *   1. Walks the relative static import graph rooted at `src/tui.tsx`,
 *      recording the set of files that ship.
 *   2. Compiles each `.tsx` source through the solid-transform helper
 *      (loaded via file URL because the package does not expose the
 *      scripts subpath) and rewrites the runtime import specifiers to
 *      virtual runtime modules, emitting the transformed JS to
 *      `src/tui-compiled/`.
 *   3. Copies non-TSX sources as-is (they need no JSX transformation).
 *      Each source lands at `src/tui-compiled/<stripped-from-src>`
 *      so the compiled tree mirrors the source layout relative to `src/`,
 *      which means `src/tui/entry.mjs`'s `../tui-compiled/tui.tsx`
 *      resolution lands on the right file.
 *
 * The host entry module (`src/tui/entry.mjs`) is intentionally NOT copied
 * into the compiled tree — it is a tiny loader that lives next to the
 * source and the package exports it directly. The shipped allowlist
 * (`SHIPPED_SOURCE_FILES`) still lists it because it ships in the package
 * `files` allowlist via the `src/tui/` directory entry.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT_DEFAULT = resolve(fileURLToPath(import.meta.url), '../../')

interface BuildOptions {
  packageRoot: string
  outDir?: string
  /** Override the entry relative path inside `src/`. Defaults to `tui.tsx`. */
  entry?: string
}

interface BuildResult {
  shippedSourceFiles: string[]
  outDir: string
  /** Path to the compiled entry the host runtime module imports. */
  compiledEntry: string
  rawEntry: string
}

interface SolidTransformModule {
  transformSolidSource(
    code: string,
    options: {
      filename: string
      moduleName?: string
      resolvePath?: (specifier: string) => string | null
    },
  ): Promise<string>
  isNodeModulesPath(path: string): boolean
  stripQueryAndHash(path: string): string
}

const SOLID_TRANSFORM_PATH = pathToFileURL(
  resolve(
    PACKAGE_ROOT_DEFAULT,
    'node_modules/@opentui/solid/scripts/solid-transform.js',
  ),
).href

const SOURCE_PREFIX = 'src/'

let cachedTransform: SolidTransformModule | null = null

async function loadSolidTransform(): Promise<SolidTransformModule> {
  if (cachedTransform) return cachedTransform
  // Dynamic import through a file URL — the package does not export this
  // subpath through `package.json` exports, but Bun resolves file URLs
  // directly without consulting the exports map.
  const mod = (await import(SOLID_TRANSFORM_PATH)) as SolidTransformModule
  cachedTransform = mod
  return mod
}

export const SHIPPED_SOURCE_FILES: readonly string[] = [
  'src/tui.tsx',
  'src/tui/entry.mjs',
  'src/tui/command-dialogs.tsx',
  'src/tui/file-logger.ts',
  'src/tui-preferences.ts',
  'src/sidebar-state.ts',
  'src/rpc/rpc-client.ts',
  'src/rpc/rpc-dir.ts',
  'src/rpc/port-file.ts',
  'src/rpc/protocol.ts',
  // Privacy-safe quota/account data projection used by the data-first
  // dialogs (Task 9). The compiled tree must include the type-only
  // module that dialogs import `CommandAccountRow` from.
  'src/plugin/command-data.ts',
]

/**
 * Walk every relative static import reachable from `roots`, returning the
 * absolute on-disk paths that the sidebar tree depends on. The traversal
 * does not follow external (non-relative) imports — those are resolved by
 * the host at runtime and intentionally not shipped.
 */
export async function collectRelativeImportGraph(
  roots: string[],
  packageRoot: string = PACKAGE_ROOT_DEFAULT,
): Promise<string[]> {
  const transform = await loadSolidTransform()
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) continue
    const absolute = isAbsolute(next) ? next : resolve(packageRoot, next)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    if (!existsSync(absolute)) continue
    if (transform.isNodeModulesPath(absolute)) continue
    const code = readFileSync(absolute, 'utf-8')
    for (const specifier of collectRelativeSpecifiers(code)) {
      queue.push(resolveRelative(absolute, specifier))
    }
  }
  return [...seen]
}

export async function buildTui(options: BuildOptions): Promise<BuildResult> {
  const packageRoot = options.packageRoot
  const outDir = options.outDir ?? join(packageRoot, 'src/tui-compiled')
  const entry = options.entry ?? 'src/tui.tsx'

  const transform = await loadSolidTransform()

  const roots = [join(packageRoot, entry)]
  const reachable = await collectRelativeImportGraph(
    roots.map((path) => path),
    packageRoot,
  )

  // Always re-emit the tree so a deleted stale file is removed.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })

  const shipped: string[] = []
  for (const sourcePath of reachable) {
    const rel = relative(packageRoot, sourcePath)
    if (rel.startsWith('..')) continue
    // Strip the leading `src/` so the compiled tree mirrors the source
    // layout relative to `src/`. The host entry module
    // (`src/tui/entry.mjs`) resolves `../tui-compiled/tui.tsx` against
    // its own location, so we want `tui.tsx` to land at
    // `src/tui-compiled/tui.tsx` — directly inside `outDir`.
    const outRel = rel.startsWith(SOURCE_PREFIX)
      ? rel.slice(SOURCE_PREFIX.length)
      : rel
    if (!outRel) continue
    shipped.push(outRel)
    const destination = join(outDir, outRel)
    mkdirSync(dirname(destination), { recursive: true })
    if (sourcePath.endsWith('.tsx')) {
      const code = readFileSync(sourcePath, 'utf-8')
      const transformed = await transform.transformSolidSource(code, {
        filename: sourcePath,
        moduleName: '@opentui/solid',
        resolvePath: (specifier) => {
          if (RUNTIME_SPECIFIERS.has(specifier)) {
            return `opentui:runtime-module:${encodeURIComponent(specifier)}`
          }
          return null
        },
      })
      writeFileSync(destination, transformed, 'utf-8')
    } else {
      copyFileSync(sourcePath, destination)
    }
  }

  return {
    shippedSourceFiles: shipped.sort(),
    outDir,
    compiledEntry: join(outDir, 'tui.tsx'),
    rawEntry: join(packageRoot, entry),
  }
}

const RUNTIME_SPECIFIERS = new Set([
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
])

function collectRelativeSpecifiers(code: string): string[] {
  const specifiers: string[] = []
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    code.replace(pattern, (_full, prefix, specifier, suffix) => {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        specifiers.push(specifier)
      }
      return `${prefix}${specifier}${suffix}`
    })
  }
  return specifiers
}

const STATIC_IMPORT_PATTERNS = [
  /(from\s+["'])([^"']+)(["'])/g,
  /(import\s+["'])([^"']+)(["'])/g,
  /(import\s*\(\s*["'])([^"']+)(["']\s*\))/g,
  /(require\s*\(\s*["'])([^"']+)(["']\s*\))/g,
]

function resolveRelative(fromFile: string, specifier: string): string {
  const base = dirname(fromFile)
  // Mirror the resolver's extension probing: try the literal path, then
  // `.ts`, `.tsx`, `.mjs`, `.js`, and finally as a directory with
  // `index.ts`/`index.tsx`.
  const candidates: string[] = []
  const direct = resolve(base, specifier)
  candidates.push(direct)
  for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
    candidates.push(`${direct}${ext}`)
  }
  for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
    candidates.push(join(direct, `index${ext}`))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Returning the direct path even if missing keeps the caller honest: it
  // surfaces a missing-file assertion in build-tui.test.ts instead of a
  // silent skip.
  return direct
}

if ((import.meta as { main?: boolean }).main) {
  const packageRoot = PACKAGE_ROOT_DEFAULT
  buildTui({ packageRoot })
    .then((result) => {
      process.stdout.write(
        `[build-tui] compiled ${result.shippedSourceFiles.length} files -> ${result.outDir}\n`,
      )
    })
    .catch((error: unknown) => {
      process.stderr.write(`[build-tui] failed: ${formatError(error)}\n`)
      process.exitCode = 1
    })
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
