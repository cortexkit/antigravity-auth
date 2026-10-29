import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommand } from './support/run-command.ts'

const roots: string[] = []
const sourceRoot = resolve(import.meta.dir, '..')
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function command(
  root: string,
  argv: string[],
  env?: Record<string, string | undefined>,
) {
  return runCommand(argv, { cwd: root, env, deadlineMs: 10_000 })
}

async function git(root: string, ...args: string[]) {
  const result = await command(root, ['git', ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepush-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'bin'))
  cpSync(
    join(sourceRoot, 'scripts/prepush.sh'),
    join(root, 'scripts/prepush.sh'),
  )
  writeFileSync(join(root, '.gitignore'), 'bin/\ncalls\n.cortexkit/\n')
  for (const [name, body] of Object.entries({
    bun: `
if [[ "$*" == --version ]]; then echo "\${BUN_VERSION:-1.4.2}"; exit; fi
echo "bun $*" >> calls
if [[ "$*" == "\${FAIL_COMMAND:-}" ]]; then exit 7; fi
if [[ "$*" == "\${DIRTY_COMMAND:-}" ]]; then echo changed >> tracked; fi
`,
    ck: `
echo "ck $*" >> calls
[[ "$1 $2 $3 $4 $5 $6" == "motor run --vcpus 16 --net --cwd" ]] || exit 8
shift 7
[[ "$1" == -- ]] || exit 8
shift
exec "$@"
`,
    uname: 'echo Linux\n',
  })) {
    const path = join(root, 'bin', name)
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}`)
    chmodSync(path, 0o755)
  }
  writeFileSync(join(root, 'tracked'), 'original\n')
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Prepush Test')
  await git(root, 'config', 'user.email', 'prepush@example.invalid')
  await git(root, 'config', 'core.hooksPath', '/dev/null')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'fixture')
  const commit = await git(root, 'rev-parse', 'HEAD')
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  }
  return { root, commit, env }
}

test('prepush --fast runs static guards without a build or remote submission', async () => {
  const { root, commit, env } = await fixture()
  const result = await command(
    root,
    ['bash', 'scripts/prepush.sh', '--fast'],
    env,
  )
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain(`PREPUSH_FAST_OK ${commit}`)
  expect(result.stdout).not.toContain(`PREPUSH_OK ${commit}`)
  expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toEqual([
    'bun install --frozen-lockfile --dry-run',
    'bun install --cwd tools/common-auth-build --frozen-lockfile --dry-run --ignore-scripts',
    'bun run embed:check',
    'bun run format:check',
    'bun run lint',
    'bun test --isolate ./test/test-root.test.ts',
    'bun test --isolate ./packages/opencode/src/plugin/shared/import-graph.test.ts',
    'bun test --isolate ./test/sync-spawn-guard.test.ts',
  ])
  expect(result.stdout).toContain(
    'Covered by GitHub CI only: four-runtime RPC matrix',
  )
})

for (const [step, failing] of [
  ['format', 'run format:check'],
  ['disk-test-list', 'test --isolate ./test/test-root.test.ts'],
  ['lockfile', 'install --frozen-lockfile --dry-run'],
]) {
  test(`prepush fails fast and names ${step}`, async () => {
    const { root, env } = await fixture()
    const result = await command(root, ['bash', 'scripts/prepush.sh'], {
      ...env,
      FAIL_COMMAND: failing,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      `PREPUSH_FAILED phase=fast step=${step}: exit=7`,
    )
    expect(result.stdout).not.toContain('PREPUSH_OK')
    expect(readFileSync(join(root, 'calls'), 'utf8')).not.toContain('ck motor')
  })
}

test('prepush refuses dirty tracked files and tracked ignored CortexKit files', async () => {
  const { root, env } = await fixture()
  writeFileSync(join(root, 'tracked'), 'dirty\n')
  let result = await command(
    root,
    ['bash', 'scripts/prepush.sh', '--fast'],
    env,
  )
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('dirty tracked tree')
  await git(root, 'restore', 'tracked')
  mkdirSync(join(root, '.cortexkit'))
  writeFileSync(join(root, '.cortexkit', 'private'), 'fixture\n')
  // Track before applying the ignore rule, as a historical accidental commit would.
  writeFileSync(join(root, '.gitignore'), 'bin/\ncalls\n')
  await git(root, 'add', '.cortexkit', '.gitignore')
  await git(root, 'commit', '-m', 'tracked private fixture')
  writeFileSync(join(root, '.gitignore'), 'bin/\ncalls\n.cortexkit/\n')
  await git(root, 'add', '.gitignore')
  await git(root, 'commit', '-m', 'ignore private fixture')
  result = await command(root, ['bash', 'scripts/prepush.sh', '--fast'], env)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('ignored .cortexkit files are tracked')
})

test('prepush submits exactly one sequential Linux job and certifies the commit', async () => {
  const { root, commit, env } = await fixture()
  const result = await command(root, ['bash', 'scripts/prepush.sh'], env)
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain(`PREPUSH_OK ${commit}`)
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
  expect(calls.filter((line) => line.startsWith('ck '))).toEqual([
    `ck motor run --vcpus 16 --net --cwd ${root} -- bash scripts/prepush.sh --full-here ${commit}`,
  ])
  expect(calls.slice(9)).toEqual([
    'bun install --frozen-lockfile',
    'bun packages/opencode/scripts/embed-common-auth.ts --check',
    'bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts',
    'bun run embed:check',
    'bun run --cwd packages/core build',
    'bun run typecheck',
    'bun run build',
    'bun run --cwd packages/opencode smoke:tui',
    'bun run test',
    'bun run test:e2e',
  ])
})

test('prepush reports a full-phase failure without certifying the commit', async () => {
  const { root, env } = await fixture()
  const result = await command(root, ['bash', 'scripts/prepush.sh'], {
    ...env,
    FAIL_COMMAND: 'run test:e2e',
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain(
    'PREPUSH_FAILED phase=full step=test-e2e: exit=7',
  )
  expect(result.stdout).not.toContain('PREPUSH_OK')
})

test('prepush --full-here runs the full phase without contacting ck', async () => {
  const { root, commit, env } = await fixture()
  const result = await command(
    root,
    ['bash', 'scripts/prepush.sh', '--full-here'],
    env,
  )
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain(`PREPUSH_OK ${commit}`)
  expect(result.stdout).toContain(
    'PREPUSH_EXIT phase=full step=test-e2e exit=0',
  )
  expect(result.stdout).not.toContain('PREPUSH_FAST_OK')
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
  expect(calls).toHaveLength(10)
  expect(calls[0]).toBe('bun install --frozen-lockfile')
  expect(calls.some((line) => line.startsWith('ck '))).toBe(false)
})

test('prepush checks Bun, remote commit identity and post-check tree identity', async () => {
  const { root, env } = await fixture()
  let result = await command(root, ['bash', 'scripts/prepush.sh', '--fast'], {
    ...env,
    BUN_VERSION: '1.4.4',
  })
  expect(result.stderr).toContain('requires Bun 1.4.2 exactly')
  expect(result.exitCode).toBe(1)
  result = await command(
    root,
    ['bash', 'scripts/prepush.sh', '--full-here', 'wrong-commit'],
    env,
  )
  expect(result.stderr).toContain(
    'MOTOR checkout does not match submitted commit',
  )
  expect(result.exitCode).toBe(1)
  result = await command(root, ['bash', 'scripts/prepush.sh', '--fast'], {
    ...env,
    DIRTY_COMMAND: 'run lint',
  })
  expect(result.stderr).toContain('dirty tracked tree')
  expect(result.exitCode).toBe(1)
  expect(result.stdout).not.toContain('PREPUSH_FAST_OK')
})
