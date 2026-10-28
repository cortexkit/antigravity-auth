import { spawn } from 'node:child_process'

/**
 * Collect a CLI attempt through close, including after deadline or output-limit kills.
 * @returns {Promise<{pid: number | undefined, stdout: string, stderr: string, status: number | null, signal: string | null, error: Error | undefined, timedOut: boolean}>}
 */
export async function collectRelocationCommand(
  label,
  executable,
  args,
  { cwd, env, deadlineMs = 120_000, maxBuffer = 4 * 1024 * 1024 } = {},
) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let error
  let timedOut = false
  const stop = (failure) => {
    error ??= failure
    child.kill('SIGKILL')
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop(new Error(`${label} exceeded its ${deadlineMs}ms command deadline`))
  }, deadlineMs)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const collect = (stream, chunk) => {
    const current = stream === 'stdout' ? stdout : stderr
    if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > maxBuffer) {
      stop(new Error(`${label} exceeded its ${maxBuffer}-byte ${stream} limit`))
      return
    }
    if (stream === 'stdout') stdout += chunk
    else stderr += chunk
  }
  child.stdout.on('data', (chunk) => collect('stdout', chunk))
  child.stderr.on('data', (chunk) => collect('stderr', chunk))
  child.on('error', (failure) => {
    error ??= failure
  })
  return new Promise((resolve) => {
    // Do not return on timeout alone: close confirms the killed child was reaped.
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({
        pid: child.pid,
        stdout,
        stderr,
        status: status ?? null,
        signal: signal ?? null,
        error,
        timedOut,
      })
    })
  })
}
