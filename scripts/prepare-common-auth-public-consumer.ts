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
  let pipeTimer: ReturnType<typeof setTimeout> | undefined
  let leaderExited = false
  let pipesClosed = false
  let exitSignal: string | null = null
  let stdoutBytes = 0
  let stderrBytes = 0
  let parentDeadlineMs = 0
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
    const closed = new Promise<void>((resolve) =>
      child?.once('close', () => {
        pipesClosed = true
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
    executionTimer = setTimeout(
      () => stop(new Error('test command execution deadline exceeded')),
      bounds.executionMs,
    )
    await stopped
    clearTimeout(executionTimer)
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
    clearTimeout(pipeTimer)
    clearInterval(monitor)
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    try {
      inspector?.close()
    } catch (error) {
      cleanupFailure ??= error
      cleanupConfirmed = false
    }
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
