import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fixture, hash, repository } from './fixture.mjs'
import { validateResult } from './result-validator.mjs'

export function admitRuntime(runtime) {
  assert(
    isAbsolute(runtime.path),
    `${runtime.name}: supply an explicit executable path`,
  )
  const child = spawnSync(runtime.path, ['--version'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 5000,
  })
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
    const child = spawnSync(runtime.path, argv, {
      cwd: repository,
      encoding: 'utf8',
      timeout: 45000,
    })
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
