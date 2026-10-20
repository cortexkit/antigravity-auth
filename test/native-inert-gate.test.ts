import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  createScopedBiomeConfig,
  reconcileMotor,
  SOURCE_PATHS,
  scopedBiomeCheckArgs,
} from '../scripts/native-inert-gate.ts'
import { traceTestCommand } from '../scripts/test-child-lifecycle.ts'
import { runCommandBytes } from './support/run-command.ts'

const sourceRoot = resolve(import.meta.dir, '..')
const inventoryPath = 'packages/e2e-tests/docker/native-inert-inventory.json'
const frozen = readFileSync(join(sourceRoot, inventoryPath))
const roots: string[] = []
// Each command fails at its own deadline, before the enclosing test's timeout.
const TEST_TIMEOUT_MS = 60_000
const COMMAND_DEADLINE_MS = 30_000
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function git(root: string, ...args: string[]) {
  const result = await traceTestCommand('native-git', 'git', args.length, () =>
    runCommandBytes(['git', ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: root,
      },
      deadlineMs: COMMAND_DEADLINE_MS,
    }),
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-inert-record-'))
  roots.push(root)
  mkdirSync(join(root, 'packages/e2e-tests/docker'), { recursive: true })
  writeFileSync(join(root, inventoryPath), frozen)
  writeFileSync(join(root, '.gitignore'), '.cortexkit/\n')
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Gate Test')
  await git(root, 'config', 'user.email', 'gate@example.invalid')
  await git(root, 'add', '.')
  await git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture')
  const result = {
    schemaVersion: 1,
    commit: await git(root, 'rev-parse', 'HEAD'),
    tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
    pass: true,
    stages: [
      'bun-version',
      'typescript-version',
      'biome-version',
      'core-build',
      'strict-ga',
      'strict-scripts',
      'scoped-biome-check',
      'portable-suite',
      'motor-suite',
    ].map((name) => ({ name, exit: 0 })),
    names: JSON.parse(frozen.toString()) as string[],
    inventorySha256: createHash('sha256').update(frozen).digest('hex'),
    motor: { pass: 279, fail: 0, assertions: 2336 },
    bunVersion: '1.4.2',
    startedUtc: '2026-10-17T08:00:00.000Z',
    endedUtc: '2026-10-17T08:01:00.000Z',
  }
  return {
    root,
    result,
    record: join(root, '.cortexkit/release-gates/native-inert.json'),
  }
}

function run(root: string, script: string, ...args: string[]) {
  return traceTestCommand(
    'native-run',
    process.execPath,
    args.length + 1,
    () =>
      runCommandBytes(
        [process.execPath, join(sourceRoot, 'scripts', script), ...args],
        { cwd: root, deadlineMs: COMMAND_DEADLINE_MS },
      ),
    true,
  )
}

test(
  'native-inert record writer accepts a fully validated result',
  async () => {
    const { root, result, record } = await fixture()
    const stdout = join(root, '.cortexkit/stdout')
    mkdirSync(join(root, '.cortexkit'), { recursive: true })
    const text = `stage output\nNATIVE_INERT_GATE_RESULT=${JSON.stringify(result)}\n`
    writeFileSync(stdout, text)
    const written = await run(root, 'record-native-inert-gate.ts', stdout)
    expect(written.exitCode, written.stderr.toString()).toBe(0)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      ...result,
      stdoutSha256: createHash('sha256').update(text).digest('hex'),
    })
  },
  TEST_TIMEOUT_MS,
)

