import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyMutationResult,
  embedMutationCases,
} from './mutation-records.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const embed = 'packages/opencode/scripts/embed-common-auth.ts'
const manifest = 'packages/opencode/src/common-auth-embedded/source-output.json'
const tests = 'test/common-auth-094-adoption/embed-build'
const controls = [
  {
    name: 'unsafe archive path guard',
    path: embed,
    from: "name.split('/').some((part) => !part || part === '.' || part === '..')",
    to: 'false',
    red: 'embed.archive_refusals',
  },
  {
    name: 'publication exports guard',
    path: embed,
    from: 'if (JSON.stringify(pkg.exports?.[root]) !== JSON.stringify(targets))',
    to: 'if (false)',
    red: 'embed.inventory',
  },
  {
    name: 'canonical bytes guard',
    path: embed,
    from: 'if (!data || data.length !== bytes || sha256(data) !== hash)',
    to: 'if (false)',
    red: 'embed.inventory',
  },
  {
    name: 'publication inventory guard',
    path: embed,
    from: "throw new Error('publication: inventory')",
    to: '{ /* inventory refusal neutralized */ }',
    red: 'embed.inventory',
  },
  {
    name: 'full MIT license hash guard',
    path: embed,
    from: "sha256(entries.get('package/LICENSE') ?? '') !==",
    to: "false && sha256(entries.get('package/LICENSE') ?? '') !==",
    red: 'embed.attribution',
  },
  {
    name: 'SRI verification',
    path: embed,
    from: 'if (sri !== pin.sri)',
    to: 'if (false)',
    red: 'embed.integrity',
  },
  {
    name: 'duplicate archive guard',
    path: embed,
    from: 'if (entries.has(name))',
    to: 'if (false)',
    red: 'embed.archive_refusals',
  },
  {
    name: 'symlink archive guard',
    path: embed,
    from: 'if (kind === 50)',
    to: 'if (false)',
    red: 'embed.archive_refusals',
  },
  {
    name: 'hardlink archive guard',
    path: embed,
    from: 'if (kind === 49)',
    to: 'if (false)',
    red: 'embed.archive_refusals',
  },
  {
    name: 'nonregular archive guard',
    path: embed,
    from: 'if (kind !== 48 && kind !== 0)',
    to: 'if (false)',
    red: 'embed.archive_refusals',
  },
  {
    name: 'publication version guard',
    path: embed,
    from: "if (pkg.version !== '0.9.4')",
    to: 'if (false)',
    red: 'embed.inventory',
  },
  {
    name: 'NOTICE Git attribute protection',
    path: '.gitattributes',
    from: '/packages/opencode/src/common-auth-embedded/NOTICE.txt -text -eol -filter -working-tree-encoding',
    to: '# removed NOTICE protection',
    red: 'embed.clean_input',
  },
  {
    name: 'canonical Biome discovery exclusion',
    path: 'biome.jsonc',
    from: '      "!!packages/opencode/src/common-auth-embedded",\n',
    to: '',
    red: 'build.repo_hygiene',
  },
]
const hash = (data) => createHash('sha256').update(data).digest('hex')
const command = (cwd, program, args) =>
  execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, npm_config_offline: 'true' },
  })
const evidence = []
const base = await mkdtemp(join(here, '.mutations-'))
try {
  // This copy owns all mutations. No operation stages, changes or restores the live worktree.
  for (const path of [
    'package.json',
    'biome.jsonc',
    'lefthook.yml',
    '.gitignore',
    '.dockerignore',
    '.gitattributes',
    embed,
    'packages/opencode/src/common-auth-embedded',
    'tools/common-auth-build/package.json',
    'tools/common-auth-build/bun.lock',
    'tools/common-auth-build/build.mjs',
    'tools/common-auth-build/inputs',
    `${tests}/embed-input.test.ts`,
    `${tests}/publication.json`,
    `${tests}/archive-fixtures.json`,
  ]) {
    await mkdir(dirname(join(base, path)), { recursive: true })
    await cp(join(root, path), join(base, path), {
      recursive: true,
      filter: (source) =>
        !source
          .split('/')
          .some(
            (part) =>
              part.startsWith('.mutations-') ||
              part.startsWith('.owned-') ||
              part.startsWith('.tool-'),
          ),
    })
  }
  await symlink(join(root, 'node_modules'), join(base, 'node_modules'))
  await symlink(
    join(root, 'tools/common-auth-build/node_modules'),
    join(base, 'tools/common-auth-build/node_modules'),
  )
  command(base, 'git', ['init', '-q'])
  command(base, 'git', ['add', '.'])
  for (const control of controls) {
    const path = join(base, control.path)
    const original = await readFile(path)
    const originalManifest = await readFile(join(base, manifest))
    if (!original.toString().includes(control.from))
      throw new Error(`Unreached mutation anchor: ${control.name}`)
    // Stage the mutation inputs so the disposable checkout has no unstaged changes before each mutation.
    command(base, 'git', ['add', control.path, manifest])
    if (command(base, 'git', ['diff', '--stat']).trim())
      throw new Error('Dirty mutation baseline')
    await writeFile(
      path,
      `${original.toString().replace(control.from, control.to)}\n${control.path.endsWith('.gitattributes') ? '# ' : '// '}NON-VACUITY BREAK\n`,
    )
    if (control.path === embed) command(base, 'bun', [embed])
    const mutantStat = command(base, 'git', ['diff', '--stat']).trim()
    if (!mutantStat) throw new Error('Empty mutation diff')
    const result = spawnSync(
      'bun',
      ['test', '--isolate', `${tests}/embed-input.test.ts`],
      {
        cwd: base,
        encoding: 'utf8',
        timeout: 180000,
        env: { ...process.env, npm_config_offline: 'true' },
      },
    )
    const output = `${result.stdout}${result.stderr}`
    const { failures, passes, outcome } = classifyMutationResult(
      result,
      control.red,
      embedMutationCases,
    )
    // Restore the saved file contents directly, then verify that the mutated file and manifest match their saved contents.
    await writeFile(path, original)
    await writeFile(join(base, manifest), originalManifest)
    const restoredStat = command(base, 'git', ['diff', '--stat']).trim()
    if (
      restoredStat ||
      hash(await readFile(path)) !== hash(original) ||
      hash(await readFile(join(base, manifest))) !== hash(originalManifest)
    )
      throw new Error('Mutation restoration was not byte-exact')
    const row = {
      control: control.name,
      expected_red: control.red,
      captured_output:
        `${failures.map((name) => `(fail) ${name}`).join('; ')}; unaffected: ${passes.join(', ')}`.slice(
          0,
          400,
        ),
      applied_evidence: `${control.path}; original SHA256 ${hash(original)}; NON-VACUITY BREAK; during: ${mutantStat}; after: empty unstaged diff, original hashes verified`,
      outcome,
    }
    evidence.push(row)
    console.log(JSON.stringify(row))
    if (row.outcome !== 'reddened')
      throw new Error(`Unexpected mutation result: ${control.name}\n${output}`)
  }
  command(base, 'bun', ['test', '--isolate', `${tests}/embed-input.test.ts`])
  if (command(base, 'git', ['diff', '--stat']).trim())
    throw new Error('Final disposable worktree is dirty')
} finally {
  await rm(base, { recursive: true, force: true })
}
console.log(JSON.stringify({ mutations: evidence.length, restored: true }))
