import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand } from './support/run-command.ts'

/**
 * Tests and the code that only runs inside them must not spawn children
 * synchronously. Bun's synchronous spawn can lose a child's exit on Linux
 * (oven-sh/bun#34069): the runner spins at 100% CPU beside a zombie child and
 * no test timeout can fire. Use test/support/run-command.ts instead.
 *
 * This guard checks test and test-support code, not product source.
 */
const root = resolve(import.meta.dir, '..')
const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\s*\(/

/** Test-related sources and TUI build scripts run by Bun tests. */
function inScope(path: string): boolean {
  if (!/\.(?:[cm]?[jt]s|tsx)$/.test(path)) return false
  return (
    /(?:^|\/)[^/]+\.test\.(?:[cm]?[jt]s|tsx)$/.test(path) ||
    path.startsWith('test/') ||
    path.includes('/__fixtures__/') ||
    path.startsWith('packages/e2e-tests/') ||
    [
      'packages/opencode/scripts/build-tui.ts',
      'packages/opencode/scripts/smoke-tui-pack-install.ts',
      'scripts/prepare-common-auth-public-consumer.ts',
      'scripts/test-stall-diagnostics.ts',
      'scripts/test-child-lifecycle.ts',
      'scripts/build-test-child.ts',
    ].includes(path)
  )
}

/**
 * Files that keep a synchronous spawn, each for a stated reason. None of them
 * spawns synchronously inside the Bun test runner. An entry whose file no
 * longer spawns synchronously fails the guard; remove the entry when that happens.
 */
const ALLOWED: Record<string, string> = {
  // The spawn is source text for a separate child Bun process. The test proves
  // the build phase clock reports a blocked synchronous wait, which needs one.
  'test/build-phase-clock.test.ts': 'synchronous wait under test, in a child',
  // A standalone measurement CLI: its synchronous spawns run only from its
  // import.meta.main path. Tests import its pure helpers, and it must stay
  // self-contained for the four-file Docker input layout.
  'packages/e2e-tests/docker/measure-ga-proxy-matrix.ts':
    'standalone measurement CLI',
  // Standalone mutation-proof and diagnostic scripts run by hand with
  // `bun <file>` or `node <file>`; no test imports or spawns them.
  'test/common-auth-094-adoption/embed-build/mutation-proof.mjs':
    'standalone script',
  'test/common-auth-094-adoption/embed-build/path-mutation-proof.mjs':
    'standalone script',
  'test/common-auth-094-adoption/embed-build/record-mutation-proof.mjs':
    'standalone script',
  'test/common-auth-094-adoption/rpc/mutation-proof.mjs': 'standalone script',
  'test/common-auth-094-adoption/rpc/prepare-0112-candidate.mjs':
    'standalone script',
  'test/common-auth-094-adoption/rpc/result-mutation-proof.mjs':
    'standalone script',
  'test/common-auth-094-adoption/rpc/shutdown-diagnostic.mjs':
    'standalone script',
  // Windows CI verifiers run by Node, not Bun. Tests import only dacl.mjs's
  // pure functions; its spawning reader is used by the verifiers alone.
  'test/windows-migration/verify.mjs': 'Node-only Windows verifier',
  'test/windows-pi-preflight/verify.mjs': 'Node-only Windows verifier',
  'test/windows-vault/dacl.mjs': 'Node-only Windows verifier',
}

test('tests, test support and TUI build scripts never spawn children synchronously', async () => {
  const listed = await runCommand(['git', 'ls-files', '-z'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: root,
    },
    deadlineMs: 10_000,
  })
  expect(listed.exitCode, listed.stderr).toBe(0)
  const files = listed.stdout.split('\0').filter(inScope)
  // A broken file listing must not pass as "no offenders".
  expect(files.length).toBeGreaterThan(100)
  const offenders: string[] = []
  const stale: string[] = []
  for (const path of files) {
    const source = await readFile(join(root, path), 'utf8')
    const lines = source
      .split('\n')
      .flatMap((line, index) =>
        SYNC_SPAWN.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [],
      )
    if (path in ALLOWED) {
      if (!lines.length) stale.push(path)
    } else offenders.push(...lines)
  }
  expect(offenders).toEqual([])
  expect(stale).toEqual([])
  for (const path of Object.keys(ALLOWED)) expect(files).toContain(path)
}, 20_000)

test('the synchronous spawn guard pattern matches every forbidden call form', () => {
  // Assembled at run time so this file does not itself contain a forbidden call.
  const call = (name: string, args: string) => `${name}Sync${args}`
  for (const line of [
    call('Bun.spawn', "(['git'])"),
    call('spawn', "('git', [])"),
    call('execFile', "('git', [])"),
    call('exec', "('git status')"),
    call('childProcess.spawn', ' (command)'),
  ])
    expect(SYNC_SPAWN.test(line)).toBe(true)
  for (const line of [
    "runCommand(['git'])",
    "spawn('git', [])",
    'traceSyncTestChild(label)',
    'import { spawnSync } from',
  ])
    expect(SYNC_SPAWN.test(line)).toBe(false)
})
