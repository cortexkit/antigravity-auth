import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyMutationResult } from './mutation-records.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const helper = 'mutation-records.mjs'
const inventory = [
  'mutation.records.exact_inventory',
  'mutation.records.diagnostic_prefixes',
  'mutation.records.missing_pass',
  'mutation.records.duplicate_pass',
  'mutation.records.foreign_pass',
  'mutation.records.wrong_failure',
  'mutation.records.process_failures',
  'mutation.records.complete_green_control',
]
const controls = [
  {
    name: 'Bun record start-of-line anchor',
    red: 'mutation.records.diagnostic_prefixes',
    from: '/^\\((pass|fail)\\)',
    to: '/\\((pass|fail)\\)',
  },
  {
    name: 'distinct unaffected pass names',
    red: 'mutation.records.duplicate_pass',
    from: 'distinct(left) &&',
    to: 'true &&',
  },
  {
    name: 'exact unaffected pass-name membership',
    red: 'mutation.records.foreign_pass',
    from: 'left.every((name) => right.includes(name))',
    to: 'true',
  },
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const command = (cwd, program, args) =>
  execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 30000 })
const base = await mkdtemp(join(here, '.record-mutations-'))
try {
  // Parser controls execute only pure-data tests: no compiler, install or Docker workload.
  for (const file of [helper, 'mutation-records.test.ts'])
    await cp(join(here, file), join(base, file))
  command(base, 'git', ['init', '-q'])
  command(base, 'git', ['add', helper])
  const path = join(base, helper)
  const original = await readFile(path)
  for (const control of controls) {
    command(base, 'git', ['add', helper])
    if (command(base, 'git', ['diff', '--stat']).trim())
      throw new Error('Dirty parser mutation baseline')
    if (original.toString().split(control.from).length !== 2)
      throw new Error(`Ambiguous parser control: ${control.name}`)
    await writeFile(
      path,
      `${original.toString().replace(control.from, control.to)}\n// NON-VACUITY BREAK\n`,
    )
    const during = command(base, 'git', ['diff', '--stat']).trim()
    if (!during) throw new Error('Empty parser mutation diff')
    const result = spawnSync(
      'bun',
      ['test', '--isolate', './mutation-records.test.ts'],
      { cwd: base, encoding: 'utf8', timeout: 30000 },
    )
    const { failures, passes, outcome } = classifyMutationResult(
      result,
      control.red,
      inventory,
    )
    await writeFile(path, original)
    const after = command(base, 'git', ['diff', '--stat']).trim()
    if (after || hash(await readFile(path)) !== hash(original))
      throw new Error('Parser mutation restoration failed')
    console.log(
      JSON.stringify({
        control: control.name,
        expected_red: control.red,
        captured_output:
          `${failures.map((name) => `(fail) ${name}`).join('; ')}; unaffected: ${passes.join(', ')}`.slice(
            0,
            400,
          ),
        applied_evidence: `${helper}; original SHA256 ${hash(original)}; NON-VACUITY BREAK; during: ${during}; after: empty unstaged diff and original hash verified`,
        outcome,
      }),
    )
    if (outcome !== 'reddened')
      throw new Error(
        `Unexpected parser mutation: ${control.name}\n${result.stdout}${result.stderr}`,
      )
  }
  command(base, 'bun', ['test', '--isolate', './mutation-records.test.ts'])
  if (command(base, 'git', ['diff', '--stat']).trim())
    throw new Error('Restored parser checkout is dirty')
  console.log(JSON.stringify({ controls: controls.length, restored: true }))
} finally {
  await rm(base, { recursive: true, force: true })
}