for (const invalid of [
  'pass false',
  'missing stage',
  '40 names',
  'wrong hash',
  'two result lines',
  'unknown commit',
  'truncated line',
  'interrupted output',
  'wrong tree',
  'failed stage',
  'zero assertions',
  'bad schema',
  'bad times',
] as const) {
  test(
    `native-inert record writer rejects ${invalid}`,
    async () => {
      const { root, result, record } = await fixture()
      mkdirSync(join(root, '.cortexkit/release-gates'), { recursive: true })
      writeFileSync(
        record,
        JSON.stringify({ ...result, commit: '0'.repeat(40) }),
      )
      if (invalid === 'pass false') result.pass = false
      if (invalid === 'missing stage') result.stages.pop()
      if (invalid === '40 names') result.names.pop()
      if (invalid === 'wrong hash') result.inventorySha256 = '0'.repeat(64)
      if (invalid === 'unknown commit') result.commit = 'f'.repeat(40)
      if (invalid === 'wrong tree') result.tree = '0'.repeat(40)
      if (invalid === 'failed stage')
        result.stages[0] = { name: 'bun-version', exit: 1 }
      if (invalid === 'zero assertions') result.motor.assertions = 0
      if (invalid === 'bad schema') result.schemaVersion = 2
      if (invalid === 'bad times') result.endedUtc = 'yesterday'
      let text = `NATIVE_INERT_GATE_RESULT=${JSON.stringify(result)}\n`
      if (invalid === 'two result lines') text += text
      if (invalid === 'truncated line') text = text.slice(0, -5)
      if (invalid === 'interrupted output')
        text = 'stage started, job interrupted\n'
      const stdout = join(root, '.cortexkit/stdout')
      writeFileSync(stdout, text)
      const written = await run(root, 'record-native-inert-gate.ts', stdout)
      expect(written.exitCode).not.toBe(0)
      expect(existsSync(record)).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )
}

for (const state of [
  'absent',
  'other commit',
  'pass false',
  'exact commit',
] as const) {
  test(
    `native-inert release check handles ${state}`,
    async () => {
      const { root, result, record } = await fixture()
      if (state === 'other commit') {
        await git(
          root,
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--allow-empty',
          '-m',
          'identical tree, different commit',
        )
        expect(await git(root, 'rev-parse', 'HEAD^{tree}')).toBe(result.tree)
      }
      if (state === 'pass false') result.pass = false
      if (state !== 'absent') {
        mkdirSync(join(root, '.cortexkit/release-gates'), { recursive: true })
        writeFileSync(
          record,
          JSON.stringify({ ...result, stdoutSha256: 'a'.repeat(64) }),
        )
      }
      const checked = await run(root, 'check-native-inert-release.ts')
      expect(checked.exitCode === 0, checked.stderr.toString()).toBe(
        state === 'exact commit',
      )
      if (state !== 'exact commit') {
        expect(checked.stderr.toString()).toContain('bun run test:native-inert')
        expect(checked.stderr.toString()).toContain(
          'record-native-inert-gate.ts',
        )
      }
    },
    TEST_TIMEOUT_MS,
  )
}

test('motor reconciliation requires each frozen registration, entry and framework pass once', () => {
  const names = JSON.parse(frozen.toString()) as string[]
  const registration = `MOTOR_INERT_INVENTORY=${JSON.stringify({ revision: 'r6', profile: 'motor-inert', expected: names, registered: names, executedAtInventoryCheck: names, registeredCount: 41, executedCountAtInventoryCheck: 41 })}\n`
  const entries = names
    .map((name) => `MOTOR_INERT_EXECUTED=${JSON.stringify(name)}`)
    .join('\n')
  const passes = names.map((name) => `(pass) ${name} [1.00ms]`).join('\n')
  const stdout = `${registration}${entries}\n`
  const stderr = `${passes}\n 41 pass\n 0 fail\n 100 expect() calls\n`
  expect(reconcileMotor(stdout, stderr, names)).toEqual({
    pass: 41,
    fail: 0,
    assertions: 100,
  })
  expect(() => reconcileMotor(stdout + registration, stderr, names)).toThrow()
  expect(() =>
    reconcileMotor(
      stdout.replace(`MOTOR_INERT_EXECUTED=${JSON.stringify(names[0])}\n`, ''),
      stderr,
      names,
    ),
  ).toThrow()
  expect(() =>
    reconcileMotor(
      stdout,
      stderr.replace(`(pass) ${names[0]} [1.00ms]\n`, ''),
      names,
    ),
  ).toThrow()
  expect(() =>
    reconcileMotor(stdout, stderr.replace(' 0 fail', ' 1 fail'), names),
  ).toThrow()
  expect(() =>
    reconcileMotor(stdout, `${stderr}(skip) other case\n`, names),
  ).toThrow()
})

test('native-inert source lint covers every gate source and is wired into lint scripts and pre-commit', () => {
  const scripts = JSON.parse(
    readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
  ).scripts as Record<string, string>
  const lefthook = readFileSync(join(sourceRoot, 'lefthook.yml'), 'utf8')
  const expectedSources = [
    'packages/e2e-tests/docker/measure-ga-proxy-matrix.ts',
    'packages/e2e-tests/docker/ga-contract-inputs.test.ts',
    'packages/e2e-tests/src/fixtures/opencode-ga-host/native-job.ts',
    'packages/e2e-tests/docker/inert-fixture.ts',
  ]

  expect(SOURCE_PATHS).toEqual(expectedSources)
  expect(scopedBiomeCheckArgs('/tmp/biome.scoped.json').slice(3)).toEqual(
    SOURCE_PATHS,
  )
  expect(scripts['lint:native-inert']).toBe(
    'bun scripts/lint-native-inert-sources.ts',
  )
  expect(scripts.lint).toContain('bun run lint:native-inert')
  expect(scripts['format:check']).toContain('bun run lint:native-inert')
  expect(lefthook).toContain('run: bun run lint:native-inert')
})

test('scoped native-inert Biome config excludes nested project configs', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'native-inert-biome-config-'))
  roots.push(temporary)
  const configPath = createScopedBiomeConfig(sourceRoot, temporary)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    extends: string[]
    files: { includes: string[] }
  }

  // GitHub CI run 39475258143 reported a nested-root error for a copied fixture
  // config. The same nested invocation passes locally, so assert the scanner
  // exclusion explicitly and still exercise the nested lint entry below.
  expect(config.extends).toEqual([join(sourceRoot, 'biome.jsonc')])
  expect(config.files.includes).toEqual([
    '**',
    '!!**/biome.json',
    '!!**/biome.jsonc',
  ])
  expect(scopedBiomeCheckArgs(configPath)).toEqual([
    'check',
    '--config-path',
    configPath,
    ...SOURCE_PATHS,
  ])
})

