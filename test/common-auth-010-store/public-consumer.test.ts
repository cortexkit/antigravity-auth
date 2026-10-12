// Packs the built core package and loads its common-auth bindings the way a
// published consumer does: from an installed tarball, through the package's
// export map, with no workspace source on the resolution path. Dependencies are
// linked from this repository's installed copies, so the test needs no
// network. It runs under the current runtime only (`process.execPath`); the
// cross-runtime matrix runs in CI.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const coreRoot = join(repoRoot, 'packages/core')
const piRoot = join(repoRoot, 'packages/pi')
const piPackage = '@cortexkit/pi-antigravity-auth'
const CLAUSTRUM_CLIENT = '@cortexkit/claustrum-client'
const corePackage = '@cortexkit/antigravity-auth-core'
const ENTRIES = [
  'store',
  'fs',
  'routing',
  'quota',
  'commands',
  'auth-menu',
  'claustrum',
  'logger',
] as const

/** Bound on one type-check test: one tsc process over the packed types. */
const COMPILER_RUN_MS = 60_000

let root: string
let consumer: string
let installed: string

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    )
  return result.stdout
}

/** Links `name` into the consumer from the copy core itself resolves. */
function linkDependency(name: string) {
  const require = createRequire(join(coreRoot, 'package.json'))
  const manifest = realpathSync(require.resolve(`${name}/package.json`))
  const target = join(consumer, 'node_modules', name)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(dirname(manifest), target, 'dir')
}

/** Packs `packageRoot` (already built) and unpacks it as an installed package. */
function installPacked(packageRoot: string, name: string, filename: string) {
  run(
    process.execPath,
    [
      'pm',
      'pack',
      '--ignore-scripts',
      '--filename',
      join(root, filename),
      '--quiet',
    ],
    packageRoot,
  )
  const target = join(consumer, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  run(
    'tar',
    ['-xzf', join(root, filename), '-C', target, '--strip-components=1'],
    root,
  )
  return target
}

function runConsumer(source: string): string {
  const script = join(consumer, `probe-${Date.now()}-${Math.random()}.mjs`)
  writeFileSync(script, source)
  return run(process.execPath, [script], consumer)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-public-consumer-'))
  consumer = join(root, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'core-public-consumer', private: true, type: 'module' })}\n`,
  )
  installed = installPacked(coreRoot, corePackage, 'core.tgz')
  installPacked(piRoot, piPackage, 'pi.tgz')
  for (const name of [CLAUSTRUM_CLIENT, 'xdg-basedir', 'zod'])
    linkDependency(name)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('packed core common-auth bindings', () => {
  it('ships every embedded entry with its declarations', () => {
    for (const entry of ENTRIES) {
      for (const file of ['index.js', 'index.d.ts']) {
        const path = join(installed, 'dist/common-auth-embedded', entry, file)
        expect(lstatSync(path).isFile()).toBe(true)
      }
    }
  })

  it('loads each entry lazily and as the same module as its subpath export', () => {
    const output = runConsumer(`
      const core = await import('${corePackage}')
      const entries = ${JSON.stringify(ENTRIES)}
      const loaders = {
        store: core.loadCommonAuthStore,
        fs: core.loadCommonAuthFs,
        routing: core.loadCommonAuthRouting,
        quota: core.loadCommonAuthQuota,
        commands: core.loadCommonAuthCommands,
        'auth-menu': core.loadCommonAuthAuthMenu,
        claustrum: core.loadCommonAuthClaustrum,
        logger: core.loadCommonAuthLogger,
      }
      const same = {}
      for (const entry of entries) {
        const loaded = await loaders[entry]()
        const direct = await import('${corePackage}/common-auth/' + entry)
        same[entry] = loaded === direct
      }
      const { store, fs } = await core.loadCommonAuthStoreModules()
      console.log(JSON.stringify({
        same,
        openPoolStore: typeof store.openPoolStore,
        withLock: typeof fs.withLock,
      }))
    `)
    const result = JSON.parse(output.trim())
    expect(result.same).toEqual(
      Object.fromEntries(ENTRIES.map((entry) => [entry, true])),
    )
    expect(result.openPoolStore).toBe('function')
    expect(result.withLock).toBe('function')
  })

  it('imports the package root without loading a missing embedded entry, and retries the load', () => {
    const chunk = join(
      installed,
      'dist/common-auth-embedded/claustrum/index.js',
    )
    const parked = `${chunk}.parked`
    const output = runConsumer(`
      import { renameSync } from 'node:fs'
      renameSync(${JSON.stringify(chunk)}, ${JSON.stringify(parked)})
      const core = await import('${corePackage}')
      let firstError = null
      try {
        await core.loadCommonAuthClaustrum()
      } catch (error) {
        firstError = String(error?.code ?? error?.name ?? 'error')
      }
      const store = await core.loadCommonAuthStore()
      renameSync(${JSON.stringify(parked)}, ${JSON.stringify(chunk)})
      const claustrum = await core.loadCommonAuthClaustrum()
      console.log(JSON.stringify({
        firstError,
        storeLoaded: typeof store.openPoolStore,
        retried: typeof claustrum.ClaustrumConsumer,
      }))
    `)
    const result = JSON.parse(output.trim())
    expect(result.firstError).not.toBeNull()
    expect(result.storeLoaded).toBe('function')
    expect(result.retried).toBe('function')
    // The probe restores the chunk; a failed probe must not leave it parked.
    try {
      renameSync(parked, chunk)
    } catch {}
  })

  it('builds the shared /antigravity menu in sections mode from the packed root', () => {
    // The mode a host without account rows (Pi) uses: four host sections run
    // through the embedded library dispatcher.
    const output = runConsumer(`
      const core = await import('${corePackage}')
      const section = (title) => ({ title, build: () => ({ lines: [title] }) })
      const menu = core.createAntigravityCommandMenu({
        source: 'sections',
        commands: await core.loadCommonAuthCommands(),
        sections: {
          accounts: section('Accounts'),
          quota: section('Quota'),
          routing: section('Routing'),
          limits: section('Limits'),
        },
      })
      const payload = await menu.open({ notify: () => undefined })
      console.log(JSON.stringify({
        command: menu.command,
        slots: payload.menu.sections.map((entry) => entry.slot),
      }))
    `)
    expect(JSON.parse(output.trim())).toEqual({
      command: 'antigravity',
      slots: ['accounts', 'quota', 'routing', 'limits'],
    })
  })

  it.each([
    ['NodeNext', { module: 'NodeNext', moduleResolution: 'NodeNext' }],
    ['Bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
  ] as const)(
    'type-checks root and subpath imports under %s resolution with library checking on',
    (label, resolution) => {
      const types = join(consumer, 'node_modules/@types/node')
      if (!existsSync(types)) {
        mkdirSync(dirname(types), { recursive: true })
        symlinkSync(
          realpathSync(join(repoRoot, 'node_modules/@types/node')),
          types,
          'dir',
        )
      }
      writeFileSync(
        join(consumer, 'consumer.ts'),
        `import {
  type CommonAuthStoreModules,
  loadCommonAuthStoreModules,
} from '${corePackage}'
import type { PoolStore } from '${corePackage}/common-auth/store'
import type { CommandMenu } from '${corePackage}/common-auth/commands'
import type { ClaustrumConsumer } from '${corePackage}/common-auth/claustrum'
import type { PluginSection } from '${corePackage}/common-auth/commands'
import {
  type AntigravityMenuSections,
  type AntigravitySectionsMenuOptions,
  createAntigravityCommandMenu,
  loadCommonAuthCommands,
} from '${corePackage}'

