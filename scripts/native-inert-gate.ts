import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type GatePlacement,
  type GateResult,
  git,
  INVENTORY_PATH,
  inventory,
  object,
  qualifiedPlacement,
  RESULT_PREFIX,
  STAGE_NAMES,
  sameNames,
  sha256,
  validateResult,
} from './native-inert-result.ts'

const TEST_PATHS = [
  'packages/e2e-tests/docker/ga-contract-inputs.test.ts',
  'packages/e2e-tests/src/opencode-ga-harness.test.ts',
  'packages/e2e-tests/src/opencode-ga-inputs.test.ts',
]
export const SOURCE_PATHS = [
  'packages/e2e-tests/docker/measure-ga-proxy-matrix.ts',
  TEST_PATHS[0] as string,
  'packages/e2e-tests/src/fixtures/opencode-ga-host/native-job.ts',
  'packages/e2e-tests/docker/inert-fixture.ts',
]

export function createScopedBiomeConfig(root: string, temporary: string) {
  const config = join(temporary, 'biome.scoped.json')
  writeFileSync(
    config,
    JSON.stringify({
      extends: [join(root, 'biome.jsonc')],
      files: {
        // A fixture config must not become a second project root during this check.
        includes: ['**', '!!**/biome.json', '!!**/biome.jsonc'],
      },
    }),
    { mode: 0o600 },
  )
  return config
}

export function scopedBiomeCheckArgs(config: string) {
  return ['check', '--config-path', config, ...SOURCE_PATHS]
}

export function reconcileMotor(
  stdout: string,
  stderr: string,
  names: string[],
): GateResult['motor'] {
  const lines = stdout.split(/\r?\n/)
  const registrations = lines.filter((line) =>
    line.startsWith('MOTOR_INERT_INVENTORY='),
  )
  if (registrations.length !== 1)
    throw new Error('expected one motor inventory record')
  const registered = object(
    JSON.parse((registrations[0] ?? '').slice('MOTOR_INERT_INVENTORY='.length)),
  )
  const entries = lines
    .filter((line) => line.startsWith('MOTOR_INERT_EXECUTED='))
    .map((line) => JSON.parse(line.slice('MOTOR_INERT_EXECUTED='.length)))
  if (
    registered.profile !== 'motor-inert' ||
    registered.revision !== 'r6' ||
    registered.registeredCount !== 41 ||
    registered.executedCountAtInventoryCheck !== 41 ||
    !sameNames(registered.expected, names) ||
    !sameNames(registered.registered, names) ||
    !sameNames(registered.executedAtInventoryCheck, names) ||
    !sameNames(entries, names)
  )
    throw new Error(
      'motor registrations or entries differ from frozen inventory',
    )
  const report = `${stdout}\n${stderr}`
  const passed = [
    ...report.matchAll(/^\(pass\) (.+?)(?: \[[^\]\n]+\])?$/gm),
  ].map((match) => match[1])
  for (const name of names) {
    if (passed.filter((entry) => entry === name).length !== 1)
      throw new Error(`motor name did not pass exactly once: ${name}`)
  }
  const count = (pattern: RegExp) => {
    const matches = [...report.matchAll(pattern)]
    if (matches.length !== 1)
      throw new Error(`missing or duplicate motor summary: ${pattern}`)
    return Number(matches[0]?.[1])
  }
  const motor = {
    pass: count(/^\s*(\d+) pass\s*$/gm),
    fail: count(/^\s*(\d+) fail\s*$/gm),
    assertions: count(/^\s*(\d+) expect\(\) calls\s*$/gm),
  }
  if (
    motor.pass !== passed.length ||
    motor.fail !== 0 ||
    motor.assertions < 41 ||
    /^\((?:fail|skip|todo)\) /m.test(report) ||
    /^\s*[1-9]\d* (?:skip|todo)\s*$/m.test(report)
  )
    throw new Error(
      'motor summary contains failures, skips, or inconsistent counts',
    )
  return motor
}

async function runStage(
  argv: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<{ exit: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let forcedExit: number | undefined
      const stop = (code: number) => {
        forcedExit = code
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              stderr += String(error)
          }
        }
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const timeout = setTimeout(() => stop(124), timeoutMs)
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
        if (stdout.length + stderr.length > 16 * 1024 * 1024) stop(125)
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
        if (stdout.length + stderr.length > 16 * 1024 * 1024) stop(125)
      })
      child.on('error', (error) => {
        stderr += String(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ exit: forcedExit ?? code ?? 1, stdout, stderr })
      })
    },
  )
}

