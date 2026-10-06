import { afterEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  embedCommonAuth,
  inputPath,
  outputPath,
  readVerifiedArchive,
  validatePublication,
} from '../../../packages/opencode/scripts/embed-common-auth.ts'
import fixtures from './archive-fixtures.json'
import publication from './publication.json'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const temporary: string[] = []
const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const sri = (bytes: Uint8Array) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const protectedPaths = [
  inputPath,
  ...publication.files.map(([path]) => `${outputPath}/${path}`),
  `${outputPath}/source-output.json`,
  `${outputPath}/NOTICE.txt`,
]

async function owned(): Promise<string> {
  const path = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), '.owned-'),
  )
  temporary.push(path)
  return path
}
async function put(root: string, path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes)
}
async function copy(root: string, paths: readonly string[]) {
  for (const path of paths)
    await put(
      root,
      path,
      await readFile(
        join(
          resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
          path,
        ),
      ),
    )
}
function command(cwd: string, program: string, args: string[]) {
  return execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, npm_config_offline: 'true', LEFTHOOK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function git(cwd: string, ...args: string[]) {
  return command(cwd, 'git', args)
}
function init(cwd: string) {
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'user.name', 'Owned fixture')
  git(cwd, 'config', 'core.hooksPath', '/dev/null')
}
async function hashes(directory: string, paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => [
      path,
      hash(await readFile(join(directory, path))),
    ]),
  )
}
async function names(path: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(
        ...(await names(join(path, entry.name), `${prefix}${entry.name}/`)),
      )
    else result.push(`${prefix}${entry.name}`)
  }
  return result.sort()
}
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true })
})

test('embed.integrity', async () => {
  const input = await readFile(join(root, inputPath))
  expect(hash(input)).toBe(publication.sha256)
  expect(sri(input)).toBe(publication.sri)
  expect(readVerifiedArchive(input, publication).size).toBe(175)
  expect(() =>
    readVerifiedArchive(input, { ...publication, sri: 'sha512-wrong' }),
  ).toThrow('integrity: SHA512 SRI mismatch')
  expect(() =>
    readVerifiedArchive(Buffer.from('not gzip'), publication),
  ).toThrow('integrity: SHA256 mismatch')
  // If either acquisition fails, an existing unreadable/stale output cannot be consulted.
  const target = await owned()
  await put(target, `${outputPath}/stale`, 'stale sentinel')
  await expect(embedCommonAuth(target, true)).rejects.toThrow('ENOENT')
  await put(target, inputPath, 'wrong bytes')
  await expect(embedCommonAuth(target, true)).rejects.toThrow(
    'integrity: SHA256 mismatch',
  )
  expect(await readFile(join(target, outputPath, 'stale'), 'utf8')).toBe(
    'stale sentinel',
  )
})

test('embed.inventory', async () => {
  const entries = readVerifiedArchive(
    await readFile(join(root, inputPath)),
    publication,
  )
  validatePublication(entries)
  const actual = await names(join(root, outputPath))
  expect(actual).toEqual(
    [
      ...publication.files.map(([path]) => String(path)),
      'NOTICE.txt',
      'source-output.json',
    ].sort(),
  )
  let total = 0
  for (const [path, bytes, digest] of publication.files) {
    const data = await readFile(join(root, outputPath, String(path)))
    expect(data.length).toBe(Number(bytes))
    expect(hash(data)).toBe(String(digest))
    total += data.length
  }
  expect(total).toBe(61726)
  for (const [property, value, message] of [
    ['name', 'wrong', 'identity'],
    ['version', '0.9.3', 'version'],
    ['exports', {}, 'exports'],
    ['license', 'BSD', 'license'],
  ] as const) {
    const mutant = new Map(entries)
    const manifest = JSON.parse(mutant.get('package/package.json')!.toString())
    manifest[property] = value
    mutant.set('package/package.json', Buffer.from(JSON.stringify(manifest)))
    expect(() => validatePublication(mutant)).toThrow(`publication: ${message}`)
  }
  const missing = new Map(entries)
  missing.delete('package/dist/logger/index.js')
  expect(() => validatePublication(missing)).toThrow('publication: inventory')
  const extra = new Map(entries)
  extra.set('package/dist/logger/unexpected.js', Buffer.from('extra'))
  expect(() => validatePublication(extra)).toThrow('publication: inventory')
  const changed = new Map(entries)
  changed.set('package/dist/logger/index.js', Buffer.from('wrong'))
  expect(() => validatePublication(changed)).toThrow(
    'publication: bytes logger/index.js',
  )
})

