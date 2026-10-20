#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PUBLIC_CONSUMER_ENV,
  provisionPublicConsumer,
  publicFixtureBytes,
} from '../packages/core/src/__fixtures__/common-auth-public-consumer.test.ts'
import { prepareLegacyWriter } from '../packages/core/src/__fixtures__/legacy-writer.test.ts'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandInspector,
  type PublicCommandScope,
  reapPublicCommandScope,
} from '../packages/core/src/__fixtures__/public-command-processes.test.ts'

import { createBuildPhaseReporter } from './build-phase-clock.ts'
import {
  BUN_SPAWNSYNC_WEDGE,
  bunSpawnSyncWedgeMessage,
  captureTestStall,
  createTestFileObserver,
  matchBunSpawnSyncWedge,
  ownedLiveTestChildren,
  readWedgeSnapshot,
  type WedgeSnapshot,
} from './test-stall-diagnostics.ts'

export const PUBLIC_COMMAND_BOUNDS = {
  executionMs: 20 * 60_000,
  reapMs: 5_000,
  termGraceMs: 1_000,
  outputCapBytes: 8 * 1024 * 1024,
} as const

export interface PublicCommandDiagnostic {
  periodicObservation: boolean
  calls: number
  dropped: number
  samples: {
    enteredMs: number
    exitedMs: number
    elapsedMs: number
    nativeTableRows: number | null
    nativeSessionMembers: number | null
    activeMembers: number | null
    parentDeadlineMs: number
    leaderExited: boolean
    pipesClosed: boolean
    stdoutBytes: number
    stderrBytes: number
    error: string | null
  }[]
  execution?: {
    argv: string[]
    env: NodeJS.ProcessEnv
    bounds:
      | typeof PUBLIC_COMMAND_BOUNDS
      | {
          executionMs: number
          reapMs: number
          termGraceMs: number
          outputCapBytes: number
        }
    startedMs: number
    parentDeadlineMs: number
  }
  completion?: {
    exitedMs: number
    status: number | null
    signal: string | null
    leaderExited: boolean
    pipesClosed: boolean
    stdoutBytes: number
    stderrBytes: number
    primary: string | null
    cleanupFailure: string | null
    cleanupConfirmed: boolean
    signals: PublicCommandScope['signals']
  }
}

/** How the supervisor watches for Bun's spawnSync wedge; tests inject the reader. */
export interface WedgeWatch {
  intervalMs: number
  read: (runnerPid: number) => Promise<WedgeSnapshot | undefined>
  platform: NodeJS.Platform
}

export const DEFAULT_WEDGE_WATCH: WedgeWatch = {
  intervalMs: BUN_SPAWNSYNC_WEDGE.checkIntervalMs,
  read: readWedgeSnapshot,
  platform: process.platform,
}

export function createPublicCommandDiagnostic(
  periodicObservation: boolean,
): PublicCommandDiagnostic {
  return { periodicObservation, calls: 0, dropped: 0, samples: [] }
}

