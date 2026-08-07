/**
 * Guard the published dependency ranges against install-breaking upper bounds.
 *
 * The plugin is installed by `opencode plugin` into a tree that ALREADY
 * contains the host (`@opencode-ai/plugin`) and its OpenTUI stack. Whenever we
 * declare a range for a package the host also declares, an upper bound on our
 * side can make the tree unsatisfiable and npm aborts with ERESOLVE — the
 * plugin then fails to install at all, which surfaces to the user as a missing
 * provider ("Model not found: google/antigravity-...").
 *
 * That shipped in 2.0.0: `@opentui/*` was declared as `^0.4.5`, which on a 0.x
 * version means `>=0.4.5 <0.5.0`. OpenTUI released 0.5.0, the host accepted it
 * via its own `>=0.4.5`, and every fresh install broke.
 *
 * The rule these tests encode is narrow and mechanical: a FLOOR is fine (we can
 * require a minimum), a CEILING is not. `999.0.0` stands in for "any future
 * release" — a range that rejects it carries an upper bound, whether explicit
 * (`<2`), tilde (`~0.4.5`), or the implicit caret-on-zero (`^0.4.5`).
 *
 * Scope, stated plainly: these are STATIC range assertions. They do not run a
 * resolver and prove nothing about the shape of an installed tree. The
 * end-to-end proof that a real install succeeds and dedupes to one copy is
 * `scripts/smoke-tui-pack-install.ts`, which packs the tarball and installs it
 * into a throwaway consumer. These tests exist because that smoke test only
 * exercises the versions present when it runs: it cannot fail for a ceiling no
 * released version has crossed YET, which is exactly how the 2.0.0 break
 * reached users. A ceiling is detectable the moment it is written; waiting for
 * the ecosystem to cross it is what turned this one into a field report.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../')

interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(path, 'utf-8')) as Manifest

const ourManifest = readManifest(join(PACKAGE_ROOT, 'package.json'))

/** Every range we publish, regardless of which field declares it. */
const ourRanges: Record<string, string> = {
  ...(ourManifest.dependencies ?? {}),
  ...(ourManifest.peerDependencies ?? {}),
}

/**
 * Resolve the host manifest from the installed tree rather than hardcoding a
 * copy — the point is to compare against whatever host version is in play.
 */
