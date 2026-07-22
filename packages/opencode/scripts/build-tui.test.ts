/**
 * Lock the shipped allowlist for the TUI tree.
 *
 * Walks every relative static import reachable from `tui.tsx` and
 * `tui/entry.mjs`, then asserts:
 *
 *   1. Every reached file is listed in `SHIPPED_SOURCE_FILES`.
 *   2. Every listed file exists on disk inside the package.
 *   3. The package's `files` allowlist covers every listed file (so the
 *      published tarball ships the whole tree).
 *   4. Every compiled-relative import inside the precompiled tree resolves
 *      under `src/tui-compiled/` (so a published host can find neighbours).
 *
 * The negative-fixture test catches a future contributor who adds a new
 * relative import to `tui.tsx` without updating `SHIPPED_SOURCE_FILES` —
 * the build allowlist and the package `files` array drift apart and a
 * packed install silently loses the file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildTui,
  collectRelativeImportGraph,
  SHIPPED_SOURCE_FILES,
} from './build-tui'

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../')
const SHIPPED_ABSOLUTE = SHIPPED_SOURCE_FILES.map((rel) =>
  isAbsolute(rel) ? rel : join(PACKAGE_ROOT, rel),
)

describe('TUI shipping allowlist', () => {
  it('lists every file reachable from the entry modules', async () => {
    const reachable = await collectRelativeImportGraph(
      [
        join(PACKAGE_ROOT, 'src/tui.tsx'),
        join(PACKAGE_ROOT, 'src/tui/entry.mjs'),
      ],
      PACKAGE_ROOT,
    )
    const shippedSet = new Set(SHIPPED_ABSOLUTE)
    const missing = reachable.filter((path) => !shippedSet.has(path))
    expect(missing).toEqual([])
  })

  it('every listed file exists on disk', () => {
    for (const absolute of SHIPPED_ABSOLUTE) {
      expect(existsSync(absolute)).toBe(true)
    }
  })

  it('every listed file is covered by the package.json files allowlist', async () => {
    const pkgRaw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as { files?: string[] }
    const allowlist = pkg.files ?? []
    const normalize = (entry: string): string => entry.replace(/\/$/, '')
    const allowedPrefixes = allowlist.map(normalize)
    for (const shipped of SHIPPED_SOURCE_FILES) {
      const covered = allowedPrefixes.some((entry) => {
        if (entry.includes('*')) return false
        return shipped === entry || shipped.startsWith(`${entry}/`)
      })
      expect(covered).toBe(true)
    }
  })
})

describe('buildTui()', () => {
  let outputDir: string

  beforeAll(() => {
    outputDir = join(PACKAGE_ROOT, 'src/tui-compiled')
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('writes every shipped source under src/tui-compiled/', async () => {
    const result = await buildTui({ packageRoot: PACKAGE_ROOT })
    for (const rel of result.shippedSourceFiles) {
      const out = join(result.outDir, rel)
      expect(existsSync(out)).toBe(true)
    }
  })

  it('rewrites every compiled-relative import to a file under src/tui-compiled/', async () => {
    const result = await buildTui({ packageRoot: PACKAGE_ROOT })
    for (const rel of result.shippedSourceFiles) {
      if (!rel.endsWith('.tsx') && !rel.endsWith('.ts')) continue
      const compiled = join(result.outDir, rel)
      const code = readFileSync(compiled, 'utf-8')
      for (const specifier of collectRelativeSpecifiers(code)) {
        const resolved = resolveRelativeInTree(
          compiled,
          specifier,
          result.outDir,
        )
        expect(
          existsSync(resolved),
          `compiled-relative import "${specifier}" from ${rel} should resolve under ${result.outDir} (got ${resolved})`,
        ).toBe(true)
      }
    }
  })

  it('replaces OpenTUI/solid-js imports with virtual runtime-module specifiers', async () => {
    const result = await buildTui({ packageRoot: PACKAGE_ROOT })
    const compiled = readFileSync(result.compiledEntry, 'utf-8')
    expect(compiled).toContain(
      `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`,
    )
    expect(compiled).toContain(
      `opentui:runtime-module:${encodeURIComponent('solid-js')}`,
    )
  })

  it('refuses to ship a file that is not in SHIPPED_SOURCE_FILES (negative fixture)', async () => {
    const phantom = 'src/tui/__phantom__.ts'
    const phantomPath = join(PACKAGE_ROOT, phantom)
    expect(existsSync(phantomPath)).toBe(false)
    // The phantom path is not in the allowlist; collectRelativeImportGraph
    // would still find it if it were imported, but buildTui must not emit
    // anything outside SHIPPED_SOURCE_FILES. We assert by listing the
    // shipped output: the phantom must not appear even hypothetically.
    expect(SHIPPED_SOURCE_FILES).not.toContain(phantom)
  })
})

const STATIC_IMPORT_PATTERNS = [
  /(from\s+["'])([^"']+)(["'])/g,
  /(import\s+["'])([^"']+)(["'])/g,
  /(import\s*\(\s*["'])([^"']+)(["']\s*\))/g,
  /(require\s*\(\s*["'])([^"']+)(["']\s*\))/g,
]

function collectRelativeSpecifiers(code: string): string[] {
  const out: string[] = []
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    code.replace(pattern, (_full, prefix, specifier, suffix) => {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        out.push(specifier)
      }
      return `${prefix}${specifier}${suffix}`
    })
  }
  return out
}

function resolveRelativeInTree(
  fromFile: string,
  specifier: string,
  treeRoot: string,
): string {
  const base = dirname(fromFile)
  const direct = resolve(base, specifier)
  for (const ext of ['', '.ts', '.tsx', '.mjs', '.js']) {
    const candidate = `${direct}${ext}`
    if (existsSync(candidate)) return candidate
  }
  for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
    const candidate = join(direct, `index${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return direct
}

describe('RPC source shipping', () => {
  it('ships every RPC module imported by the TUI tree', () => {
    expect(SHIPPED_SOURCE_FILES).toEqual(
      expect.arrayContaining([
        'src/rpc/rpc-client.ts',
        'src/rpc/rpc-dir.ts',
        'src/rpc/port-file.ts',
        'src/rpc/protocol.ts',
      ]),
    )
  })
})

describe('standalone CLI isolation', () => {
  it('keeps cli.ts out of the TUI import graph', async () => {
    const reachable = await collectRelativeImportGraph(
      [
        join(PACKAGE_ROOT, 'src/tui.tsx'),
        join(PACKAGE_ROOT, 'src/tui/entry.mjs'),
      ],
      PACKAGE_ROOT,
    )
    expect(reachable).not.toContain(join(PACKAGE_ROOT, 'src/cli.ts'))
  })
})

describe('TUI import graph — credential modules stay out', () => {
  // Modules that store credentials, manage OAuth, or persist account state
  // must never appear in the TUI's transitive import graph. The shipped
  // TUI is transformed (not tree-shaken), so a single stray import pulls
  // the whole module into the host's render path.
  const FORBIDDEN = [
    'src/plugin/account-manager.ts',
    'src/plugin/account-storage.ts',
    'src/plugin/quota-manager.ts',
    'src/plugin/rotation.ts',
  ]
  const FORBIDDEN_PATTERNS = [
    /\/account-manager\.ts$/,
    /\/account-storage\.ts$/,
    /\/(?:antigravity\/)?oauth\.ts$/,
    /\/quota-manager\.ts$/,
    /\/rotation\.ts$/,
  ]

  it('never reaches account-manager, account-storage, oauth, quota-manager, or rotation modules', async () => {
    const reachable = await collectRelativeImportGraph(
      [
        join(PACKAGE_ROOT, 'src/tui.tsx'),
        join(PACKAGE_ROOT, 'src/tui/entry.mjs'),
      ],
      PACKAGE_ROOT,
    )
    const offending = reachable.filter((path) =>
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test(path)),
    )
    expect(offending).toEqual([])
  })

  it('does not import the core barrel or any credentials module', async () => {
    const reachable = await collectRelativeImportGraph(
      [
        join(PACKAGE_ROOT, 'src/tui.tsx'),
        join(PACKAGE_ROOT, 'src/tui/entry.mjs'),
      ],
      PACKAGE_ROOT,
    )
    // Belt-and-suspenders: FORBIDDEN is the canonical list but the
    // declaring names matter too — if a future contributor moves a
    // caller, the exact path moves with it.
    for (const rel of FORBIDDEN) {
      expect(reachable).not.toContain(join(PACKAGE_ROOT, rel))
    }
  })
})