// Usage: bun scripts/prepare-common-auth-public-consumer.ts <command> [args...]
// Both fixture variables name the same process-created directory. Every package
// member is checked against the fixed published archive before tests can use it.
export async function runPublicConsumerCommand(
  argv: string[],
  bounds: Readonly<{
    executionMs: number
    reapMs: number
    termGraceMs: number
    outputCapBytes: number
  }> = PUBLIC_COMMAND_BOUNDS,
  inspectorFactory: () => Promise<PublicCommandInspector> = createPublicCommandInspector,
  diagnostic?: PublicCommandDiagnostic,
  wedgeWatch: WedgeWatch = DEFAULT_WEDGE_WATCH,
): Promise<number> {
  const [command, ...args] = argv
  if (!command) throw new Error('explicit test command required')
  for (const key of Object.keys(
    PUBLIC_COMMAND_BOUNDS,
  ) as (keyof typeof PUBLIC_COMMAND_BOUNDS)[])
    if (
      !Number.isSafeInteger(bounds[key]) ||
      bounds[key] <= 0 ||
      bounds[key] > PUBLIC_COMMAND_BOUNDS[key]
    )
      throw new Error(
        `injected command bound must not exceed production: ${key}`,
      )
  const fixture = await provisionPublicConsumer()
  let cleanupConfirmed = true
  let primary: unknown
  let cleanupFailure: unknown
  let status: number | undefined
  let inspector: PublicCommandInspector | undefined
  let scope: PublicCommandScope | undefined
  let child: ReturnType<typeof spawn> | undefined
  let executionTimer: ReturnType<typeof setTimeout> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  let phaseMonitor: ReturnType<typeof setInterval> | undefined
  let wedgeMonitor: ReturnType<typeof setInterval> | undefined
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined
  let pipeTimer: ReturnType<typeof setTimeout> | undefined
  let leaderExited = false
  let pipesClosed = false
  let exitSignal: string | null = null
  let stdoutBytes = 0
  let stderrBytes = 0
  let parentDeadlineMs = 0
  let flushFileBoundaries = () => {}
  try {
    const oldDistRoot = await prepareLegacyWriter(fixture.root)
    for (const directory of [
      'home',
      'tmp',
      'config',
      'cache',
      'state',
      'data',
      'pi',
      'opencode',
    ])
      await mkdir(join(fixture.root, directory), { mode: 0o700 })
    console.log(
      JSON.stringify({ publicConsumer: fixture.root, ...fixture.receipt }),
    )
    console.log(
      (
        await publicFixtureBytes(
          join(oldDistRoot, 'legacy-writer-receipt.json'),
        )
      ).toString(),
    )
    inspector = await inspectorFactory()
    const childEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(fixture.root, 'home'),
      USERPROFILE: join(fixture.root, 'home'),
      TMPDIR: join(fixture.root, 'tmp'),
      TMP: join(fixture.root, 'tmp'),
      TEMP: join(fixture.root, 'tmp'),
      XDG_CONFIG_HOME: join(fixture.root, 'config'),
      XDG_CACHE_HOME: join(fixture.root, 'cache'),
      XDG_STATE_HOME: join(fixture.root, 'state'),
      XDG_DATA_HOME: join(fixture.root, 'data'),
      PI_AGENT_DIR: join(fixture.root, 'pi'),
      OPENCODE_CONFIG_DIR: join(fixture.root, 'opencode'),
      OPENCODE_DB: join(fixture.root, 'opencode.db'),
      [PUBLIC_CONSUMER_ENV]: fixture.root,
      ACCOUNT_MIGRATION_PUBLIC_INPUT_ROOT: fixture.root,
      ACCOUNT_MIGRATION_OLD_DIST_ROOT: oldDistRoot,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      NO_COLOR: '1',
      ...(process.env.AGY_TRACE_SIDEBAR_WINDOWS === '1'
        ? { AGY_TRACE_SIDEBAR_WINDOWS: '1' }
        : {}),
    }
    child = spawn(command === 'bun' ? process.execPath : command, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment,
    })
    const ownedPid = child.pid
    cleanupConfirmed = ownedPid === undefined
    let wake: () => void = () => {}
    const stopped = new Promise<void>((resolve) => {
      wake = resolve
    })
    const stop = (error: unknown) => {
      primary ??= error
      wake()
    }
    child.once('exit', (code, signal) => {
      leaderExited = true
      exitSignal = signal
      status = code ?? 1
      wake()
    })
    child.once('error', stop)
    const reportBuildPhases = createBuildPhaseReporter(fixture.root)
    let firstSlowSnapshot: string | undefined
    // Captures run ps asynchronously; a pending slow-file sample is awaited
    // before a later snapshot so it is still printed first.
    let slowSample: Promise<void> | undefined
    let deadlineSnapshot: string | undefined
    let sampledSlow = false
    let reportedFailure = false
    const snapshot = async (
      reason: 'deadline' | 'failure' | 'bun-spawnsync-wedge',
    ) => {
      files.flush()
      if (!scope || !inspector) return
      const [ownedScope, ownedInspector] = [scope, inspector]
      await slowSample
      if (firstSlowSnapshot) {
        console.error(firstSlowSnapshot)
        firstSlowSnapshot = undefined
      }
      const line =
        reason === 'deadline'
          ? (deadlineSnapshot ??
            (await captureTestStall(
              reason,
              ownedScope,
              ownedInspector,
              fixture.root,
            )))
          : await captureTestStall(
              reason,
              ownedScope,
              ownedInspector,
              fixture.root,
            )
      if (line) console.error(line)
    }
    const files = createTestFileObserver(
      ownedPid ?? -1,
      () => {
        if (!scope || !inspector) return null
        try {
          return ownedLiveTestChildren(scope, inspector)
        } catch {
          return null
        }
      },
      (line) => process.stderr.write(line),
    )
    flushFileBoundaries = () => {
      files.flush()
    }
    phaseMonitor = setInterval(() => {
      reportBuildPhases()
      if (!sampledSlow && files.slow() && scope && inspector) {
        sampledSlow = true
        // Keep the early sample quiet unless this command eventually fails.
        slowSample = captureTestStall(
          'slow-file',
          scope,
          inspector,
          fixture.root,
        ).then(
          (line) => {
            firstSlowSnapshot = line
          },
          () => {},
        )
      }
    }, 1_000)
    const closed = new Promise<void>((resolve) =>
      child?.once('close', () => {
        pipesClosed = true
        files.close()
        if (primary || status !== 0 || cleanupFailure) files.flush()
        resolve()
      }),
    )
    for (const [input, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      if (!input) throw new Error('owned command pipe unavailable')
      let bytes = 0
      input.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (input === child?.stdout) stdoutBytes = bytes
        else stderrBytes = bytes
        if (input === child?.stderr) {
          files.feed(chunk)
          if (!reportedFailure && /(?:^|\n)\(fail\) /.test(chunk.toString())) {
            reportedFailure = true
            void snapshot('failure').catch(() => {})
          }
        }
        if (bytes <= bounds.outputCapBytes) output.write(chunk)
        else stop(new Error('test command output cap exceeded'))
      })
      input.on('error', stop)
    }
    if (ownedPid !== undefined) {
      const leader = inspector.read(ownedPid)
      if (
        !leader ||
        leader.ppid !== process.pid ||
        leader.pgid !== ownedPid ||
        leader.sid !== ownedPid
      )
        throw new Error(
          'spawned command birth/session/group identity unavailable',
        )
      scope = { leader, observed: new Map([[leader.pid, leader]]), signals: [] }
      const ownedScope = scope,
        nativeInspector = inspector
      if (wedgeWatch.platform === 'linux') {
        // Fail fast on Bun's lost spawnSync child exit instead of spinning until
        // the execution deadline. A detected wedge stops the test command,
        // which is not restarted.
        let checking = false
        wedgeMonitor = setInterval(() => {
          if (checking || primary || !files.open()) return
          checking = true
          void wedgeWatch
            .read(ownedScope.leader.pid)
            .then(async (observed) => {
              const wedge = matchBunSpawnSyncWedge(
                observed,
                wedgeWatch.platform,
              )
              if (!wedge || primary) return
              clearInterval(wedgeMonitor)
              reportedFailure = true
              primary = new Error(bunSpawnSyncWedgeMessage(wedge))
              await snapshot('bun-spawnsync-wedge').catch(() => {})
              wake()
            })
            .catch(() => {})
            .finally(() => {
              checking = false
            })
        }, wedgeWatch.intervalMs)
      }
      if (diagnostic?.periodicObservation !== false)
        monitor = setInterval(() => {
          const enteredMs = diagnostic ? performance.now() : 0
          const generation = diagnostic
            ? nativeInspector.counts?.generation
            : undefined
          let activeMembers: number | null = null
          let failure: string | null = null
          try {
            activeMembers = inspectPublicCommandScope(
              ownedScope,
              nativeInspector,
            ).length
          } catch (error) {
            failure = String(error).slice(0, 256)
            stop(error)
          } finally {
            if (diagnostic) {
              diagnostic.calls++
              const exitedMs = performance.now()
              const counts = nativeInspector.counts
              if (diagnostic.samples.length < 16)
                diagnostic.samples.push({
                  enteredMs,
                  exitedMs,
                  elapsedMs: exitedMs - enteredMs,
                  nativeTableRows:
                    counts?.generation !== generation
                      ? (counts?.tableRows ?? null)
                      : null,
                  nativeSessionMembers:
                    counts?.generation !== generation
                      ? (counts?.sessionMembers ?? null)
                      : null,
                  activeMembers,
                  parentDeadlineMs,
                  leaderExited,
                  pipesClosed,
                  stdoutBytes,
                  stderrBytes,
                  error: failure,
                })
              else diagnostic.dropped++
            }
          }
        }, 1_000)
    }
    const executionStartedMs = performance.now()
    parentDeadlineMs = executionStartedMs + bounds.executionMs
    if (diagnostic)
      diagnostic.execution = {
        argv: [...child.spawnargs],
        env: { ...childEnvironment },
        bounds: { ...bounds },
        startedMs: executionStartedMs,
        parentDeadlineMs,
      }
    executionTimer = setTimeout(() => {
      reportedFailure = true
      // Record the cause now; release the run only after the snapshot printed.
      primary ??= new Error('test command execution deadline exceeded')
      void snapshot('deadline')
        .catch(() => {})
        .finally(wake)
    }, bounds.executionMs)
    snapshotTimer = setTimeout(
      () => {
        if (scope && inspector)
          void captureTestStall(
            'deadline',
            scope,
            inspector,
            fixture.root,
          ).then(
            (line) => {
              deadlineSnapshot = line
            },
            () => {},
          )
      },
      Math.max(
        1,
        bounds.executionMs - Math.min(1_000, bounds.executionMs / 10),
      ),
    )
    await stopped
    if ((primary || status !== 0) && !reportedFailure) await snapshot('failure')
    reportBuildPhases(
      primary || status !== 0
        ? String(primary ?? `test command exited with code ${status}`)
        : undefined,
    )
    clearInterval(phaseMonitor)
    clearInterval(wedgeMonitor)
    clearTimeout(executionTimer)
    clearTimeout(snapshotTimer)
    clearInterval(monitor)
    const deadline = performance.now() + bounds.reapMs
    if (scope) {
      try {
        await reapPublicCommandScope(
          scope,
          inspector,
          deadline,
          bounds.termGraceMs,
        )
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            pipeTimer = setTimeout(
              () =>
                reject(
                  new Error('owned command leader/pipe completion unconfirmed'),
                ),
              Math.max(1, deadline - performance.now()),
            )
          }),
        ])
        if (
          !leaderExited ||
          !pipesClosed ||
          inspectPublicCommandScope(scope, inspector).length !== 0
        )
          throw new Error('owned command completion unconfirmed')
        cleanupConfirmed = true
      } catch (error) {
        cleanupFailure = error
      }
    } else if (!cleanupConfirmed) {
      cleanupFailure = new Error(
        'spawned command cleanup cannot be verified without its birth identity',
      )
    }
  } catch (error) {
    primary ??= error
    if (!cleanupConfirmed && !cleanupFailure)
      cleanupFailure = new Error(
        'owned command cleanup unconfirmed; no unsafe signal attempted',
      )
  } finally {
    clearTimeout(executionTimer)
    clearTimeout(snapshotTimer)
    clearTimeout(pipeTimer)
    clearInterval(monitor)
    clearInterval(phaseMonitor)
    clearInterval(wedgeMonitor)
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    try {
      inspector?.close()
    } catch (error) {
      cleanupFailure ??= error
      cleanupConfirmed = false
    }
    if (primary || status !== 0 || cleanupFailure) flushFileBoundaries()
  }
  const commandFailure =
    primary ??
    (status !== undefined && status !== 0
      ? new Error(`test command exited with code ${status}`)
      : undefined)
  if (diagnostic)
    diagnostic.completion = {
      exitedMs: performance.now(),
      status: status ?? null,
      signal: exitSignal,
      leaderExited,
      pipesClosed,
      stdoutBytes,
      stderrBytes,
      primary: commandFailure ? String(commandFailure) : null,
      cleanupFailure: cleanupFailure ? String(cleanupFailure) : null,
      cleanupConfirmed: cleanupConfirmed && !cleanupFailure,
      signals: scope?.signals ?? [],
    }
  console.log(
    JSON.stringify({
      ownedCommandCleanup: cleanupConfirmed && !cleanupFailure,
      root: fixture.root,
      leader: scope
        ? {
            pid: scope.leader.pid,
            start: scope.leader.start.toString(),
            pgid: scope.leader.pgid,
            sid: scope.leader.sid,
          }
        : null,
      signals: scope?.signals ?? [],
      primary: commandFailure ? String(commandFailure) : null,
      cleanupFailure: cleanupFailure ? String(cleanupFailure) : null,
    }),
  )
  if (cleanupConfirmed && !cleanupFailure) {
    try {
      await fixture.remove()
    } catch (error) {
      cleanupFailure = error
    }
  }
  if (!cleanupConfirmed || cleanupFailure)
    throw new AggregateError(
      [
        ...(commandFailure === undefined ? [] : [commandFailure]),
        cleanupFailure ??
          new Error('owned session/group cleanup remains unconfirmed'),
      ],
      `owned command cleanup failed; retained fixture ${fixture.root}`,
    )
  if (primary) throw primary
  return status ?? 1
}

if (import.meta.main) {
  try {
    process.exitCode = await runPublicConsumerCommand(process.argv.slice(2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
