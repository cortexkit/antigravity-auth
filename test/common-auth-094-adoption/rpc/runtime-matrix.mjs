import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repository } from './fixture.mjs'
import { admitRuntime, runRuntime } from './run-runtime.mjs'

const required = [
  { flag: '--node20', name: 'Node 20.0.0', kind: 'node', version: 'v20.0.0' },
  { flag: '--node24', name: 'Node 24.16.0', kind: 'node', version: 'v24.16.0' },
  { flag: '--bun13', name: 'Bun 1.3.14', kind: 'bun', version: '1.3.14' },
  { flag: '--bun14', name: 'Bun 1.4.2', kind: 'bun', version: '1.4.2' },
]

export function parseMatrixArgs(args) {
  const paths = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    assert(
      required.some((runtime) => runtime.flag === flag),
      `Unknown RPC matrix flag: ${flag}`,
    )
    assert(!paths.has(flag), `Duplicate RPC matrix flag: ${flag}`)
    const path = args[index + 1]
    assert(
      typeof path === 'string' && path.trim() && !path.startsWith('--'),
      `Missing executable path for ${flag}`,
    )
    paths.set(flag, resolve(repository, path))
  }
  for (const { flag } of required)
    assert(paths.has(flag), `Missing required RPC matrix flag: ${flag}`)
  return required.map((runtime) => ({
    ...runtime,
    path: paths.get(runtime.flag),
  }))
}

export async function main(args) {
  // Run --version on every supplied binary and require its exact version before
  // creating fixtures or running RPC callbacks.
  const runtimes = parseMatrixArgs(args).map(admitRuntime)
  const failures = []
  for (const runtime of runtimes) {
    try {
      await runRuntime(runtime)
    } catch (error) {
      // A failing runtime must not erase the other required runtime observations.
      failures.push(error)
      console.error(`${runtime.name}: RPC matrix verification failed`, error)
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'RPC matrix did not pass all four required runtimes',
    )
  console.log(
    'RPC matrix: all 17 contracts passed on all four required exact runtimes',
  )
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  await main(process.argv.slice(2))
}
