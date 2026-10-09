import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertMeasuredNativeJob } from './fixtures/opencode-ga-host/native-job.ts'
import {
  assertOwnedCommandSucceeded,
  startOwnedCommand,
} from './fixtures/opencode-ga-host/owned-command.ts'
import {
  GA_CONTRACT_PATH,
  GA_PIN_PATH,
  gaChildEnvironment,
  ownedPath,
  prepareGaRoot,
  readGaPin,
  record,
  sha256,
  verifiedArchiveFiles,
  verifyExecutable,
} from './opencode-ga-harness.ts'

export const GA_OFFLINE_FIXTURE =
  'packages/e2e-tests/src/fixtures/opencode-ga-host'
const PACKAGE = '@cortexkit/opencode-antigravity-auth'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertGaFixturePins(repo: string): void {
  const pin = readGaPin(repo)
  const fixture = join(repo, GA_OFFLINE_FIXTURE)
  const manifest = record(
    JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')),
  )
  const lock = record(
    JSON.parse(readFileSync(join(fixture, 'bun.lock'), 'utf8')),
  )
  const dependencies = record(manifest.dependencies)
  const lockedRoot = record(record(record(lock.workspaces)['']).dependencies)
  check(
    manifest.private === true && !manifest.scripts && !manifest.workspaces,
    'Host fixture must be private, standalone and script-free',
  )
  check(
    JSON.stringify(dependencies) === JSON.stringify(lockedRoot),
    'Fixture manifest and frozen lock disagree',
  )
  const cli = record(lock.packages)[pin.package]
  check(
    dependencies[pin.package] === pin.version &&
      Array.isArray(cli) &&
      cli[0] === `${pin.package}@${pin.version}` &&
      cli[3] === pin.sri &&
      record(cli[2]).os === 'linux' &&
      record(cli[2]).cpu === 'x64',
    'Official platform fixture differs from tracked SRI/version/platform pin',
  )
  const expected = [
    pin.package,
    '@cortexkit/claustrum-client',
    '@cortexkit/subc-client',
    'jsonc-parser',
    'xdg-basedir',
    'zod',
  ].sort()
  check(
    JSON.stringify(Object.keys(record(lock.packages)).sort()) ===
      JSON.stringify(expected),
    'Unexpected offline consumer dependency closure',
  )
}

export function gaConsumerPrefix(): string {
  const prefix = process.env.GA_CONSUMER_PREFIX ?? '/opt/ga-consumer'
  check(
    isAbsolute(prefix) &&
      !prefix.startsWith(`${realpathSync(resolve('.'))}/`) &&
      realpathSync(prefix) === prefix,
    'Consumer prefix must be an installed owned directory outside the checkout',
  )
  return prefix
}

/** Resolve the installed public export, not a guessed dist path or a checkout source. */
export function gaInstalledServer(
  prefix: string,
  kind: 'import' | 'types',
): string {
  const root = join(prefix, 'node_modules', ...PACKAGE.split('/'))
  const manifest = record(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  )
  const target = record(record(manifest.exports)['./server'])[kind]
  check(
    typeof target === 'string' && target.startsWith('./'),
    'Installed package lacks the public server entry',
  )
  const entry = resolve(root, target)
  ownedPath(prefix, entry)
  check(
    statSync(entry).isFile() && realpathSync(entry) === entry,
    'Installed server entry is not a regular packed file',
  )
  if (kind === 'import')
    check(
      Bun.resolveSync(`${PACKAGE}/server`, prefix) === entry,
      'Installed import resolution disagrees with its manifest',
    )
  return entry
}

function assertInstalledTree(root: string): void {
  const canonical = realpathSync(root)
  let entries = 0
  let bytes = 0
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const file = lstatSync(path)
      check(++entries <= 20_000, 'Offline fixture has excessive file inventory')
      if (file.isSymbolicLink())
        check(
          realpathSync(path).startsWith(`${canonical}/`),
          'Offline fixture symlink escapes its dependency closure',
        )
      else if (file.isDirectory()) visit(path)
      else {
        check(file.isFile(), 'Unsupported offline fixture file type')
        bytes += file.size
        check(bytes <= 512 * 1024 * 1024, 'Offline fixture exceeds byte cap')
      }
    }
  }
  visit(root)
}

