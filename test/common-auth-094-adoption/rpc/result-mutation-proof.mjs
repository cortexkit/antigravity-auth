import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hash, repository } from './fixture.mjs'

const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
await mkdir(owned, { recursive: true })
const root = await mkdtemp(join(owned, 'result-proof-'))
const git = (...args) => {
  const child = spawnSync('git', args, { cwd: repository, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout
}
const path = join(root, 'result-validator.mjs')
const relativePath = relative(repository, path)
const expected =
  'rpc.results.strict_boolean_refusal: malformed truthy success is not acceptance'
const unaffected = [
  'rpc.results.valid_success: complete boolean success agrees with exit zero',
  'rpc.results.valid_named_red: a complete named failure agrees with exit one',
  'rpc.results.inventory_refusal: missing duplicate unknown and reordered rows fail',
  'rpc.results.exit_refusal: unsupported and contradictory exits cannot be green',
  'rpc.results.schema_refusal: malformed empty and contradictory evidence fails',
  'rpc.matrix.cli: four explicit paths preserve all required exact versions',
  'rpc.matrix.cli_refusal: missing duplicate unknown and valueless flags fail',
  'rpc.matrix.admission_refusal: missing executables and wrong versions fail before callbacks',
]

// Relocate only relative imports in these disposable copies. All dependencies
// except the mutated validator still resolve to the live verification modules.
const source = await readFile(
  join(repository, 'test/common-auth-094-adoption/rpc/result-validator.mjs'),
  'utf8',
)
const original = source.replace(
  "from './fixture.mjs'",
  "from '../../fixture.mjs'",
)
const tests = await readFile(
  join(repository, 'test/common-auth-094-adoption/rpc/result-boundary.test.ts'),
  'utf8',
)
await writeFile(path, original)
await writeFile(
  join(root, 'result-boundary.test.ts'),
  tests
    .replace("from './fixture.mjs'", "from '../../fixture.mjs'")
    .replace("from './run-runtime.mjs'", "from '../../run-runtime.mjs'")
    .replace("from './runtime-matrix.mjs'", "from '../../runtime-matrix.mjs'"),
)
git('add', '-f', '--', relativePath)
assert.equal(
  git('diff', '--stat'),
  '',
  'stage intentional changes before the proof',
)
let receipt
try {
  assert(
    original.includes('typeof row.ok,'),
    'strict boolean guard must be reached',
  )
  await writeFile(
    path,
    `// NON-VACUITY BREAK: coerce malformed success into boolean success\n${original.replace('typeof row.ok,', 'typeof (row.ok = Boolean(row.ok)),')}`,
  )
  const applied = git('diff', '--stat')
  assert(applied.trim())
  const child = spawnSync(
    process.execPath,
    ['test', '--isolate', join(root, 'result-boundary.test.ts')],
    {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  )
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  const output = child.stdout + child.stderr
  const names = (kind) =>
    [
      ...output.matchAll(
        new RegExp(`^\\(${kind}\\) (.+?)(?: \\[.*?\\])?$`, 'gm'),
      ),
    ].map((match) => match[1])
  assert.deepEqual(names('fail'), [expected], output)
  assert.deepEqual(names('pass'), unaffected, output)
  receipt = {
    control: 'Coerce non-boolean child success with Boolean(row.ok)',
    expected_red: expected,
    captured_output: output
      .split('\n')
      .find((line) => line.startsWith(`(fail) ${expected}`)),
    unaffected,
    outcome: 'reddened',
    original_sha256: hash(original),
    applied,
  }
} finally {
  await writeFile(path, original)
  assert.equal(hash(await readFile(path)), hash(original))
  const restored = git('diff', '--stat')
  assert.equal(restored, '')
  if (receipt) {
    receipt.applied_evidence = `${relativePath}: non-empty during mutation: ${receipt.applied.trim()}; empty after byte-exact restore: ${JSON.stringify(restored)}`
    await writeFile(
      join(owned, 'result-mutation-receipt.receipt'),
      JSON.stringify(receipt, null, 2),
    )
    console.log(JSON.stringify(receipt))
  }
  git('rm', '--cached', '-f', '--', relativePath)
  await rm(root, { recursive: true, force: true })
}