test(
  'native-inert lint runs from a nested Biome root inside another repository',
  async () => {
    const outer = mkdtempSync(join(tmpdir(), 'native-inert-outer-repo-'))
    roots.push(outer)
    writeFileSync(
      join(outer, 'biome.jsonc'),
      readFileSync(join(sourceRoot, 'biome.jsonc')),
    )
    writeFileSync(
      join(outer, 'package.json'),
      readFileSync(join(sourceRoot, 'package.json')),
    )
    await git(outer, 'init', '-b', 'main')
    await git(outer, 'config', 'user.name', 'Gate Test')
    await git(outer, 'config', 'user.email', 'gate@example.invalid')
    await git(outer, 'add', 'biome.jsonc', 'package.json')
    await git(
      outer,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'outer repository',
    )

    const fixture = join(
      outer,
      'test/common-auth-094-adoption/embed-build/.owned-native-inert',
    )
    mkdirSync(fixture, { recursive: true })
    writeFileSync(
      join(fixture, 'biome.jsonc'),
      readFileSync(join(sourceRoot, 'biome.jsonc')),
    )
    writeFileSync(
      join(fixture, 'package.json'),
      readFileSync(join(sourceRoot, 'package.json')),
    )
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    for (const script of [
      'lint-native-inert-sources.ts',
      'native-inert-gate.ts',
      'native-inert-result.ts',
    ])
      copyFileSync(
        join(sourceRoot, 'scripts', script),
        join(fixture, 'scripts', script),
      )
    symlinkSync(join(sourceRoot, 'node_modules'), join(fixture, 'node_modules'))
    for (const source of SOURCE_PATHS) {
      const destination = join(fixture, source)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(sourceRoot, source), destination)
    }
    expect(existsSync(join(fixture, '.git'))).toBe(false)

    const result = await traceTestCommand(
      'native-run',
      process.execPath,
      2,
      () =>
        runCommandBytes([process.execPath, 'run', 'lint:native-inert'], {
          cwd: fixture,
          env: {
            ...process.env,
            npm_config_offline: 'true',
            LEFTHOOK: '1',
          },
          deadlineMs: COMMAND_DEADLINE_MS,
        }),
      true,
    )
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    expect(result.exitCode, output).toBe(0)
    expect(output).toContain('Found 6 warnings.')
    expect(output).not.toContain('Found a nested root configuration')
  },
  TEST_TIMEOUT_MS,
)