test('embed.regeneration', async () => {
  const first = await owned()
  const second = await owned()
  await copy(first, [inputPath])
  await copy(second, [inputPath])
  await embedCommonAuth(first)
  await embedCommonAuth(second)
  await embedCommonAuth(first, true)
  const paths = await names(join(first, outputPath))
  expect(
    await hashes(
      first,
      paths.map((path) => `${outputPath}/${path}`),
    ),
  ).toEqual(
    await hashes(
      second,
      paths.map((path) => `${outputPath}/${path}`),
    ),
  )
  for (const path of paths)
    expect(await readFile(join(first, outputPath, path))).toEqual(
      await readFile(join(root, outputPath, path)),
    )
  await put(first, `${outputPath}/stale.js`, 'stale')
  await expect(embedCommonAuth(first, true)).rejects.toThrow(
    'output: inventory mismatch',
  )
  await embedCommonAuth(first)
  expect(await names(join(first, outputPath))).toEqual(paths)
  await put(first, `${outputPath}/rpc/client.js`, 'wrong')
  await expect(embedCommonAuth(first, true)).rejects.toThrow(
    'output: bytes rpc/client.js',
  )
})

test('embed.attribution', async () => {
  const notice = await readFile(join(root, outputPath, 'NOTICE.txt'))
  expect(hash(notice)).toBe(publication.licenseSha256)
  expect(notice.toString()).toContain('Copyright (c) 2026 Ex Machina')
  const entries = readVerifiedArchive(
    await readFile(join(root, inputPath)),
    publication,
  )
  entries.set('package/LICENSE', Buffer.from('MIT without the license'))
  expect(() => validatePublication(entries)).toThrow('publication: license')
  const manifest = JSON.parse(
    await readFile(join(root, outputPath, 'source-output.json'), 'utf8'),
  )
  expect(manifest.package).toBe('@cortexkit/common-auth')
  expect(manifest.version).toBe('0.9.4')
  expect(manifest.tarballSha256).toBe(publication.sha256)
  expect(manifest.sri).toBe(publication.sri)
  expect(manifest.publicRoots).toEqual({
    './rpc': { types: './dist/rpc/index.d.ts', import: './dist/rpc/index.js' },
    './rpc/client': {
      types: './dist/rpc/client.d.ts',
      import: './dist/rpc/client.js',
    },
    './logger': {
      types: './dist/logger/index.d.ts',
      import: './dist/logger/index.js',
    },
    './tui': { types: './dist/tui/index.d.ts', import: './dist/tui/index.js' },
  })
  expect(manifest.files).toEqual(
    publication.files.map(([path, bytes, digest]) => ({
      source: `package/dist/${path}`,
      output: path,
      bytes,
      sourceSha256: digest,
      outputSha256: digest,
      transform: 'verbatim',
    })),
  )
  expect(manifest.generator.sha256).toBe(
    hash(await readFile(join(root, manifest.generator.path))),
  )
  expect(manifest.transforms).toEqual([])
})

test('embed.archive_refusals', async () => {
  const target = await owned()
  for (const fixture of fixtures) {
    const input = Buffer.from(fixture.gzip, 'base64')
    // Check these Python/USTAR fixture hashes before passing the bytes to the production decoder.
    expect(hash(input)).toBe(fixture.sha256)
    expect(sri(input)).toBe(fixture.sri)
    expect(() => readVerifiedArchive(input, fixture)).toThrow(fixture.error)
    await put(target, inputPath, input)
    await expect(embedCommonAuth(target)).rejects.toThrow(
      'integrity: SHA256 mismatch',
    )
    expect(await names(target)).toEqual([inputPath])
  }
})

