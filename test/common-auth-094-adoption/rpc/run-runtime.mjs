import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fixture, hash, repository } from './fixture.mjs'
import { validateResult } from './result-validator.mjs'

/**
 * Run one child asynchronously and collect its output. This module is loaded
 * by Bun tests and by the Node runtime matrix, so it cannot use the Bun-only
 * test/support/run-command.ts helper; it follows the same rules. A synchronous
 * spawn can hang a Bun test runner on Linux (oven-sh/bun#34069). A spawn failure
 * resolves with `error` set, as spawnSync reported it. Past the deadline the
 * child is killed and the call throws with the command name. Nothing retries.
 */
function runChild(file, args, deadlineMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let error
    let expired = false
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    let settled = false
    const finish = (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (expired)
        reject(
          new Error(
            `command ${basename(file)} (argc=${args.length + 1}) exceeded its ${deadlineMs} ms deadline and was killed`,
          ),
        )
      else resolve({ status, signal, stdout, stderr, error })
    }
    let timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
      // Report once the child is reaped, without waiting on pipes a grandchild
      // may still hold; give up waiting after a short bound.
      child.once('exit', () => finish(null, 'SIGKILL'))
      timer = setTimeout(() => finish(null, null), 2000)
    }, deadlineMs)
    child.once('error', (cause) => {
      error = cause
      // A child that never started has no exit or pipes to wait for.
      if (child.pid === undefined) finish(null, null)
    })
    // close follows both exit and the end of both output pipes.
    child.once('close', finish)
  })
}

export async function admitRuntime(runtime) {
  assert(
    isAbsolute(runtime.path),
    `${runtime.name}: supply an explicit executable path`,
  )
  const child = await runChild(runtime.path, ['--version'], 5000)
  assert.equal(
    child.error,
    undefined,
    `${runtime.name}: executable admission failed: ${child.error}`,
  )
  assert.equal(
    child.status,
    0,
    `${runtime.name}: --version failed: ${child.stderr}`,
  )
  assert.equal(
    child.stdout.trim(),
    runtime.version,
    `${runtime.name}: wrong exact version`,
  )
  return { ...runtime, admittedVersion: child.stdout.trim() }
}

export async function runRuntime(runtime) {
  const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
  await mkdir(owned, { recursive: true })
  const root = await mkdtemp(join(owned, 'runtime-'))
  try {
    const inputs = await fixture(root)
    const argv = [
      join(repository, 'test/common-auth-094-adoption/rpc/runtime.mjs'),
      root,
    ]
    const child = await runChild(runtime.path, argv, 45000)
    assert.equal(
      child.error,
      undefined,
      `${runtime.name}: runtime child failed: ${child.error}`,
    )
    const { result, failures } = validateResult(
      JSON.parse(child.stdout.trim()),
      child.status,
    )
    if (runtime.kind === 'bun')
      assert.equal(
        result.bun,
        runtime.version,
        `${runtime.name}: child runtime mismatch`,
      )
    else {
      assert.equal(result.bun, null, `${runtime.name}: child is not Node`)
      assert.equal(
        result.runtime,
        runtime.version,
        `${runtime.name}: child runtime mismatch`,
      )
    }
    // These hashes record the executed inputs. Compare them with a separately
    // frozen artifact, not expected values derived from this same receipt.
    const receipt = {
      executable: runtime.path,
      executableSha256: hash(await readFile(runtime.path)),
      version: runtime.admittedVersion,
      argv,
      cwd: repository,
      inputs,
      exit: child.status,
      stderr: child.stderr,
      ...result,
    }
    const evidence = await mkdtemp(join(owned, 'receipt-'))
    // JSON evidence is data, not a source file for repository format/write gates.
    const receiptPath = join(evidence, 'result.receipt')
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2))
    console.log(
      JSON.stringify({
        runtime: runtime.name,
        receipt: receiptPath,
        exit: child.status,
        cases: result.rows.map((row) => ({ name: row.name, ok: row.ok })),
        idle: result.rows.find((row) => row.name === 'rpc.timeout_zero')
          .observation,
      }),
    )
    assert.equal(
      failures.length,
      0,
      `${runtime.name}: named failures: ${JSON.stringify(failures)}`,
    )
    return receipt
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