// Read where this gate process runs, directly and without spawning anything, so
// the record proves its own placement. Any unreadable fact throws.
export function observeGatePlacement(): GatePlacement {
  const uid = process.getuid?.()
  const euid = process.geteuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || euid === undefined || gid === undefined)
    throw new Error('native-inert gate cannot read its user identity')
  return {
    arch: process.arch,
    uid,
    euid,
    gid,
    host: hostname(),
    pidNamespace: readlinkSync('/proc/self/ns/pid'),
    pid1Namespace: readlinkSync('/proc/1/ns/pid'),
    pid1Comm: readFileSync('/proc/1/comm', 'utf8').trim(),
    cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim(),
  }
}

export async function nativeInertGate(): Promise<number> {
  const root = process.cwd()
  const result: GateResult = {
    schemaVersion: 2,
    commit: '',
    tree: '',
    pass: false,
    stages: [],
    names: [],
    inventorySha256: '',
    motor: { pass: 0, fail: 0, assertions: 0 },
    bunVersion: '',
    startedUtc: new Date().toISOString(),
    endedUtc: '',
  }
  let activeStage = 'preflight'
  let temporary: string | undefined
  try {
    // Never let an earlier local pass survive a failed or interrupted rerun.
    rmSync(join(root, '.cortexkit/release-gates/native-inert.json'), {
      force: true,
    })
    process.env.GA_NATIVE_JOB_TEST_PROFILE = 'motor-inert'
    if (process.env.GA_NATIVE_JOB_TEST_PROFILE !== 'motor-inert')
      throw new Error('cannot set motor-inert profile')
    if (process.platform !== 'linux')
      throw new Error(
        'native-inert gate requires the qualified MOTOR Linux job',
      )
    result.placement = observeGatePlacement()
    // Refuse an unqualified placement now rather than after every stage ran.
    qualifiedPlacement(result.placement)
    if (git(root, 'status', '--porcelain') !== '')
      throw new Error('native-inert gate requires a clean working tree')
    result.commit = git(root, 'rev-parse', 'HEAD').trim()
    result.tree = git(root, 'rev-parse', 'HEAD^{tree}').trim()
    const raw = readFileSync(join(root, INVENTORY_PATH), 'utf8')
    result.names = inventory(raw)
    result.inventorySha256 = sha256(raw)
    temporary = mkdtempSync(join(tmpdir(), 'native-inert-gate-'))
    const config = createScopedBiomeConfig(root, temporary)
    const commands = [
      ['bun', '--version'],
      ['./node_modules/.bin/tsc', '--version'],
      ['./node_modules/.bin/biome', '--version'],
      ['bun', 'run', '--cwd', 'packages/core', 'build'],
      ['bun', 'run', '--cwd', 'packages/e2e-tests', 'typecheck:ga'],
      ['./node_modules/.bin/tsc', '-p', 'tsconfig.scripts.json'],
      ['./node_modules/.bin/biome', ...scopedBiomeCheckArgs(config)],
      [
        'env',
        '-u',
        'GA_NATIVE_JOB_TEST_PROFILE',
        'bun',
        'test',
        '--isolate',
        ...TEST_PATHS,
      ],
      [
        'env',
        'GA_NATIVE_JOB_TEST_PROFILE=motor-inert',
        'bun',
        'test',
        '--isolate',
        ...TEST_PATHS,
      ],
    ]
    const limits = [
      10_000, 10_000, 10_000, 120_000, 120_000, 120_000, 30_000, 180_000,
      180_000,
    ]
    for (const [i, argv] of commands.entries()) {
      activeStage = STAGE_NAMES[i] as string
      const stage = await runStage(argv, limits[i] as number, {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      })
      result.stages.push({ name: activeStage, exit: stage.exit })
      console.error(
        `NATIVE_INERT_GATE_STAGE=${JSON.stringify({ name: activeStage, exit: stage.exit })}`,
      )
      process.stderr.write(stage.stdout)
      process.stderr.write(stage.stderr)
      if (stage.exit !== 0)
        throw new Error(`${activeStage} exited ${stage.exit}`)
      if (i === 0) result.bunVersion = stage.stdout.trim()
      if (i === 8) {
        activeStage = 'reconciliation'
        result.motor = reconcileMotor(stage.stdout, stage.stderr, result.names)
      }
    }
    activeStage = 'final-identity'
    if (
      git(root, 'status', '--porcelain') !== '' ||
      git(root, 'rev-parse', 'HEAD').trim() !== result.commit ||
      git(root, 'rev-parse', 'HEAD^{tree}').trim() !== result.tree
    )
      throw new Error('checkout changed during gate')
    result.pass = true
    result.endedUtc = new Date().toISOString()
    validateResult(result, root)
  } catch (error) {
    result.pass = false
    result.failingStage = activeStage
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    result.endedUtc = new Date().toISOString()
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`)
  }
  return result.pass ? 0 : 1
}

if (import.meta.main) process.exitCode = await nativeInertGate()
