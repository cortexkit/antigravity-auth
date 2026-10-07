import { expect, test } from 'bun:test'
import { caseNames } from './fixture.mjs'
import { admitRuntime, runRuntime } from './run-runtime.mjs'

// Routine units use the executing Bun, even when the preload isolates HOME.
// The separately mandatory matrix admits all four explicitly supplied binaries.
test('S-RPC complete contracts on the current unit-test runtime', async () => {
  const version = process.versions.bun ?? process.version
  const runtime = admitRuntime({
    name: `Current runtime ${version}`,
    kind: process.versions.bun ? 'bun' : 'node',
    version,
    path: process.execPath,
  })
  const receipt = await runRuntime(runtime)
  expect(receipt.rows.map((row: { name: string }) => row.name)).toEqual(
    caseNames,
  )
  expect(receipt.exit).toBe(0)
}, 60000)