const modules: CommonAuthStoreModules = await loadCommonAuthStoreModules()
const open: (...args: Parameters<typeof modules.store.openPoolStore>) => PoolStore =
  modules.store.openPoolStore
export const surface: [typeof open, CommandMenu | undefined, ClaustrumConsumer | undefined] =
  [open, undefined, undefined]

const section: PluginSection = { title: 'Accounts', build: () => ({ lines: [] }) }
const sections: AntigravityMenuSections = {
  accounts: section,
  quota: section,
  routing: section,
  limits: section,
}
const menuOptions: AntigravitySectionsMenuOptions = {
  source: 'sections',
  commands: await loadCommonAuthCommands(),
  sections,
}
export const menu: CommandMenu = createAntigravityCommandMenu(menuOptions)
`,
      )
      const config = `tsconfig.${label}.json`
      writeFileSync(
        join(consumer, config),
        `${JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            ...resolution,
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ['node'],
          },
          files: ['consumer.ts'],
        })}\n`,
      )
      const tsc = createRequire(join(repoRoot, 'package.json')).resolve(
        'typescript/bin/tsc',
      )
      run(process.execPath, [tsc, '-p', config], consumer)
    },
    // A full strict compiler run over the published declarations, as a separate
    // process, takes several seconds; Bun's default 5 s test limit is too short.
    COMPILER_RUN_MS,
  )
})

describe('packed Pi extension and core share one Claustrum client', () => {
  it('declares the same exact client release as core', () => {
    const pi = JSON.parse(
      readFileSync(
        join(consumer, 'node_modules', piPackage, 'package.json'),
        'utf8',
      ),
    )
    const core = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf8'),
    )
    expect(pi.dependencies[CLAUSTRUM_CLIENT]).toBe(
      core.dependencies[CLAUSTRUM_CLIENT],
    )
    expect(pi.dependencies[corePackage]).toBe(core.version)
  })

  it('resolves the client to one installed copy from Pi and from core', () => {
    const piDir = join(consumer, 'node_modules', piPackage)
    const claustrumEntry = join(
      installed,
      'dist/common-auth-embedded/claustrum/index.js',
    )
    const fromPi = realpathSync(Bun.resolveSync(CLAUSTRUM_CLIENT, piDir))
    const fromCore = realpathSync(
      Bun.resolveSync(CLAUSTRUM_CLIENT, dirname(claustrumEntry)),
    )
    expect(fromPi).toBe(fromCore)
  })

  it('keeps the client out of the Pi bundle', () => {
    // The client's own function definition appears in a bundle only when
    // esbuild inlined a second copy instead of leaving the import external.
    const bundle = readFileSync(
      join(consumer, 'node_modules', piPackage, 'dist/index.js'),
      'utf8',
    )
    expect(bundle).not.toContain('function resolveClaustrumConnectionPath(')
  })
})
