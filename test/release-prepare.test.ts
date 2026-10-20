import { afterEach, expect, test } from 'bun:test'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommandBytes } from './support/run-command.ts'

const sourceRoot = resolve(import.meta.dir, '..')
// Each command fails at its own deadline, before the enclosing test's timeout.
const TEST_TIMEOUT_MS = 90_000
const COMMAND_DEADLINE_MS = 60_000
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function git(root: string, ...args: string[]) {
  const result = await runCommandBytes(['git', ...args], {
    cwd: root,
    deadlineMs: COMMAND_DEADLINE_MS,
  })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of ['release.sh', 'version-sync.mjs', 'sync-release-lock.ts'])
    cpSync(join(sourceRoot, 'scripts', file), join(root, 'scripts', file))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  )
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  for (const name of ['core', 'opencode', 'pi']) {
    mkdirSync(join(root, 'packages', name), { recursive: true })
    const pkg = {
      name:
        name === 'core'
          ? '@cortexkit/antigravity-auth-core'
          : `@example/${name}`,
      version: '1.0.0',
      description: 'unchanged',
      ...(name === 'core'
        ? {}
        : { dependencies: { '@cortexkit/antigravity-auth-core': '1.0.0' } }),
    }
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify(pkg),
    )
  }
  const installed = await runCommandBytes(
    [
      process.execPath,
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--offline',
    ],
    { cwd: root, deadlineMs: COMMAND_DEADLINE_MS },
  )
  if (installed.exitCode) throw new Error(installed.stderr.toString())
  symlinkSync(
    join(sourceRoot, 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  )
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Release Test')
  await git(root, 'config', 'user.email', 'release@example.invalid')
  await git(root, 'config', 'core.hooksPath', '/dev/null')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'fixture')
  return root
}

async function bump(root: string, corrupt?: string) {
  for (const name of ['core', 'opencode', 'pi']) {
    const path = join(root, 'packages', name, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.version = '1.0.1'
    if (pkg.dependencies)
      pkg.dependencies['@cortexkit/antigravity-auth-core'] = '1.0.1'
    if (name === 'core' && corrupt === 'manifest')
      pkg.description = 'smuggled change'
    writeFileSync(path, JSON.stringify(pkg))
  }
  const lockPath = join(root, 'bun.lock')
  const lock = Bun.JSONC.parse(readFileSync(lockPath, 'utf8')) as {
    workspaces: Record<
      string,
      { version?: string; dependencies?: Record<string, string> }
    >
    packages: Record<string, unknown>
  }
  for (const [path, pkg] of Object.entries(lock.workspaces)) {
    if (!path.startsWith('packages/')) continue
    pkg.version = '1.0.1'
    if (pkg.dependencies)
      pkg.dependencies['@cortexkit/antigravity-auth-core'] = '1.0.1'
  }
  if (corrupt === 'lock') lock.packages.injected = ['unexpected']
  writeFileSync(lockPath, JSON.stringify(lock))
  if (corrupt === 'source')
    writeFileSync(join(root, 'source.ts'), 'export const smuggled = true\n')
  await git(root, 'add', '.')
  await git(
    root,
    'commit',
    '-m',
    corrupt === 'subject' ? 'not a version sync' : 'release: v1.0.1',
  )
}

for (const state of [
  'valid',
  'manifest',
  'lock',
  'source',
  'subject',
] as const) {
  test(
    `release version-sync check handles ${state}`,
    async () => {
      const root = await fixture()
      await bump(root, state)
      const checked = await runCommandBytes(
        [
          process.execPath,
          join(sourceRoot, 'scripts/check-release-version.ts'),
          '1.0.1',
        ],
        { cwd: root, deadlineMs: COMMAND_DEADLINE_MS },
      )
      expect(checked.exitCode === 0, checked.stderr.toString()).toBe(
        state === 'valid',
      )
    },
    TEST_TIMEOUT_MS,
  )
}

test(
  'release --prepare commits versions without a tag or gate',
  async () => {
    const root = await fixture()
    const prepared = await runCommandBytes(
      ['bash', 'scripts/release.sh', '--prepare', '1.0.1'],
      { cwd: root, deadlineMs: COMMAND_DEADLINE_MS },
    )
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('release: v1.0.1')
    expect(await git(root, 'tag', '--list')).toBe('')
    expect(await git(root, 'status', '--porcelain')).toBe('')
    expect(prepared.stdout.toString()).not.toContain(
      'Running pre-release checks',
    )
    expect(prepared.stdout.toString()).not.toContain('Creating tag')
    const checked = await runCommandBytes(
      [
        process.execPath,
        join(sourceRoot, 'scripts/check-release-version.ts'),
        '1.0.1',
      ],
      { cwd: root, deadlineMs: COMMAND_DEADLINE_MS },
    )
    expect(
      checked.exitCode,
      `${checked.stderr}\n${await git(root, 'diff', 'HEAD^', 'HEAD', '--', 'bun.lock')}`,
    ).toBe(0)
  },
  TEST_TIMEOUT_MS,
)
