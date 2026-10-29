import { describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  forEachChild,
  getPreEmitDiagnostics,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isFunctionDeclaration,
  isIfStatement,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  ModuleKind,
  ModuleResolutionKind,
  type Node,
  ScriptTarget,
  version as typescriptVersion,
} from 'typescript'
import { runCommand } from '../../../test/support/run-command.ts'
import type { NativeProbeCommandResult } from '../src/fixtures/opencode-ga-host/native-job.ts'
import {
  assertRewriteConformance,
  GA_LOOPBACK_REQUEST_CONTRACT,
  matchesGoogleContentPath,
} from './ga-loopback-request-contract.ts'
import {
  captureInertBirth,
  finishInertTest,
  type InertChild,
  type InertDeadlineDiagnostic,
  type InertIdentity,
  type InertReadyIdentity,
  inertActorTasksRemain,
  inertAlive,
  publishInertFixture,
  readInertIdentity,
  readyBeforeInertCleanup,
  reportInertDeadline,
  waitForInertReady as waitForFixtureReady,
  waitForInertDeparture,
} from './inert-fixture.ts'
import {
  armNativeCommandTimer,
  assertCliCompletion,
  assertConformance,
  assertNative,
  assertNativeJobAdmission,
  assertNativeRunnerUnchanged,
  cgroupMemberIds,
  classify,
  commandForCase,
  enableNativeTaskDiagnostic,
  inventory,
  runNativeCommand as invokeNativeCommand,
  isolatedEnv,
  type Matrix,
  MatrixSchema,
  materialize,
  type NativeCommandTimers,
  type NativePlacementFacts,
  type NativeProcessIdentity,
  nativeHostEnv,
  nativeSignalOwned,
  observeNativeRunner,
  PinSchema,
  PORTS,
  parseArgs,
  parseLines,
  parseTunnelRequests,
  prepareNativeGit,
  qualifyNativeJobIdentities,
  qualifyNativePlacement,
  qualifyNativeProcessScope,
  scopedProcesses,
  selectCases,
  sha256,
  snapshotNativeComparison,
  sourceDigests,
  threadGroupHasLiveTasks,
  validateMatrix,
  verifiedBinary,
  type Wire,
} from './measure-ga-proxy-matrix.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
function nativeTestProfile(env: NodeJS.ProcessEnv): 'portable' | 'motor-inert' {
  if (!('GA_NATIVE_JOB_TEST_PROFILE' in env)) return 'portable'
  if (env.GA_NATIVE_JOB_TEST_PROFILE !== 'motor-inert')
    throw new Error(
      'unknown GA_NATIVE_JOB_TEST_PROFILE; omit it or select motor-inert',
    )
  return 'motor-inert'
}
const selectedTestProfile = nativeTestProfile(process.env)
const CLEANUP_GROUP =
  'qualified private namespace native cleanup source and inert controls'
const GIT_GROUP = 'native Git and retained comparison source controls'
const motorRegistered: string[] = []
const motorExecuted: string[] = []
// Keep the frozen release-gate list independent of registration loops so losing
// an inert case fails completeness instead of silently shrinking expected coverage.
const MOTOR_INERT_EXPECTED = Object.freeze([
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses pid1-mismatch after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses controller-mismatch after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses namespace-mismatch after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses cgroup-mismatch after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-writable after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-rw-mount after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-shadow-mount after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-owner after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-substituted after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses psi-symlink after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses critical-owned after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses memory-limit-owned after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses pid-limit-owned after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses other-pressure-owned after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses executable-owned after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses executable-writable after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > initial qualification refuses control-writable after an unmocked precondition',
  'qualified private namespace native cleanup source and inert controls > caller-supplied current boundary facts cannot mint cleanup or launch authority',
  'qualified private namespace native cleanup source and inert controls > qualified spawn failure preserves its error and completes bounded empty cleanup',
  'qualified private namespace native cleanup source and inert controls > preexisting listener controller and PID1 are protected from native command cleanup',
  'qualified private namespace native cleanup source and inert controls > a changed captured birth fails closed but remaining owned listener is still reaped',
  'qualified private namespace native cleanup source and inert controls > boundary invalidation after discovery forbids every cleanup signal',
  'qualified private namespace native cleanup source and inert controls > foreign live PID1 process ownership refuses before launch and signal calls',
  'qualified private namespace native cleanup source and inert controls > native cleanup reaps detached pipe-holding listener on success without changing the command result',
  'qualified private namespace native cleanup source and inert controls > native cleanup reaps detached pipe-holding listener on nonzero without changing the command result',
  'qualified private namespace native cleanup source and inert controls > native cleanup after a ready-gated timeout reaps detached pipe-holding listener without changing the command result',
  'qualified private namespace native cleanup source and inert controls > native cleanup reaps detached pipe-holding listener on output-cap without changing the command result',
  'qualified private namespace native cleanup source and inert controls > the all-root PSI fixture qualifies through the same live admission path',
  'qualified private namespace native cleanup source and inert controls > live protected private PID and cgroup facts qualify without pretending to attest unit properties',
  'native Git and retained comparison source controls > native Git never executes caller PATH or copies caller configuration templates',
  'qualified private namespace native cleanup source and inert controls > extant thread group is unknown while its listener survives original-command close',
  'qualified private namespace native cleanup source and inert controls > cleanup budget expiry during an empty scan forbids a final rescan',
  'qualified private namespace native cleanup source and inert controls > partial identity ENOENT is unknown while a real group remains live',
  'qualified private namespace native cleanup source and inert controls > genuinely exited groups remain clean with zero cleanup signals',
  'qualified private namespace native cleanup source and inert controls > running runner inode mismatch refuses before dispatch',
  'qualified private namespace native cleanup source and inert controls > runner recheck hashes kernel-bound bytes and refuses a replaced path',
  'qualified private namespace native cleanup source and inert controls > terminal zombie snapshot without live kernel tasks remains finished',
  'qualified private namespace native cleanup source and inert controls > actor-free budget expiry during signal requalification forbids subsequent reads and signals',
  'qualified private namespace native cleanup source and inert controls > actor-free budget expiry during target identity read forbids subsequent reads and signals',
  'qualified private namespace native cleanup source and inert controls > actor-free budget expiry during final scoped check forbids subsequent reads and signals',
  'qualified private namespace native cleanup source and inert controls > native command real wall-clock timeout kills a sleeping owned child',
])
function motorTest(
  group: string,
  name: string,
  body: () => void | Promise<void>,
): void {
  if (selectedTestProfile !== 'motor-inert') return
  const fullName = `${group} > ${name}`
  test(name, async () => {
    motorExecuted.push(fullName)
    console.log(`MOTOR_INERT_EXECUTED=${JSON.stringify(fullName)}`)
    const run: InertRun = {
      testName: fullName,
      children: [],
      identities: [],
      roots: new Set(),
      errors: [],
    }
    activeInertRun = run
    const stopDiagnostic = enableNativeTaskDiagnostic({
      runnerPid: process.pid,
      actorPids: () =>
        [...run.identities, ...[...run.roots].flatMap(fixtureIdentities)].map(
          (identity) => identity.pid,
        ),
      emit: (line) => console.log(line),
    })
    const errors: unknown[] = []
    try {
      await body()
    } catch (error) {
      errors.push(error)
    } finally {
      await finishInertTest(errors, [
        async () => {
          for (const root of run.roots)
            run.identities.push(...fixtureIdentities(root))
          await reapInertIdentities(run.identities, run)
          if (run.errors.length)
            throw new AggregateError(run.errors, 'actor birth capture failed')
        },
        () => {
          stopDiagnostic()
          activeInertRun = undefined
        },
      ])
    }
  })
  motorRegistered.push(fullName)
}
const pin = PinSchema.parse(
  JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
)
const native = {
  hostUname: 'x86_64',
  daemonArchitecture: 'amd64',
  containerUname: 'x86_64',
  elfMachine: 62,
  runtime: pin.runtime,
  network: 'none',
  interfaces: ['lo'],
  image: `sha256:${'a'.repeat(64)}`,
}
const nonce = 'GA-NONCE-01234567-0123-4123-a123-0123456789ab'
const primaryJob = '01234567-0123-4123-a123-0123456789ab'
const titleJob = '01234567-0123-4123-a123-0123456789ac'
const dispatch = {
  hook: 'http.request',
  method: 'POST',
  urlPattern: 'http://127.0.0.1:<port>/agy/<job>',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}
const rewrite = (kind = 'primary', job = primaryJob) => ({
  type: 'rewrite',
  kind,
  job,
  sessionID: 'ses_fake',
  nonce,
  originalURL:
    'http://127.0.0.1:38195/v1beta/models/probe-model:streamGenerateContent?alt=sse',
  originalBodySha256: 'b'.repeat(64),
  dispatch,
})
const events = () => [{ type: 'setup', runtime: pin.runtime }, rewrite()]
const wire = (
  channel: Wire['channel'] = 'mock',
  job = primaryJob,
  connection: string | null = null,
): Wire => ({
  channel,
  method: 'POST',
  target: `http://127.0.0.1:${PORTS.mock}/agy/${job}`,
  body: '{}',
  connection,
})
function matrix(): Extract<Matrix, { profile: 'docker' }> {
  return {
    schema: 1,
    profile: 'docker',
    full: true,
    binarySha256: pin.binarySha256,
    native: assertNative(native),
    sources: sourceDigests(),
    rows: inventory().map((spec) => {
      const variables = materialize(spec.env)
      return {
        id: spec.id,
        variables,
        conflicts:
          Object.keys(variables).length > 1 ? Object.keys(variables) : [],
        outcome: 'direct',
        recorder: null,
        reason: null,
        binarySha256: pin.binarySha256,
        pluginPath: '/input/ga-measure-plugin.ts',
        command: commandForCase(spec.id),
      }
    }),
  }
}

function processBoundaryFixture() {
  const directory = { uid: 0, gid: 0, mode: 0o755, jobWritable: false }
  const file = { uid: 0, gid: 0, mode: 0o644, jobWritable: false }
  return {
    policy: {
      source: 'MOTOR owner-qualified supervisor contract',
      privatePids: true,
      killMode: 'control-group',
      jobEndBackstop: 'systemd teardown',
      unitPropertiesObserved: false,
      signedAttestation: false,
    },
    namespace: { self: 'pid:[456]', pid1: 'pid:[456]' },
    cgroup: {
      self: '/motor.slice/motor-jobs.slice/motor-job-01234567-0123-4123-a123-0123456789ab.service',
      pid1: '/motor.slice/motor-jobs.slice/motor-job-01234567-0123-4123-a123-0123456789ab.service',
      directory,
      parents: {
        '/sys/fs/cgroup': directory,
        '/sys/fs/cgroup/motor.slice': directory,
        '/sys/fs/cgroup/motor.slice/motor-jobs.slice': directory,
      },
      controls: {
        'cgroup.procs': file,
        'cgroup.threads': file,
        'cgroup.kill': { ...file, mode: 0o200 },
        'cgroup.events': { ...file, mode: 0o444 },
        'cgroup.subtree_control': file,
        'memory.max': file,
        'pids.max': file,
      },
      pressureObservation: {
        name: 'memory.pressure',
        fileType: 'regular',
        ...file,
        mount: {
          point: '/sys/fs/cgroup',
          root: '/',
          type: 'cgroup2',
          source: 'cgroup',
          options: ['ro', 'nosuid', 'nodev', 'noexec'],
          superOptions: ['rw'],
        },
      },
    },
    pid1: {
      uid: 999,
      kernel: {
        NoNewPrivs: '1',
        Seccomp: '2',
        CapInh: '0000000000000000',
        CapPrm: '0000000000000000',
        CapEff: '0000000000000000',
        CapBnd: '0000000000000000',
        CapAmb: '0000000000000000',
      },
      comm: 'bash',
      argvPrefix: ['/bin/bash', '-c'],
      executable: '/bin/bash',
      canonicalExecutable: '/usr/bin/bash',
      executableSha256: 'c'.repeat(64),
      digestProvenance: 'observed, not an approved artifact pin',
      protection: directory,
      parents: { '/': directory, '/usr': directory, '/usr/bin': directory },
    },
    controller: {
      uid: 999,
      kernel: {
        NoNewPrivs: '1',
        Seccomp: '2',
        CapInh: '0000000000000000',
        CapPrm: '0000000000000000',
        CapEff: '0000000000000000',
        CapBnd: '0000000000000000',
        CapAmb: '0000000000000000',
      },
    },
  }
}

// Placement facts as the MOTOR build server reported them for 3.0.11, before any
// per-test change: a private PID namespace whose PID 1 is the job wrapper, and a
// root-owned MOTOR job unit, moved into motor.slice/motor-jobs.slice where MOTOR
// now places every job unit.
const MOTOR_UNIT =
  '/motor.slice/motor-jobs.slice/motor-job-01a168ba-aab2-72c9-83da-e4a254cfee3c.service'
function motorPlacementFacts(
  overrides: Partial<NativePlacementFacts> = {},
): NativePlacementFacts {
  return {
    platform: 'linux',
    arch: 'x64',
    uid: 999,
    euid: 999,
    pidNamespace: 'pid:[4026533381]',
    pid1Namespace: 'pid:[4026533381]',
    pid1Comm: 'bash',
    cgroup: `0::${MOTOR_UNIT}\n`,
    cgroupDirectoryUid: 0,
    ...overrides,
  }
}
function modeledIdentity(
  pid: number,
  uid: number,
  comm: string,
): NativeProcessIdentity {
  return {
    pid,
    start: '123',
    state: 'S',
    uid,
    namespace: 'pid:[4026533381]',
    cgroup: MOTOR_UNIT,
    comm,
    parent: pid === 1 ? 0 : 1,
    pgid: 1,
    sid: 1,
  }
}
// The serialized boundary of a job whose user is `jobUid`, with the PSI file
// owned by that user behind the fixture's read-only mount.
function jobUserBoundary(jobUid: number) {
  const value = nativeMatrix()
  value.native.processBoundary.pid1.uid = jobUid
  value.native.processBoundary.controller.uid = jobUid
  value.native.processBoundary.cgroup.pressureObservation.uid = jobUid
  return value
}
// Classify this host from raw facts read here, independently of the guard under
// test: a MOTOR job has a non-host PID namespace shared with a PID 1 named bash,
// and a single unified cgroup line naming a MOTOR job unit.
function rawMotorJobPlacement() {
  const read = <T>(operation: () => T): T | undefined => {
    try {
      return operation()
    } catch {
      return undefined
    }
  }
  const facts = {
    platform: process.platform,
    arch: process.arch,
    pid1Comm: read(() => readFileSync('/proc/1/comm', 'utf8').trim()),
    pidNamespace: read(() => readlinkSync('/proc/self/ns/pid')),
    pid1Namespace: read(() => readlinkSync('/proc/1/ns/pid')),
    cgroup: read(() => readFileSync('/proc/self/cgroup', 'utf8')),
  }
  const motor =
    facts.platform === 'linux' &&
    facts.arch === 'x64' &&
    facts.pid1Comm === 'bash' &&
    facts.pidNamespace !== undefined &&
    facts.pidNamespace === facts.pid1Namespace &&
    facts.pidNamespace !== 'pid:[4026531836]' &&
    /^0::\/motor\.slice\/motor-jobs\.slice\/motor-job-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.service\n$/.test(
      facts.cgroup ?? '',
    )
  // The guard fails closed without the job cgroup's PSI file, so this
  // independent classifier must require it too. Gate jobs (ck motor run and
  // the native-inert gate) run on the build server, which provides
  // memory.pressure.
  const unit = /^0::([^\n]+)\n$/.exec(facts.cgroup ?? '')?.[1]
  let pressurePath: string | undefined
  let pressurePresent = false
  if (motor && unit) {
    pressurePath = `/sys/fs/cgroup${unit}/memory.pressure`
    try {
      readFileSync(pressurePath)
      pressurePresent = true
    } catch {
      pressurePresent = false
    }
  }
  return { motor, facts, pressurePath, pressurePresent }
}

// Keep each built-in's overloads and properties while changing a test observation.
function observeBuiltin<T extends object>(
  target: T,
  alter: (value: unknown, args: unknown[]) => unknown,
): T {
  return new Proxy(target, {
    apply(fn, receiver: unknown, args: unknown[]) {
      if (typeof fn !== 'function')
        throw new Error('test observation requires a function')
      const value: unknown = Reflect.apply(fn, receiver, args)
      return alter(value, args)
    },
  })
}
function fixtureUid(stat: object, uid: number): number | bigint {
  return 'uid' in stat && typeof stat.uid === 'bigint' ? BigInt(uid) : uid
}
interface InertRun {
  testName?: string
  reportedDeadlines?: Set<string>
  children: {
    handle: childProcess.ChildProcess
    identity?: InertIdentity
    closed: () => boolean
    retainedAt: number
  }[]
  identities: InertIdentity[]
  roots: Set<string>
  errors: unknown[]
}
let activeInertRun: InertRun | undefined

function inertDiagnostic(
  additionalIdentities: () => InertIdentity[] = () => [],
): InertDeadlineDiagnostic | undefined {
  const run = activeInertRun
  if (!run) return undefined
  run.reportedDeadlines ??= new Set()
  return {
    testName: run.testName ?? 'modeled inert fixture',
    identities: () => {
      const identities = [...run.identities, ...additionalIdentities()]
      for (const root of run.roots) {
        try {
          identities.push(...fixtureIdentities(root))
        } catch {
          // A bad publication must not hide already captured child identities.
        }
      }
      return identities
    },
    emit: (line) => console.log(line),
    children: () => run.children,
    reported: run.reportedDeadlines,
  }
}

function waitForInertReady(
  path: string,
  deadline: number,
  options: Parameters<typeof waitForFixtureReady>[2] = {},
): Promise<InertReadyIdentity> {
  return waitForFixtureReady(path, deadline, {
    diagnostic: inertDiagnostic(),
    ...options,
  })
}

function reportInertOracle(
  deadline: number,
  missingReady?: string,
  additionalIdentities?: () => InertIdentity[],
): void {
  reportInertDeadline(
    missingReady === undefined ? 'completion' : 'readiness',
    deadline,
    inertDiagnostic(additionalIdentities),
    missingReady,
  )
}

async function withChangedBirthDiagnostic(
  assertions: () => void | Promise<void>,
  snapshot: () => unknown,
  diagnostic = inertDiagnostic(),
): Promise<void> {
  try {
    await assertions()
  } catch (error) {
    try {
      diagnostic?.emit(`CHANGED_BIRTH_FAILURE=${JSON.stringify(snapshot())}`)
    } catch {
      // A diagnostic read or sink failure must not replace the assertion failure.
    }
    throw error
  }
}

function changedBirthFixtureFiles(root: string, read = fs.readFileSync) {
  const names = new Set([
    'leader.json',
    'worker-spawn.json',
    'worker-birth.json',
    'worker.json',
    'preexisting-birth.json',
    'preexisting.json',
    ...fs.readdirSync(root),
  ])
  return Object.fromEntries(
    [...names].map((name) => {
      const path = join(root, name)
      const present = existsSync(path)
      try {
        return [
          name,
          {
            present,
            identity: name.endsWith('.json')
              ? ((name === 'worker.json' || name === 'preexisting.json'
                  ? readInertIdentity(path, true, read)
                  : readInertIdentity(path, false, read)) ?? null)
              : null,
          },
        ]
      } catch (error) {
        return [name, { present, error: String(error) }]
      }
    }),
  )
}

function retainStartedInertChild(child: childProcess.ChildProcess): void {
  const run = activeInertRun
  if (!run || child.pid === undefined) return
  const retainedAt = performance.now()
  let closed = false
  child.once('close', () => {
    closed = true
  })
  try {
    const identity = captureStartedInertBirth(child.pid)
    run.children.push({
      handle: child,
      identity,
      closed: () => closed,
      retainedAt,
    })
    run.identities.push(identity)
  } catch (error) {
    // Keep the handle even if a birth read fails; teardown must report it.
    run.errors.push(error)
    run.children.push({ handle: child, closed: () => closed, retainedAt })
  }
}

function runNativeCommand(
  ...[scope, binary, args, options]: Parameters<typeof invokeNativeCommand>
) {
  return invokeNativeCommand(scope, binary, args, {
    ...options,
    testChild: retainStartedInertChild,
  })
}

function captureStartedInertBirth(pid: number): InertIdentity {
  try {
    return captureInertBirth(pid)
  } catch (error) {
    if (
      !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
    // A just-exited child can lose namespace links before its close event.
    // Its terminal stat still supplies birth; membership was inherited at spawn.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (
      !['Z', 'X'].includes(fields[0] ?? '') ||
      !/^\d+$/.test(fields[19] ?? '')
    )
      throw error
    return {
      pid,
      start: fields[19]!,
      pgid: Number(fields[2]),
      sid: Number(fields[3]),
      namespace: readlinkSync('/proc/self/ns/pid'),
      cgroup: readFileSync('/proc/self/cgroup', 'utf8'),
    }
  }
}
function inertProgram(root: string): string {
  activeInertRun?.roots.add(root)
  const path = join(root, 'inert-native-child.mjs')
  writeFileSync(
    path,
    `import { captureInertBirth as identity, publishInertFixture, readInertIdentity } from ${JSON.stringify(new URL('./inert-fixture.ts', import.meta.url).href)}
import { spawn } from 'node:child_process'
import { writeFileSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
const [mode, root] = process.argv.slice(2)
if (mode === 'worker' || mode === 'preexisting') {
  if (mode === 'preexisting') writeFileSync('/proc/self/comm', 'ga-protected')
  const file = root + '/' + (mode === 'worker' ? 'worker' : 'preexisting') + '.json'
  await publishInertFixture(root + '/' + mode + '-birth.json', identity(process.pid))
  const server = createServer((socket) => socket.end('inert-listener'))
  server.listen(0, '127.0.0.1', async () => {
    await publishInertFixture(file, { ...identity(process.pid), port: server.address().port })
    writeFileSync(3, 'ready')
    closeSync(3)
  })
} else {
  await publishInertFixture(root + '/leader.json', identity(process.pid))
  const child = spawn(process.execPath, [process.argv[1], 'worker', root], { env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'pipe'] })
  await publishInertFixture(root + '/worker-spawn.json', identity(child.pid))
  child.stdio[3].once('data', async () => {
    if (mode === 'boundary') {
      while (!readInertIdentity(root + '/release.json', true)) await new Promise((resolve) => setImmediate(resolve))
      process.exit(0)
    }
    if (mode === 'success') process.exit(0)
    if (mode === 'nonzero') process.exit(7)
    if (mode === 'output-cap') process.stdout.write('X'.repeat(65536))
    setInterval(() => {}, 1000)
  })
}
`,
  )
  return path
}
function fixtureIdentities(root: string): InertIdentity[] {
  const rows = [
    'leader.json',
    'worker-spawn.json',
    'worker-birth.json',
    'worker.json',
    'preexisting-birth.json',
    'preexisting.json',
  ]
    .map((name) =>
      name === 'worker.json' || name === 'preexisting.json'
        ? readInertIdentity(join(root, name), true)
        : readInertIdentity(join(root, name)),
    )
    .filter((row): row is InertIdentity => row !== undefined)
  return [
    ...new Map(rows.map((row) => [`${row.pid}:${row.start}`, row])).values(),
  ]
}
function heldNativeTimer() {
  let callback: (() => void) | undefined
  let cleared = false
  let dispatched = 0
  const delays: number[] = []
  const token = {} as ReturnType<typeof setTimeout>
  const timers: NativeCommandTimers = {
    setTimer: (fn, delay) => {
      expect(callback).toBeUndefined()
      callback = fn
      delays.push(delay)
      return token
    },
    clearTimer: (handle) => {
      expect(handle).toBe(token)
      cleared = true
    },
  }
  return {
    timers,
    fire: () => {
      expect(callback).toBeDefined()
      expect(cleared).toBe(false)
      dispatched++
      callback!()
    },
    settleOnFailure: () => {
      // A setup failure may leave the timer held. Dispatch only during teardown
      // so the pending command can settle even if independent reaping fails.
      if (!cleared) callback?.()
    },
    assertCompleted: (dispatches: number) => {
      expect(delays).toEqual([100])
      expect(dispatched).toBe(dispatches)
      expect(cleared).toBe(true)
    },
  }
}
async function finallyReapInert(root: string): Promise<void> {
  const identities = fixtureIdentities(root)
  activeInertRun?.identities.push(...identities)
  await reapInertIdentities(identities, activeInertRun)
  console.log(`INERT_FINALLY_EMPTY=${JSON.stringify(identities)}`)
}
async function reapInertIdentities(
  identities: InertIdentity[],
  run?: InertRun,
): Promise<void> {
  const deadline = performance.now() + 500
  for (const identity of identities) {
    if (
      !Number.isInteger(identity.pid) ||
      identity.pid <= 1 ||
      identity.pid === process.pid ||
      !/^\d+$/.test(identity.start)
    )
      throw new Error('invalid independent fixture identity')
    if (!inertAlive(identity)) continue
    if (
      identity.namespace !== readlinkSync('/proc/self/ns/pid') ||
      identity.namespace !== readlinkSync(`/proc/${identity.pid}/ns/pid`) ||
      identity.cgroup !== readFileSync('/proc/self/cgroup', 'utf8') ||
      identity.cgroup !== readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8')
    )
      throw new Error('independent fixture identity escaped its job')
    process.kill(identity.pid, 'SIGKILL')
  }
  const children: InertChild[] = run?.children ?? []
  await waitForInertDeparture(identities, children, deadline, inertDiagnostic())
}
async function inertListener(
  port: number,
  identity?: InertIdentity,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(100, () => {
      socket.destroy()
      reject(new Error('inert listener probe timed out'))
    })
    socket.once('data', (value) => {
      socket.destroy()
      resolve(identity !== undefined || value.toString() === 'inert-listener')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve(false)
      else if (error.code === 'ECONNRESET' && identity) {
        try {
          if (!inertActorTasksRemain(identity)) resolve(false)
          else reject(error)
        } catch (identityError) {
          reject(identityError)
        }
      } else reject(error)
    })
  })
}