const findHostManifest = (): Manifest | null => {
  let dir = PACKAGE_ROOT
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules/@opencode-ai/plugin/package.json')
    try {
      return readManifest(candidate)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/**
 * Every DISTINCT installed copy of `name` reachable from the workspace.
 *
 * Two shapes have to be covered, because a duplicate can appear either way:
 *
 *   - the ancestor walk (`<pkg>/node_modules`, then each parent up to the
 *     workspace root) — where a hoisted install lives;
 *   - one nested level (`node_modules/<dep>/node_modules/<name>`, including
 *     scoped `<scope>/<dep>`) — where npm parks a second copy when it cannot
 *     satisfy every dependent with one hoisted version. That nested copy IS
 *     the "ranges forced a second install" outcome, so a walk that only climbs
 *     ancestors would pass while the tree carries two.
 *
 * Identity is the file's inode, not its path and not its realpath: Bun's store
 * links one physical package into several trees, and it may use hardlinks,
 * which `realpathSync` does not collapse. Two entries here therefore means two
 * genuinely distinct installs on disk.
 *
 * Depth is bounded at one nested level. A duplicate buried deeper is not
 * detected — that is a real limit, accepted because the failure this guards
 * puts the second copy directly under the dependent that forced it.
 */
const findInstalledCopies = (name: string): string[] => {
  const byInode = new Map<string, string>()

  const record = (packageJson: string): void => {
    if (!existsSync(packageJson)) return
    const version = (
      JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: string }
    ).version
    if (version === undefined) return
    const stats = statSync(packageJson)
    byInode.set(`${stats.dev}:${stats.ino}`, version)
  }

  const scanNested = (modulesDir: string): void => {
    if (!existsSync(modulesDir)) return
    for (const entry of readdirSync(modulesDir)) {
      if (entry === '.bin' || entry === '.cache') continue
      const owners = entry.startsWith('@')
        ? readdirSync(join(modulesDir, entry)).map((child) =>
            join(entry, child),
          )
        : [entry]
      for (const owner of owners) {
        record(join(modulesDir, owner, 'node_modules', name, 'package.json'))
      }
    }
  }

  let dir = PACKAGE_ROOT
  for (let depth = 0; depth < 6; depth += 1) {
    const modulesDir = join(dir, 'node_modules')
    record(join(modulesDir, name, 'package.json'))
    scanNested(modulesDir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...byInode.values()]
}

/** Stands in for "some future release the host will happily accept". */
const FUTURE_VERSION = '999.0.0'

describe('published dependency ranges', () => {
  it('declares no upper bound on the host\u2019s own peer dependencies', () => {
    const host = findHostManifest()
    expect(host).not.toBeNull()

    // Only the host's PEER dependencies matter here: npm requires a peer to be
    // satisfied by ONE version shared with the dependent, so our range and the
    // host's must be simultaneously satisfiable or the install aborts. The
    // host's ordinary `dependencies` (e.g. zod) can nest a second copy, so a
    // bound there is not an install hazard and is deliberately not flagged.
    const hostPeers = Object.keys(host?.peerDependencies ?? {})

    const shared = hostPeers.filter((name) => name in ourRanges)
    // If this is ever empty the test has stopped testing anything.
    expect(shared.length).toBeGreaterThan(0)

    const capped = shared.filter(
      (name) => !Bun.semver.satisfies(FUTURE_VERSION, ourRanges[name] ?? ''),
    )
    expect(capped).toEqual([])
  })

  it('declares no upper bound on the host plugin itself', () => {
    const range = ourRanges['@opencode-ai/plugin']
    expect(range).toBeDefined()
    expect(Bun.semver.satisfies(FUTURE_VERSION, range ?? '')).toBe(true)
  })

  it('the installed tree resolves one shared copy per host peer', () => {
    // The static assertions above cannot see an actual resolution, so pin the
    // outcome they exist to protect: for every host peer we also declare, the
    // workspace must contain exactly ONE installed copy, and its version must
    // satisfy both ranges at once. This is the property npm enforces at
    // install time and the one the 2.0.0 ranges made unsatisfiable.
    const host = findHostManifest()
    expect(host).not.toBeNull()
    const hostPeers = host?.peerDependencies ?? {}

    const shared = Object.keys(hostPeers).filter((name) => name in ourRanges)
    expect(shared.length).toBeGreaterThan(0)

    for (const name of shared) {
      const copies = findInstalledCopies(name)
      // Exactly one copy: a second means the ranges forced a duplicate
      // install rather than one shared version every dependent can use.
      expect({ name, copies: copies.length }).toEqual({ name, copies: 1 })

      const installed = copies[0] ?? ''
      expect({
        name,
        satisfiesOurs: Bun.semver.satisfies(installed, ourRanges[name] ?? ''),
        satisfiesHost: Bun.semver.satisfies(installed, hostPeers[name] ?? ''),
      }).toEqual({ name, satisfiesOurs: true, satisfiesHost: true })
    }
  })

  it('accepts the OpenTUI versions the host accepts', () => {
    // The concrete regression: 0.5.x was rejected by `^0.4.5`.
    for (const name of ['@opentui/core', '@opentui/keymap', '@opentui/solid']) {
      const range = ourRanges[name]
      expect(range).toBeDefined()
      for (const version of ['0.4.5', '0.5.0', '0.5.1', '1.0.0']) {
        expect(Bun.semver.satisfies(version, range ?? '')).toBe(true)
      }
    }
  })
})