test('embed.clean_input', async () => {
  const target = await owned()
  await copy(target, [
    ...protectedPaths,
    '.gitattributes',
    '.gitignore',
    '.dockerignore',
  ])
  init(target)
  git(target, 'config', 'core.autocrlf', 'true')
  const attr = git(
    target,
    'check-attr',
    'text',
    'eol',
    'filter',
    'working-tree-encoding',
    '--',
    ...protectedPaths,
  )
    .trim()
    .split('\n')
  expect(attr.length).toBe(protectedPaths.length * 4)
  for (const line of attr) expect(line.endsWith(': unset')).toBe(true)
  expect(git(target, 'check-ignore', '-v', '--', inputPath)).toContain(
    `!/tools/common-auth-build/inputs/cortexkit-common-auth-0.9.4.tgz`,
  )
  await put(
    target,
    'tools/common-auth-build/inputs/other.tgz',
    'must be ignored',
  )
  expect(
    git(
      target,
      'check-ignore',
      '--',
      'tools/common-auth-build/inputs/other.tgz',
    ).trim(),
  ).toBe('tools/common-auth-build/inputs/other.tgz')
  git(
    target,
    'add',
    '.gitattributes',
    '.gitignore',
    '.dockerignore',
    ...protectedPaths,
  )
  expect(git(target, 'ls-files', '*.tgz').trim()).toBe(inputPath)
  git(target, 'commit', '-qm', 'Owned byte-preservation fixture')
  const checkout = join(await owned(), 'checkout')
  git(
    target,
    '-c',
    'core.autocrlf=true',
    'clone',
    '--no-hardlinks',
    '--quiet',
    target,
    checkout,
  )
  expect(await hashes(checkout, protectedPaths)).toEqual(
    await hashes(root, protectedPaths),
  )
  const dockerignore = await readFile(join(target, '.dockerignore'), 'utf8')
  expect(
    dockerignore.indexOf(
      '!tools/common-auth-build/inputs/cortexkit-common-auth-0.9.4.tgz',
    ),
  ).toBeGreaterThan(dockerignore.indexOf('**/*.tgz'))
  expect(dockerignore).not.toMatch(/^!.*\*.*tgz/m)
  // A real scratch-image context export exercises Docker's ignore implementation, offline.
  await put(
    target,
    'Dockerfile',
    'FROM scratch\nCOPY tools/common-auth-build/inputs/ /inputs/\n',
  )
  const exported = await owned()
  const tag = `common-auth-input-${target.split('/').at(-1)!.replaceAll('.', '').toLowerCase()}`
  let container = ''
  let built = false
  try {
    command(target, 'docker', [
      'build',
      '--network=none',
      '--pull=false',
      '-t',
      tag,
      '.',
    ])
    built = true
    container = command(target, 'docker', [
      'create',
      tag,
      '/never-executed',
    ]).trim()
    command(target, 'docker', ['cp', `${container}:/inputs/.`, exported])
  } finally {
    if (container) command(target, 'docker', ['rm', container])
    if (built) command(target, 'docker', ['image', 'rm', tag])
  }
  expect(await names(exported)).toEqual(['cortexkit-common-auth-0.9.4.tgz'])
  expect(
    hash(await readFile(join(exported, 'cortexkit-common-auth-0.9.4.tgz'))),
  ).toBe(publication.sha256)
}, 120000)

test('build.repo_hygiene', async () => {
  const target = await owned()
  await copy(target, [
    'biome.jsonc',
    'package.json',
    'lefthook.yml',
    ...protectedPaths,
  ])
  await symlink(join(root, 'node_modules'), join(target, 'node_modules'))
  const generated = [
    'packages/opencode/src/tui-raw/canary.js',
    'packages/opencode/src/tui-compiled/canary.js',
  ]
  for (const path of generated)
    await put(target, path, 'export const canary={byte: 1};\n')
  const immutable = [...protectedPaths, ...generated]
  const before = await hashes(target, immutable)
  const handwritten = 'packages/opencode/src/handwritten.ts'
  await put(target, handwritten, 'export const handwritten = 1\n')
  for (const script of ['format:check', 'lint', 'format']) {
    const output = command(target, 'bun', ['run', script])
    expect(output).toMatch(/(?:Formatted|Checked) [1-9]\d* files?/)
    expect(await hashes(target, immutable)).toEqual(before)
  }
  init(target)
  git(target, 'add', '.')
  command(target, join(root, 'node_modules/.bin/lefthook'), [
    'run',
    'pre-commit',
  ])
  expect(await hashes(target, immutable)).toEqual(before)
  await put(
    target,
    handwritten,
    'export const handwritten={value:"not formatted"};\n',
  )
  const badFormat = spawnSync(process.execPath, ['run', 'format:check'], {
    cwd: target,
    encoding: 'utf8',
  })
  expect(badFormat.status).toBe(1)
  expect(`${badFormat.stdout}${badFormat.stderr}`).toContain('handwritten.ts')
  await put(target, handwritten, 'debugger\nexport const handwritten = 1\n')
  const badLint = spawnSync(process.execPath, ['run', 'lint'], {
    cwd: target,
    encoding: 'utf8',
  })
  expect(badLint.status).toBe(1)
  expect(`${badLint.stdout}${badLint.stderr}`).toContain('noDebugger')
  git(target, 'add', handwritten)
  const hook = spawnSync(
    join(root, 'node_modules/.bin/lefthook'),
    ['run', 'pre-commit'],
    { cwd: target, encoding: 'utf8', env: { ...process.env, LEFTHOOK: '1' } },
  )
  expect(hook.status).not.toBe(0)
  expect(`${hook.stdout}${hook.stderr}`).toContain('noDebugger')
  await put(
    target,
    handwritten,
    'export const handwritten={value:"not formatted"};\n',
  )
  command(target, 'bun', ['run', 'format'])
  command(target, 'bun', ['run', 'format:check'])
  command(target, 'bun', ['run', 'lint'])
  git(target, 'add', handwritten)
  command(target, join(root, 'node_modules/.bin/lefthook'), [
    'run',
    'pre-commit',
  ])
  expect(await hashes(target, immutable)).toEqual(before)
}, 120000)
