import { expect, test } from 'bun:test'
import { createServer } from 'node:net'

import { ANTIGRAVITY_REDIRECT_URI } from '../constants'
import { startOAuthListener } from './server.ts'

const CALLBACK_TIMEOUT_MS = 60
const CALLBACK_TIMER_GRACE_MS = 250
const CHILD_EXECUTION_BOUND_MS = 5_000

const redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI)
const port = Number.parseInt(redirectUri.port, 10)

function callbackUrl(path = redirectUri.pathname): URL {
  const url = new URL(redirectUri)
  url.hostname = '127.0.0.1'
  url.pathname = path
  url.searchParams.set('code', 'callback-code')
  url.searchParams.set('state', 'callback-state')
  return url
}

async function listenOccupant() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
  return server
}

async function runBoundedChild(childScript: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const child = Bun.spawn([process.execPath, '-e', childScript], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const killTimer = setTimeout(
    () => child.kill('SIGKILL'),
    CHILD_EXECUTION_BOUND_MS,
  )

  try {
    const [stdout, stderr, exitCode] = await output
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(killTimer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await output
  }
}

test('startOAuthListener clears its callback timer when startup fails', async () => {
  const occupant = await listenOccupant()
  let child: ReturnType<typeof Bun.spawn> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let output: Promise<[string, string, number]> | undefined

  try {
    const listenerModule = new URL('./server.ts', import.meta.url).href
    const childScript = `
      import { startOAuthListener } from ${JSON.stringify(listenerModule)}
      try {
        const listener = await startOAuthListener({ timeoutMs: ${CALLBACK_TIMEOUT_MS} })
        await listener.close()
        process.stderr.write('OAuth listener unexpectedly started\\n')
        process.exitCode = 2
      } catch (error) {
        const startupError = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error)
        process.stdout.write(JSON.stringify({ startupError }) + '\\n')
        await new Promise((resolve) => setTimeout(resolve, ${CALLBACK_TIMER_GRACE_MS}))
      }
    `
    const spawned = Bun.spawn([process.execPath, '-e', childScript], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child = spawned
    output = Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ])
    killTimer = setTimeout(
      () => spawned.kill('SIGKILL'),
      CHILD_EXECUTION_BOUND_MS,
    )

    const [stdout, stderr, exitCode] = await output
    const childError = JSON.parse(stdout) as {
      startupError: { name: string; message: string; stack: string }
    }
    expect({
      exitCode,
      stdout,
      stderr,
      startupError: childError.startupError,
    }).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('"startupError"'),
      stderr: '',
      startupError: {
        name: 'Error',
        message:
          `Port ${port} is already in use. ` +
          'Another process is occupying this port. ' +
          'Please terminate the process or try again later.',
        stack: expect.any(String),
      },
    })
  } finally {
    if (killTimer) clearTimeout(killTimer)
    if (child?.exitCode === null) child.kill('SIGKILL')
    if (child) await child.exited
    if (output) await output
    await new Promise<void>((resolve, reject) => {
      occupant.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

test('startOAuthListener clears its callback timer when listen throws synchronously', async () => {
  const listenerModule = new URL('./server.ts', import.meta.url).href
  const childScript = `
    import { Server } from 'node:http'
    Server.prototype.listen = function () {
      throw new Error('Synthetic synchronous listener startup failure')
    }
    const { startOAuthListener } = await import(${JSON.stringify(listenerModule)})
    try {
      const listener = await startOAuthListener({ timeoutMs: ${CALLBACK_TIMEOUT_MS} })
      await listener.close()
      process.stderr.write('OAuth listener unexpectedly started\\n')
      process.exitCode = 2
    } catch (error) {
      const startupError = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error)
      process.stdout.write(JSON.stringify({ startupError }) + '\\n')
      await new Promise((resolve) => setTimeout(resolve, ${CALLBACK_TIMER_GRACE_MS}))
    }
  `
  const child = await runBoundedChild(childScript)
  const childError = JSON.parse(child.stdout) as {
    startupError: { name: string; message: string; stack: string }
  }

  expect({ ...child, startupError: childError.startupError }).toEqual({
    exitCode: 0,
    stdout: expect.stringContaining('"startupError"'),
    stderr: '',
    startupError: {
      name: 'Error',
      message: 'Synthetic synchronous listener startup failure',
      stack: expect.any(String),
    },
  })
})

test('startOAuthListener resolves a valid callback and serves the success page', async () => {
  const listener = await startOAuthListener({ timeoutMs: 1_000 })
  const callback = listener.waitForCallback()

  try {
    const response = await fetch(callbackUrl())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authentication Successful')
    const received = await callback
    expect(received.pathname).toBe(redirectUri.pathname)
    expect(received.searchParams.get('code')).toBe('callback-code')
    expect(received.searchParams.get('state')).toBe('callback-state')
  } finally {
    await listener.close()
  }
})

test('startOAuthListener ignores a wrong callback path', async () => {
  const listener = await startOAuthListener({ timeoutMs: 1_000 })
  const callback = listener.waitForCallback()

  try {
    const wrongPathResponse = await fetch(callbackUrl('/wrong-path'))
    expect(wrongPathResponse.status).toBe(404)
    await expect(
      Promise.race([callback.then(() => true), Promise.resolve(false)]),
    ).resolves.toBe(false)

    const response = await fetch(callbackUrl())
    expect(response.status).toBe(200)
    await expect(callback).resolves.toMatchObject({
      pathname: redirectUri.pathname,
    })
  } finally {
    await listener.close()
  }
})

test('startOAuthListener rejects a callback that times out', async () => {
  const listener = await startOAuthListener({ timeoutMs: 40 })
  const callback = listener.waitForCallback()

  try {
    await expect(callback).rejects.toThrow(
      'Timed out waiting for OAuth callback',
    )
  } finally {
    await listener.close()
  }
})

test('startOAuthListener rejects a callback when closed before it arrives', async () => {
  const listener = await startOAuthListener({ timeoutMs: 1_000 })
  const callback = listener.waitForCallback()

  await listener.close()
  await expect(callback).rejects.toThrow(
    'OAuth listener closed before callback',
  )
})
