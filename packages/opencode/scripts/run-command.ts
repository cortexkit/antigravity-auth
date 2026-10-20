import { spawn } from 'node:child_process'

export type CommandResult = {
  pid?: number
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
  stdout: string
  stderr: string
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    deadlineMs: number
    maxBufferBytes?: number
  },
): Promise<CommandResult> {
  const maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputError: Error | undefined
    let spawnError: Error | undefined
    let timedOut = false

    const kill = () => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        }
      }
      child.kill('SIGKILL')
    }
    const deadline = setTimeout(() => {
      timedOut = true
      kill()
    }, options.deadlineMs)

    const collect = (
      chunks: Buffer[],
      data: Buffer,
      stream: 'stdout' | 'stderr',
    ) => {
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes
      if (used + data.length > maxBufferBytes) {
        outputError ??= new Error(
          `${command} ${args.join(' ')} exceeded ${maxBufferBytes} output bytes`,
        )
        kill()
        return
      }
      chunks.push(data)
      if (stream === 'stdout') stdoutBytes += data.length
      else stderrBytes += data.length
    }

    child.stdout?.on('data', (data: Buffer) => collect(stdout, data, 'stdout'))
    child.stderr?.on('data', (data: Buffer) => collect(stderr, data, 'stderr'))
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (timedOut) {
        reject(
          new Error(
            `Command timed out after ${options.deadlineMs} ms: ${command} ${args.join(' ')}`,
          ),
        )
        return
      }
      resolve({
        pid: child.pid,
        status: spawnError || outputError ? null : status,
        signal,
        error: spawnError ?? outputError,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}