export async function prepareNativeGaConsumer(
  repo: string,
  prefix: string,
): Promise<void> {
  assertMeasuredNativeJob()
  assertGaFixturePins(repo)
  check(
    isAbsolute(prefix) &&
      !existsSync(prefix) &&
      !prefix.startsWith(`${realpathSync(repo)}/`) &&
      realpathSync(dirname(prefix)) === dirname(prefix),
    'Native consumer prefix must be fresh and outside the checkout',
  )
  check(
    existsSync(join(repo, GA_CONTRACT_PATH)),
    'Missing tracked official host contract',
  )
  const fixture = join(repo, GA_OFFLINE_FIXTURE)
  const modules = join(fixture, 'node_modules')
  check(
    existsSync(modules) && realpathSync(modules) === modules,
    'Trusted frozen fixture installation is missing; runtime cannot fetch/install it',
  )
  assertInstalledTree(modules)
  const pin = readGaPin(repo)
  const platformBinary = join(
    modules,
    ...pin.package.split('/'),
    'bin',
    'opencode',
  )
  check(
    statSync(platformBinary).size === pin.binaryBytes,
    'Installed official platform binary has wrong size',
  )
  verifyExecutable(platformBinary, pin.binarySha256, pin.elfMachine)
  mkdirSync(prefix, { mode: 0o700 })
  cpSync(modules, join(prefix, 'node_modules'), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  })
  mkdirSync(join(prefix, 'preparation'), { mode: 0o700 })
  const paths = prepareGaRoot(join(prefix, 'preparation'))
  const env = gaChildEnvironment(paths, {})
  const commands = async (name: string, args: string[], cwd: string) => {
    const result = await startOwnedCommand(
      realpathSync(process.execPath),
      args,
      { cwd, env, deadlineMs: 120_000 },
    ).result
    writeFileSync(
      join(prefix, `${name}.json`),
      JSON.stringify({ command: process.execPath, args, result }, null, 2),
      { flag: 'wx', mode: 0o600 },
    )
    assertOwnedCommandSucceeded(result)
  }
  check(
    typeof Bun !== 'undefined',
    'Native preparation must run with the pinned Bun tool',
  )
  await commands('build', ['run', 'build'], repo)
  for (const [directory, packageName, filename] of [
    ['packages/core', '@cortexkit/antigravity-auth-core', 'core.tgz'],
    ['packages/opencode', PACKAGE, 'plugin.tgz'],
  ]) {
    const archive = join(prefix, filename!)
    await commands(
      filename!,
      ['pm', 'pack', '--ignore-scripts', '--filename', archive],
      join(repo, directory!),
    )
    const bytes = readFileSync(archive)
    const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
    const files = verifiedArchiveFiles(bytes, integrity)
    const manifest = JSON.parse(
      files.get('package/package.json')?.toString() ?? 'null',
    )
    check(
      record(manifest).name === packageName,
      'Packed package identity mismatch',
    )
    const destination = join(prefix, 'node_modules', ...packageName!.split('/'))
    check(
      !existsSync(destination),
      'Packed product must not replace a fixture dependency',
    )
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const [name, contents] of files) {
      check(name.startsWith('package/'), 'Packed file is outside package root')
      const target = ownedPath(
        prefix,
        join(destination, name.slice('package/'.length)),
      )
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, contents, { flag: 'wx', mode: 0o600 })
    }
  }
  writeFileSync(
    join(prefix, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    { flag: 'wx', mode: 0o600 },
  )
  gaInstalledServer(prefix, 'import')
  gaInstalledServer(prefix, 'types')
  for (const forbidden of [
    '@opencode/plugin',
    '@opencode-ai',
    '@opentui',
    'solid-js',
  ])
    check(
      !existsSync(join(prefix, 'node_modules', forbidden)),
      `Consumer installed a package-owned host framework: ${forbidden}`,
    )
  writeFileSync(
    join(prefix, 'artifacts.json'),
    JSON.stringify(
      {
        sourceRevision: process.env.GA_SOURCE_REVISION,
        sourceTree: process.env.GA_SOURCE_TREE,
        pinSha256: sha256(readFileSync(join(repo, GA_PIN_PATH))),
        contractSha256: sha256(readFileSync(join(repo, GA_CONTRACT_PATH))),
        fixtureLockSha256: sha256(readFileSync(join(fixture, 'bun.lock'))),
        coreSha256: sha256(readFileSync(join(prefix, 'core.tgz'))),
        pluginSha256: sha256(readFileSync(join(prefix, 'plugin.tgz'))),
        binarySha256: pin.binarySha256,
        installation:
          'verified local packs with trusted frozen dependency closure; no runtime registry or lifecycle scripts',
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  )
}

/** Read declaration targets from the genuine installed 2.0.22 SDK dependency layout. */
export function gaSdkDeclarationPaths(repo: string): Record<string, string[]> {
  const plugin = realpathSync(
    join(repo, 'packages/opencode/node_modules/@opencode/plugin'),
  )
  const scope = dirname(plugin)
  const paths: Record<string, string[]> = {}
  for (const name of ['plugin', 'client', 'schema', 'protocol']) {
    const root = realpathSync(join(scope, name))
    check(
      root.startsWith(`${realpathSync(repo)}/`),
      'SDK package escaped the selected checkout',
    )
    const manifest = record(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    )
    check(
      manifest.name === `@opencode/${name}` && manifest.version === '2.0.22',
      'Consumer types require the genuine 2.0.22 SDK',
    )
    for (const [subpath, conditions] of Object.entries(
      record(manifest.exports),
    )) {
      const types = record(conditions).types
      if (typeof types !== 'string') continue
      const specifier = `@opencode/${name}${subpath === '.' ? '' : subpath.slice(1)}`
      paths[specifier] = [join(root, types)]
    }
  }
  check(
    paths['@opencode/plugin'] && paths['@opencode/client/promise'],
    'Official SDK lacks required public declarations',
  )
  return paths
}
