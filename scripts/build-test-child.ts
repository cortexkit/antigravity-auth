import { spawn } from 'node:child_process'
import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandScope,
  reapPublicCommandScope,
} from '../packages/core/src/__fixtures__/public-command-processes.test.ts'

export class UnreapedBuildTestChild extends Error {}

/** Reserve the last five seconds of the setup budget for confirmed child/pipe reaping. */
export async function runBuildTestChild(
  argv: string[],
  deadline: number,
): Promise<void> {
  const inspector = await createPublicCommandInspector()
  let scope: PublicCommandScope | undefined
  let primary: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  let pipeTimer: ReturnType<typeof setTimeout> | undefined
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  let status: number | null = null
  let signal: string | null = null
  let closed = false
  let wake = () => {}
  const stopped = new Promise<void>((resolve) => {
    wake = resolve
  })
  const stop = (error: unknown) => {
    primary ??= error
    wake()
  }
  child.once('error', stop)
  child.once('exit', (code, reason) => {
    exited = true
    status = code
    signal = reason
    wake()
  })
  const pipes = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true
      resolve()
    }),
  )
  let bytes = 0
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024)
        stop(new Error('build test child output cap exceeded'))
    })
    stream?.on('error', stop)
  }
  try {
    const leader =
      child.pid === undefined ? undefined : inspector.read(child.pid)
    if (
      !leader ||
      leader.ppid !== process.pid ||
      leader.pgid !== leader.pid ||
      leader.sid !== leader.pid
    )
      throw new UnreapedBuildTestChild(
        'build child ownership unavailable; retain fixture',
      )
    scope = { leader, observed: new Map([[leader.pid, leader]]), signals: [] }
    const owned = scope
    monitor = setInterval(() => {
      try {
        inspectPublicCommandScope(owned, inspector)
      } catch (error) {
        stop(error)
      }
    }, 50)
    timer = setTimeout(
      () => stop(new Error('build setup child deadline exceeded')),
      Math.max(1, deadline - performance.now() - 5_000),
    )
    await stopped
    clearTimeout(timer)
    clearInterval(monitor)
    try {
      await reapPublicCommandScope(scope, inspector, deadline, 1_000)
      await Promise.race([
        pipes,
        new Promise<never>((_, reject) => {
          pipeTimer = setTimeout(
            () => reject(new Error('build child pipes did not close')),
            Math.max(1, deadline - performance.now()),
          )
        }),
      ])
      if (
        !exited ||
        !closed ||
        inspectPublicCommandScope(scope, inspector).length
      )
        throw new Error('build child completion unconfirmed')
    } catch {
      throw new UnreapedBuildTestChild(
        'build child reaping unconfirmed; retain fixture',
      )
    }
    if (primary) throw primary
    if (status !== 0 || signal)
      throw new Error(
        `build test child failed: status=${status} signal=${signal}`,
      )
  } finally {
    clearTimeout(timer)
    clearTimeout(pipeTimer)
    clearInterval(monitor)
    child.stdout?.destroy()
    child.stderr?.destroy()
    inspector.close()
  }
}