function nativeMatrix() {
  const docker = matrix()
  const root = '/tmp/ga-native-schema-fixture'
  return {
    ...docker,
    profile: 'native-job' as const,
    sources: sourceDigests('native-job'),
    native: {
      root,
      executable: {
        path: `${root}/inputs/ga-verified-opencode`,
        sha256: pin.binarySha256,
        bytes: pin.binaryBytes,
        elfMachine: pin.elfMachine,
        reportedVersion: pin.reportedVersion,
      },
      runtime: structuredClone(pin.runtime),
      runner: {
        path: '/usr/local/bin/bun',
        sha256: 'a'.repeat(64),
        bytes: 100,
        elfMachine: 62,
        version: '1.4.2',
        revision: pin.runtime.revision,
        device: '1',
        inode: '123',
      },
      boundary: {
        architecture: 'x86_64',
        interfaces: ['lo'],
        namespace: 'net:[123]',
        status: {
          NoNewPrivs: '1',
          Seccomp: '2',
          CapInh: '0000000000000000',
          CapPrm: '0000000000000000',
          CapEff: '0000000000000000',
          CapBnd: '0000000000000000',
          CapAmb: '0000000000000000',
        },
        controls: [
          ...[2, 10].flatMap((family) =>
            ['external_tcp', 'external_udp'].map((control) => ({
              control,
              family,
              errno: 101,
            })),
          ),
          { control: 'external_dns', errno: 101 },
          ...[2, 10].map((family) => ({
            control: 'loopback_tcp',
            family,
            roundTrip: true,
          })),
          { control: 'unix_round_trip', roundTrip: true },
          { control: 'child_inheritance', namespace: 'net:[123]', errno: 101 },
          {
            control: 'namespace_escape',
            exit: 1,
            stderr: 'unshare: Operation not permitted',
          },
        ],
      },
      processBoundary: processBoundaryFixture(),
      cleanup: [
        { id: 'boundary-probe', outcome: 'clean', signaled: 0 },
        { id: 'version', outcome: 'clean', signaled: 0 },
        ...docker.rows.flatMap((row) => [
          { id: `git:${row.id}`, outcome: 'clean', signaled: 0 },
          { id: row.id, outcome: 'clean', signaled: 0 },
        ]),
      ],
    },
    rows: docker.rows.map((row) => ({
      ...row,
      pluginPath: `${root}/inputs/ga-measure-plugin.ts`,
      command: [`${root}/inputs/ga-verified-opencode`, ...row.command.slice(1)],
    })),
  }
}

function nativeBoundarySummary() {
  const parsed = MatrixSchema.parse(nativeMatrix())
  if (parsed.profile !== 'native-job')
    throw new Error('expected native schema fixture')
  return parsed.native.processBoundary
}

