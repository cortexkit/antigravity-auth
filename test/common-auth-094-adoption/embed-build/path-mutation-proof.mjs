import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyMutationResult,
  pathMutationCases,
} from './mutation-records.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const helper = 'tools/common-auth-build/build.mjs'
const testFile =
  'test/common-auth-094-adoption/embed-build/path-admission.test.ts'
const controls = [
  {
    name: 'map-to-source alias admission',
    red: 'build.map_source_alias',
    edits: [
      [
        'async function inspectDestination(packageRoot, path, kind) {',
        'async function inspectDestination(packageRoot, path, kind) {\n  if (path.endsWith(sep + "map-source-alias.json")) return path',
      ],
    ],
  },
  {
    name: 'output ancestor escape admission',
    red: 'build.output_ancestor_alias',
    edits: [
      [
        'async function inspectDestination(packageRoot, path, kind) {',
        'async function inspectDestination(packageRoot, path, kind) {\n  if (path.includes(sep + "outside-ancestor" + sep)) return path',
      ],
    ],
  },
  {
    name: 'output source-tree alias admission',
    red: 'build.output_source_alias',
    edits: [
      [
        'async function inspectDestination(packageRoot, path, kind) {',
        'async function inspectDestination(packageRoot, path, kind) {\n  if (path.includes(sep + "source-output-alias")) return path',
      ],
    ],
  },
  {
    name: 'canonical package-root normalization',
    red: 'build.symlink_root_equivalence',
    edits: [['packageRoot: root,', 'packageRoot,']],
  },
  {
    name: 'lexical and physical output disjointness',
    red: 'build.lexical_path_refusals',
    edits: [
      [
        'if (within(rawDir, runtimeDir) || within(runtimeDir, rawDir))',
        'if (false)',
      ],
      ['if (within(raw, runtime) || within(runtime, raw))', 'if (false)'],
    ],
  },
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const command = (cwd, program, args) =>
  execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, npm_config_offline: 'true' },
  })
const base = await mkdtemp(join(here, '.alias-mutations-'))
try {
  // This disposable checkout owns the mutated helper, compiler install and all fake source trees.
  for (const path of [
    helper,
    testFile,
    'tools/common-auth-build/package.json',
    'tools/common-auth-build/bun.lock',
    'tools/common-auth-build/inputs/cortexkit-common-auth-0.12.0.tgz',
    'packages/opencode/scripts/embed-common-auth.ts',
  ]) {
    await mkdir(dirname(join(base, path)), { recursive: true })
    await cp(join(repo, path), join(base, path))
  }
  const cache =
    process.env.COMMON_AUTH_BUN_CACHE ??
    resolve(dirname(process.execPath), '../install/cache')
  console.log(
    command(base, 'bun', [
      'install',
      '--cwd',
      'tools/common-auth-build',
      '--cache-dir',
      cache,
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
    ]),
  )
  command(base, 'git', ['init', '-q'])
  command(base, 'git', ['add', helper])
  const path = join(base, helper)
  const original = await readFile(path)
  for (const control of controls) {
    command(base, 'git', ['add', helper])
    if (command(base, 'git', ['diff', '--stat']).trim())
      throw new Error('Dirty alias mutation baseline')
    let mutated = original.toString()
    for (const [from, to] of control.edits) {
      if (mutated.split(from).length !== 2)
        throw new Error(`Unreached or ambiguous control: ${control.name}`)
      mutated = mutated.replace(from, to)
    }
    await writeFile(path, `${mutated}\n// NON-VACUITY BREAK\n`)
    const during = command(base, 'git', ['diff', '--stat']).trim()
    if (!during) throw new Error('Empty alias mutation diff')
    const result = spawnSync('bun', ['test', '--isolate', testFile], {
      cwd: base,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, npm_config_offline: 'true' },
    })
    const output = `${result.stdout}${result.stderr}`
    const { failures, passes, outcome } = classifyMutationResult(
      result,
      control.red,
      pathMutationCases,
    )
    // Restore the saved bytes before reporting results, including when a control goes unexpectedly red.
    await writeFile(path, original)
    const after = command(base, 'git', ['diff', '--stat']).trim()
    if (after || hash(await readFile(path)) !== hash(original))
      throw new Error('Alias mutation restoration failed')
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
      throw new Error(`Unexpected alias control: ${control.name}\n${output}`)
  }
  command(base, 'bun', ['test', '--isolate', testFile])
  if (command(base, 'git', ['diff', '--stat']).trim())
    throw new Error('Restored alias checkout is dirty')
  console.log(JSON.stringify({ controls: controls.length, restored: true }))
} finally {
  await rm(base, { recursive: true, force: true })
}