// Supply synthetic /proc and interface values to test the probe-launch callback
// without qualifying a real machine or starting Python or another child process.
function modeledProbeKernel() {
  const boundary = nativeMatrix().native.boundary
  const read = fs.readFileSync
  const readdir = fs.readdirSync
  const readlink = fs.readlinkSync
  const reads = spyOn(fs, 'readFileSync').mockImplementation(
    new Proxy(read, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/proc/self/status')
          return Object.entries(boundary.status)
            .map(([key, value]) => `${key}:\t${value}`)
            .join('\n')
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const directories = spyOn(fs, 'readdirSync').mockImplementation(
    new Proxy(readdir, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/sys/class/net') return ['lo']
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const links = spyOn(fs, 'readlinkSync').mockImplementation(
    new Proxy(readlink, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/proc/self/ns/net') return boundary.namespace
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  return {
    boundary,
    restore: () => {
      links.mockRestore()
      directories.mockRestore()
      reads.mockRestore()
    },
  }
}

describe('native boundary probe launcher source controls', () => {
  const controls = [
    'success',
    'nonzero exit',
    'missing exit',
    'signal',
    'spawn failure',
    'timeout',
    'output cap',
    'failed cleanup',
    'cleanup signal count',
    'cleanup signal record',
    'cleanup failure',
    'unknown survivors',
    'remaining survivor',
  ] as const
  for (const control of controls)
    test(`typed probe launcher preserves raw ${control} result and enforces qualified cleanup`, async () => {
      const { measureNativeJob } = await import(
        '../src/fixtures/opencode-ga-host/native-job.ts'
      )
      const root = mkdtempSync(join(tmpdir(), 'ga-probe-adapter-'))
      const evidence = join(root, 'boundary-evidence.json')
      const modeled = modeledProbeKernel()
      let dispatches = 0
      let unqualifiedLaunches = 0
      const launch = spyOn(childProcess, 'spawn').mockImplementation(() => {
        unqualifiedLaunches++
        throw new Error('unqualified probe launcher trap')
      })
      const raw: NativeProbeCommandResult = {
        code: 0,
        signal: null,
        stdout: JSON.stringify(modeled.boundary),
        stderr: 'modeled-probe-stderr',
        timedOut: false,
        outputCapExceeded: false,
        spawnError: null,
        cleanup: {
          outcome: 'clean',
          signaled: 0,
          signals: [],
          preexisting: [{ protectedModel: true }],
          survivors: [],
          failures: [],
        },
      }
      if (control === 'nonzero exit') raw.code = 7
      if (control === 'missing exit') raw.code = null
      if (control === 'signal') raw.signal = 'SIGTERM'
      if (control === 'spawn failure') raw.spawnError = 'modeled spawn failure'
      if (control === 'timeout') raw.timedOut = true
      if (control === 'output cap') raw.outputCapExceeded = true
      if (control === 'failed cleanup') raw.cleanup.outcome = 'failed'
      if (control === 'cleanup signal count') raw.cleanup.signaled = 1
      if (control === 'cleanup signal record')
        raw.cleanup.signals = [{ modeledSignal: true }]
      if (control === 'cleanup failure')
        raw.cleanup.failures = ['modeled cleanup failure']
      if (control === 'unknown survivors') raw.cleanup.survivors = null
      if (control === 'remaining survivor')
        raw.cleanup.survivors = [{ modeledSurvivor: true }]
      const before = JSON.stringify(raw)
      try {
        const pending = measureNativeJob(
          join(HERE, '../../..'),
          root,
          { PATH: '/usr/bin:/bin' },
          evidence,
          async (binary, args, options) => {
            dispatches++
            expect(binary).toBe('/usr/bin/python3')
            expect(args).toEqual([
              fs.realpathSync(
                join(
                  HERE,
                  '../src/fixtures/opencode-ga-host/native-boundary.py',
                ),
              ),
              root,
            ])
            expect(options).toEqual({
              cwd: root,
              env: { PATH: '/usr/bin:/bin' },
              timeoutMs: 15_000,
              outputCapBytes: 64 * 1024,
            })
            return raw
          },
        )
        if (control === 'success') await pending
        else
          await expect(pending).rejects.toThrow(
            'Qualified native probe failed:',
          )
        expect(dispatches).toBe(1)
        expect(unqualifiedLaunches).toBe(0)
        const captured: unknown = JSON.parse(readFileSync(evidence, 'utf8'))
        expect(captured).toEqual({
          probeSha256: sha256(
            readFileSync(
              join(HERE, '../src/fixtures/opencode-ga-host/native-boundary.py'),
            ),
          ),
          result: JSON.parse(before),
        })
        expect(JSON.stringify(raw)).toBe(before)
      } finally {
        launch.mockRestore()
        modeled.restore()
        rmSync(root, { recursive: true, force: true })
      }
    })
  test('unchanged non-matrix callers retain the default owned probe launcher', async () => {
    const { measureNativeJob } = await import(
      '../src/fixtures/opencode-ga-host/native-job.ts'
    )
    const owned = await import(
      '../src/fixtures/opencode-ga-host/owned-command.ts'
    )
    const root = mkdtempSync(join(tmpdir(), 'ga-probe-default-'))
    const modeled = modeledProbeKernel()
    let defaults = 0
    let realSpawnAttempts = 0
    const spawnTripwire = spyOn(childProcess, 'spawn').mockImplementation(
      () => {
        realSpawnAttempts++
        throw new Error('default probe test must not start a real child')
      },
    )
    const launch = spyOn(owned, 'startOwnedCommand').mockImplementation(
      (binary, args, options) => {
        defaults++
        expect(binary).toBe('/usr/bin/python3')
        expect(args).toEqual([
          fs.realpathSync(
            join(HERE, '../src/fixtures/opencode-ga-host/native-boundary.py'),
          ),
          root,
        ])
        expect(options).toEqual({
          cwd: root,
          env: { PATH: '/usr/bin:/bin' },
          deadlineMs: 15_000,
          outputCapBytes: 64 * 1024,
        })
        throw new Error(
          'default owned probe launcher reached; no actor started',
        )
      },
    )
    try {
      await expect(
        measureNativeJob(
          join(HERE, '../../..'),
          root,
          { PATH: '/usr/bin:/bin' },
          join(root, 'evidence.json'),
        ),
      ).rejects.toThrow(
        'default owned probe launcher reached; no actor started',
      )
      expect(defaults).toBe(1)
      expect(realSpawnAttempts).toBe(0)
    } finally {
      launch.mockRestore()
      spawnTripwire.mockRestore()
      modeled.restore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('actor fixture publication never exposes truncated JSON before rename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ga-publication-'))
  const path = join(root, 'worker.json')
  const old: InertReadyIdentity = {
    pid: 123,
    start: '456',
    namespace: 'pid:[789]',
    cgroup: '0::/fixture\n',
    pgid: 123,
    sid: 123,
    port: 12345,
  }
  const next = { ...old, port: 23456 }
  try {
    for (const previous of [undefined, old]) {
      if (previous) await publishInertFixture(path, previous)
      const halfWritten = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const publishing = publishInertFixture(path, next, async () => {
        halfWritten.resolve()
        await release.promise
      })
      try {
        await halfWritten.promise
        expect(readInertIdentity(path, true)).toEqual(previous)
      } finally {
        release.resolve()
        await publishing
      }
      expect(readInertIdentity(path, true)).toEqual(next)
    }
    for (const corrupt of [
      '',
      '{"pid":123,',
      '{}',
      JSON.stringify({ ...old, port: undefined }),
    ]) {
      writeFileSync(path, corrupt)
      const original = fs.readFileSync
      let attempts = 0
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        observeBuiltin(original, (value, args) => {
          if (String(args[0]) === path) attempts++
          return value
        }),
      )
      try {
        await expect(
          waitForInertReady(path, performance.now() + 500),
        ).rejects.toThrow(path)
        expect(attempts).toBe(1)
      } finally {
        reads.mockRestore()
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runner-held actor handles retain birth and require close rather than exit', () => {
  const run: InertRun = {
    children: [],
    identities: [],
    roots: new Set(),
    errors: [],
  }
  const child = new childProcess.ChildProcess()
  Object.defineProperty(child, 'pid', { value: 100 })
  const original = fs.readFileSync
  const originalLink = fs.readlinkSync
  const reads = spyOn(fs, 'readFileSync').mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/proc/100/stat')
          return `100 (child) S ${Array(18).fill('0').join(' ')} 123 0\n`
        if (String(args[0]) === '/proc/100/cgroup') return '0::/modeled\n'
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const links = spyOn(fs, 'readlinkSync').mockImplementation(
    new Proxy(originalLink, {
      apply(target, receiver, args: unknown[]) {
        return String(args[0]) === '/proc/100/ns/pid'
          ? 'pid:[1]'
          : Reflect.apply(target, receiver, args)
      },
    }),
  )
  activeInertRun = run
  try {
    retainStartedInertChild(child)
    expect(run.errors).toEqual([])
    expect(run.identities).toMatchObject([
      { pid: 100, start: '123', namespace: 'pid:[1]', cgroup: '0::/modeled\n' },
    ])
    expect(run.children[0]?.handle).toBe(child)
    child.emit('exit', 0, null)
    expect(run.children[0]?.closed()).toBe(false)
    child.emit('close', 0, null)
    expect(run.children[0]?.closed()).toBe(true)
  } finally {
    activeInertRun = undefined
    links.mockRestore()
    reads.mockRestore()
  }
})

function modeledInertActor(state = 'Z', start = '123') {
  const identity: InertIdentity = {
    pid: 100,
    start: '123',
    namespace: 'pid:[1]',
    cgroup: '0::/modeled\n',
    pgid: 100,
    sid: 100,
  }
  const model = { state, start, elapsed: 0, sibling: false }
  const lines: string[] = []
  const stat = (pid: number, currentState: string, birth: string) =>
    `${pid} (modeled actor) ${currentState} 1 ${Array(17).fill('0').join(' ')} ${birth} 0\n`
  const clock = spyOn(performance, 'now').mockImplementation(
    () => model.elapsed,
  )
  const read = fs.readFileSync
  const reads = spyOn(fs, 'readFileSync').mockImplementation(
    new Proxy(read, {
      apply(target, receiver, args: unknown[]) {
        const path = String(args[0])
        if (path === '/proc/100/stat' || path === '/proc/100/task/100/stat')
          return stat(100, model.state, model.start)
        if (path === '/proc/100/task/101/stat' && model.sibling)
          return stat(101, 'S', '124')
        if (path === '/proc/100/cgroup') return identity.cgroup
        if (path.startsWith('/proc/') || path.includes('cgroup.threads'))
          throw new Error(`forbidden non-owned observation: ${path}`)
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const directory = fs.readdirSync
  const directories = spyOn(fs, 'readdirSync').mockImplementation(
    new Proxy(directory, {
      apply(target, receiver, args: unknown[]) {
        const path = String(args[0])
        if (path === '/proc/100/task')
          return model.sibling ? ['100', '101'] : ['100']
        if (path.startsWith('/proc/') || path.includes('cgroup'))
          throw new Error(`forbidden non-owned inventory: ${path}`)
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const link = fs.readlinkSync
  const links = spyOn(fs, 'readlinkSync').mockImplementation(
    new Proxy(link, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/proc/100/ns/pid') return identity.namespace
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  return {
    identity,
    model,
    lines,
    diagnostic: (testName: string): InertDeadlineDiagnostic => ({
      testName,
      identities: () => [identity],
      emit: (line) => lines.push(line),
    }),
    restore: () => {
      links.mockRestore()
      directories.mockRestore()
      reads.mockRestore()
      clock.mockRestore()
    },
  }
}

test('owned orphan zombie is departed while PID1 does not reap it', async () => {
  const actor = modeledInertActor()
  try {
    const pending = waitForInertDeparture([actor.identity], [], 500)
    actor.model.elapsed = 500
    await expect(pending).resolves.toBeUndefined()
  } finally {
    actor.restore()
  }
})

test('vanished foreign TID cannot block owned fixture departure', async () => {
  const actor = modeledInertActor('X')
  try {
    // The read tripwire forbids even looking up a foreign TID that might vanish.
    const pending = waitForInertDeparture([actor.identity], [], 500)
    actor.model.elapsed = 500
    await expect(pending).resolves.toBeUndefined()
  } finally {
    actor.restore()
  }
})

test('reused PID with a different start time is not our actor', async () => {
  const actor = modeledInertActor('S', '999')
  try {
    const pending = waitForInertDeparture([actor.identity], [], 500)
    actor.model.elapsed = 500
    await expect(pending).resolves.toBeUndefined()
  } finally {
    actor.restore()
  }
})

test('owned live or stopped actor blocks fixture departure', async () => {
  for (const state of ['S', 'T']) {
    const actor = modeledInertActor(state)
    const name = 'owned live or stopped actor blocks fixture departure'
    let resolved = false
    try {
      const pending = waitForInertDeparture(
        [actor.identity],
        [],
        500,
        actor.diagnostic(name),
      ).then(() => {
        resolved = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(resolved).toBe(false)
      expect(actor.lines).toEqual([])
      actor.model.elapsed = 500
      await expect(pending).rejects.toThrow(
        'independent fixture task departure deadline exceeded',
      )
      expect(actor.lines).toHaveLength(1)
      const snapshot = JSON.parse(actor.lines[0]!.split('=', 2)[1]!)
      expect(snapshot).toMatchObject({
        testName: name,
        kind: 'departure',
        budgetMs: 500,
        elapsedMs: 500,
        identities: [
          {
            pid: 100,
            start: '123',
            observedStart: '123',
            state,
            ppid: 1,
            matched: true,
          },
        ],
      })
    } finally {
      actor.model.elapsed = 500
      actor.restore()
    }
  }
})

test('deadline snapshot is emitted on departure timeout and does not change the outcome', async () => {
  const actor = modeledInertActor('T')
  const name =
    'deadline snapshot is emitted on departure timeout and does not change the outcome'
  try {
    const pending = waitForInertDeparture(
      [actor.identity],
      [],
      500,
      actor.diagnostic(name),
    )
    actor.model.elapsed = 500
    await expect(pending).rejects.toThrow(
      'independent fixture task departure deadline exceeded',
    )
    expect(actor.lines).toHaveLength(1)
    expect(JSON.parse(actor.lines[0]!.split('=', 2)[1]!)).toMatchObject({
      testName: name,
      kind: 'departure',
      elapsedMs: 500,
      budgetMs: 500,
      identities: [
        { pid: 100, start: '123', state: 'T', ppid: 1, matched: true },
      ],
    })
    await expect(
      waitForInertDeparture([actor.identity], [], 500, {
        ...actor.diagnostic(name),
        emit: () => {
          throw new Error('broken diagnostic sink')
        },
      }),
    ).rejects.toThrow('independent fixture task departure deadline exceeded')
  } finally {
    actor.restore()
  }
})

test('readiness and completion deadline snapshots retain the missing record and exact actor identity', async () => {
  const actor = modeledInertActor('S')
  const name =
    'readiness and completion deadline snapshots retain the missing record and exact actor identity'
  const output = spyOn(console, 'log').mockImplementation((line) =>
    actor.lines.push(String(line)),
  )
  activeInertRun = {
    testName: name,
    children: [],
    identities: [actor.identity],
    roots: new Set(),
    errors: [],
  }
  try {
    await expect(
      waitForInertReady('/missing-ready-record.json', 500, {
        absent: () => {
          actor.model.elapsed = 500
        },
      }),
    ).rejects.toThrow('actor fixture setup deadline expired')
    reportInertOracle(500, '/missing-ready-record.json')
    reportInertOracle(500, undefined, () => [
      { ...actor.identity, start: '999' },
    ])
    expect(actor.lines).toHaveLength(2)
    const snapshots = actor.lines.map((line) =>
      JSON.parse(line.split('=', 2)[1]!),
    )
    expect(snapshots[0]).toMatchObject({
      testName: name,
      kind: 'readiness',
      budgetMs: 500,
      elapsedMs: 500,
      missingReady: '/missing-ready-record.json',
      identities: [
        { pid: 100, start: '123', state: 'S', ppid: 1, matched: true },
      ],
    })
    expect(snapshots[1]).toMatchObject({
      testName: name,
      kind: 'completion',
      budgetMs: 500,
      elapsedMs: 500,
      identities: [
        { pid: 100, start: '123', observedStart: '123', matched: true },
        { pid: 100, start: '999', observedStart: '123', matched: false },
      ],
    })
    expect(snapshots[1]).not.toHaveProperty('missingReady')
  } finally {
    activeInertRun = undefined
    output.mockRestore()
    actor.restore()
  }
})

function modeledInertConnection(event: 'reset' | 'answer') {
  return spyOn(net, 'createConnection').mockImplementation(() => {
    const socket = new net.Socket()
    queueMicrotask(() => {
      if (event === 'answer')
        socket.emit('data', Buffer.from('an answering listener'))
      else
        socket.emit(
          'error',
          Object.assign(new Error('modeled reset'), { code: 'ECONNRESET' }),
        )
    })
    return socket
  })
}

test('post-kill reset counts as not listening only after the listener identity is gone', async () => {
  const actor = modeledInertActor()
  const connection = modeledInertConnection('reset')
  try {
    expect(await inertListener(12345, actor.identity)).toBe(false)
    actor.model.state = 'S'
    actor.model.start = '999'
    expect(await inertListener(12345, actor.identity)).toBe(false)
    await expect(inertListener(12345)).rejects.toThrow('modeled reset')
  } finally {
    connection.mockRestore()
    actor.restore()
  }
})

test('an accepted answering connection still fails the post-kill probe', async () => {
  const actor = modeledInertActor()
  const connection = modeledInertConnection('answer')
  try {
    expect(await inertListener(12345, actor.identity)).toBe(true)
  } finally {
    connection.mockRestore()
    actor.restore()
  }
})

test('a reset while the listener identity is live still fails', async () => {
  const actor = modeledInertActor('S')
  const connection = modeledInertConnection('reset')
  try {
    await expect(inertListener(12345, actor.identity)).rejects.toThrow(
      'modeled reset',
    )
    actor.model.state = 'Z'
    actor.model.sibling = true
    await expect(inertListener(12345, actor.identity)).rejects.toThrow(
      'modeled reset',
    )
  } finally {
    connection.mockRestore()
    actor.restore()
  }
})

test('terminal leader teardown waits for close and its own live sibling thread to depart', async () => {
  const actor = modeledInertActor()
  actor.model.sibling = true
  let closed = false
  let done = false
  const pending = waitForInertDeparture(
    [actor.identity],
    [{ closed: () => closed }],
    500,
  ).then(() => {
    done = true
  })
  try {
    expect(inertAlive(actor.identity)).toBe(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    closed = true
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    actor.model.sibling = false
    await pending
    expect(done).toBe(true)
  } finally {
    actor.model.sibling = false
    closed = true
    try {
      await pending
    } finally {
      actor.restore()
    }
  }
})

test('fixture departure deadline fails visibly for an unclosed child', async () => {
  const actor = modeledInertActor()
  try {
    const pending = waitForInertDeparture(
      [actor.identity],
      [{ closed: () => false }],
      500,
    )
    actor.model.elapsed = 500
    await expect(pending).rejects.toThrow(
      'independent fixture task departure deadline exceeded',
    )
  } finally {
    actor.restore()
  }
})

test('teardown budget starts at teardown, not at first child', async () => {
  const actor = modeledInertActor('S')
  const run: InertRun = {
    testName: 'teardown budget starts at teardown, not at first child',
    children: [],
    identities: [],
    roots: new Set(),
    errors: [],
  }
  const child = new childProcess.ChildProcess()
  Object.defineProperty(child, 'pid', { value: 100 })
  activeInertRun = run
  try {
    retainStartedInertChild(child)
    expect(run.errors).toEqual([])
    await expect(
      waitForInertReady('/missing-ready-record.json', 500, {
        absent: () => {
          actor.model.elapsed = 500
        },
      }),
    ).rejects.toThrow('actor fixture setup deadline expired')
    actor.model.state = 'Z'
    const pending = reapInertIdentities(run.identities, run)
    actor.model.elapsed = 999
    child.emit('close', 0, null)
    await expect(pending).resolves.toBeUndefined()
    actor.model.elapsed = 1500
    await expect(
      reapInertIdentities(run.identities, run),
    ).resolves.toBeUndefined()
  } finally {
    activeInertRun = undefined
    actor.restore()
  }
})

test('slow actor readiness precedes the cleanup trigger within the existing deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ga-ready-order-'))
  const path = join(root, 'worker.json')
  const record: InertReadyIdentity = {
    pid: 123,
    start: '456',
    namespace: 'pid:[789]',
    cgroup: '0::/fixture\n',
    pgid: 123,
    sid: 123,
    port: 12345,
  }
  const release = Promise.withResolvers<void>()
  const absentRead = Promise.withResolvers<void>()
  const deadline = performance.now() + 500
  const events: string[] = []
  let admitted: InertReadyIdentity | undefined
  const publishing = (async () => {
    await release.promise
    await publishInertFixture(path, record)
  })()
  // Gate the actual publisher, then observe a read while readiness is absent.
  const ready = waitForInertReady(path, deadline, {
    absent: () => {
      if (!events.includes('absent')) events.push('absent')
      absentRead.resolve()
    },
  })
  const ordered = readyBeforeInertCleanup(
    ready,
    () => {
      events.push('trigger')
      expect(admitted).toEqual(record)
    },
    (identity) => {
      admitted = identity
      events.push('ready')
    },
  ).then(
    (identity) => ({ identity }),
    (error: unknown) => ({ error }),
  )
  try {
    await absentRead.promise
    expect(events).toEqual(['absent'])
    release.resolve()
    await publishing
    const result = await ordered
    if ('error' in result) throw result.error
    expect(result.identity.port).toBe(12345)
    expect(events).toEqual(['absent', 'ready', 'trigger'])
    expect(performance.now()).toBeLessThan(deadline)

    rmSync(path)
    let clock = 0
    let absent = 0
    let triggered = false
    await expect(
      readyBeforeInertCleanup(
        waitForInertReady(path, 500, {
          now: () => clock,
          absent: () => {
            absent++
            clock = 500
          },
        }),
        () => {
          triggered = true
        },
      ),
    ).rejects.toThrow(`actor fixture setup deadline expired: ${path}`)
    expect(absent).toBe(1)
    expect(clock).toBe(500)
    expect(triggered).toBe(false)
  } finally {
    release.resolve()
    await publishing
    await ordered
    rmSync(root, { recursive: true, force: true })
  }
})

test('native command timer defaults to real setTimeout and clearTimeout', async () => {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const sets = spyOn(globalThis, 'setTimeout').mockImplementation(originalSet)
  const clears = spyOn(globalThis, 'clearTimeout').mockImplementation(
    originalClear,
  )
  try {
    const fired = Promise.withResolvers<void>()
    const cancel = armNativeCommandTimer(fired.resolve, 1)
    expect(sets).toHaveBeenCalledWith(fired.resolve, 1)
    await fired.promise
    cancel()
    expect(clears).toHaveBeenCalledWith(sets.mock.results[0]!.value)
  } finally {
    clears.mockRestore()
    sets.mockRestore()
  }
})

test('held native command timers are armed and cleared without dispatch until the cleanup trigger', () => {
  const held = heldNativeTimer()
  let dispatched = 0
  const cancel = armNativeCommandTimer(
    () => {
      dispatched++
    },
    100,
    held.timers,
  )
  expect(dispatched).toBe(0)
  cancel()
  held.assertCompleted(0)
})

// These portable source controls check the motor call sites, not native reaping.
// The behavioral held-timer control above exercises the timer implementation.
for (const name of [
  'genuinely exited groups remain clean with zero cleanup signals',
  'extant thread group is unknown while its listener survives original-command close',
  'preexisting listener controller and PID1 are protected from native command cleanup',
  'a changed captured birth fails closed but remaining owned listener is still reaped',
]) {
  test(`natural-exit timer wiring holds until exit: ${name}`, () => {
    const source = createSourceFile(
      'ga-contract-inputs.test.ts',
      readFileSync(fileURLToPath(import.meta.url), 'utf8'),
      ScriptTarget.Latest,
      true,
    )
    const registrations: Node[] = []
    const visit = (node: Node) => {
      if (
        isCallExpression(node) &&
        node.expression.getText(source) === 'motorTest' &&
        node.arguments[1] &&
        isStringLiteral(node.arguments[1]) &&
        node.arguments[1].text === name
      )
        registrations.push(node.arguments[2]!)
      forEachChild(node, visit)
    }
    visit(source)
    expect(registrations).toHaveLength(1)
    let held = 0
    let commands = 0
    let wired = 0
    let asserted = 0
    const inspect = (node: Node) => {
      if (
        isVariableDeclaration(node) &&
        node.name.getText(source) === 'timerControl'
      ) {
        expect(node.initializer?.getText(source)).toBe('heldNativeTimer()')
        held++
      }
      if (isCallExpression(node)) {
        const callee = node.expression.getText(source)
        if (callee === 'runNativeCommand') {
          commands++
          const options = node.arguments[3]
          if (options && isObjectLiteralExpression(options))
            for (const property of options.properties)
              if (
                isPropertyAssignment(property) &&
                property.name.getText(source) === 'testTimers'
              ) {
                expect(property.initializer.getText(source)).toBe(
                  'timerControl.timers',
                )
                wired++
              }
        }
        if (callee === 'timerControl.assertCompleted') {
          expect(node.arguments.map((arg) => arg.getText(source))).toEqual([
            '0',
          ])
          asserted++
        }
      }
      forEachChild(node, inspect)
    }
    inspect(registrations[0]!)
    expect({ held, commands, wired, asserted }).toEqual({
      held: 1,
      commands: 1,
      wired: 1,
      asserted: 1,
    })
  })
}

test('changed-birth assertion failure emits exactly one full snapshot and preserves the failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ga-birth-diagnostic-'))
  const worker: InertReadyIdentity = {
    pid: 123,
    start: '456',
    namespace: 'pid:[789]',
    cgroup: '0::/fixture\n',
    pgid: 123,
    sid: 123,
    port: 12345,
  }
  try {
    await publishInertFixture(join(root, 'worker.json'), worker)
    writeFileSync(join(root, 'worker-birth.json'), '{')
    const fixtureFiles = changedBirthFixtureFiles(root)
    expect(fixtureFiles['worker.json']).toEqual({
      present: true,
      identity: worker,
    })
    expect(fixtureFiles['leader.json']).toEqual({
      present: false,
      identity: null,
    })
    expect(fixtureFiles['worker-birth.json']?.present).toBe(true)
    expect(typeof fixtureFiles['worker-birth.json']?.error).toBe('string')
    const lines: string[] = []
    const diagnostic: InertDeadlineDiagnostic = {
      testName: 'modeled changed birth',
      identities: () => [],
      emit: (line) => lines.push(line),
    }
    const snapshot = {
      result: {
        code: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: 'actor output',
        stderr: '',
        cleanup: {
          failures: ['identity changed before signal'],
          signals: [
            { identity: { pid: 123, start: '456' }, signal: 'SIGKILL' },
          ],
          survivors: [],
        },
      },
      fixtureFiles,
      spyCalls: 17,
      matchingPathCount: 0,
    }
    let failure: unknown
    await expect(
      withChangedBirthDiagnostic(
        () => {
          try {
            expect(snapshot.matchingPathCount).toBeGreaterThanOrEqual(2)
          } catch (error) {
            failure = error
            throw error
          }
        },
        () => snapshot,
        diagnostic,
      ),
    ).rejects.toBe(failure)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('CHANGED_BIRTH_FAILURE=')).toBe(true)
    expect(
      JSON.parse(lines[0]!.slice('CHANGED_BIRTH_FAILURE='.length)),
    ).toEqual(snapshot)
    lines.length = 0
    await withChangedBirthDiagnostic(
      () => {},
      () => snapshot,
      diagnostic,
    )
    expect(lines).toEqual([])
    const primary = new Error('later assertion')
    await expect(
      withChangedBirthDiagnostic(
        () => {
          throw primary
        },
        () => snapshot,
        {
          ...diagnostic,
          emit: () => {
            throw new Error('sink failure')
          },
        },
      ),
    ).rejects.toBe(primary)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('actor publication closes an exclusive sibling before rename without fsync and removes failed writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ga-publish-protocol-'))
  const path = join(root, 'worker-spawn.json')
  const events: string[] = []
  const originalOpen = fs.openSync
  const originalClose = fs.closeSync
  const originalRename = fs.renameSync
  let temporary = ''
  const opens = spyOn(fs, 'openSync').mockImplementation(
    new Proxy(originalOpen, {
      apply(target, receiver, args: unknown[]) {
        temporary = String(args[0])
        expect(dirname(temporary)).toBe(root)
        expect(temporary).not.toBe(path)
        expect(args[1]).toBe('wx')
        events.push('open')
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const syncs = spyOn(fs, 'fsyncSync').mockImplementation(() => {
    throw new Error(
      'fixture publication must not wait for power-loss durability',
    )
  })
  const closes = spyOn(fs, 'closeSync').mockImplementation((fd) => {
    events.push('close')
    originalClose(fd)
  })
  const renames = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    expect(events).toEqual(['open', 'close'])
    expect(String(from)).toBe(temporary)
    expect(String(to)).toBe(path)
    events.push('rename')
    originalRename(from, to)
  })
  try {
    await publishInertFixture(path, { birth: 1 })
    expect(events).toEqual(['open', 'close', 'rename'])
    const firstTemporary = temporary
    events.length = 0
    await expect(
      publishInertFixture(path, { birth: 2 }, () => {
        throw new Error('controlled write failure')
      }),
    ).rejects.toThrow(path)
    expect(temporary).not.toBe(firstTemporary)
    expect(fs.readdirSync(root)).toEqual(['worker-spawn.json'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ birth: 1 })
  } finally {
    renames.mockRestore()
    closes.mockRestore()
    syncs.mockRestore()
    opens.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('actor teardown preserves the primary failure and still settles and removes after a reaper failure', async () => {
  const primary = new Error('primary assertion')
  const reaper = new Error('invalid fixture path')
  const events: string[] = []
  let failure: unknown
  try {
    await finishInertTest(
      [primary],
      [
        () => {
          events.push('reap')
          throw reaper
        },
        () => {
          events.push('settle')
        },
        () => {
          events.push('remove')
        },
      ],
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([primary, reaper])
  expect(events).toEqual(['reap', 'settle', 'remove'])
  await expect(finishInertTest([primary], [])).rejects.toBe(primary)
})

// Model both task inventories and leader identities without borrowing host /proc.
function modeledAdmissionTasks(
  before: { tid: number; tgid: number }[],
  after = before,
  changedBirth?: number,
  // Members the kernel lists as 0 because they live outside this PID namespace,
  // as the MOTOR runner's own process does on the hosted tenant and Boat.
  outsideNamespace = 0,
) {
  const outside = Array<string>(outsideNamespace).fill('0')
  const summary = nativeBoundarySummary()
  const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
  const paths: string[] = []
  let inventories = 0
  const read = fs.readFileSync
  const link = fs.readlinkSync
  const directory = fs.readdirSync
  const readModeled = new Proxy(read, {
    apply(target, receiver, args: unknown[]) {
      const path = String(args[0])
      paths.push(path)
      if (path === threads) {
        inventories++
        return [
          ...outside,
          ...(inventories === 1 ? before : after).map(({ tid }) => tid),
        ].join('\n')
      }
      if (path === threads.replace('cgroup.threads', 'cgroup.procs'))
        return [...outside, ...new Set(before.map(({ tgid }) => tgid))].join(
          '\n',
        )
      const match = /^\/proc\/(\d+)\/(status|stat|cgroup)$/.exec(path)
      if (match) {
        const pid = Number(match[1])
        const tasks = inventories < 2 ? before : after
        const task = tasks.find(({ tid }) => tid === pid)
        if (!task && !tasks.some(({ tgid }) => tgid === pid))
          throw Object.assign(new Error('modeled departed task'), {
            code: 'ENOENT',
          })
        if (match[2] === 'status')
          return `Pid:\t${pid}\nTgid:\t${task?.tgid ?? pid}\nUid:\t999 999 999 999\n`
        if (match[2] === 'cgroup') return `0::${summary.cgroup.self}\n`
        const birth = inventories >= 2 && pid === changedBirth ? '999' : '123'
        return `${pid} (modeled runner) S ${Array(18).fill('0').join(' ')} ${birth} 0\n`
      }
      return Reflect.apply(target, receiver, args)
    },
  })
  const reads = spyOn(fs, 'readFileSync').mockImplementation(readModeled)
  const links = spyOn(fs, 'readlinkSync').mockImplementation(
    new Proxy(link, {
      apply(target, receiver, args: unknown[]) {
        if (/^\/proc\/\d+\/ns\/pid$/.test(String(args[0])))
          return summary.namespace.self
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const directories = spyOn(fs, 'readdirSync').mockImplementation(
    new Proxy(directory, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === '/proc')
          return [...new Set(before.map(({ tgid }) => String(tgid)))]
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  return {
    summary,
    read: readModeled,
    paths,
    inventories: () => inventories,
    reset: () => {
      inventories = 0
    },
    restore: () => {
      directories.mockRestore()
      links.mockRestore()
      reads.mockRestore()
    },
  }
}

describe(CLEANUP_GROUP, () => {
  test('modeled runner thread spawn preserves inspected group admission', () => {
    const model = modeledAdmissionTasks(
      [{ tid: 100, tgid: 100 }],
      [
        { tid: 100, tgid: 100 },
        { tid: 101, tgid: 100 },
      ],
    )
    const lines: string[] = []
    const stop = enableNativeTaskDiagnostic({
      runnerPid: 100,
      actorPids: () => [],
      emit: (line) => lines.push(line),
    })
    try {
      expect(scopedProcesses(model.summary, true)).toMatchObject([
        { pid: 100, start: '123', namespace: model.summary.namespace.self },
      ])
      expect(model.inventories()).toBe(2)
      expect(model.paths).toContain('/proc/101/status')
      expect(model.paths).toContain('/proc/101/stat')
      expect(lines).toEqual([])
    } finally {
      stop()
      model.restore()
    }
  })
  test('modeled tenant cgroup member outside the PID namespace is counted but never inventoried or signalled', () => {
    // The hosted tenant listed cgroup.procs as "0 1 2 29 30": the runner process
    // that unshared the job's PID namespace stays in the unit and reads as 0.
    const model = modeledAdmissionTasks(
      [{ tid: 100, tgid: 100 }],
      undefined,
      undefined,
      1,
    )
    let signals = 0
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      signals++
      return true
    })
    try {
      expect(scopedProcesses(model.summary, true)).toMatchObject([
        { pid: 100, start: '123', namespace: model.summary.namespace.self },
      ])
      expect(model.paths.filter((path) => path.startsWith('/proc/0/'))).toEqual(
        [],
      )
      expect(signals).toBe(0)
    } finally {
      signal.mockRestore()
      model.restore()
    }
  })
  test('an outside-namespace zero never helps an ordinary host qualify or reach a signal', () => {
    // A 0 in cgroup.procs is only tolerated inside an already qualified MOTOR
    // job. On an ordinary host (host PID 1 and namespace, no MOTOR unit), every
    // member list reads as zeros here, yet the guard must still refuse at
    // placement, before it reads any member list, and must never signal.
    const read = fs.readFileSync
    const link = fs.readlinkSync
    const paths: string[] = []
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(read, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          paths.push(path)
          if (path === '/proc/self/cgroup')
            return '0::/user.slice/user-1000.slice/session-1.scope\n'
          if (path === '/proc/1/comm') return 'systemd\n'
          if (/cgroup\.(procs|threads)$/.test(path)) return '0\n0\n'
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    const links = spyOn(fs, 'readlinkSync').mockImplementation(
      new Proxy(link, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          if (path === '/proc/self/ns/pid') return 'pid:[4026531836]'
          if (path === '/proc/1/ns/pid') return 'pid:[4026531836]'
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    let signals = 0
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      signals++
      return true
    })
    try {
      expect(() => qualifyNativeProcessScope()).toThrow(
        'native cleanup requires the unprivileged Linux x64 MOTOR job (',
      )
      expect(
        paths.filter((path) => /cgroup\.(procs|threads)$/.test(path)),
      ).toEqual([])
      expect(signals).toBe(0)
    } finally {
      signal.mockRestore()
      links.mockRestore()
      reads.mockRestore()
    }
  })
  test('cgroup member lists admit only distinct positive ids and count outside-namespace zeros', () => {
    expect(
      cgroupMemberIds(['0', '1', '2', '29', '30'], 'cgroup.procs', 'ambiguous'),
    ).toEqual({ members: [1, 2, 29, 30], outsideNamespace: 1 })
    expect(cgroupMemberIds(['0', '0', '7'], 'cgroup.threads', 'x')).toEqual({
      members: [7],
      outsideNamespace: 2,
    })
    expect(() =>
      cgroupMemberIds(
        ['5', '5'],
        'cgroup.procs',
        'ambiguous cgroup membership',
      ),
    ).toThrow('ambiguous cgroup membership')
    for (const entry of ['', 'max', '-1', '01', '1.5', '1e3', ' 4'])
      expect(() => cgroupMemberIds([entry], 'cgroup.procs', 'x')).toThrow(
        `unqualifiable cgroup.procs entry ${JSON.stringify(entry)}`,
      )
  })
  for (const control of [
    'new thread group',
    'thread in uninspected group',
    'changed leader birth',
    'departed group',
  ] as const)
    test(`modeled admission refuses ${control} between task inventories`, () => {
      const before = [
        { tid: 100, tgid: 100 },
        ...(control === 'departed group' ? [{ tid: 300, tgid: 300 }] : []),
      ]
      const after =
        control === 'departed group'
          ? [{ tid: 300, tgid: 300 }]
          : control === 'new thread group'
            ? [...before, { tid: 200, tgid: 200 }]
            : control === 'thread in uninspected group'
              ? [...before, { tid: 201, tgid: 200 }]
              : before
      const model = modeledAdmissionTasks(
        before,
        after,
        control === 'changed leader birth' ? 100 : undefined,
      )
      try {
        expect(() => threadGroupHasLiveTasks(100, model.summary)).toThrow(
          'UNKNOWN cgroup task inventory changed during admission',
        )
        expect(model.inventories()).toBe(2)
      } finally {
        model.restore()
      }
    })
  test('modeled partial namespace ENOENT reaches the extant thread group refusal without launch or signal', () => {
    const summary = nativeBoundarySummary()
    const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
    const original = fs.readFileSync
    const originalLink = fs.readlinkSync
    const originalDirectory = fs.readdirSync
    let injected = 0
    let launches = 0
    let signals = 0
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          if (path === threads) return '101\n'
          if (path === threads.replace('cgroup.threads', 'cgroup.procs'))
            return '100\n'
          if (path === '/proc/101/status') return 'Pid:\t101\nTgid:\t100\n'
          if (path === '/proc/100/status')
            return 'Pid:\t100\nTgid:\t100\nUid:\t999 999 999 999\n'
          if (path === '/proc/100/stat' || path === '/proc/101/stat')
            return `${path.includes('/100/') ? '100 (leader) Z' : '101 (task) S'} ${Array(18).fill('0').join(' ')} 123 0\n`
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    const links = spyOn(fs, 'readlinkSync').mockImplementation(
      new Proxy(originalLink, {
        apply(target, receiver, args: unknown[]) {
          if (String(args[0]) === '/proc/100/ns/pid') {
            injected++
            throw Object.assign(new Error('modeled namespace ENOENT'), {
              code: 'ENOENT',
            })
          }
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    const directories = spyOn(fs, 'readdirSync').mockImplementation(
      new Proxy(originalDirectory, {
        apply(target, receiver, args: unknown[]) {
          return String(args[0]) === '/proc'
            ? ['100']
            : Reflect.apply(target, receiver, args)
        },
      }),
    )
    const launch = spyOn(childProcess, 'spawn').mockImplementation(() => {
      launches++
      throw new Error('modeled launch trap')
    })
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      signals++
      return true
    })
    try {
      let reason: string | undefined
      try {
        scopedProcesses(summary, true, { deadline: performance.now() + 3000 })
      } catch (error) {
        reason = (error as Error).message
      }
      expect(reason).toBe(
        'UNKNOWN extant thread group 100 has a dead or unqualifiable leader: Error: UNKNOWN partial identity for thread group 100: Error: modeled namespace ENOENT',
      )
      expect(injected).toBe(1)
      expect(launches).toBe(0)
      expect(signals).toBe(0)
    } finally {
      signal.mockRestore()
      launch.mockRestore()
      directories.mockRestore()
      links.mockRestore()
      reads.mockRestore()
    }
  })
  test('admission task diagnostic retains first identities without changing the exact refusal', () => {
    const model = modeledAdmissionTasks(
      [
        { tid: 101, tgid: 100 },
        { tid: 102, tgid: process.pid },
        { tid: 103, tgid: 300 },
      ],
      [
        { tid: 102, tgid: process.pid },
        { tid: 103, tgid: 300 },
        { tid: 104, tgid: 300 },
      ],
    )
    const { summary } = model
    const original = model.read
    const lines: string[] = []
    let vanishedReads = 0
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          const match = /^\/proc\/(10[1-4])\/(status|stat)$/.exec(path)
          if (match) {
            const tid = Number(match[1])
            if (tid === 101 && ++vanishedReads > 2)
              throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
            return match[2] === 'status'
              ? `Pid:\t${tid}\nTgid:\t${tid === 101 ? 100 : tid === 102 ? process.pid : 300}\n`
              : `${tid} (task) S ${Array(18).fill('0').join(' ')} ${tid * 10} 0\n`
          }
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    try {
      const refusal = () => {
        let message: string | undefined
        try {
          threadGroupHasLiveTasks(100, summary)
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).toBe(
          'UNKNOWN cgroup task inventory changed during admission',
        )
      }
      refusal()
      expect(lines).toEqual([])
      model.reset()
      vanishedReads = 0
      const stop = enableNativeTaskDiagnostic({
        runnerPid: process.pid,
        actorPids: () => [100],
        emit: (line) => {
          lines.push(line)
        },
      })
      try {
        refusal()
      } finally {
        stop()
      }
      expect(vanishedReads).toBe(2)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!.split('=')[1]!)).toEqual({
        before: [101, 102, 103],
        after: [102, 103, 104],
        tasks: [
          { tid: 101, tgid: 100, start: '1010', state: 'S', group: 'actor' },
          {
            tid: 102,
            tgid: process.pid,
            start: '1020',
            state: 'S',
            group: 'runner',
          },
          { tid: 103, tgid: 300, start: '1030', state: 'S', group: 'unknown' },
          { tid: 104, tgid: 300, start: '1040', state: 'S', group: 'unknown' },
        ],
      })
      model.reset()
      vanishedReads = 0
      const stopThrowing = enableNativeTaskDiagnostic({
        runnerPid: process.pid,
        actorPids: () => [],
        emit: () => {
          throw new Error('diagnostic sink failed')
        },
      })
      try {
        refusal()
      } finally {
        stopThrowing()
      }
      model.reset()
      vanishedReads = 0
      const stopUnknownActors = enableNativeTaskDiagnostic({
        runnerPid: process.pid,
        actorPids: () => {
          throw new Error('actor fixture unavailable')
        },
        emit: (line) => {
          lines.push(line)
        },
      })
      try {
        refusal()
      } finally {
        stopUnknownActors()
      }
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[1]!.split('=')[1]!).tasks[0].group).toBe(
        'unknown',
      )
    } finally {
      reads.mockRestore()
      model.restore()
    }
  })
  for (const control of [
    'duplicate inventory',
    'listed unavailable task',
    'admission turnover',
  ] as const)
    test(`source-modeled ${control} refuses unresolved task coverage in the real helper`, () => {
      const model = modeledAdmissionTasks(
        [{ tid: 101, tgid: 100 }],
        control === 'admission turnover'
          ? [{ tid: 102, tgid: 200 }]
          : [{ tid: 101, tgid: 100 }],
      )
      const { summary } = model
      const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
      const read = model.read
      let inventories = 0
      let taskReads = 0
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args: unknown[]) {
            const path = String(args[0])
            if (path === threads) {
              inventories++
              return control === 'duplicate inventory'
                ? '101\n101\n'
                : Reflect.apply(target, receiver, args)
            }
            if (path === '/proc/101/status') {
              taskReads++
              if (control === 'listed unavailable task')
                throw Object.assign(
                  new Error('modeled listed task unavailable'),
                  { code: 'ENOENT' },
                )
              return 'Pid:\t101\nTgid:\t100\n'
            }
            if (path === '/proc/101/stat') return '101 (terminal-model) Z 0\n'
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      try {
        const expected = {
          'duplicate inventory': 'UNKNOWN ambiguous cgroup task inventory',
          'listed unavailable task':
            'UNKNOWN listed cgroup task has unavailable identity',
          'admission turnover':
            'UNKNOWN cgroup task inventory changed during admission',
        }[control]
        expect(() => threadGroupHasLiveTasks(100, summary)).toThrow(expected)
        expect(inventories).toBe(control === 'duplicate inventory' ? 1 : 2)
        expect(taskReads).toBe(control === 'duplicate inventory' ? 0 : 1)
      } finally {
        reads.mockRestore()
        model.restore()
      }
    })
  test('source-modeled replacement task is inspected by the real group helper', () => {
    const summary = nativeBoundarySummary()
    const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
    const original = fs.readFileSync
    const paths: string[] = []
    let inventories = 0
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          paths.push(path)
          if (path === threads) return ++inventories === 1 ? '101\n' : '102\n'
          if (path === '/proc/101/status')
            throw Object.assign(new Error('modeled old task exited'), {
              code: 'ENOENT',
            })
          if (path === '/proc/102/status') return 'Pid:\t102\nTgid:\t100\n'
          if (path === '/proc/102/stat') return '102 (replacement-model) S 0\n'
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    try {
      expect(
        threadGroupHasLiveTasks(100, summary, {
          deadline: performance.now() + 3000,
        }),
      ).toBe(true)
      expect(inventories).toBe(3)
      expect(paths).toContain('/proc/101/status')
      expect(paths).toContain('/proc/102/status')
      expect(paths).toContain('/proc/102/stat')
    } finally {
      reads.mockRestore()
    }
  })
  test('source-modeled task turnover exhausts the original budget instead of certifying absence', () => {
    const summary = nativeBoundarySummary()
    const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
    const original = fs.readFileSync
    let elapsed = 0
    let inventories = 0
    let taskReads = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => elapsed)
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          if (path === threads) {
            elapsed += 1000
            return `${100 + ++inventories}\n`
          }
          if (/^\/proc\/10\d\/status$/.test(path)) {
            taskReads++
            throw Object.assign(new Error('modeled task turnover'), {
              code: 'ENOENT',
            })
          }
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    try {
      expect(() =>
        threadGroupHasLiveTasks(100, summary, { deadline: 3000 }),
      ).toThrow('native cleanup budget exhausted')
      expect(inventories).toBe(3)
      expect(taskReads).toBe(2)
    } finally {
      reads.mockRestore()
      clock.mockRestore()
    }
  })
  test('source-modeled stable terminal task inventory certifies only finished groups', () => {
    const model = modeledAdmissionTasks([{ tid: 101, tgid: 100 }])
    const { summary } = model
    const threads = `/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`
    const original = model.read
    let inventories = 0
    let terminalReads = 0
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          if (path === threads) {
            inventories++
            return '101\n'
          }
          if (path === '/proc/101/status') return 'Pid:\t101\nTgid:\t100\n'
          if (path === '/proc/101/stat') {
            terminalReads++
            return '101 (terminal-model) Z 0\n'
          }
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    try {
      expect(threadGroupHasLiveTasks(100, summary)).toBe(false)
      expect(inventories).toBe(2)
      expect(terminalReads).toBe(2)
    } finally {
      reads.mockRestore()
      model.restore()
    }
  })
  test('source-modeled task discovery refuses a live group omitted from both leader inventories without signaling a TID', () => {
    const summary = nativeBoundarySummary()
    const cgroup = `/sys/fs/cgroup${summary.cgroup.self}`
    const original = fs.readFileSync
    const originalReadDirectory = fs.readdirSync
    const paths: string[] = []
    let signals = 0
    const reads = spyOn(fs, 'readFileSync').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const path = String(args[0])
          paths.push(path)
          if (path === `${cgroup}/cgroup.procs`) return '99\n'
          if (path === `${cgroup}/cgroup.threads`) return '102\n'
          if (path === '/proc/102/status') return 'Pid:\t102\nTgid:\t100\n'
          if (path === '/proc/102/stat') return '102 (hidden-group-model) S 0\n'
          if (path === '/proc/100/stat' || path === '/proc/99/stat')
            throw Object.assign(new Error('modeled absent leader'), {
              code: 'ENOENT',
            })
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    const directories = spyOn(fs, 'readdirSync').mockImplementation(
      observeBuiltin(originalReadDirectory, (value, args) =>
        String(args[0]) === '/proc' ? [] : value,
      ),
    )
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      signals++
      return true
    })
    try {
      expect(() => scopedProcesses(summary)).toThrow(
        'UNKNOWN extant thread group 100',
      )
      expect(paths).toContain('/proc/100/stat')
      expect(paths).toContain('/proc/102/status')
      expect(signals).toBe(0)
    } finally {
      signal.mockRestore()
      directories.mockRestore()
      reads.mockRestore()
    }
  })
  motorTest(
    CLEANUP_GROUP,
    'terminal zombie snapshot without live kernel tasks remains finished',
    async () => {
      const scope = qualifyNativeProcessScope()
      const original = fs.readFileSync
      const terminalPid = 2147483647
      let terminalReads = 0
      const fields = ['Z', ...Array(18).fill('0'), '1', '0', '0']
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        new Proxy(original, {
          apply(target, receiver, args: unknown[]) {
            if (String(args[0]) === `/proc/${terminalPid}/stat`) {
              terminalReads++
              return `${terminalPid} (finished-zombie-control) ${fields.join(' ')}\n`
            }
            const value: unknown = Reflect.apply(target, receiver, args)
            return String(args[0]) ===
              `/sys/fs/cgroup${scope.summary.cgroup.self}/cgroup.procs` &&
              typeof value === 'string'
              ? `${value.trim()}\n${terminalPid}\n`
              : value
          },
        }),
      )
      let dispatches = 0
      const spawnTrap = spyOn(childProcess, 'spawn').mockImplementation(() => {
        dispatches++
        throw new Error('finished group empty-command control')
      })
      try {
        const result = await runNativeCommand(scope, '/bin/true', [], {
          cwd: '/tmp',
          env: { PATH: '/usr/bin:/bin' },
          timeoutMs: 100,
        })
        expect(terminalReads).toBeGreaterThan(0)
        expect(dispatches).toBe(1)
        expect(result.spawnError).toContain(
          'finished group empty-command control',
        )
        expect(result.cleanup.outcome).toBe('clean')
        expect(result.cleanup.signaled).toBe(0)
        expect(result.cleanup.survivors).toEqual([])
        console.log(
          'TERMINAL_GROUP_CONTROL=source-backed terminal snapshot and real protected task inventory; no actor spawned',
        )
      } finally {
        spawnTrap.mockRestore()
        reads.mockRestore()
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'runner recheck hashes kernel-bound bytes and refuses a replaced path',
    () => {
      qualifyNativeProcessScope()
      const binding = observeNativeRunner()
      const originalRead = fs.readFileSync
      const originalStat = fs.statSync
      let pathnameReads = 0
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        new Proxy(originalRead, {
          apply(target, receiver, args: unknown[]) {
            if (String(args[0]) === binding.path) {
              pathnameReads++
              throw new Error('mutable pathname hash trap')
            }
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      let stats: ReturnType<typeof spyOn<typeof fs, 'statSync'>> | undefined
      try {
        expect(() => assertNativeRunnerUnchanged(binding)).not.toThrow()
        expect(pathnameReads).toBe(0)
        stats = spyOn(fs, 'statSync').mockImplementation(
          observeBuiltin(originalStat, (value, args) => {
            if (
              String(args[0]) !== binding.path ||
              !value ||
              typeof value !== 'object' ||
              !('ino' in value)
            )
              return value
            const changed: object = Object.create(value)
            Object.defineProperty(changed, 'ino', {
              value:
                typeof value.ino === 'bigint'
                  ? value.ino + 1n
                  : Number(value.ino) + 1,
            })
            return changed
          }),
        )
        let dispatches = 0
        expect(() => {
          assertNativeRunnerUnchanged(binding)
          dispatches++
        }).toThrow('running executable inode mismatch')
        expect(dispatches).toBe(0)
      } finally {
        stats?.mockRestore()
        reads.mockRestore()
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'running runner inode mismatch refuses before dispatch',
    () => {
      qualifyNativeProcessScope()
      const path = fs.realpathSync(process.execPath)
      const original = fs.statSync
      let dispatches = 0
      const stats = spyOn(fs, 'statSync').mockImplementation(
        observeBuiltin(original, (value, args) => {
          if (
            String(args[0]) !== path ||
            !value ||
            typeof value !== 'object' ||
            !('ino' in value)
          )
            return value
          const changed: object = Object.create(value)
          const inode = value.ino
          if (typeof inode !== 'bigint' && typeof inode !== 'number')
            throw new Error('bad runner inode fixture')
          Object.defineProperty(changed, 'ino', {
            value: typeof inode === 'bigint' ? inode + 1n : inode + 1,
          })
          return changed
        }),
      )
      try {
        expect(() => {
          observeNativeRunner()
          dispatches++
        }).toThrow('running executable inode mismatch')
        expect(dispatches).toBe(0)
      } finally {
        stats.mockRestore()
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'genuinely exited groups remain clean with zero cleanup signals',
    async () => {
      const scope = qualifyNativeProcessScope()
      // This control measures natural exit, not command timeout accuracy.
      const timerControl = heldNativeTimer()
      const result = await runNativeCommand(scope, '/bin/true', [], {
        cwd: '/tmp',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 100,
        testTimers: timerControl.timers,
      })
      expect(result.code).toBe(0)
      expect(result.timedOut).toBe(false)
      timerControl.assertCompleted(0)
      expect(result.cleanup.outcome).toBe('clean')
      expect(result.cleanup.signaled).toBe(0)
      expect(result.cleanup.survivors).toEqual([])
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'partial identity ENOENT is unknown while a real group remains live',
    async () => {
      const scope = qualifyNativeProcessScope()
      const root = mkdtempSync(join(tmpdir(), 'ga-native-partial-identity-'))
      const script = inertProgram(root)
      const child = spawn(process.execPath, [script, 'preexisting', root], {
        cwd: root,
        env: nativeHostEnv(root, {}),
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      })
      retainStartedInertChild(child)
      let timer: ReturnType<typeof setTimeout> | undefined
      let links: ReturnType<typeof spyOn<typeof fs, 'readlinkSync'>> | undefined
      let launchTrap:
        | ReturnType<typeof spyOn<typeof childProcess, 'spawn'>>
        | undefined
      const errors: unknown[] = []
      try {
        const readinessDeadline = performance.now() + 500
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            child.stdio[3]!.once('data', () => resolve())
            child.once('error', reject)
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reportInertOracle(
                readinessDeadline,
                join(root, 'preexisting.json'),
              )
              reject(new Error('partial identity fixture did not become ready'))
            }, 500)
          }),
        ])
        const identity = readInertIdentity(join(root, 'preexisting.json'), true)
        if (!identity)
          throw new Error(
            `missing ready actor fixture ${join(root, 'preexisting.json')}`,
          )
        const original = fs.readlinkSync
        let observedENOENT = 0
        let dispatches = 0
        links = spyOn(fs, 'readlinkSync').mockImplementation(
          new Proxy(original, {
            apply(target, receiver, args: unknown[]) {
              if (String(args[0]) === `/proc/${identity.pid}/ns/pid`) {
                observedENOENT++
                throw Object.assign(
                  new Error('source-backed partial identity ENOENT control'),
                  { code: 'ENOENT' },
                )
              }
              return Reflect.apply(target, receiver, args)
            },
          }),
        )
        launchTrap = spyOn(childProcess, 'spawn').mockImplementation(() => {
          dispatches++
          throw new Error('partial identity launch trap')
        })
        await expect(
          runNativeCommand(scope, '/bin/true', [], {
            cwd: root,
            env: nativeHostEnv(root, {}),
            timeoutMs: 100,
          }),
        ).rejects.toThrow('UNKNOWN extant thread group')
        expect(observedENOENT).toBeGreaterThan(0)
        expect(dispatches).toBe(0)
        expect(inertAlive(identity)).toBe(true)
        expect(await inertListener(identity.port)).toBe(true)
        console.log(
          'PARTIAL_IDENTITY_ENOENT_CONTROL=source-backed injected error; not the real Z-leader witness',
        )
      } catch (error) {
        errors.push(error)
      } finally {
        await finishInertTest(errors, [
          () => {
            launchTrap?.mockRestore()
            links?.mockRestore()
            if (timer) clearTimeout(timer)
          },
          () => finallyReapInert(root),
          () => {
            child.stdio[3]?.destroy()
          },
          () => rmSync(root, { recursive: true, force: true }),
        ])
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'cleanup budget expiry during an empty scan forbids a final rescan',
    async () => {
      const scope = qualifyNativeProcessScope()
      const originalNow = performance.now.bind(performance)
      const originalReadDirectory = fs.readdirSync
      let offset = 0
      let crossed = false
      let commandStarted = false
      let scansAfterExpiry = 0
      const clock = spyOn(performance, 'now').mockImplementation(
        () => originalNow() + offset,
      )
      const scans = spyOn(fs, 'readdirSync').mockImplementation(
        observeBuiltin(originalReadDirectory, (value, args) => {
          if (String(args[0]) === '/proc' && commandStarted) {
            if (crossed) scansAfterExpiry++
            else {
              crossed = true
              offset = 4000
            }
          }
          return value
        }),
      )
      const spawnTrap = spyOn(childProcess, 'spawn').mockImplementation(() => {
        commandStarted = true
        throw new Error('inert controlled empty command')
      })
      const pending = runNativeCommand(scope, '/bin/true', [], {
        cwd: '/tmp',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 100,
      })
      let oracle: ReturnType<typeof setTimeout> | undefined
      try {
        const completionDeadline = performance.now() + 500
        const observed = await Promise.race([
          pending.then((result) => ({ result })),
          new Promise<{ expired: true }>((resolve) => {
            oracle = setTimeout(() => resolve({ expired: true }), 500)
          }),
        ])
        if (!('result' in observed)) reportInertOracle(completionDeadline)
        expect('result' in observed).toBe(true)
        if (!('result' in observed))
          throw new Error(
            'budget cleanup did not finish within independent oracle',
          )
        expect(crossed).toBe(true)
        expect(scansAfterExpiry).toBe(0)
        expect(observed.result.cleanup.signaled).toBe(0)
        expect(observed.result.spawnError).toContain(
          'inert controlled empty command',
        )
        expect(observed.result.cleanup.outcome).toBe('failed')
        expect(observed.result.cleanup.survivors).toBeNull()
        expect(observed.result.cleanup.failures.join('\n')).toContain(
          'budget exhausted',
        )
      } finally {
        spawnTrap.mockRestore()
        scans.mockRestore()
        clock.mockRestore()
        if (oracle) clearTimeout(oracle)
        await pending.catch(() => undefined)
      }
    },
  )
  for (const phase of [
    'signal requalification',
    'target identity read',
    'final scoped check',
  ] as const)
    motorTest(
      CLEANUP_GROUP,
      `actor-free budget expiry during ${phase} forbids subsequent reads and signals`,
      async () => {
        const scope = qualifyNativeProcessScope()
        // The modeled survivor belongs to the qualified job user, whatever its uid.
        const jobUid = scope.summary.controller.uid
        const read = fs.readFileSync
        const readdir = fs.readdirSync
        const readlink = fs.readlinkSync
        const now = performance.now.bind(performance)
        const modeledPid = 2147483647
        const modeledStat = `${modeledPid} (actor-free-budget-model) ${['S', '1', String(modeledPid), String(modeledPid), ...Array(15).fill('0'), '9223372036854775807', '0'].join(' ')}\n`
        const group = `/sys/fs/cgroup${scope.summary.cgroup.self}/cgroup.procs`
        let started = false
        let reached = false
        let elapsed = 0
        let modelReads = 0
        let scans = 0
        let readsAfterExpiry = 0
        let launches = 0
        let signals = 0
        const clock = spyOn(performance, 'now').mockImplementation(
          () => now() + elapsed,
        )
        const expire = () => {
          reached = true
          elapsed = 4000
        }
        const observeAfterExpiry = (path: string) => {
          if (
            reached &&
            (path.startsWith('/proc') || path.startsWith('/sys/fs/cgroup'))
          )
            readsAfterExpiry++
        }
        const reads = spyOn(fs, 'readFileSync').mockImplementation(
          new Proxy(read, {
            apply(target, receiver, args: unknown[]) {
              const path = String(args[0])
              observeAfterExpiry(path)
              if (started && phase !== 'final scoped check') {
                if (path === `/proc/${modeledPid}/stat`) {
                  modelReads++
                  if (phase === 'target identity read' && modelReads === 2)
                    expire()
                  return modeledStat
                }
                if (path === `/proc/${modeledPid}/status`)
                  return `Pid:\t${modeledPid}\nTgid:\t${modeledPid}\nUid:\t${jobUid}\t${jobUid}\t${jobUid}\t${jobUid}\n`
                if (path === `/proc/${modeledPid}/cgroup`)
                  return `0::${scope.summary.cgroup.self}\n`
              }
              const value: unknown = Reflect.apply(target, receiver, args)
              if (
                started &&
                phase === 'signal requalification' &&
                modelReads === 1 &&
                path === `/proc/${process.pid}/stat`
              )
                expire()
              return started &&
                phase !== 'final scoped check' &&
                path === group &&
                typeof value === 'string'
                ? `${value.trim()}\n${modeledPid}\n`
                : value
            },
          }),
        )
        const directories = spyOn(fs, 'readdirSync').mockImplementation(
          observeBuiltin(readdir, (value, args) => {
            const path = String(args[0])
            observeAfterExpiry(path)
            if (started && path === '/proc') {
              scans++
              if (phase === 'final scoped check' && scans === 2) expire()
              if (phase !== 'final scoped check' && Array.isArray(value))
                return [...value, String(modeledPid)]
            }
            return value
          }),
        )
        const links = spyOn(fs, 'readlinkSync').mockImplementation(
          new Proxy(readlink, {
            apply(target, receiver, args: unknown[]) {
              const path = String(args[0])
              observeAfterExpiry(path)
              if (started && path === `/proc/${modeledPid}/ns/pid`)
                return scope.summary.namespace.self
              return Reflect.apply(target, receiver, args)
            },
          }),
        )
        const launch = spyOn(childProcess, 'spawn').mockImplementation(() => {
          launches++
          started = true
          throw new Error('actor-free budget phase spawn trap')
        })
        const signal = spyOn(process, 'kill').mockImplementation(() => {
          signals++
          return true
        })
        try {
          const result = await runNativeCommand(scope, '/bin/true', [], {
            cwd: '/tmp',
            env: { PATH: '/usr/bin:/bin' },
            timeoutMs: 100,
          })
          expect(launches).toBe(1)
          expect(reached).toBe(true)
          expect(scans).toBe(phase === 'final scoped check' ? 2 : 1)
          expect(modelReads).toBe(
            phase === 'target identity read'
              ? 2
              : phase === 'signal requalification'
                ? 1
                : 0,
          )
          expect(readsAfterExpiry).toBe(0)
          expect(signals).toBe(0)
          expect(result.spawnError).toContain(
            'actor-free budget phase spawn trap',
          )
          expect(result.cleanup.signaled).toBe(0)
          expect(result.cleanup.outcome).toBe('failed')
          expect(result.cleanup.survivors).toBeNull()
          expect(result.cleanup.failures.join('\n')).toContain(
            'native cleanup budget exhausted',
          )
        } finally {
          signal.mockRestore()
          launch.mockRestore()
          links.mockRestore()
          directories.mockRestore()
          reads.mockRestore()
          clock.mockRestore()
        }
      },
    )
  motorTest(
    CLEANUP_GROUP,
    'extant thread group is unknown while its listener survives original-command close',
    async () => {
      const CHILD_CODE =
        "import ctypes, errno, json, os, select, socket, sys, threading, time\nroot, fd_text, expected_ns, expected_cgroup = sys.argv[1:5]\nready_fd = int(fd_text)\ntgid = os.getpid()\nready = threading.Event()\nstate = {}\n\n\ndef text(path):\n    with open(path) as stream:\n        return stream.read()\n\n\ndef stat_fields(tid):\n    raw = text('/proc/' + str(tid) + '/stat')\n    fields = raw[raw.rfind(')') + 2:].split()\n    return {'state': fields[0], 'birth': fields[19]}\n\n\ndef identity(tid):\n    status = dict(line.split(':', 1) for line in text('/proc/' + str(tid) + '/status').splitlines() if ':' in line)\n    return {'tid': tid, 'tgid': int(status['Tgid']), 'pid': int(status['Pid']),\n            'uids': [int(value) for value in status['Uid'].split()], **stat_fields(tid),\n            'namespace': os.readlink('/proc/' + str(tid) + '/ns/pid'),\n            'cgroup': text('/proc/' + str(tid) + '/cgroup').strip()}\n\n\ndef attempted(operation):\n    try:\n        return {'value': operation()}\n    except OSError as error:\n        return {'error': str(error), 'errno': error.errno}\n\n\ndef save(value):\n    temporary = root + '/thread-witness.tmp'\n    with open(temporary, 'w') as stream:\n        json.dump(value, stream)\n    os.replace(temporary, root + '/thread-witness.json')\n\n\ndef admitted(value):\n    return value['uids'] == [os.getuid()] * 4 and value['namespace'] == expected_ns and value['cgroup'] == '0::' + expected_cgroup\n\n\nassert sys.platform == 'linux' and os.uname().machine == 'x86_64'\nassert os.getuid() == os.geteuid() != 0\nleader_before = identity(tgid)\nassert admitted(leader_before)\nlibc = ctypes.CDLL(None, use_errno=True)\nthread_exit = libc.syscall\nthread_exit.argtypes = (ctypes.c_long, ctypes.c_long)\nthread_exit.restype = ctypes.c_long\n\n\ndef worker():\n    expiry = time.monotonic() + 0.250\n    listener = None\n    ready_open = True\n    exit_code = 74\n    witnessed = False\n    try:\n        tid = threading.get_native_id()\n        before = identity(tid)\n        assert tid != tgid and before['tgid'] == tgid and before['pid'] == tid and admitted(before)\n        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n        listener.setblocking(False)\n        listener.bind(('127.0.0.1', 0))\n        listener.listen(1)\n        state.update({'tid': tid, 'before': before, 'expiry': expiry, 'admitted': True})\n        save({'phase': 'worker-ready-before-transition', 'leaderBefore': leader_before,\n              'threadBefore': before, 'port': listener.getsockname()[1], 'expiry': expiry})\n        ready.set()\n        while time.monotonic() < expiry:\n            leader = attempted(lambda: stat_fields(tgid))\n            if 'error' in leader and leader.get('errno') not in [errno.ENOENT, errno.ESRCH]:\n                raise RuntimeError('FAILED WITNESS unexpected leader-stat read error: ' + repr(leader))\n            if not witnessed and (('error' in leader and leader.get('errno') in [errno.ENOENT, errno.ESRCH]) or leader.get('value', {}).get('state') in ['Z','X']):\n                after = identity(tid)\n                members = [int(value) for value in text('/sys/fs/cgroup' + expected_cgroup + '/cgroup.threads').split()]\n                assert after['tgid'] == tgid and after['pid'] == tid and after['birth'] == before['birth']\n                assert after['state'] not in ['Z','X'] and admitted(after) and tid in members\n                save({'phase': 'main-exited-live-thread', 'tgid': tgid, 'tid': tid,\n                      'leaderBefore': leader_before, 'threadBefore': before, 'threadAfter': after,\n                      'leaderStatAfter': leader,\n                      'leaderNamespaceAfter': attempted(lambda: os.readlink('/proc/' + str(tgid) + '/ns/pid')),\n                      'port': listener.getsockname()[1], 'expiry': expiry, 'observed': time.monotonic(),\n                      'threadInProtectedCgroupThreads': True})\n                os.write(ready_fd, b'R')\n                os.close(ready_fd)\n                ready_open = False\n                witnessed = True\n                exit_code = 0\n            remaining = expiry - time.monotonic()\n            if remaining <= 0:\n                break\n            readable, _, _ = select.select([listener], [], [], min(0.005, remaining))\n            if not readable:\n                continue\n            try:\n                connection, _ = listener.accept()\n            except BlockingIOError:\n                continue\n            connection.setblocking(False)\n            try:\n                pending = b'inert-listener'\n                while pending and time.monotonic() < expiry:\n                    try:\n                        count = connection.send(pending)\n                        if count <= 0:\n                            break\n                        pending = pending[count:]\n                    except BlockingIOError:\n                        remaining = expiry - time.monotonic()\n                        if remaining <= 0:\n                            break\n                        select.select([], [connection], [], min(0.005, remaining))\n                    except (BrokenPipeError, ConnectionResetError):\n                        break\n            finally:\n                connection.close()\n    except BaseException as error:\n        try:\n            save({'phase': 'witness-error', 'error': repr(error), 'state': state})\n        except BaseException:\n            pass\n    finally:\n        ready.set()\n        if ready_open:\n            try:\n                os.close(ready_fd)\n            except OSError:\n                pass\n        try:\n            if listener is not None:\n                listener.close()\n        finally:\n            os._exit(exit_code)\n\n\nthreading.Thread(target=worker, daemon=False).start()\nif not ready.wait(0.050) or state.get('admitted') is not True or time.monotonic() >= state['expiry']:\n    os._exit(75)\nthread_exit(ctypes.c_long(60), ctypes.c_long(0))\nos._exit(76)"
      const PARENT_CODE =
        "import json, math, os, re, select, socket, subprocess, sys, time\nchild_code, root, expected_ns, expected_cgroup = sys.argv[1:5]\nread_fd, write_fd = os.pipe()\nchild = subprocess.Popen(\n    [sys.executable, '-c', child_code, root, str(write_fd), expected_ns, expected_cgroup],\n    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n    close_fds=True, pass_fds=(write_fd,), start_new_session=True,\n)\nos.close(write_fd)\nwith open(root + '/parent-child.json', 'w') as stream:\n    json.dump({'childPid': child.pid}, stream)\ntry:\n    readable, _, _ = select.select([read_fd], [], [], 0.075)\n    if not readable or os.read(read_fd, 1) != b'R':\n        raise RuntimeError('thread transition readiness not reached')\nfinally:\n    os.close(read_fd)\nwith open(root + '/thread-witness.json') as stream:\n    witness = json.load(stream)\npositive_pid = lambda value: type(value) is int and 1 < value < 2147483648\nassert witness['phase'] == 'main-exited-live-thread'\ntid, tgid, port = witness['tid'], witness['tgid'], witness['port']\nassert positive_pid(tid) and positive_pid(tgid) and tid != tgid and tgid == child.pid\nassert type(port) is int and 0 < port < 65536\nassert isinstance(witness['threadBefore']['birth'], str) and re.fullmatch('[0-9]+', witness['threadBefore']['birth'])\nexpiry = witness['expiry']\nassert type(expiry) in [int, float] and math.isfinite(expiry) and time.monotonic() < expiry\nwith open('/proc/' + str(tid) + '/status') as stream:\n    status = dict(line.split(':', 1) for line in stream.read().splitlines() if ':' in line)\nassert int(status['Tgid']) == tgid and int(status['Pid']) == tid\nassert [int(value) for value in status['Uid'].split()] == [os.getuid()] * 4\nassert os.readlink('/proc/' + str(tid) + '/ns/pid') == expected_ns\nwith open('/proc/' + str(tid) + '/cgroup') as stream:\n    assert stream.read().strip() == '0::' + expected_cgroup\nwith open('/proc/' + str(tid) + '/stat') as stream:\n    stat = stream.read()\nfields = stat[stat.rfind(')') + 2:].split()\nassert fields[0] not in ['Z','X'] and fields[19] == witness['threadBefore']['birth']\nwith open('/sys/fs/cgroup' + expected_cgroup + '/cgroup.threads') as stream:\n    assert tid in [int(value) for value in stream.read().split()]\npeer_deadline = min(expiry, time.monotonic() + 0.025)\nremaining = peer_deadline - time.monotonic()\nassert remaining > 0\nwith socket.create_connection(('127.0.0.1', port), timeout=remaining) as connection:\n    expected_response = b'inert-listener'\n    received = b''\n    while len(received) < len(expected_response):\n        remaining = peer_deadline - time.monotonic()\n        assert remaining > 0\n        connection.settimeout(remaining)\n        chunk = connection.recv(len(expected_response) - len(received))\n        if not chunk:\n            raise RuntimeError('FAILED WITNESS EOF before complete listener response')\n        received += chunk\n        assert received == expected_response[:len(received)]\n    assert received == expected_response\nwith open(root + '/parent-proof.json', 'w') as stream:\n    json.dump({'childPid': child.pid, 'tgid': tgid, 'tid': tid, 'birth': fields[19],\n               'port': port, 'checkedAt': time.monotonic(), 'expiry': expiry}, stream)\n# G has no P stdout/stderr and has closed the only private readiness writer.\nos._exit(0)"
      const scope = qualifyNativeProcessScope()
      const root = mkdtempSync(join(tmpdir(), 'ga-native-thread-group-'))
      const oracleEnd = performance.now() + 500
      let primary: unknown
      const cleanupErrors: unknown[] = []
      let settled = false
      let oracle: ReturnType<typeof setTimeout> | undefined
      let cleanupCertified = false
      let owned:
        | {
            tgid: number
            tid: number
            birth: string
            port: number
            group: InertIdentity
          }
        | undefined
      // The parent must publish its witness and exit naturally before cleanup.
      const timerControl = heldNativeTimer()
      const pending = runNativeCommand(
        scope,
        '/usr/bin/python3',
        [
          '-c',
          PARENT_CODE,
          CHILD_CODE,
          root,
          scope.summary.namespace.self,
          scope.summary.cgroup.self,
        ],
        {
          cwd: root,
          env: nativeHostEnv(root, {}),
          timeoutMs: 100,
          testTimers: timerControl.timers,
        },
      ).then(
        (result) => {
          settled = true
          return { result }
        },
        (error: unknown) => {
          settled = true
          return { error }
        },
      )
      const validPid = (value: unknown): value is number =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 1 &&
        value < 2147483648
      const load = () => {
        const witness = JSON.parse(
          readFileSync(join(root, 'thread-witness.json'), 'utf8'),
        )
        const parent = JSON.parse(
          readFileSync(join(root, 'parent-child.json'), 'utf8'),
        )
        const tgid = witness.tgid ?? witness.leaderBefore?.tgid
        const tid = witness.tid ?? witness.threadBefore?.tid
        const birth = witness.threadBefore?.birth
        const port = witness.port
        if (
          !validPid(parent.childPid) ||
          !validPid(tgid) ||
          !validPid(tid) ||
          tgid !== parent.childPid ||
          tgid === tid ||
          tid === process.pid ||
          tgid === process.pid ||
          typeof birth !== 'string' ||
          !/^\d+$/.test(birth) ||
          typeof witness.leaderBefore?.birth !== 'string' ||
          !/^\d+$/.test(witness.leaderBefore.birth) ||
          typeof port !== 'number' ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65535
        )
          throw new Error('UNKNOWN malformed/missing owned thread identity')
        const group: InertIdentity = {
          pid: tgid,
          start: witness.leaderBefore.birth,
          pgid: tgid,
          sid: tgid,
          namespace: scope.summary.namespace.self,
          cgroup: `0::${scope.summary.cgroup.self}\n`,
        }
        return { witness, identity: { tgid, tid, birth, port, group } }
      }
      const witnessIdentities = (): InertIdentity[] => {
        try {
          return [load().identity.group]
        } catch {
          return []
        }
      }
      const direct = (tid: number) => {
        try {
          const raw = readFileSync(`/proc/${tid}/stat`, 'utf8')
          const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
          const status = Object.fromEntries(
            readFileSync(`/proc/${tid}/status`, 'utf8')
              .split('\n')
              .filter((line) => line.includes(':'))
              .map((line) => {
                const at = line.indexOf(':')
                return [line.slice(0, at), line.slice(at + 1).trim()]
              }),
          )
          return {
            state: fields[0],
            birth: fields[19],
            tgid: Number(status.Tgid),
            pid: Number(status.Pid),
            uids: (status.Uid ?? '').split(/\s+/).map(Number),
            namespace: readlinkSync(`/proc/${tid}/ns/pid`),
            cgroup: readFileSync(`/proc/${tid}/cgroup`, 'utf8').trim(),
          }
        } catch (error) {
          if (
            ['ENOENT', 'ESRCH'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            return undefined
          throw error
        }
      }
      const members = () =>
        readFileSync(
          `/sys/fs/cgroup${scope.summary.cgroup.self}/cgroup.threads`,
          'utf8',
        )
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
      const listener = (port: number): Promise<'alive' | 'refused'> =>
        new Promise((resolve, reject) => {
          const deadline = Math.min(oracleEnd, performance.now() + 100)
          if (performance.now() >= deadline) {
            reject(
              new Error('UNKNOWN listener check beyond independent oracle'),
            )
            return
          }
          const expected = Buffer.from('inert-listener')
          let received = Buffer.alloc(0)
          let peer: ReturnType<typeof net.createConnection> | undefined
          let timer: ReturnType<typeof setTimeout> | undefined
          let finished = false
          const finish = (result: 'alive' | 'refused' | Error) => {
            if (finished) return
            finished = true
            if (timer) clearTimeout(timer)
            peer?.destroy()
            if (result instanceof Error) reject(result)
            else resolve(result)
          }
          timer = setTimeout(
            () =>
              finish(new Error('UNKNOWN listener absolute deadline exceeded')),
            Math.max(0, deadline - performance.now()),
          )
          try {
            peer = net.createConnection({ host: '127.0.0.1', port })
            peer.on('data', (chunk: Buffer) => {
              if (finished) return
              if (performance.now() >= deadline) {
                finish(new Error('UNKNOWN listener data after deadline'))
                return
              }
              if (received.length + chunk.length > expected.length) {
                finish(new Error('unexpected listener bytes'))
                return
              }
              received = Buffer.concat([received, chunk])
              if (!received.equals(expected.subarray(0, received.length))) {
                finish(new Error('unexpected listener bytes'))
                return
              }
              if (received.length === expected.length) finish('alive')
            })
            peer.once('error', (error: NodeJS.ErrnoException) => {
              if (performance.now() >= deadline) {
                finish(new Error('UNKNOWN listener error after deadline'))
              } else if (error.code === 'ECONNREFUSED') {
                finish('refused')
              } else {
                finish(error)
              }
            })
            peer.once('end', () =>
              finish(
                new Error('UNKNOWN listener EOF before complete response'),
              ),
            )
            peer.once('close', () =>
              finish(
                new Error('UNKNOWN listener closed before complete response'),
              ),
            )
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        })
      try {
        const observed = await Promise.race([
          pending,
          new Promise<{ expired: true }>((resolve) => {
            oracle = setTimeout(
              () => resolve({ expired: true }),
              Math.max(0, oracleEnd - performance.now()),
            )
          }),
        ])
        if ('error' in observed) throw observed.error
        if (!('result' in observed))
          reportInertOracle(oracleEnd, undefined, witnessIdentities)
        if (!('result' in observed))
          throw new Error('FAILED WITNESS command result not reached')
        const loaded = load()
        owned = loaded.identity
        const { witness } = loaded
        expect(witness.phase).toBe('main-exited-live-thread')
        const parentProof = JSON.parse(
          readFileSync(join(root, 'parent-proof.json'), 'utf8'),
        )
        expect(parentProof.childPid).toBe(owned.tgid)
        expect(parentProof.tid).toBe(owned.tid)
        expect(parentProof.birth).toBe(owned.birth)
        const task = direct(owned.tid)
        expect(task).toBeDefined()
        expect(task?.state === 'Z' || task?.state === 'X').toBe(false)
        expect(task?.birth).toBe(owned.birth)
        expect(task?.tgid).toBe(owned.tgid)
        expect(task?.pid).toBe(owned.tid)
        expect(task?.uids).toEqual(Array(4).fill(scope.summary.controller.uid))
        expect(task?.namespace).toBe(scope.summary.namespace.self)
        expect(task?.cgroup).toBe(`0::${scope.summary.cgroup.self}`)
        expect(members()).toContain(owned.tid)
        expect(
          (witness.leaderStatAfter.error !== undefined &&
            [2, 3].includes(witness.leaderStatAfter.errno)) ||
            ['Z', 'X'].includes(witness.leaderStatAfter.value?.state),
        ).toBe(true)
        expect(observed.result.code).toBe(0)
        expect(observed.result.signal).toBeNull()
        expect(observed.result.spawnError).toBeNull()
        expect(observed.result.timedOut).toBe(false)
        expect(observed.result.outputCapExceeded).toBe(false)
        timerControl.assertCompleted(0)
        expect(await listener(owned.port)).toBe('alive')
        console.log(
          `MAIN_EXITED_LIVE_THREAD_AT_COMMAND_RETURN=${JSON.stringify({ witness, task, result: observed.result })}`,
        )
        // Intended old-code red, only after the stronger state has actually been proven.
        expect(observed.result.cleanup.outcome).toBe('failed')
        expect(observed.result.cleanup.survivors).toBeNull()
        expect(observed.result.cleanup.signaled).toBe(0)
      } catch (error) {
        primary = error
      } finally {
        if (oracle) clearTimeout(oracle)
        if (!owned) {
          try {
            owned = load().identity
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        if (owned) {
          let absent = false
          try {
            while (performance.now() < oracleEnd) {
              const task = direct(owned.tid)
              const sameLive =
                task?.birth === owned.birth &&
                !['Z', 'X'].includes(task.state ?? '')
              if (
                !sameLive &&
                performance.now() < oracleEnd &&
                !members().includes(owned.tid)
              ) {
                absent = true
                break
              }
              await new Promise<void>((resolve) => setImmediate(resolve))
            }
          } catch (error) {
            cleanupErrors.push(error)
          }
          if (!absent) {
            reportInertOracle(oracleEnd, undefined, witnessIdentities)
            cleanupErrors.push(
              new Error(
                'UNKNOWN actor did not certify self-expiry within independent oracle',
              ),
            )
          }
          let listenerRefused = false
          try {
            if (performance.now() >= oracleEnd)
              cleanupErrors.push(
                new Error('UNKNOWN no remaining oracle for listener closure'),
              )
            else {
              listenerRefused = (await listener(owned.port)) === 'refused'
              if (!listenerRefused)
                cleanupErrors.push(
                  new Error('FAILED actor listener remains live'),
                )
            }
          } catch (error) {
            cleanupErrors.push(error)
          }
          try {
            await waitForInertDeparture(
              [owned.group],
              [],
              performance.now() + 500,
              inertDiagnostic(witnessIdentities),
            )
          } catch (error) {
            cleanupErrors.push(error)
          }
          cleanupCertified =
            absent && listenerRefused && settled && cleanupErrors.length === 0
        }
        if (!settled)
          cleanupErrors.push(
            new Error('UNKNOWN command settlement not certified'),
          )
        // No process or group signal exists in this finally.
        if (cleanupCertified && settled) {
          try {
            rmSync(root, { recursive: true, force: true })
          } catch (error) {
            cleanupErrors.push(error)
            cleanupCertified = false
          }
        }
        console.log(
          `SELF_EXPIRY_CLEANUP=${JSON.stringify({ owned, settled, cleanupCertified, primary: primary === undefined ? null : String(primary), cleanupErrors: cleanupErrors.map(String), root })}`,
        )
      }
      if (primary !== undefined && cleanupErrors.length)
        throw new AggregateError(
          [primary, ...cleanupErrors],
          'primary witness failure and independent cleanup failure',
        )
      if (primary !== undefined) throw primary
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          'independent cleanup UNKNOWN/FAILED; artifacts retained',
        )
    },
  )
  test('test-only profile selection is exact and cannot supply production authority', () => {
    expect(nativeTestProfile({})).toBe('portable')
    expect(
      nativeTestProfile({ GA_NATIVE_JOB_TEST_PROFILE: 'motor-inert' }),
    ).toBe('motor-inert')
    for (const value of ['', 'portable', 'motor-iner', 'MOTOR-INERT', '1'])
      expect(() =>
        nativeTestProfile({ GA_NATIVE_JOB_TEST_PROFILE: value }),
      ).toThrow('unknown GA_NATIVE_JOB_TEST_PROFILE')
    expect(
      readFileSync(join(HERE, 'measure-ga-proxy-matrix.ts'), 'utf8').includes(
        'GA_NATIVE_JOB_TEST_PROFILE',
      ),
    ).toBe(false)
    expect(
      nativeHostEnv('/tmp/native-test-profile', {}).GA_NATIVE_JOB_TEST_PROFILE,
    ).toBeUndefined()
    expect(() =>
      nativeHostEnv('/tmp/native-test-profile', {
        GA_NATIVE_JOB_TEST_PROFILE: 'motor-inert',
      }),
    ).toThrow()
  })
  test('unqualified serialized facts refuse before any portable launch or signal', async () => {
    const parsed = MatrixSchema.parse(nativeMatrix())
    if (parsed.profile !== 'native-job')
      throw new Error('wrong schema fixture profile')
    const forged = { summary: parsed.native.processBoundary }
    let launches = 0
    let signals = 0
    const launch = spyOn(childProcess, 'spawn').mockImplementation(() => {
      launches++
      throw new Error('portable launch trap')
    })
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      signals++
      return true
    })
    try {
      await expect(
        runNativeCommand(forged, '/bin/true', [], {
          cwd: '/tmp',
          env: {},
          timeoutMs: 100,
        }),
      ).rejects.toThrow('unqualified native process scope')
      expect(launches).toBe(0)
      expect(signals).toBe(0)
    } finally {
      signal.mockRestore()
      launch.mockRestore()
    }
  })
  for (const kind of [
    'pid1-mismatch',
    'controller-mismatch',
    'namespace-mismatch',
    'cgroup-mismatch',
    'psi-writable',
    'psi-rw-mount',
    'psi-shadow-mount',
    'psi-owner',
    'psi-substituted',
    'psi-symlink',
    'critical-owned',
    'memory-limit-owned',
    'pid-limit-owned',
    'other-pressure-owned',
    'executable-owned',
    'executable-writable',
    'control-writable',
  ] as const)
    motorTest(
      CLEANUP_GROUP,
      `initial qualification refuses ${kind} after an unmocked precondition`,
      () => {
        const unmocked = qualifyNativeProcessScope()
        expect(unmocked.summary.namespace.self).toBe(
          readlinkSync('/proc/self/ns/pid'),
        )
        // Job-owned fixtures use the qualified job user, whatever its uid is.
        const jobUid = unmocked.summary.controller.uid
        const read = fs.readFileSync
        const stat = fs.lstatSync
        const access = fs.accessSync
        const realpath = fs.realpathSync
        const readlink = fs.readlinkSync
        const cgroup = `/sys/fs/cgroup${read('/proc/self/cgroup', 'utf8').trim().split('::')[1]}`
        const pressure = `${cgroup}/memory.pressure`
        const executable = realpath('/proc/1/exe')
        const reached: string[] = []
        const expectedPath = {
          'pid1-mismatch': '/proc/1/status',
          'controller-mismatch': `/proc/${process.pid}/status`,
          'namespace-mismatch': '/proc/1/ns/pid',
          'cgroup-mismatch': '/proc/1/cgroup',
          'psi-writable': pressure,
          'psi-rw-mount': '/proc/self/mountinfo',
          'psi-shadow-mount': '/proc/self/mountinfo',
          'psi-owner': pressure,
          'psi-substituted': pressure,
          'psi-symlink': pressure,
          'critical-owned': `${cgroup}/cgroup.procs`,
          'memory-limit-owned': `${cgroup}/memory.max`,
          'pid-limit-owned': `${cgroup}/pids.max`,
          'other-pressure-owned': `${cgroup}/cpu.pressure`,
          'executable-owned': executable,
          'executable-writable': executable,
          'control-writable': `${cgroup}/cgroup.kill`,
        }[kind]
        const expectedRefusal = {
          'pid1-mismatch': 'missing protected PID1/controller identities:',
          'controller-mismatch':
            'missing protected PID1/controller identities:',
          'namespace-mismatch':
            'native cleanup requires the unprivileged Linux x64 MOTOR job (PID namespace differs from PID1)',
          'cgroup-mismatch': 'cgroup differs from PID1',
          'psi-writable': 'unexpected value true; expected false',
          'psi-rw-mount':
            'job-owned PSI observation requires a read-only mount',
          'psi-shadow-mount': `unexpected value ${pressure}; expected /sys/fs/cgroup`,
          'psi-owner': `unexpected value 1000; expected 0,${jobUid}`,
          'psi-substituted': 'aliased PSI observation path',
          'psi-symlink': `unprotected file: ${pressure}`,
          'critical-owned': `unprotected file ${expectedPath}: Error: unexpected value ${jobUid}; expected 0`,
          'memory-limit-owned': `unprotected file ${expectedPath}: Error: unexpected value ${jobUid}; expected 0`,
          'pid-limit-owned': `unprotected file ${expectedPath}: Error: unexpected value ${jobUid}; expected 0`,
          'other-pressure-owned': `unprotected file ${expectedPath}: Error: unexpected value ${jobUid}; expected 0`,
          'executable-owned': `unprotected file ${expectedPath}: Error: unexpected value ${jobUid}; expected 0`,
          'executable-writable': `unprotected file ${expectedPath}: Error: unexpected value true; expected false`,
          'control-writable': `unprotected file ${expectedPath}: Error: unexpected value true; expected false`,
        }[kind]
        let launches = 0
        let signals = 0
        const reads = spyOn(fs, 'readFileSync').mockImplementation(
          observeBuiltin(read, (value, args) => {
            const path = String(args[0])
            if (typeof value !== 'string') return value
            if (
              (kind === 'pid1-mismatch' && path === '/proc/1/status') ||
              (kind === 'controller-mismatch' &&
                path === `/proc/${process.pid}/status`)
            ) {
              reached.push(path)
              return value.replace(/^Uid:.*$/m, 'Uid:\t1000\t1000\t1000\t1000')
            }
            if (kind === 'cgroup-mismatch' && path === '/proc/1/cgroup') {
              reached.push(path)
              return '0::/motor.slice/motor-jobs.slice/motor-job-01234567-0123-4123-a123-0123456789ab.service\n'
            }
            if (
              kind === 'psi-shadow-mount' &&
              path === '/proc/self/mountinfo'
            ) {
              reached.push(path)
              return `${value}9999 1 0:1 / ${pressure} ro,nosuid,nodev - tmpfs tmpfs rw\n`
            }
            if (kind === 'psi-rw-mount' && path === '/proc/self/mountinfo')
              return value
                .split('\n')
                .map((line) => {
                  const [left, right] = line.split(' - ')
                  const fields = left?.split(' ') ?? []
                  if (fields[4] === '/sys/fs/cgroup') {
                    reached.push(path)
                    const flags = fields[5]
                    if (!flags) throw new Error('malformed fixture mount flags')
                    fields[5] = flags
                      .split(',')
                      .map((item) => (item === 'ro' ? 'rw' : item))
                      .join(',')
                    return `${fields.join(' ')} - ${right}`
                  }
                  return line
                })
                .join('\n')
            return value
          }),
        )
        const stats = spyOn(fs, 'lstatSync').mockImplementation(
          observeBuiltin(stat, (value, args) => {
            if (!value || typeof value !== 'object') return value
            const path = String(args[0])
            const changed: object = Object.create(value)
            const target =
              kind === 'critical-owned'
                ? `${cgroup}/cgroup.procs`
                : kind === 'memory-limit-owned'
                  ? `${cgroup}/memory.max`
                  : kind === 'pid-limit-owned'
                    ? `${cgroup}/pids.max`
                    : kind === 'other-pressure-owned'
                      ? `${cgroup}/cpu.pressure`
                      : kind === 'executable-owned'
                        ? executable
                        : ''
            if (path === target) {
              reached.push(path)
              Object.defineProperty(changed, 'uid', {
                value: fixtureUid(value, jobUid),
              })
            }
            if (path === pressure && kind === 'psi-owner') {
              reached.push(path)
              Object.defineProperty(changed, 'uid', {
                value: fixtureUid(value, 1000),
              })
            }
            if (
              path === pressure &&
              (kind === 'psi-writable' || kind === 'psi-rw-mount')
            )
              Object.defineProperty(changed, 'uid', {
                value: fixtureUid(value, jobUid),
              })
            if (path === pressure && kind === 'psi-symlink') {
              reached.push(path)
              Object.defineProperty(changed, 'isFile', { value: () => false })
            }
            return changed
          }),
        )
        const accesses = spyOn(fs, 'accessSync').mockImplementation(
          (...args: Parameters<typeof fs.accessSync>) => {
            const path = String(args[0])
            if (
              (kind === 'psi-writable' && path === pressure) ||
              (kind === 'executable-writable' && path === executable) ||
              (kind === 'control-writable' && path === `${cgroup}/cgroup.kill`)
            ) {
              reached.push(path)
              return
            }
            return access(...args)
          },
        )
        const realpaths = spyOn(fs, 'realpathSync').mockImplementation(
          observeBuiltin(realpath, (value, args) => {
            if (kind === 'psi-substituted' && String(args[0]) === pressure) {
              reached.push(pressure)
              return `${cgroup}/cgroup.events`
            }
            return value
          }),
        )
        const readlinks = spyOn(fs, 'readlinkSync').mockImplementation(
          observeBuiltin(readlink, (value, args) => {
            if (
              kind === 'namespace-mismatch' &&
              String(args[0]) === '/proc/1/ns/pid'
            ) {
              reached.push('/proc/1/ns/pid')
              return 'pid:[1]'
            }
            return value
          }),
        )
        const launchesSpy = spyOn(childProcess, 'spawn').mockImplementation(
          () => {
            launches++
            throw new Error('unqualified launch trap')
          },
        )
        const signalsSpy = spyOn(process, 'kill').mockImplementation(() => {
          signals++
          return true
        })
        try {
          let phase = 'initial-qualification'
          let refusal: unknown
          try {
            qualifyNativeProcessScope()
            phase = 'qualified'
          } catch (error) {
            refusal = error
          }
          expect(phase).toBe('initial-qualification')
          expect(reached.length).toBeGreaterThan(0)
          expect(new Set(reached)).toEqual(new Set([expectedPath]))
          expect(refusal).toBeInstanceOf(Error)
          if (!(refusal instanceof Error))
            throw new Error('missing intended qualification refusal')
          if (kind === 'pid1-mismatch' || kind === 'controller-mismatch') {
            const separator = refusal.message.indexOf(':')
            expect(refusal.message.slice(0, separator + 1)).toBe(
              expectedRefusal,
            )
            const identities: unknown = JSON.parse(
              refusal.message.slice(separator + 1),
            )
            expect(identities).toMatchObject({
              [kind === 'pid1-mismatch' ? 'pid1' : 'controller']: { uid: 1000 },
              currentPid: process.pid,
            })
          } else expect(refusal.message).toBe(expectedRefusal)
          expect(launches).toBe(0)
          expect(signals).toBe(0)
        } finally {
          signalsSpy.mockRestore()
          launchesSpy.mockRestore()
          readlinks.mockRestore()
          realpaths.mockRestore()
          accesses.mockRestore()
          stats.mockRestore()
          reads.mockRestore()
        }
      },
    )
  motorTest(
    CLEANUP_GROUP,
    'caller-supplied current boundary facts cannot mint cleanup or launch authority',
    async () => {
      const genuine = qualifyNativeProcessScope()
      const forged = { summary: structuredClone(genuine.summary) }
      let launches = 0
      let signals = 0
      const launchSpy = spyOn(childProcess, 'spawn').mockImplementation(() => {
        launches++
        throw new Error('forged launch trap')
      })
      const signalSpy = spyOn(process, 'kill').mockImplementation(() => {
        signals++
        return true
      })
      try {
        await expect(
          runNativeCommand(forged, '/bin/true', [], {
            cwd: '/tmp',
            env: { PATH: '/usr/bin:/bin' },
            timeoutMs: 100,
          }),
        ).rejects.toThrow('unqualified native process scope')
        expect(launches).toBe(0)
        expect(signals).toBe(0)
      } finally {
        signalSpy.mockRestore()
        launchSpy.mockRestore()
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'qualified spawn failure preserves its error and completes bounded empty cleanup',
    async () => {
      const scope = qualifyNativeProcessScope()
      const result = await runNativeCommand(
        scope,
        '/bin/ga-deliberately-absent-inert-command',
        [],
        { cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, timeoutMs: 100 },
      )
      expect(result.spawnError).toContain('ENOENT')
      expect(result.cleanup.outcome).toBe('clean')
      expect(result.cleanup.signaled).toBe(0)
      expect(result.cleanup.survivors).toEqual([])
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'preexisting listener controller and PID1 are protected from native command cleanup',
    async () => {
      const scope = qualifyNativeProcessScope()
      const root = mkdtempSync(join(tmpdir(), 'ga-native-preexisting-'))
      const script = inertProgram(root)
      const child = spawn(process.execPath, [script, 'preexisting', root], {
        cwd: root,
        env: nativeHostEnv(root, {}),
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      })
      retainStartedInertChild(child)
      let timer: ReturnType<typeof setTimeout> | undefined
      const errors: unknown[] = []
      try {
        const readinessDeadline = performance.now() + 500
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            child.stdio[3]!.once('data', () => resolve())
            child.once('error', reject)
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reportInertOracle(
                readinessDeadline,
                join(root, 'preexisting.json'),
              )
              reject(
                new Error('preexisting inert fixture did not become ready'),
              )
            }, 500)
          }),
        ])
        const identity = readInertIdentity(join(root, 'preexisting.json'), true)
        if (!identity)
          throw new Error(
            `missing ready actor fixture ${join(root, 'preexisting.json')}`,
          )
        expect(readFileSync(`/proc/${identity.pid}/comm`, 'utf8').trim()).toBe(
          'ga-protected',
        )
        expect(await inertListener(identity.port)).toBe(true)
        // Preserve the command's natural-exit result after preexisting readiness.
        const timerControl = heldNativeTimer()
        const result = await runNativeCommand(
          scope,
          process.execPath,
          ['-e', "console.log('inert command')"],
          {
            cwd: root,
            env: nativeHostEnv(root, {}),
            timeoutMs: 100,
            testTimers: timerControl.timers,
          },
        )
        expect(result.code).toBe(0)
        timerControl.assertCompleted(0)
        expect(result.cleanup.outcome).toBe('clean')
        expect(result.cleanup.signaled).toBe(0)
        expect(inertAlive(identity)).toBe(true)
        expect(await inertListener(identity.port)).toBe(true)
        expect(process.kill(process.pid, 0)).toBe(true)
        expect(process.kill(1, 0)).toBe(true)
      } catch (error) {
        errors.push(error)
      } finally {
        await finishInertTest(errors, [
          () => {
            if (timer) clearTimeout(timer)
          },
          () => finallyReapInert(root),
          () => {
            child.stdio[3]?.destroy()
          },
          () => rmSync(root, { recursive: true, force: true }),
        ])
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'a changed captured birth fails closed but remaining owned listener is still reaped',
    async () => {
      const scope = qualifyNativeProcessScope()
      const root = mkdtempSync(join(tmpdir(), 'ga-native-birth-'))
      const script = inertProgram(root)
      const original = fs.readFileSync
      let targetReads = 0
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        observeBuiltin(original, (value, args) => {
          const file = join(root, 'worker.json')
          if (typeof value === 'string') {
            const identity = readInertIdentity(file, true, original)
            if (
              identity &&
              String(args[0]) === `/proc/${identity.pid}/stat` &&
              ++targetReads === 2
            ) {
              const at = value.lastIndexOf(')') + 2
              const fields = value.slice(at).split(' ')
              fields[19] = String(BigInt(fields[19]!) + 1n)
              return value.slice(0, at) + fields.join(' ')
            }
          }
          return value
        }),
      )
      // Success exits only after the worker publishes readiness and notifies it.
      // Hold the timeout so only that natural exit can start cleanup.
      const timerControl = heldNativeTimer()
      const pending = runNativeCommand(
        scope,
        process.execPath,
        [script, 'success', root],
        {
          cwd: root,
          env: nativeHostEnv(root, {}),
          timeoutMs: 100,
          testTimers: timerControl.timers,
        },
      )
      let oracle: ReturnType<typeof setTimeout> | undefined
      const errors: unknown[] = []
      let admitted: InertReadyIdentity | undefined
      try {
        const completionDeadline = performance.now() + 500
        const completion = waitForInertReady(
          join(root, 'worker.json'),
          completionDeadline,
        ).then((identity) => {
          admitted = identity
          return pending
        })
        const observed = await Promise.race([
          completion.then((result) => ({ result })),
          new Promise<{ expired: true }>((resolve) => {
            oracle = setTimeout(() => resolve({ expired: true }), 500)
          }),
        ])
        if (!('result' in observed))
          reportInertOracle(
            completionDeadline,
            !admitted ? join(root, 'worker.json') : undefined,
          )
        if (!('result' in observed) && !admitted)
          throw new Error(
            `actor fixture setup deadline expired: ${join(root, 'worker.json')}`,
          )
        expect('result' in observed).toBe(true)
        if (!('result' in observed))
          throw new Error('ownership failure did not finish cleanup')
        await withChangedBirthDiagnostic(
          async () => {
            expect(targetReads).toBeGreaterThanOrEqual(2)
            expect(observed.result.code).toBe(0)
            expect(observed.result.cleanup.outcome).toBe('failed')
            expect(observed.result.cleanup.failures.join('\n')).toContain(
              'identity changed before signal',
            )
            expect(fixtureIdentities(root).some(inertAlive)).toBe(false)
            const worker = readInertIdentity(
              join(root, 'worker.json'),
              true,
              original,
            )
            if (!worker)
              throw new Error(
                `missing ready actor fixture ${join(root, 'worker.json')}`,
              )
            expect(await inertListener(worker.port, worker)).toBe(false)
            timerControl.assertCompleted(0)
          },
          () => ({
            result: observed.result,
            fixtureFiles: changedBirthFixtureFiles(root, original),
            spyCalls: reads.mock.calls.length,
            matchingPathCount: targetReads,
          }),
        )
      } catch (error) {
        errors.push(error)
      } finally {
        await finishInertTest(errors, [
          () => {
            reads.mockRestore()
            if (oracle) clearTimeout(oracle)
          },
          timerControl.settleOnFailure,
          () => finallyReapInert(root),
          () => pending,
          () => rmSync(root, { recursive: true, force: true }),
        ])
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'boundary invalidation after discovery forbids every cleanup signal',
    async () => {
      const scope = qualifyNativeProcessScope()
      const controlPath = `/sys/fs/cgroup${scope.summary.cgroup.self}/cgroup.procs`
      // A control handed to the job user, whatever its uid, must refuse.
      const jobUid = scope.summary.controller.uid
      const expectedRefusal = `Error: unprotected file ${controlPath}: Error: unexpected value ${jobUid}; expected 0`
      const modifiedControls: string[] = []
      const root = mkdtempSync(join(tmpdir(), 'ga-native-before-signal-'))
      const script = inertProgram(root)
      const originalRead = fs.readFileSync
      const originalStat = fs.lstatSync
      let invalidate = false
      let observedWorker: InertReadyIdentity | undefined
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        observeBuiltin(originalRead, (value, args) => {
          if (
            observedWorker &&
            String(args[0]) === `/proc/${observedWorker.pid}/stat`
          )
            invalidate = true
          return value
        }),
      )
      const stats = spyOn(fs, 'lstatSync').mockImplementation(
        observeBuiltin(originalStat, (value, args) => {
          const path = String(args[0])
          if (
            !invalidate ||
            path !== controlPath ||
            !value ||
            typeof value !== 'object'
          )
            return value
          const changed: object = Object.create(value)
          Object.defineProperty(changed, 'uid', {
            value: fixtureUid(value, jobUid),
          })
          modifiedControls.push(path)
          return changed
        }),
      )
      // Hold the timer so cleanup follows only the actor's natural, post-ready exit.
      const timerControl = heldNativeTimer()
      const deadline = performance.now() + 500
      const pending = runNativeCommand(
        scope,
        process.execPath,
        [script, 'boundary', root],
        {
          cwd: root,
          env: nativeHostEnv(root, {}),
          timeoutMs: 100,
          testTimers: timerControl.timers,
        },
      )
      let oracle: ReturnType<typeof setTimeout> | undefined
      const errors: unknown[] = []
      try {
        const completion = readyBeforeInertCleanup(
          waitForInertReady(join(root, 'worker.json'), deadline),
          () => publishInertFixture(join(root, 'release.json'), observedWorker),
          (identity) => {
            observedWorker = identity
          },
        ).then(() => pending)
        const observed = await Promise.race([
          completion.then((result) => ({ result })),
          new Promise<{ expired: true }>((resolve) => {
            oracle = setTimeout(
              () => resolve({ expired: true }),
              Math.max(0, deadline - performance.now()),
            )
          }),
        ])
        if (!('result' in observed))
          reportInertOracle(
            deadline,
            !observedWorker ? join(root, 'worker.json') : undefined,
          )
        if (!('result' in observed) && !observedWorker)
          throw new Error(
            `actor fixture setup deadline expired: ${join(root, 'worker.json')}`,
          )
        expect('result' in observed).toBe(true)
        if (!('result' in observed))
          throw new Error('unqualified cleanup did not finish')
        expect(invalidate).toBe(true)
        expect(observed.result.code).toBe(0)
        expect(observed.result.timedOut).toBe(false)
        timerControl.assertCompleted(0)
        expect(observed.result.cleanup.outcome).toBe('failed')
        expect(observed.result.cleanup.signaled).toBe(0)
        expect(observed.result.cleanup.survivors).toBeNull()
        expect(modifiedControls.length).toBeGreaterThan(0)
        expect(new Set(modifiedControls)).toEqual(new Set([controlPath]))
        expect(observed.result.cleanup.failures).toEqual([expectedRefusal])
        const worker = observedWorker!
        expect(inertAlive(worker)).toBe(true)
        expect(await inertListener(worker.port, worker)).toBe(true)
      } catch (error) {
        errors.push(error)
      } finally {
        await finishInertTest(errors, [
          () => {
            stats.mockRestore()
            reads.mockRestore()
            if (oracle) clearTimeout(oracle)
          },
          timerControl.settleOnFailure,
          () => finallyReapInert(root),
          () => pending,
          () => rmSync(root, { recursive: true, force: true }),
        ])
      }
    },
  )
  motorTest(
    CLEANUP_GROUP,
    'foreign live PID1 process ownership refuses before launch and signal calls',
    async () => {
      const original = fs.readFileSync
      let launches = 0
      let signals = 0
      const reads = spyOn(fs, 'readFileSync').mockImplementation(
        observeBuiltin(original, (value, args) => {
          return String(args[0]) === '/proc/1/status' &&
            typeof value === 'string'
            ? value.replace(/^Uid:.*$/m, 'Uid:\t0\t0\t0\t0')
            : value
        }),
      )
      const launchesSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => {
          launches++
          throw new Error('foreign boundary launch trap')
        },
      )
      const signalsSpy = spyOn(process, 'kill').mockImplementation(() => {
        signals++
        return true
      })
      try {
        await expect(
          (async () => {
            const scope = qualifyNativeProcessScope()
            await runNativeCommand(scope, '/bin/true', [], {
              cwd: '/tmp',
              env: { PATH: '/usr/bin:/bin' },
              timeoutMs: 100,
            })
          })(),
        ).rejects.toThrow('PID1/controller identities')
        expect(reads).toHaveBeenCalled()
        expect(launches).toBe(0)
        expect(signals).toBe(0)
      } finally {
        signalsSpy.mockRestore()
        launchesSpy.mockRestore()
        reads.mockRestore()
      }
    },
  )
  for (const mode of ['success', 'nonzero', 'timeout', 'output-cap'])
    motorTest(
      CLEANUP_GROUP,
      mode === 'timeout'
        ? 'native cleanup after a ready-gated timeout reaps detached pipe-holding listener without changing the command result'
        : `native cleanup reaps detached pipe-holding listener on ${mode} without changing the command result`,
      async () => {
        const scope = qualifyNativeProcessScope()
        const root = mkdtempSync(join(tmpdir(), 'ga-native-cleanup-'))
        const script = inertProgram(root)
        // Natural-exit/output-cap controls hold the timer. Only the timeout
        // control dispatches it after readiness; none measures wall-clock accuracy.
        const timerControl = heldNativeTimer()
        const deadline = performance.now() + 500
        const pending = runNativeCommand(
          scope,
          process.execPath,
          [script, mode, root],
          {
            cwd: root,
            env: nativeHostEnv(root, {}),
            timeoutMs: 100,
            outputCapBytes: 1024,
            testTimers: timerControl.timers,
          },
        )
        let oracle: ReturnType<typeof setTimeout> | undefined
        const errors: unknown[] = []
        let admitted: InertReadyIdentity | undefined
        try {
          const completion =
            mode === 'timeout'
              ? readyBeforeInertCleanup(
                  waitForInertReady(join(root, 'worker.json'), deadline),
                  timerControl.fire,
                  (identity) => {
                    admitted = identity
                  },
                ).then(() => pending)
              : pending
          const observed = await Promise.race([
            completion.then((result) => ({ result })),
            new Promise<{ expired: true }>((resolve) => {
              oracle = setTimeout(
                () => resolve({ expired: true }),
                Math.max(0, deadline - performance.now()),
              )
            }),
          ])
          if (!('result' in observed))
            reportInertOracle(
              deadline,
              mode === 'timeout' && !admitted
                ? join(root, 'worker.json')
                : undefined,
            )
          if (!('result' in observed) && mode === 'timeout' && !admitted)
            throw new Error(
              `actor fixture setup deadline expired: ${join(root, 'worker.json')}`,
            )
          expect('result' in observed).toBe(true)
          if (!('result' in observed))
            throw new Error('production cleanup exceeded inert oracle bound')
          const { result } = observed
          const worker = readInertIdentity(join(root, 'worker.json'), true)
          if (!worker)
            throw new Error(
              `missing ready actor fixture ${join(root, 'worker.json')}`,
            )
          expect(worker.pgid).toBe(worker.pid)
          expect(worker.sid).toBe(worker.pid)
          expect(fixtureIdentities(root).some(inertAlive)).toBe(false)
          expect(await inertListener(worker.port, worker)).toBe(false)
          expect(result.cleanup.outcome).toBe('clean')
          expect(result.cleanup.signaled).toBeGreaterThan(0)
          expect(result.timedOut).toBe(mode === 'timeout')
          expect(result.outputCapExceeded).toBe(mode === 'output-cap')
          timerControl.assertCompleted(mode === 'timeout' ? 1 : 0)
          if (mode === 'success' || mode === 'nonzero') {
            expect(result.code).toBe(mode === 'success' ? 0 : 7)
            expect(
              result.cleanup.signals.find(
                (entry) => entry.identity.pid === worker.pid,
              )?.identity.parent,
            ).toBe(1)
          }
        } catch (error) {
          errors.push(error)
        } finally {
          await finishInertTest(errors, [
            () => {
              if (oracle) clearTimeout(oracle)
            },
            timerControl.settleOnFailure,
            () => finallyReapInert(root),
            () => pending,
            () => rmSync(root, { recursive: true, force: true }),
          ])
        }
      },
    )
  motorTest(
    CLEANUP_GROUP,
    'native command real wall-clock timeout kills a sleeping owned child',
    async () => {
      const scope = qualifyNativeProcessScope()
      const root = mkdtempSync(join(tmpdir(), 'ga-native-real-timer-'))
      const originalSpawn = childProcess.spawn
      const originalSet = globalThis.setTimeout
      const originalClear = globalThis.clearTimeout
      let birth: InertIdentity | undefined
      let published = Promise.resolve()
      let realTimer: ReturnType<typeof setTimeout> | undefined
      let fired = 0
      let cleared = false
      const delays: number[] = []
      const launches = spyOn(childProcess, 'spawn').mockImplementation(
        new Proxy(originalSpawn, {
          apply(target, receiver, args: unknown[]) {
            const child = Reflect.apply(
              target,
              receiver,
              args,
            ) as childProcess.ChildProcess
            if (child.pid === undefined)
              throw new Error('sleep actor did not spawn')
            birth = captureInertBirth(child.pid)
            published = publishInertFixture(join(root, 'leader.json'), birth)
            return child
          },
        }),
      )
      const sets = spyOn(globalThis, 'setTimeout').mockImplementation(
        new Proxy(originalSet, {
          apply(target, receiver, args: unknown[]) {
            expect(target).toBe(originalSet)
            const callback = args[0] as () => void
            delays.push(Number(args[1]))
            realTimer = Reflect.apply(target, receiver, [
              () => {
                fired++
                callback()
              },
              ...args.slice(1),
            ]) as ReturnType<typeof setTimeout>
            return realTimer
          },
        }),
      )
      const clears = spyOn(globalThis, 'clearTimeout').mockImplementation(
        observeBuiltin(originalClear, (value, args) => {
          if (args[0] === realTimer) cleared = true
          return value
        }),
      )
      // Sleep has no readiness protocol and cannot finish naturally in 100 ms.
      // No timer seam is supplied: the default must fire and reap this live PID.
      const pending = runNativeCommand(scope, '/bin/sleep', ['30'], {
        cwd: root,
        env: nativeHostEnv(root, {}),
        timeoutMs: 100,
      })
      const errors: unknown[] = []
      try {
        const result = await pending
        await published
        if (!birth) throw new Error('sleep actor birth was not captured')
        expect(delays).toEqual([100])
        expect(fired).toBe(1)
        expect(cleared).toBe(true)
        expect(result).toMatchObject({
          code: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: '',
          timedOut: true,
          outputCapExceeded: false,
          spawnError: null,
          cleanup: {
            outcome: 'clean',
            signaled: 1,
            survivors: [],
            failures: [],
          },
        })
        expect(
          result.cleanup.signals.map((entry) => ({
            pid: entry.identity.pid,
            start: entry.identity.start,
            signal: entry.signal,
          })),
        ).toEqual([{ pid: birth.pid, start: birth.start, signal: 'SIGKILL' }])
        expect(
          result.cleanup.preexisting.some(
            (row) => row.pid === birth!.pid && row.start === birth!.start,
          ),
        ).toBe(false)
        // This assertion precedes the backstop, so it proves subject-side reaping.
        expect(inertAlive(birth)).toBe(false)
      } catch (error) {
        errors.push(error)
      } finally {
        await finishInertTest(errors, [
          () => {
            clears.mockRestore()
            sets.mockRestore()
            launches.mockRestore()
          },
          () => published,
          () => finallyReapInert(root),
          () => pending,
          () => {
            if (birth) expect(inertAlive(birth)).toBe(false)
          },
          () => rmSync(root, { recursive: true, force: true }),
        ])
      }
    },
  )
  test('a non-writable job-owned PSI observation through a read-only mount is truthful evidence', () => {
    const value = nativeMatrix()
    value.native.processBoundary.cgroup.pressureObservation.uid = 999
    const parsed: unknown = MatrixSchema.parse(value)
    expect(parsed).toEqual(value)
    expect(validateMatrix(value, pin).rows).toHaveLength(253)
  })
  test('the existing all-root protection case remains valid without a PSI owner exception', () => {
    const value = nativeMatrix()
    value.native.processBoundary.cgroup.pressureObservation.mount.options = [
      'rw',
      'nosuid',
      'nodev',
      'noexec',
    ]
    const parsed: unknown = MatrixSchema.parse(value)
    expect(parsed).toEqual(value)
  })
  motorTest(
    CLEANUP_GROUP,
    'the all-root PSI fixture qualifies through the same live admission path',
    () => {
      const original = fs.lstatSync
      const stats = spyOn(fs, 'lstatSync').mockImplementation(
        observeBuiltin(original, (value, args) => {
          if (!value || typeof value !== 'object') return value
          if (!String(args[0]).endsWith('/memory.pressure')) return value
          const rootOwned: object = Object.create(value)
          Object.defineProperty(rootOwned, 'uid', {
            value: fixtureUid(value, 0),
          })
          return rootOwned
        }),
      )
      try {
        const scope = qualifyNativeProcessScope()
        expect(scope.summary.cgroup.pressureObservation.uid).toBe(0)
        expect(scope.summary.pid1.uid).toBe(process.getuid?.() ?? -1)
        expect(scope.summary.controller.uid).toBe(scope.summary.pid1.uid)
        expect(scope.summary.pid1.protection.uid).toBe(0)
      } finally {
        stats.mockRestore()
      }
    },
  )
  test('native schema rejects unsupported process or filesystem authority facts', () => {
    for (const mutate of [
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.pid1.uid = 0
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.pid1.uid = 1000
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.controller.uid = 1000
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.pid1.protection.uid = 999
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.pid1.protection.jobWritable = true
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.controls['cgroup.procs'].uid = 999
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        Reflect.deleteProperty(
          v.native.processBoundary.cgroup.controls,
          'memory.max',
        )
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        Reflect.deleteProperty(
          v.native.processBoundary.cgroup.controls,
          'pids.max',
        )
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        Object.assign(v.native.processBoundary.cgroup.controls, {
          'memory.unknown': {
            uid: 999,
            gid: 0,
            mode: 0o644,
            jobWritable: false,
          },
        })
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.uid = 1000
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.uid = 999
        v.native.processBoundary.cgroup.pressureObservation.mount.options = [
          'rw',
        ]
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.jobWritable = true
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.name =
          'cpu.pressure'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.fileType = 'symlink'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.namespace.pid1 = 'pid:[999]'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pid1 = '/system.slice/foreign.service'
      },
      // The retired placement directly under system.slice, in both fields.
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.self =
          '/system.slice/motor-job-01234567-0123-4123-a123-0123456789ab.service'
        v.native.processBoundary.cgroup.pid1 =
          v.native.processBoundary.cgroup.self
      },
      // A unit under motor.slice that skips the motor-jobs.slice parent.
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.self =
          '/motor.slice/motor-job-01234567-0123-4123-a123-0123456789ab.service'
        v.native.processBoundary.cgroup.pid1 =
          v.native.processBoundary.cgroup.self
      },
      // A motor-jobs.slice parent the job could write to. The fixture shares one
      // protection object across directories, so replace it rather than edit it.
      (v: ReturnType<typeof nativeMatrix>) => {
        const parents = v.native.processBoundary.cgroup.parents
        const jobs = '/sys/fs/cgroup/motor.slice/motor-jobs.slice'
        parents[jobs] = { ...parents[jobs], jobWritable: true }
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        const parents = v.native.processBoundary.cgroup.parents
        const jobs = '/sys/fs/cgroup/motor.slice/motor-jobs.slice'
        parents[jobs] = { ...parents[jobs], uid: 999 }
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.policy.signedAttestation = true
      },
    ]) {
      const value = nativeMatrix()
      mutate(value)
      expect(() => {
        MatrixSchema.parse(value)
      }).toThrow()
    }
  })
  for (const uid of [996, 997, 999])
    test(`native placement qualifies job uid ${uid} with a private namespace and MOTOR cgroup`, () => {
      expect(
        qualifyNativePlacement(motorPlacementFacts({ uid, euid: uid })),
      ).toEqual({ jobUid: uid, cgroup: MOTOR_UNIT })
    })
  // Each case changes one fact of a qualified MOTOR placement, or describes an
  // ordinary host whole, and names the fact the refusal must report.
  const HOST_NAMESPACE = 'pid:[4026531836]'
  const CONTAINER_NAMESPACE = 'pid:[4026532001]'
  type PlacementRefusal = [string, Partial<NativePlacementFacts>, string]
  const placementRefusals: PlacementRefusal[] = [
    ['uid 0', { uid: 0, euid: 0 }, '(uid 0)'],
    ['euid 0', { uid: 997, euid: 0 }, '(euid 0 differs from uid 997)'],
    ['unreadable uid', { uid: undefined }, '(uid unreadable)'],
    ['arm64', { arch: 'arm64' }, '(arch arm64)'],
    ['darwin', { platform: 'darwin' }, '(platform darwin)'],
    [
      'a macOS user 501',
      {
        platform: 'darwin',
        arch: 'arm64',
        uid: 501,
        euid: 501,
        pidNamespace: undefined,
        pid1Namespace: undefined,
        pid1Comm: undefined,
        cgroup: undefined,
        cgroupDirectoryUid: undefined,
      },
      '(platform darwin)',
    ],
    [
      'a GitHub runner user 1001 on the host',
      {
        uid: 1001,
        euid: 1001,
        pidNamespace: HOST_NAMESPACE,
        pid1Namespace: HOST_NAMESPACE,
        pid1Comm: 'systemd',
        cgroup: '0::/system.slice/hosted-compute-agent.service\n',
      },
      '(host PID namespace)',
    ],
    ...['node', 'sh'].map(
      (comm): PlacementRefusal => [
        `a Docker-like PID 1 ${comm} without a MOTOR cgroup`,
        {
          uid: 1001,
          euid: 1001,
          pidNamespace: CONTAINER_NAMESPACE,
          pid1Namespace: CONTAINER_NAMESPACE,
          pid1Comm: comm,
          cgroup: '0::/\n',
        },
        `(PID 1 is ${comm}, not the job wrapper)`,
      ],
    ),
    // Only the namespace requirement fails in the next cases.
    ...['systemd', 'init', 'launchd'].map(
      (comm): PlacementRefusal => [
        `a host PID 1 ${comm}`,
        { pid1Comm: comm },
        `(PID 1 is ${comm}, not the job wrapper)`,
      ],
    ),
    [
      'the host PID namespace inode',
      { pidNamespace: HOST_NAMESPACE, pid1Namespace: HOST_NAMESPACE },
      '(host PID namespace)',
    ],
    [
      'a PID 1 in another namespace',
      { pid1Namespace: HOST_NAMESPACE },
      '(PID namespace differs from PID1)',
    ],
    [
      'an unreadable /proc/1',
      { pid1Namespace: undefined, pid1Comm: undefined },
      '(/proc/1 unreadable)',
    ],
    [
      'an unreadable own PID namespace',
      { pidNamespace: undefined },
      '(own PID namespace unreadable)',
    ],
    // Only the cgroup requirement fails in the next cases.
    [
      'a deeper cgroup path',
      { cgroup: `0::${MOTOR_UNIT}/payload\n` },
      `(cgroup ${MOTOR_UNIT}/payload is not a MOTOR job unit)`,
    ],
    [
      'a .scope unit',
      { cgroup: `0::${MOTOR_UNIT.replace(/\.service$/, '.scope')}\n` },
      'is not a MOTOR job unit)',
    ],
    [
      'a non-UUID unit id',
      {
        cgroup: '0::/motor.slice/motor-jobs.slice/motor-job-runner-7.service\n',
      },
      '(cgroup /motor.slice/motor-jobs.slice/motor-job-runner-7.service is not a MOTOR job unit)',
    ],
    [
      'another slice',
      {
        cgroup: `0::${MOTOR_UNIT.replace('motor.slice/motor-jobs.slice', 'user.slice')}\n`,
      },
      'is not a MOTOR job unit)',
    ],
    [
      'the retired job unit directly under system.slice',
      {
        cgroup:
          '0::/system.slice/motor-job-01a168ba-aab2-72c9-83da-e4a254cfee3c.service\n',
      },
      '(cgroup /system.slice/motor-job-01a168ba-aab2-72c9-83da-e4a254cfee3c.service is not a MOTOR job unit)',
    ],
    [
      'a job unit under motor.slice without motor-jobs.slice',
      {
        cgroup:
          '0::/motor.slice/motor-job-01a168ba-aab2-72c9-83da-e4a254cfee3c.service\n',
      },
      '(cgroup /motor.slice/motor-job-01a168ba-aab2-72c9-83da-e4a254cfee3c.service is not a MOTOR job unit)',
    ],
    [
      'a non-MOTOR service',
      { cgroup: '0::/system.slice/actions.runner.service\n' },
      'is not a MOTOR job unit)',
    ],
    [
      'a hybrid cgroup v1 membership',
      { cgroup: `1:name=systemd:/\n0::${MOTOR_UNIT}\n` },
      '(not a single unified cgroup membership)',
    ],
    ['an unreadable cgroup', { cgroup: undefined }, '(cgroup unreadable)'],
    [
      'a job-owned cgroup directory',
      { cgroupDirectoryUid: 999 },
      '(cgroup directory owner 999)',
    ],
    [
      'an unreadable cgroup directory',
      { cgroupDirectoryUid: undefined },
      '(cgroup directory unreadable)',
    ],
  ]
  for (const [control, overrides, fact] of placementRefusals)
    test(`native placement refuses ${control}`, () => {
      let refusal: unknown
      try {
        qualifyNativePlacement(motorPlacementFacts(overrides))
      } catch (error) {
        refusal = error
      }
      if (!(refusal instanceof Error))
        throw new Error(`placement qualified despite ${control}`)
      expect(refusal.message).toStartWith(
        'native cleanup requires the unprivileged Linux x64 MOTOR job (',
      )
      expect(refusal.message).toContain(fact)
    })
  test('native job identities qualify PID 1 and controller owned by job uid 997', () => {
    const controller = modeledIdentity(4242, 997, 'bun')
    const pid1 = modeledIdentity(1, 997, 'bash')
    expect(qualifyNativeJobIdentities(997, controller, pid1, 4242)).toEqual({
      controller,
      pid1,
    })
  })
  for (const [control, jobUid, controllerUid, pid1Uid, pid1Comm, pid] of [
    ['PID 1 997 with controller 998', 997, 998, 997, 'bash', 4242],
    ['controller 997 with PID 1 998', 997, 997, 998, 'bash', 4242],
    ['a root-owned PID 1', 997, 997, 0, 'bash', 4242],
    ['a root job user', 0, 0, 0, 'bash', 4242],
    ['a non-wrapper PID 1', 997, 997, 997, 'sh', 4242],
    ['a controller that is PID 1', 997, 997, 997, 'bash', 1],
  ] as const)
    test(`native job identities refuse ${control}`, () => {
      expect(() =>
        qualifyNativeJobIdentities(
          jobUid,
          modeledIdentity(pid, controllerUid, 'bun'),
          modeledIdentity(1, pid1Uid, pid1Comm),
          pid,
        ),
      ).toThrow(
        `missing protected PID1/controller identities: ${JSON.stringify({
          controller: modeledIdentity(pid, controllerUid, 'bun'),
          pid1: modeledIdentity(1, pid1Uid, pid1Comm),
          currentPid: pid,
          jobUid,
        })}`,
      )
    })
  test('native schema accepts a uid-997 job boundary with a job-owned PSI observation', () => {
    const value = jobUserBoundary(997)
    const parsed = MatrixSchema.parse(value)
    expect(parsed as unknown).toEqual(value)
    if (parsed.profile !== 'native-job')
      throw new Error('wrong schema fixture profile')
    expect(parsed.native.processBoundary.controller.uid).toBe(997)
    expect(parsed.native.processBoundary.cgroup.pressureObservation.uid).toBe(
      997,
    )
  })
  test('native schema refuses PID 1 997 with controller 998', () => {
    const value = jobUserBoundary(997)
    value.native.processBoundary.controller.uid = 998
    value.native.processBoundary.cgroup.pressureObservation.uid = 0
    expect(() => MatrixSchema.parse(value)).toThrow(
      'unexpected value 997; expected 998',
    )
  })
  test('native schema refuses a root job user', () => {
    const value = jobUserBoundary(0)
    expect(() => MatrixSchema.parse(value)).toThrow('expected positive integer')
  })
  test('native schema refuses a PSI owner 998 when the job is 997', () => {
    const value = jobUserBoundary(997)
    value.native.processBoundary.cgroup.pressureObservation.uid = 998
    expect(() => MatrixSchema.parse(value)).toThrow(
      'unexpected value 998; expected 0,997',
    )
  })
  test('native cleanup signals a survivor only when the qualified job uid owns it', () => {
    expect(nativeSignalOwned(997, 997)).toBe(true)
    expect(nativeSignalOwned(998, 997)).toBe(false)
    expect(nativeSignalOwned(999, 997)).toBe(false)
    expect(nativeSignalOwned(0, 997)).toBe(false)
    expect(nativeSignalOwned(0, 0)).toBe(false)
  })
  test('native cleanup checks both survivor observations against the qualified job uid', () => {
    const source = readFileSync(
      join(HERE, 'measure-ga-proxy-matrix.ts'),
      'utf8',
    )
    const start = source.indexOf('export async function runNativeCommand(')
    const end = source.indexOf('\nexport ', start + 1)
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, end)
    expect(body).toContain(
      'const jobUid = recheckNativeScope(scope).controller.uid',
    )
    expect(body.match(/nativeSignalOwned\((\w+)\.uid, jobUid\)/g)).toEqual([
      'nativeSignalOwned(expected.uid, jobUid)',
      'nativeSignalOwned(current.uid, jobUid)',
    ])
    expect(body).not.toMatch(/\.uid !== \d/)
  })
  test('a uid-997 job qualifies end to end across placement, identities, schema and cleanup ownership', () => {
    const placement = qualifyNativePlacement(
      motorPlacementFacts({ uid: 997, euid: 997 }),
    )
    const { controller } = qualifyNativeJobIdentities(
      placement.jobUid,
      modeledIdentity(4242, 997, 'bun'),
      modeledIdentity(1, 997, 'bash'),
      4242,
    )
    const parsed = MatrixSchema.parse(jobUserBoundary(placement.jobUid))
    if (parsed.profile !== 'native-job')
      throw new Error('wrong schema fixture profile')
    const boundary = parsed.native.processBoundary
    expect(boundary.cgroup.pressureObservation.uid).toBe(997)
    expect(boundary.controller.uid).toBe(controller.uid)
    expect(nativeSignalOwned(997, boundary.controller.uid)).toBe(true)
    expect(nativeSignalOwned(998, boundary.controller.uid)).toBe(false)
    expect(nativeSignalOwned(0, boundary.controller.uid)).toBe(false)
  })
  test('the unmocked guard refuses an ordinary host and qualifies only a MOTOR job, without any signal', async () => {
    const raw = rawMotorJobPlacement()
    // A separate, ordinary Bun process runs the real guard with no fs or process
    // mocks. Any signal attempt is counted and blocked instead of delivered.
    const script = `
      let signals = 0
      process.kill = () => {
        signals++
        throw new Error('signal trap')
      }
      const { qualifyNativeProcessScope } = await import(${JSON.stringify(join(HERE, 'measure-ga-proxy-matrix.ts'))})
      let outcome
      try {
        const scope = qualifyNativeProcessScope()
        outcome = { qualified: true, jobUid: scope.summary.controller.uid, uid: process.getuid?.() }
      } catch (error) {
        outcome = { qualified: false, error: error instanceof Error ? error.message : String(error) }
      }
      console.log('GUARD_OUTCOME=' + JSON.stringify({ ...outcome, signals }))
    `
    const ran = await runCommand([process.execPath, '-e', script], {
      cwd: HERE,
      deadlineMs: 30_000,
    })
    const line = ran.stdout
      .split('\n')
      .find((entry) => entry.startsWith('GUARD_OUTCOME='))
    expect(line, `${ran.stdout}\n${ran.stderr}`).toBeDefined()
    const outcome = JSON.parse((line ?? '').slice('GUARD_OUTCOME='.length))
    expect(outcome.signals).toBe(0)
    if (raw.motor && raw.pressurePresent)
      expect(outcome, JSON.stringify(raw.facts)).toMatchObject({
        qualified: true,
        jobUid: process.getuid?.(),
        uid: process.getuid?.(),
      })
    else if (raw.motor) {
      // MOTOR-shaped placement without the PSI file: the guard must fail
      // closed naming that file, without delivering any signal.
      expect(outcome.qualified, JSON.stringify(raw.facts)).toBe(false)
      expect(
        String(outcome.error),
        JSON.stringify({ facts: raw.facts, pressurePath: raw.pressurePath }),
      ).toContain('memory.pressure')
    } else {
      expect(outcome.qualified, JSON.stringify(raw.facts)).toBe(false)
      expect(outcome.error).toStartWith(
        'native cleanup requires the unprivileged Linux x64 MOTOR job (',
      )
    }
  })
  test('native cleanup command inventory cannot omit duplicate fail or invent a command', () => {
    for (const mutate of [
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup.pop()
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup.push(v.native.cleanup[1]!)
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup[1]!.outcome = 'failed'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup[1]!.id = 'unknown'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup[1]!.signaled = -1
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.cleanup[1]!.signaled = 1
      },
    ]) {
      const value = nativeMatrix()
      mutate(value)
      expect(() => {
        validateMatrix(value, pin)
      }).toThrow()
    }
  })
  for (const control of [
    'missing',
    'duplicate',
    'misordered',
    'failed',
    'signaled',
  ] as const)
    test(`native boundary-probe cleanup inventory refuses ${control} evidence`, () => {
      const value = nativeMatrix()
      expect(value.native.cleanup[0]).toEqual({
        id: 'boundary-probe',
        outcome: 'clean',
        signaled: 0,
      })
      const probe = value.native.cleanup[0]!
      if (control === 'missing') value.native.cleanup.shift()
      if (control === 'duplicate') value.native.cleanup.push({ ...probe })
      if (control === 'misordered') {
        value.native.cleanup[0] = value.native.cleanup[1]!
        value.native.cleanup[1] = probe
      }
      if (control === 'failed') probe.outcome = 'failed'
      if (control === 'signaled') probe.signaled = 1
      expect(() => validateMatrix(value, pin)).toThrow(
        'missing/duplicate/failed native command cleanup evidence',
      )
    })
  test('comparison normalizes only qualified job IDs and preserves PSI protection and cleanup differences', () => {
    const value = nativeMatrix()
    const fresh = structuredClone(value)
    fresh.native.processBoundary.namespace.self = 'pid:[789]'
    fresh.native.processBoundary.namespace.pid1 = 'pid:[789]'
    fresh.native.processBoundary.cgroup.self =
      '/motor.slice/motor-jobs.slice/motor-job-01234567-0123-4123-a123-0123456789ac.service'
    fresh.native.processBoundary.cgroup.pid1 =
      fresh.native.processBoundary.cgroup.self
    expect(() => assertConformance(fresh, value, pin)).not.toThrow()
    for (const mutate of [
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.uid = 999
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.mode = 0o444
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.mount.options = [
          'rw',
        ]
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.pressureObservation.mount.superOptions.push(
          'nsdelegate',
        )
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.cgroup.controls['cgroup.procs'].mode = 0o444
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.processBoundary.pid1.executableSha256 = 'd'.repeat(64)
      },
    ]) {
      const changed = structuredClone(value)
      mutate(changed)
      expect(() => assertConformance(changed, value, pin)).toThrow('difference')
    }
    const dirty = structuredClone(value)
    dirty.native.cleanup[1]!.signaled = 1
    expect(() => assertConformance(dirty, value, pin)).toThrow('cleanup')
  })
  motorTest(
    CLEANUP_GROUP,
    'live protected private PID and cgroup facts qualify without pretending to attest unit properties',
    () => {
      const scope = qualifyNativeProcessScope()
      expect(scope.summary.namespace.self).toBe(scope.summary.namespace.pid1)
      expect(scope.summary.cgroup.self).toBe(scope.summary.cgroup.pid1)
      expect(scope.summary.policy.unitPropertiesObserved).toBe(false)
      expect(scope.summary.policy.signedAttestation).toBe(false)
      expect(scope.summary.pid1.digestProvenance).toBe(
        'observed, not an approved artifact pin',
      )
      console.log(
        `NATIVE_PROCESS_SCOPE_OBSERVED=${JSON.stringify(scope.summary)}`,
      )
    },
  )
})

function nativeGitRoot(parent: string, name: string): string {
  const root = join(parent, name)
  mkdirSync(root)
  mkdirSync(join(root, 'project'))
  for (const name of ['home', 'config', 'cache', 'data', 'state'])
    mkdirSync(join(root, name))
  return root
}

describe(GIT_GROUP, () => {
  test('native source wires owned Git and pre-output snapshot admission into the collector', () => {
    const source = createSourceFile(
      'measure-ga-proxy-matrix.ts',
      readFileSync(join(HERE, 'measure-ga-proxy-matrix.ts'), 'utf8'),
      ScriptTarget.Latest,
      true,
    )
    const functions = source.statements.filter(isFunctionDeclaration)
    const inside = functions.find((node) => node.name?.text === 'insideRun')!
    const nativeRun = functions.find(
      (node) => node.name?.text === 'nativeJobRun',
    )!
    const descendants = (node: Node): Node[] => {
      const nodes: Node[] = []
      const visit = (child: Node) => {
        nodes.push(child)
        forEachChild(child, visit)
      }
      forEachChild(node, visit)
      return nodes
    }
    const insideNodes = descendants(inside)
    const nativeInvoke = descendants(nativeRun)
      .filter(isVariableDeclaration)
      .find((node) => node.name.getText(source) === 'nativeInvoke')!
    const rejects = descendants(nativeInvoke)
      .filter(isIfStatement)
      .find((node) =>
        node.expression.getText(source).includes('result.spawnError'),
      )!
    expect(rejects.expression.getText(source).replace(/\s+/g, '')).toBe(
      "result.spawnError||result.signal||result.code!==0||result.timedOut||result.outputCapExceeded||result.cleanup.outcome!=='clean'||result.cleanup.signaled!==0",
    )
    expect(rejects.thenStatement.getText(source).startsWith('throw ')).toBe(
      true,
    )
    const env = insideNodes
      .filter(isVariableDeclaration)
      .find((node) => node.name.getText(source) === 'envForRow')!
    expect(env.initializer?.getText(source)).toBe(
      'job ? nativeHostEnv : isolatedEnv',
    )
    expect(
      insideNodes.filter(isIfStatement).some(
        (node) =>
          node.expression.getText(source) === 'job' &&
          descendants(node.thenStatement)
            .filter(isCallExpression)
            .some(
              (call) =>
                call.expression.getText(source) === 'prepareNativeGit' &&
                call.arguments.map((arg) => arg.getText(source)).join(',') ===
                  'root,job.scope',
            ) &&
          node.elseStatement?.getText(source) ===
            "checkedCommand('git', ['-C', join(root, 'project'), 'init'])",
      ),
    ).toBe(true)
    const calls = nativeRun
      .body!.statements.flatMap((node) => descendants(node))
      .filter(isCallExpression)
    const snapshot = calls.find(
      (node) => node.expression.getText(source) === 'snapshotNativeComparison',
    )!
    const mkdir = calls.find(
      (node) => node.expression.getText(source) === 'mkdirSync',
    )!
    const boundary = calls.find((node) =>
      node.expression.getText(source).endsWith('.measureNativeJob'),
    )!
    const probeLauncher = boundary.arguments[4]
    expect(probeLauncher).toBeDefined()
    if (!probeLauncher || !isArrowFunction(probeLauncher))
      throw new Error('matrix probe has no qualified launcher callback')
    const probeCalls = descendants(probeLauncher).filter(isCallExpression)
    const probeDispatch = probeCalls.find(
      (node) => node.expression.getText(source) === 'runNativeCommand',
    )!
    expect(probeDispatch.arguments.map((arg) => arg.getText(source))).toEqual([
      'processScope',
      'binary',
      'args',
      'commandOptions',
    ])
    const probeInventory = probeCalls.find(
      (node) => node.expression.getText(source) === 'probeCleanup.push',
    )!
    expect(
      probeInventory.arguments[0]?.getText(source).replace(/\s+/g, ''),
    ).toBe(
      "{id:'boundary-probe',outcome:result.cleanup.outcome,signaled:result.cleanup.signaled,}",
    )
    expect(
      descendants(probeLauncher)
        .filter(isReturnStatement)
        .map((node) => node.expression?.getText(source)),
    ).toEqual(['result'])
    const identity = calls.find(
      (node) => node.expression.getText(source) === 'assertNativeJob',
    )!
    expect(
      identity.arguments[0]?.getText(source).replace(/\s+/g, ''),
    ).toContain('cleanup:probeCleanup,')
    const qualification = calls.find(
      (node) => node.expression.getText(source) === 'qualifyNativeProcessScope',
    )!
    expect(snapshot.getStart(source)).toBeLessThan(
      qualification.getStart(source),
    )
    expect(qualification.getStart(source)).toBeLessThan(mkdir.getStart(source))
    expect(qualification.getStart(source)).toBeLessThan(
      boundary.getStart(source),
    )
    expect(snapshot.getStart(source)).toBeLessThan(mkdir.getStart(source))
    expect(snapshot.getStart(source)).toBeLessThan(boundary.getStart(source))
    const runnerBinding = calls.find(
      (node) => node.expression.getText(source) === 'observeNativeRunner',
    )!
    expect(runnerBinding.getStart(source)).toBeLessThan(
      boundary.getStart(source),
    )
    const rowCalls = descendants(nativeInvoke).filter(isCallExpression)
    const rebind = rowCalls.find(
      (node) =>
        node.expression.getText(source) === 'assertNativeRunnerUnchanged',
    )!
    const rowDispatch = rowCalls.find(
      (node) => node.expression.getText(source) === 'runNativeCommand',
    )!
    expect(rebind).toBeDefined()
    expect(rebind.getStart(source)).toBeLessThan(rowDispatch.getStart(source))
    const primitive = functions.find(
      (node) => node.name?.text === 'runNativeCommand',
    )!
    const signal = descendants(primitive)
      .filter(isCallExpression)
      .find((node) => node.expression.getText(source) === 'process.kill')!
    const batch = signal.parent.parent
    expect(isBlock(batch)).toBe(true)
    if (!isBlock(batch)) throw new Error('native signal has no checked block')
    const position = batch.statements.findIndex(
      (node) => node.getStart(source) === signal.parent.getStart(source),
    )
    expect(batch.statements[position - 1]?.getText(source)).toBe(
      'checkCleanupBudget(budget)',
    )
  })
  test('native host uses only system PATH and owned Git configuration roots', () => {
    const root = '/tmp/ga-native-environment'
    const env = nativeHostEnv(root, {})
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe(`${root}/home`)
    expect(env.XDG_CONFIG_HOME).toBe(`${root}/config`)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_VALUE_0).toBe(`${root}/git-hooks`)
    expect(env.GIT_CONFIG_KEY_1).toBe('init.templateDir')
    expect(env.GIT_CONFIG_VALUE_1).toBe(`${root}/git-template`)
    expect(env.GIT_TEMPLATE_DIR).toBe(`${root}/git-template`)
    expect(env.GIT_PROXY_COMMAND).toBeUndefined()
    expect(() => nativeHostEnv(root, { HOME: '/operator-home' })).toThrow()
    expect(() =>
      nativeHostEnv(root, { GIT_CONFIG_GLOBAL: '/operator-config' }),
    ).toThrow()
  })
  motorTest(
    GIT_GROUP,
    'native Git never executes caller PATH or copies caller configuration templates',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'ga-native-git-'))
      const previous = { ...process.env }
      try {
        const root = nativeGitRoot(parent, 'row')
        const bin = join(parent, 'caller-bin')
        const template = join(parent, 'caller-template')
        const marker = join(parent, 'caller-code-executed')
        mkdirSync(bin)
        mkdirSync(template)
        mkdirSync(join(template, 'hooks'))
        writeFileSync(
          join(template, 'inert-template-canary'),
          'caller template',
        )
        writeFileSync(join(template, 'hooks/pre-commit'), '#!/bin/sh\nexit 0\n')
        const config = `[init]\n  templateDir = ${template}\n[core]\n  hooksPath = ${template}/hooks\n`
        writeFileSync(join(root, 'home/.gitconfig'), config)
        writeFileSync(join(root, 'config/git-config-trap'), config)
        writeFileSync(
          join(bin, 'git'),
          `#!/bin/sh\nprintf 'caller code executed' > ${JSON.stringify(marker)}\nexec /usr/bin/git -c init.templateDir=${JSON.stringify(template)} "$@"\n`,
        )
        chmodSync(join(bin, 'git'), 0o700)
        Object.assign(process.env, {
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          HOME: join(root, 'home'),
          XDG_CONFIG_HOME: join(root, 'config'),
          GIT_CONFIG_GLOBAL: join(root, 'home/.gitconfig'),
          GIT_CONFIG_SYSTEM: join(root, 'config/git-config-trap'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'init.templateDir',
          GIT_CONFIG_VALUE_0: template,
          GIT_TEMPLATE_DIR: template,
          GIT_PROXY_COMMAND: join(bin, 'git'),
        })
        await prepareNativeGit(root)
        expect(existsSync(marker)).toBe(false)
        expect(existsSync(join(root, 'project/.git/HEAD'))).toBe(true)
        expect(
          existsSync(join(root, 'project/.git/inert-template-canary')),
        ).toBe(false)
        expect(existsSync(join(root, 'project/.git/hooks/pre-commit'))).toBe(
          false,
        )
        const command = JSON.parse(
          readFileSync(join(root, 'git.command.json'), 'utf8'),
        )
        expect(command.binary).toBe('/usr/bin/git')
        expect(command.env.PATH).toBe('/usr/bin:/bin')
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key]
        Object.assign(process.env, previous)
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )
  test('inert Git template trap copies its canary when exclusions are removed', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ga-native-git-canary-'))
    try {
      const root = nativeGitRoot(parent, 'row')
      const template = join(parent, 'template')
      mkdirSync(template)
      writeFileSync(join(template, 'inert-template-canary'), 'caller template')
      writeFileSync(
        join(root, 'home/.gitconfig'),
        `[init]\n templateDir = ${template}\n`,
      )
      // Git fails at its own deadline, before this test's timeout.
      const ran = await runCommand(
        ['/usr/bin/git', '-C', join(root, 'project'), 'init'],
        {
          env: {
            PATH: '/usr/bin:/bin',
            HOME: join(root, 'home'),
            GIT_CONFIG_NOSYSTEM: '1',
          },
          deadlineMs: 5_000,
        },
      )
      const result = { ...ran, status: ran.exitCode }
      expect(result.status).toBe(0)
      expect(
        readFileSync(join(root, 'project/.git/inert-template-canary'), 'utf8'),
      ).toBe('caller template')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }, 10_000)
  const optionsFor = (root: string, compare: string) =>
    parseArgs([
      '--profile',
      'native-job',
      '--out',
      join(root, 'fresh'),
      '--tarball',
      join(root, 'host.tgz'),
      '--compare',
      compare,
    ])
  test('native comparison refuses self comparison and invalid inputs before creating output', () => {
    const root = fs.realpathSync(
      mkdtempSync(join(tmpdir(), 'ga-native-compare-')),
    )
    try {
      const compare = join(root, 'retained.json')
      const symlink = join(root, 'retained-link.json')
      writeFileSync(compare, JSON.stringify(nativeMatrix()))
      symlinkSync(compare, symlink)
      const cases = [
        join(root, 'fresh/matrix.json'),
        join(root, 'missing.json'),
        symlink,
        root,
      ]
      for (const path of cases) {
        expect(() => {
          snapshotNativeComparison(optionsFor(root, path), pin)
        }).toThrow()
        expect(existsSync(join(root, 'fresh'))).toBe(false)
      }
      const wrongSource = nativeMatrix()
      wrongSource.sources['ga-measure-plugin.ts'] = '0'.repeat(64)
      for (const bytes of [
        'not JSON',
        JSON.stringify({ ...nativeMatrix(), full: false }),
        JSON.stringify(matrix()),
        JSON.stringify({ ...nativeMatrix(), rows: [] }),
        JSON.stringify(wrongSource),
      ]) {
        writeFileSync(compare, bytes)
        expect(() => {
          snapshotNativeComparison(optionsFor(root, compare), pin)
        }).toThrow()
        expect(existsSync(join(root, 'fresh'))).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('native comparison keeps validated snapshot bytes after the input is overwritten', () => {
    const root = fs.realpathSync(
      mkdtempSync(join(tmpdir(), 'ga-native-compare-snapshot-')),
    )
    try {
      const compare = join(root, 'retained.json')
      const retained = nativeMatrix()
      const bytes = `${JSON.stringify(retained)}\n`
      writeFileSync(compare, bytes)
      const snapshot = snapshotNativeComparison(optionsFor(root, compare), pin)
      expect(snapshot).toBeDefined()
      const changed = structuredClone(retained)
      changed.rows[1]!.outcome = 'proxied'
      changed.rows[1]!.recorder = 'A'
      writeFileSync(compare, JSON.stringify(changed))
      expect(() => snapshot!.compare(retained)).not.toThrow()
      expect(snapshot!.sha256).toBe(sha256(bytes))
      expect(() => snapshot!.compare(changed)).toThrow('difference')
      expect(existsSync(join(root, 'fresh'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('native comparison explicitly rejects an existing in-output matrix', () => {
    const root = fs.realpathSync(
      mkdtempSync(join(tmpdir(), 'ga-native-compare-self-')),
    )
    try {
      const out = join(root, 'fresh')
      mkdirSync(out)
      const compare = join(out, 'matrix.json')
      writeFileSync(compare, JSON.stringify(nativeMatrix()))
      expect(() => {
        snapshotNativeComparison(optionsFor(root, compare), pin)
      }).toThrow('outside fresh output tree')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('explicit matrix measurement profiles', () => {
  test('native profile round-trip retains truthful paths and all 253 rows', () => {
    const value = nativeMatrix()
    const parsed: unknown = MatrixSchema.parse(
      JSON.parse(JSON.stringify(value)),
    )
    expect(parsed).toEqual(value)
    expect(validateMatrix(value, pin).rows).toHaveLength(253)
  })
  test('Docker profile preserves the exact inner evidence and container row contract', () => {
    const value = matrix()
    expect(JSON.stringify(validateMatrix(value, pin).native)).toBe(
      JSON.stringify(assertNative(native)),
    )
    value.rows[0]!.pluginPath = '/tmp/native/inputs/ga-measure-plugin.ts'
    expect(() => {
      validateMatrix(value, pin)
    }).toThrow('unknown/malformed row')
  })
  test('Docker four-input layout loads without any native-job fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ga-docker-layout-'))
    try {
      for (const name of Object.keys(sourceDigests()))
        writeFileSync(join(root, name), readFileSync(join(HERE, name)))
      // The loader fails at its own deadline, before this test's timeout.
      const ran = await runCommand(
        [
          process.execPath,
          '-e',
          `import { readFileSync } from 'node:fs'; import { validateMatrix, PinSchema } from ${JSON.stringify(join(root, 'measure-ga-proxy-matrix.ts'))}; console.log(JSON.stringify(validateMatrix(JSON.parse(readFileSync(0, 'utf8')), PinSchema.parse(JSON.parse(readFileSync(${JSON.stringify(join(root, 'ga-binary-pin.json'))}, 'utf8')))).native))`,
        ],
        {
          stdin: JSON.stringify(matrix()),
          env: { PATH: process.env.PATH },
          deadlineMs: 15_000,
        },
      )
      // Keep the node-style fields the assertions read; a spawn failure now throws.
      const result = {
        ...ran,
        status: ran.exitCode,
        error: undefined as Error | undefined,
      }
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe(JSON.stringify(assertNative(native)))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
  test('missing and unknown matrix profiles are refused explicitly', () => {
    const { profile: _profile, ...untagged } = matrix()
    expect(() => {
      MatrixSchema.parse(untagged)
    }).toThrow()
    expect(() => {
      MatrixSchema.parse({ ...matrix(), profile: 'unknown' })
    }).toThrow()
  })
  test('mixed profile fields and swapped evidence are refused', () => {
    const job = nativeMatrix()
    for (const value of [
      { ...job, native: { ...job.native, image: native.image } },
      { ...matrix(), native: { ...native, boundary: job.native.boundary } },
      { ...job, native },
      { ...matrix(), native: job.native },
    ])
      expect(() => {
        MatrixSchema.parse(value)
      }).toThrow()
  })
  test('native executable identity is pinned independently of row identities', () => {
    for (const patch of [
      { sha256: '0'.repeat(64) },
      { bytes: 1 },
      { elfMachine: 183 },
      { reportedVersion: 'opencode v0.0.0' },
    ]) {
      const value = nativeMatrix()
      Object.assign(value.native.executable, patch)
      expect(() => {
        validateMatrix(value, pin)
      }).toThrow()
    }
  })
  test('native runtime refuses unapproved identities', () => {
    for (const patch of [
      { name: 'Node' },
      { version: '0.0.0' },
      { revision: '0'.repeat(40) },
    ]) {
      const value = nativeMatrix()
      Object.assign(value.native.runtime, patch)
      expect(() => {
        validateMatrix(value, pin)
      }).toThrow()
    }
  })
  test('native runner requires an ELF x64 identity and the pinned Bun runtime', () => {
    for (const patch of [
      { path: 'bun' },
      { sha256: 'bad' },
      { bytes: 0 },
      { elfMachine: 183 },
      { version: '0.0.0' },
      { revision: 'bad' },
    ]) {
      const value = nativeMatrix()
      Object.assign(value.native.runner, patch)
      expect(() => {
        MatrixSchema.parse(value)
      }).toThrow()
    }
  })
  test('native containment requires the real fixture control inventory', () => {
    for (const mutate of [
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.boundary.interfaces.push('eth0')
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.boundary.status.NoNewPrivs = '0'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.boundary.status.CapBnd = '0000000000000001'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.boundary.controls.pop()
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        Object.assign(v.native.boundary.controls[0]!, { errno: 0 })
      },
    ]) {
      const value = nativeMatrix()
      mutate(value)
      expect(() => {
        MatrixSchema.parse(value)
      }).toThrow()
    }
  })
  test('native layout binds the executable plugin and argv without Docker aliases', () => {
    for (const mutate of [
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.executable.path = '/tmp/wrong-opencode'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.native.root = '/tmp/../tmp/ga-native-schema-fixture'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.rows[0]!.pluginPath = '/input/ga-measure-plugin.ts'
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.rows[0]!.command = commandForCase(v.rows[0]!.id)
      },
      (v: ReturnType<typeof nativeMatrix>) => {
        v.rows[0]!.command[2] = '--different'
      },
    ]) {
      const value = nativeMatrix()
      mutate(value)
      expect(() => {
        validateMatrix(value, pin)
      }).toThrow()
    }
  })
  test('native sources are mandatory and partial matrices cannot conform', () => {
    const value = nativeMatrix()
    for (const key of Object.keys(value.sources)) {
      const changed = structuredClone(value)
      changed.sources[key] = '0'.repeat(64)
      expect(() => {
        validateMatrix(changed, pin)
      }).toThrow('source digest')
    }
    expect(() =>
      assertConformance({ ...value, full: false }, value, pin),
    ).toThrow()
    expect(() => assertConformance(value, matrix(), pin)).toThrow()
  })
  test('native comparison normalizes only validated job identities and retains raw runner bindings', () => {
    const value = nativeMatrix()
    const fresh = structuredClone(value)
    const root = '/tmp/ga-native-second-schema-fixture'
    fresh.native.root = root
    fresh.native.executable.path = `${root}/inputs/ga-verified-opencode`
    fresh.native.runner.device = '42'
    fresh.native.runner.inode = '456'
    fresh.native.boundary.namespace = 'net:[456]'
    const child = fresh.native.boundary.controls.find(
      (control) => control.control === 'child_inheritance',
    )!
    Object.assign(child, { namespace: 'net:[456]' })
    for (const row of fresh.rows) {
      row.pluginPath = `${root}/inputs/ga-measure-plugin.ts`
      row.command[0] = `${root}/inputs/ga-verified-opencode`
    }
    const before = JSON.stringify([fresh, value])
    expect(() => assertConformance(fresh, value, pin)).not.toThrow()
    expect(JSON.stringify([fresh, value])).toBe(before)
    fresh.native.runner.sha256 = 'b'.repeat(64)
    expect(() => assertConformance(fresh, value, pin)).toThrow('difference')
    fresh.native.runner.sha256 = value.native.runner.sha256
    fresh.native.runner.version = '0.0.0'
    expect(() => assertConformance(fresh, value, pin)).toThrow(
      'unexpected value 0.0.0; expected 1.4.2',
    )
    fresh.native.runner.version = value.native.runner.version
    fresh.native.runner.inode = '<runner-inode>'
    expect(() => assertConformance(fresh, value, pin)).toThrow(
      'malformed string',
    )
  })
  test('native argv is explicit absolute and never mixed with Docker admission', () => {
    const args = [
      '--profile',
      'native-job',
      '--out',
      '/tmp/fresh-native',
      '--tarball',
      '/tmp/host.tgz',
    ]
    expect(parseArgs(args).profile).toBe('native-job')
    for (const bad of [
      [...args, '--image', native.image],
      [...args, '--inside', 'native-container'],
      args.map((v) => (v === '/tmp/fresh-native' ? 'relative' : v)),
      args.map((v) => (v === '/tmp/host.tgz' ? 'relative.tgz' : v)),
      args.map((v) => (v === 'native-job' ? 'unknown' : v)),
      [
        ...args.map((v) => (v === 'native-job' ? 'unknown' : v)),
        '--image',
        native.image,
      ],
      args.slice(0, -2),
    ])
      expect(() => parseArgs(bad)).toThrow()
  })
  test('native launch admission refuses absent consent TLS bypass architecture and reused roots', () => {
    const parent = fs.realpathSync(
      mkdtempSync(join(tmpdir(), 'ga-native-admission-')),
    )
    try {
      const tarball = join(parent, 'host.tgz')
      writeFileSync(tarball, 'parser fixture only; no host is executed')
      const options = parseArgs([
        '--profile',
        'native-job',
        '--out',
        join(parent, 'fresh'),
        '--tarball',
        tarball,
      ])
      const admitted = { ANTIGRAVITY_GA_HOST_EXECUTION: '1' }
      expect(() =>
        assertNativeJobAdmission(options, admitted, 'linux', 'x64'),
      ).not.toThrow()
      for (const env of [
        {},
        { ANTIGRAVITY_GA_HOST_EXECUTION: '0' },
        { ...admitted, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      ])
        expect(() =>
          assertNativeJobAdmission(options, env, 'linux', 'x64'),
        ).toThrow()
      expect(() =>
        assertNativeJobAdmission(options, admitted, 'darwin', 'x64'),
      ).toThrow()
      expect(() =>
        assertNativeJobAdmission(options, admitted, 'linux', 'arm64'),
      ).toThrow()
      mkdirSync(options.out)
      expect(() =>
        assertNativeJobAdmission(options, admitted, 'linux', 'x64'),
      ).toThrow()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

// This is a parser fixture only. A tiny synthetic ELF must never be executed.
function syntheticArchive() {
  const bytes = Buffer.alloc(32)
  bytes.set(Buffer.from('7f454c460201', 'hex'))
  bytes.writeUInt16LE(62, 18)
  const header = Buffer.alloc(512)
  header.write('package/bin/opencode', 0)
  header.write('00000000040\0', 124)
  header.write('0', 156)
  header.fill(32, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  const tarball = gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc(512 - bytes.length),
      Buffer.alloc(1024),
    ]),
  )
  return {
    bytes,
    tarball,
    syntheticPin: {
      ...pin,
      binaryBytes: bytes.length,
      binarySha256: sha256(bytes),
      sri: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    },
  }
}

function checkObserverFixture(name: string, source: string) {
  const filename = join(HERE, `${name}.fixture.ts`)
  const options = {
    strict: true,
    noEmit: true,
    target: ScriptTarget.ES2023,
    module: ModuleKind.Preserve,
    moduleResolution: ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
  }
  const host = createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile
  // Only the fixture is virtual. The diagnostic type and its source closure
  // are read from the real contract file by the ordinary compiler host.
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path === filename
      ? createSourceFile(path, source, languageVersion, true)
      : originalGetSourceFile(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        )
  const program = createProgram([filename], options, host)
  return getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    message: flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))
}

describe('actual raw-sender observer type contract', () => {
  test('ga.raw-cancel.async-observer-rejected', () => {
    const preamble =
      "import type { ObserveRawSenderSignal } from './ga-loopback-request-contract.ts'\n"
    const positive = `${preamble}
export const observeRawSenderSignal: ObserveRawSenderSignal = (signal) => {
  signal.addEventListener('abort', () => {})
  return undefined
}
`
    const negative = `${preamble}
export const observeRawSenderSignal: ObserveRawSenderSignal = async (signal) => {
  signal.addEventListener('abort', () => {})
  return undefined
}
`
    expect(
      checkObserverFixture('ga.raw-cancel.sync-observer-accepted', positive),
    ).toEqual([])
    const diagnostics = checkObserverFixture(
      'ga.raw-cancel.async-observer-rejected',
      negative,
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.code).toBe(2322)
    expect(diagnostics[0]?.file).toBe(
      join(HERE, 'ga.raw-cancel.async-observer-rejected.fixture.ts'),
    )
    expect(diagnostics[0]?.message).toContain('Promise<undefined>')
    expect(diagnostics[0]?.message).toContain(
      "not assignable to type 'undefined'",
    )
    console.info(
      `TypeScript ${typescriptVersion}: synchronous observer accepted; async observer rejected with TS2322`,
    )
  }, 30_000)
})

describe('GA materialized inputs', () => {
  test('GA pin is the independently verified released x64 artifact, not a source attestation', () => {
    expect(pin.binarySha256).toBe(
      '32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122',
    )
    expect(pin.sri).toBe(
      'sha512-DlV1qgEDDnVqpTWMPqv7tCHCcXodzZBFaMcxjsiYdY6E5gHH2Q68JfasVksyQ1nu6m1887WQKGhOsepE+oKyYw==',
    )
    expect(pin.provenance.limits).toContain(
      'do not attest binary-to-source equivalence',
    )
    expect(() => PinSchema.parse({ ...pin, version: '2.0.20' })).toThrow()
    expect(() => PinSchema.parse({ ...pin, unknown: true })).toThrow()
  })
  test('V1 pins retain both independently verified 1.17.13 artifacts byte-exactly', () => {
    const bytes = readFileSync(join(HERE, 'opencode1-binary-pins.json'))
    expect(sha256(bytes)).toBe(
      '75a8b919bca7a36dae5f55ff85f3e4edfbf9e808fb7a75b41bbdc37579047b9a',
    )
    const value = JSON.parse(bytes.toString())
    expect(
      value.artifacts.map(
        (item: { package: string; elfMachine: number; version: string }) => [
          item.package,
          item.elfMachine,
          item.version,
        ],
      ),
    ).toEqual([
      ['opencode-linux-x64', 62, '1.17.13'],
      ['opencode-linux-arm64', 183, '1.17.13'],
    ])
  })
  test('overflow fixtures retain exact canned Google envelopes and provenance', () => {
    for (const [name, hash, bodyHash, length] of [
      [
        'gemini',
        '96945d1aa2e76e502993c9c5a0a0366af88e70df298b31ae61d327614724d61d',
        '8f7c248c6ea08caa5db181b1e4f27290a5cc508e259ef00bc2281035c42e982a',
        148,
      ],
      [
        'claude',
        '81575e79d0b0e88f3b5ff7cec9f65391c8844f813fcd945d5ace2e80b74ff43e',
        '773dfc1934b7d6b429f728b5842f5338ef69451b5513f4bf6b1ac48edbbec01f',
        113,
      ],
    ] as const) {
      const bytes = readFileSync(
        join(
          HERE,
          '../../opencode/src/plugin/shared/__fixtures__',
          `overflow-${name}.json`,
        ),
      )
      expect(sha256(bytes)).toBe(hash)
      const value = JSON.parse(bytes.toString())
      expect(value.status).toBe(400)
      expect(value.contentType).toBe('application/json')
      expect(value.bodySha256).toBe(bodyHash)
      expect(sha256(Buffer.from(value.body))).toBe(bodyHash)
      expect(Buffer.from(value.bodyBase64, 'base64')).toEqual(
        Buffer.from(value.body),
      )
      expect(Buffer.byteLength(value.body)).toBe(length)
      expect(JSON.parse(value.body).error.status).toBe('INVALID_ARGUMENT')
      expect(value.provenance.kind).toBe(
        'retained canned mock response, not a live backend capture',
      )
      expect(value.provenance.observedMagicContextRevision).toBe(
        'cda6851df61b3d53b900174e285cedcfecedb213',
      )
    }
  })
  test('measurement plugin is independent of proxies, retained matrices and the adapter', () => {
    const source = readFileSync(join(HERE, 'ga-measure-plugin.ts'), 'utf8')
    expect(source).not.toMatch(
      /(?:process\.env|Bun\.env)(?:\.[A-Za-z_]*[Pp][Rr][Oo][Xx][Yy]|\[['"][^'"]*[Pp][Rr][Oo][Xx][Yy])/,
    )
    expect(source).not.toMatch(
      /Object\.(?:entries|keys|values)\((?:process|Bun)\.env\)/,
    )
    expect(source).not.toMatch(
      /(?:opencode\/src|ga-proxy-env-matrix|antigravity)/i,
    )
    expect(source).toContain("import type { Plugin } from '@opencode/plugin'")
    expect(source).toMatch(/context\.session\.hook\(\s*['"]http\.request['"]/)
    expect(source).toContain("{ providerID: 'google' }")
  })
  test('runner has no ignored evidence or promoted output dependency', () => {
    const source = readFileSync(
      join(HERE, 'measure-ga-proxy-matrix.ts'),
      'utf8',
    )
    expect(source).not.toContain('.cortexkit')
    expect(source).not.toContain('ga-proxy-env-matrix.json')
    expect(source).not.toContain('ga-proxy-env-matrix.provenance.json')
  })
})

describe('released HTTP request contract', () => {
  test('pathname matching is exact, never origin-only', () => {
    expect(
      matchesGoogleContentPath('/v1beta/models/example:generateContent'),
    ).toBe(true)
    expect(
      matchesGoogleContentPath('/v1beta/models/example:streamGenerateContent'),
    ).toBe(true)
    for (const path of [
      '/v1beta/models/example:generateContent/extra',
      '/v1beta/models/example:streamGenerateContentFake',
      '/unrelated',
      '/agy/123',
      '/v1beta/models/:generateContent',
    ])
      expect(matchesGoogleContentPath(path)).toBe(false)
  })
  test('normalized dispatch freezes POST, job URL, only JSON content-type and exact empty object', async () => {
    expect(GA_LOOPBACK_REQUEST_CONTRACT.headers.copied).toEqual([])
    await assertRewriteConformance(
      new Request(`http://127.0.0.1:38191/agy/${primaryJob}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    for (const [url, init] of [
      [
        `http://localhost:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'fake',
          },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '',
        },
      ],
    ] as const)
      await expect(
        assertRewriteConformance(new Request(url, init)),
      ).rejects.toThrow()
  })
})

describe('fail-closed measurement inputs and inventory', () => {
  test('inventory includes six singles, all exclusion forms, conflicts and exact seven quoted rows', () => {
    const all = inventory()
    expect(all).toHaveLength(253)
    expect(new Set(all.map((item) => item.id)).size).toBe(253)
    expect(all.filter((item) => item.id.startsWith('single-'))).toHaveLength(6)
    expect(all.filter((item) => item.id.startsWith('quoted-'))).toHaveLength(7)
    for (const variable of [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]) {
      for (const slug of [
        'literal',
        'port',
        'localhost',
        'ipv6',
        'cidr',
        'wildcard',
        'empty',
        'padded',
        'uppercase',
        'wrong-port',
        'unrelated',
      ]) {
        expect(
          all.some((item) => item.id === `exclusion-${variable}-${slug}`),
        ).toBe(true)
        expect(
          all.some((item) => item.id === `exclusion-${variable}-list-${slug}`),
        ).toBe(true)
      }
    }
    expect(
      all.find((item) => item.id === 'quoted-http_proxy-dq')?.env.http_proxy,
    ).toBe('""')
    expect(
      all.find((item) => item.id === 'quoted-http_proxy-sq')?.env.http_proxy,
    ).toBe("''")
    expect(
      all.find((item) => item.id === 'raw-empty-http_proxy')?.env.http_proxy,
    ).toBe('')
    expect(
      new Set(all.map((item) => commandForCase(item.id).at(-1))).size,
    ).toBe(253)
  })
  test('selection refuses empty, duplicate and unknown cases and explicitly adds prerequisites', () => {
    for (const ids of [
      [],
      ['missing'],
      ['single-HTTP_PROXY', 'single-HTTP_PROXY'],
    ])
      expect(() => selectCases(ids)).toThrow()
    expect(
      selectCases(['exclusion-http_proxy-port']).map((item) => item.id),
    ).toEqual([
      'control-no-proxy',
      'single-http_proxy',
      'exclusion-http_proxy-port',
    ])
    expect(() => materialize({ HTTP_PROXY: '{unknown}' })).toThrow()
    expect(() => materialize({ UNKNOWN_PROXY: 'http://127.0.0.1' })).toThrow()
  })
  test('argv rejects zero selectors, unknown flags, mutable images and missing prerequisites', () => {
    for (const args of [
      [],
      ['--out', '/tmp/fresh'],
      [
        '--out',
        '/tmp/fresh',
        '--image',
        'ubuntu:latest',
        '--tarball',
        '/tmp/host.tgz',
      ],
      ['--out', '/tmp/fresh', '--inside', 'native-container', '--cases', ''],
      ['--out', '/tmp/fresh', '--inside', 'native-container', '--typo', '1'],
      ['--out', '/tmp/fresh', '--out', '/tmp/other'],
    ])
      expect(() => parseArgs(args)).toThrow()
    expect(
      parseArgs(['--out', '/tmp/fresh', '--inside', 'native-container']).inside,
    ).toBe('native-container')
  })
  test('isolation builds credentials, database and HOME/XDG from the row root, not the caller', () => {
    const env = isolatedEnv('/tmp/row-root', {
      HTTP_PROXY: 'http://127.0.0.1:38193',
    })
    expect(env.OPENCODE_DB).toBe('/tmp/row-root/db/opencode.db')
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ])
      expect(env[key]).toStartWith('/tmp/row-root/')
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('GA-FAKE-NOT-A-CREDENTIAL')
    expect(env.HTTPS_PROXY).toBeUndefined()
    const previous = process.env.GA_PRIVATE_ENV_CONTROL
    process.env.GA_PRIVATE_ENV_CONTROL = 'FAKE-ONLY'
    try {
      expect(
        isolatedEnv('/tmp/row-root', {}).GA_PRIVATE_ENV_CONTROL,
      ).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GA_PRIVATE_ENV_CONTROL
      else process.env.GA_PRIVATE_ENV_CONTROL = previous
    }
    expect(env.no_proxy).toBeUndefined()
  })
  test('SRI is checked before archive parsing and executable digest before execution', () => {
    const { tarball, bytes, syntheticPin } = syntheticArchive()
    expect(verifiedBinary(tarball, syntheticPin)).toEqual(bytes)
    expect(() => verifiedBinary(Buffer.from('not gzip'), syntheticPin)).toThrow(
      'SRI mismatch before extraction',
    )
    expect(() =>
      verifiedBinary(tarball, {
        ...syntheticPin,
        binarySha256: '0'.repeat(64),
      }),
    ).toThrow('digest/length mismatch before execution')
    expect(() =>
      verifiedBinary(tarball, { ...syntheticPin, elfMachine: 183 }),
    ).toThrow('ELF x86-64')
    expect(() => PinSchema.parse(syntheticPin)).toThrow()
  })
})

describe('primary-request attribution and native result validation', () => {
  test('tunnel parser retains split requests, chunked bodies and multiple jobs on one connection', () => {
    const head = `POST /agy/${titleJob} HTTP/1.1\r\nHost: 127.0.0.1:${PORTS.mock}\r\nContent-Length: 2\r\n\r\n`
    const next = `POST /agy/${primaryJob} HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`
    const parsed = parseTunnelRequests(
      Buffer.from(`${head}{}${next}`),
      `127.0.0.1:${PORTS.mock}`,
    )
    expect(parsed.requests).toEqual([
      {
        method: 'POST',
        target: `http://127.0.0.1:${PORTS.mock}/agy/${titleJob}`,
        body: '{}',
      },
      {
        method: 'POST',
        target: `http://127.0.0.1:${PORTS.mock}/agy/${primaryJob}`,
        body: '{}',
      },
    ])
    expect(parsed.remainder.length).toBe(0)
    expect(
      parseTunnelRequests(Buffer.from(`${head}{`), `127.0.0.1:${PORTS.mock}`)
        .requests,
    ).toHaveLength(0)
    const partial = Buffer.from(next.slice(0, -3))
    expect(
      parseTunnelRequests(partial, `127.0.0.1:${PORTS.mock}`).remainder,
    ).toEqual(partial)
    for (const bad of [
      'bad\r\n\r\n',
      'POST / HTTP/1.1\r\nContent-Length: fake\r\n\r\n',
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}',
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nbad-size\r\n',
    ])
      expect(() =>
        parseTunnelRequests(Buffer.from(bad), `127.0.0.1:${PORTS.mock}`),
      ).toThrow()
  })
  test('native CLI completion refuses error, zero, unknown, malformed and unterminated records', () => {
    const text = {
      type: 'text',
      timestamp: 1,
      sessionID: 'ses_fake',
      part: {
        id: 'p',
        sessionID: 'ses_fake',
        messageID: 'm',
        type: 'text',
        text: 'GA-MEASURE-OK',
        time: { start: 1, end: 2 },
      },
    }
    const finish = {
      type: 'step_finish',
      timestamp: 2,
      sessionID: 'ses_fake',
      part: {
        id: 'q',
        sessionID: 'ses_fake',
        messageID: 'm',
        type: 'step-finish',
        reason: 'stop',
        snapshot: 'fake',
        cost: 0,
        tokens: {
          input: 5,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    }
    const lines = (...values: unknown[]) =>
      values.map((value) => JSON.stringify(value)).join('\n')
    expect(() => assertCliCompletion(lines(text, finish))).not.toThrow()
    for (const value of [
      '',
      'not-json',
      lines(text),
      lines(finish),
      lines({ ...text, type: 'unknown' }),
      lines({ ...text, unknown: true }),
      lines({ ...text, sessionID: 'foreign' }, finish),
      lines({
        type: 'error',
        timestamp: 3,
        sessionID: 'ses_fake',
        error: {
          type: 'provider.transport',
          message: 'fake reset',
          status: 200,
        },
      }),
    ])
      expect(() => assertCliCompletion(value)).toThrow()
  })
  test('only a nonce-matched primary plus mock request proves direct', () => {
    expect(classify(nonce, events(), [wire()], pin)).toEqual({
      outcome: 'direct',
      recorder: null,
    })
    expect(() => classify('GA-NONCE-other', events(), [wire()], pin)).toThrow()
    expect(() => classify(nonce, [rewrite()], [wire()], pin)).toThrow()
    expect(() =>
      classify(nonce, [...events(), rewrite()], [wire()], pin),
    ).toThrow()
    expect(() => classify(nonce, events(), [], pin)).toThrow()
    expect(() => classify(nonce, events(), [wire(), wire()], pin)).toThrow()
    expect(() =>
      classify(nonce, events(), [{ ...wire(), body: 'not-json' }], pin),
    ).toThrow()
    expect(() =>
      classify(nonce, events(), [{ ...wire(), unknown: true }], pin),
    ).toThrow()
    expect(() => parseLines('{"valid":true}\nnot-json\n')).toThrow()
  })
  test('tied recorder HTTP and CONNECT prove proxied; untied CONNECT is refused', () => {
    const connection = 'abcdef01-0123-4123-a123-0123456789ab'
    const tunnel: Wire = {
      channel: 'A',
      method: 'CONNECT',
      target: `127.0.0.1:${PORTS.mock}`,
      body: '',
      connection,
    }
    expect(classify(nonce, events(), [wire(), wire('A')], pin)).toEqual({
      outcome: 'proxied',
      recorder: 'A',
    })
    expect(
      classify(
        nonce,
        events(),
        [wire(), tunnel, wire('A', primaryJob, connection)],
        pin,
      ),
    ).toEqual({ outcome: 'proxied', recorder: 'A' })
    expect(() => classify(nonce, events(), [wire(), tunnel], pin)).toThrow(
      'untied CONNECT',
    )
  })
  test('title-only CONNECT never counts as primary proxied', () => {
    const connection = 'abcdef01-0123-4123-a123-0123456789ab'
    expect(
      classify(
        nonce,
        [...events(), rewrite('title', titleJob)],
        [
          wire(),
          {
            channel: 'A',
            method: 'CONNECT',
            target: `127.0.0.1:${PORTS.mock}`,
            body: '',
            connection,
          },
          wire('A', titleJob, connection),
        ],
        pin,
      ),
    ).toEqual({ outcome: 'direct', recorder: null })
  })
  test('public fallthrough and runtime mismatches are infrastructure failures', () => {
    expect(() =>
      classify(nonce, events(), [wire(), wire('provider')], pin),
    ).toThrow('direct-provider')
    expect(() =>
      classify(
        nonce,
        [
          { type: 'setup', runtime: { ...pin.runtime, revision: 'bad' } },
          rewrite(),
        ],
        [wire()],
        pin,
      ),
    ).toThrow()
  })
  test('container x86_64 cannot certify an arm64 host or daemon', () => {
    expect(assertNative(native).containerUname).toBe('x86_64')
    for (const patch of [
      { hostUname: 'arm64' },
      { daemonArchitecture: 'aarch64' },
      { containerUname: 'aarch64' },
      { elfMachine: 183 },
      { interfaces: ['lo', 'eth0'] },
      { network: 'bridge' },
    ])
      expect(() => assertNative({ ...native, ...patch })).toThrow(
        'not native x86_64',
      )
  })
  test('matrix requires exact unique inventory, digest, schemas and positive control', () => {
    const good = matrix()
    expect(validateMatrix(good, pin).rows).toHaveLength(253)
    for (const mutate of [
      (m: Matrix) => {
        m.rows.pop()
      },
      (m: Matrix) => {
        m.rows.push(m.rows[0]!)
      },
      (m: Matrix) => {
        m.rows[0]!.id = 'unknown'
      },
      (m: Matrix) => {
        m.binarySha256 = `0${m.binarySha256.slice(1)}`
      },
      (m: Matrix) => {
        m.sources['ga-measure-plugin.ts'] = '0'.repeat(64)
      },
      (m: Matrix) => {
        m.rows[0]!.outcome = 'error'
        m.rows[0]!.reason = 'timeout'
      },
      (m: Matrix) => {
        m.rows[0]!.outcome = 'proxied'
        m.rows[0]!.recorder = 'A'
      },
      (m: Matrix) => {
        m.rows[0]!.command = ['not opencode']
      },
    ]) {
      const copy = structuredClone(good)
      mutate(copy)
      expect(() => validateMatrix(copy, pin)).toThrow()
    }
    expect(() => validateMatrix({ ...good, unknown: true }, pin)).toThrow()
    expect(() => validateMatrix({ ...good, rows: [] }, pin)).toThrow()
  })
  test('excluded rows require an observed unhonoured single, never a silent skip', () => {
    const good = matrix()
    const excluded = good.rows.find(
      (row) => row.id === 'exclusion-HTTPS_PROXY-literal',
    )!
    excluded.outcome = 'excluded'
    excluded.reason = 'unhonoured:single-HTTPS_PROXY'
    expect(validateMatrix(good, pin).rows).toHaveLength(253)
    expect(() =>
      validateMatrix(good, pin, inventory(), ['exclusion-HTTPS_PROXY-literal']),
    ).toThrow('zero-effective requested selector')
    excluded.reason = 'not run'
    expect(() => validateMatrix(good, pin)).toThrow('invalid exclusion')
    excluded.reason = 'unhonoured:single-HTTPS_PROXY'
    const prerequisite = good.rows.find(
      (row) => row.id === 'single-HTTPS_PROXY',
    )!
    prerequisite.outcome = 'proxied'
    prerequisite.recorder = 'A'
    expect(() => validateMatrix(good, pin)).toThrow('invalid exclusion')
  })
  test('conformance refuses absent retained output, focused results and normalized differences', () => {
    const good = matrix()
    expect(() =>
      assertConformance(good, structuredClone(good), pin),
    ).not.toThrow()
    expect(() => assertConformance(good, undefined, pin)).toThrow()
    const changed = structuredClone(good)
    changed.rows[1]!.outcome = 'proxied'
    changed.rows[1]!.recorder = 'A'
    expect(() => assertConformance(good, changed, pin)).toThrow('difference')
    const differentImage = structuredClone(good)
    differentImage.native.image = `sha256:${'b'.repeat(64)}`
    expect(() => assertConformance(good, differentImage, pin)).toThrow(
      'difference',
    )
    expect(() =>
      assertConformance({ ...good, full: false }, good, pin),
    ).toThrow()
  })
})

describe('GA shell runner fixture preflight, not native host certification', () => {
  test.each([
    { smoke: true, status: 42, witness: 'OWNED_DOCKER_BUILD_BOUNDARY' },
    {
      smoke: false,
      status: 2,
      witness:
        'Missing GA join input: packages/e2e-tests/docker/ga-proxy-env-matrix.json',
    },
  ])('enforces the correct fixture set with smoke=$smoke', async ({
    smoke,
    status,
    witness,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'agy-shell-preflight-'))
    const bin = join(root, 'bin')
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }
    // Each command fails at its own deadline, before this test's timeout.
    // Results keep the node-style fields the assertions read; a spawn failure throws.
    const command = async (file: string, args: string[]) => {
      const ran = await runCommand([file, ...args], {
        cwd: root,
        env,
        deadlineMs: 10_000,
      })
      return {
        ...ran,
        status: ran.exitCode,
        error: undefined as Error | undefined,
      }
    }
    try {
      mkdirSync(bin)
      const runner = 'packages/e2e-tests/docker/run-opencode-ga-test.sh'
      const input = 'packages/e2e-tests/src/owned-input.ts'
      for (const [path, contents] of [
        [runner, readFileSync(join(HERE, 'run-opencode-ga-test.sh'), 'utf8')],
        [
          'packages/e2e-tests/docker/opencode-ga/Dockerfile',
          readFileSync(join(HERE, 'opencode-ga/Dockerfile'), 'utf8'),
        ],
        ['packages/e2e-tests/docker/ga-binary-pin.json', '{}'],
        [
          'packages/opencode/docs/opencode2-ga-2.0.22-contract.md',
          'Owned fixture',
        ],
        [input, 'export {}'],
      ] as const) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), contents)
      }
      // These inert executables stop at image-build invocation. They never
      // create an image, start OpenCode or claim network-isolation evidence.
      writeFileSync(join(bin, 'uname'), '#!/bin/bash\necho x86_64\n', {
        mode: 0o700,
      })
      writeFileSync(
        join(bin, 'docker'),
        '#!/bin/bash\nif [[ "$1" == info ]]; then echo amd64; elif [[ "$1" == pull ]]; then exit 0; else echo OWNED_DOCKER_BUILD_BOUNDARY; exit 42; fi\n',
        { mode: 0o700 },
      )
      writeFileSync(join(bin, 'timeout'), '#!/bin/bash\nshift 3\nexec "$@"\n', {
        mode: 0o700,
      })
      for (const args of [
        ['init', '--quiet'],
        ['add', '.'],
        [
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--quiet',
          '-m',
          'Owned preflight fixture',
        ],
      ]) {
        const result = await command('git', args)
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
      }
      const result = await command('/bin/bash', [
        join(root, runner),
        ...(smoke ? ['--smoke'] : []),
        '--inputs',
        input,
      ])
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(status)
      expect(`${result.stdout}${result.stderr}`).toContain(witness)
      if (!smoke)
        expect(result.stdout).not.toContain('OWNED_DOCKER_BUILD_BOUNDARY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

test('Docker bootstrap avoids Hub and verifies Bun before extraction', () => {
  const source = readFileSync(join(HERE, 'opencode-ga/Dockerfile'), 'utf8')
  const baseImageDigest =
    'sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20'
  expect(source).toContain(
    `ARG BASE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim@${baseImageDigest}`,
  )
  expect(source).toContain('FROM ${BASE_IMAGE}')
  expect(source.split('\n').filter((line) => line.startsWith('FROM '))).toEqual(
    ['FROM ${BASE_IMAGE}'],
  )
  const script = readFileSync(join(HERE, 'run-opencode-ga-test.sh'), 'utf8')
  expect(script).toContain(`BASE_IMAGE_DIGEST="${baseImageDigest}"`)
  expect(script.split(baseImageDigest)).toHaveLength(2)
  const baseImageReferences = script
    .split('\n')
    .filter(
      (line) =>
        line.includes('public.ecr.aws/') || line.includes('mirror.gcr.io/'),
    )
  expect(baseImageReferences).toEqual([
    'ECR_BASE_IMAGE="public.ecr.aws/docker/library/node:24-bookworm-slim@${BASE_IMAGE_DIGEST}"',
    'MIRROR_BASE_IMAGE="mirror.gcr.io/library/node@${BASE_IMAGE_DIGEST}"',
  ])
  expect(script).toContain('docker pull --platform linux/amd64 "$image_ref"')
  expect(script).toContain('--build-arg "BASE_IMAGE=$BASE_IMAGE_REF"')
  expect(script).toContain('--pull=false')
  expect(script).not.toContain('docker.io')
  expect(script).not.toContain('hub.docker.com')
  expect(source).not.toContain('# syntax=')
  expect(source).not.toContain('FROM oven/bun')
  expect(source).not.toContain('FROM node:')
  expect(source).toContain(
    'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip',
  )
  expect(source).toContain(
    '99ebf3e6afe003b57eae3f257abce7e9aa851452429e84ef16b1b401e9d7cff1  /tmp/SHASUMS256.txt',
  )
  const manifestCheck = source.indexOf('sha256sum --check -')
  const archiveCheck = source.indexOf(
    'sha256sum --check --ignore-missing SHASUMS256.txt',
  )
  const extraction = source.indexOf('unzip -q')
  expect(manifestCheck).toBeGreaterThan(0)
  expect(archiveCheck).toBeGreaterThan(manifestCheck)
  expect(extraction).toBeGreaterThan(archiveCheck)
  expect(source).toContain('test "$(bun --version)" = 1.4.2')
  expect(
    source.indexOf(
      'bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts',
    ),
  ).toBeLessThan(source.indexOf('bun run build'))
})

test('motor-inert registration equals the independently frozen expanded inventory', () => {
  const expected =
    selectedTestProfile === 'motor-inert'
      ? [...MOTOR_INERT_EXPECTED].sort()
      : []
  const registered = [...motorRegistered].sort()
  console.log(
    `MOTOR_INERT_INVENTORY=${JSON.stringify({ revision: 'r6', profile: selectedTestProfile, expected, registered, executedAtInventoryCheck: [...motorExecuted], registeredCount: registered.length, executedCountAtInventoryCheck: motorExecuted.length })}`,
  )
  expect(registered).toEqual(expected)
  expect(new Set(motorRegistered).size).toBe(motorRegistered.length)
})
