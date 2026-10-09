import { afterEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  embedCommonAuth,
  embeddingProfiles,
  inputPath,
  outputPath,
  readVerifiedArchive,
  validatePublication,
} from '../../../packages/opencode/scripts/embed-common-auth.ts'
import publication from '../../common-auth-0113-producer/publication.json'
import fixtures from './archive-fixtures.json'

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
// Core's profile of the same emitter: every published file except the RPC
// and TUI entries, which core does not embed.
const coreOutputPath = embeddingProfiles.core.outputPath
const coreProtectedPaths = [
  ...publication.files
    .map(([path]) => `${path}`)
    .filter((path) => !/^(?:rpc|tui)\//.test(path))
    .map((path) => `${coreOutputPath}/${path}`),
  `${coreOutputPath}/source-output.json`,
  `${coreOutputPath}/NOTICE.txt`,
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
  expect(total).toBe(648487)
  for (const [property, value, message] of [
    ['name', 'wrong', 'identity'],
    ['version', '0.9.4', 'version'],
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
  expect(manifest.version).toBe('0.11.6')
  expect(manifest.artifactStatus).toBe('released')
  expect(manifest.tarballSha256).toBe(publication.sha256)
  expect(manifest.sri).toBe(publication.sri)
  expect(manifest.publicRoots).toEqual(publication.publicRoots)
  expect(manifest.canonicalFiles).toBe(134)
  expect(manifest.canonicalBytes).toBe(648487)
  expect(manifest.generator.version).toBe(3)
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
    `!/tools/common-auth-build/inputs/cortexkit-common-auth-0.11.6.tgz`,
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
      '!tools/common-auth-build/inputs/cortexkit-common-auth-0.11.6.tgz',
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
  expect(await names(exported)).toEqual(['cortexkit-common-auth-0.11.6.tgz'])
  expect(
    hash(await readFile(join(exported, 'cortexkit-common-auth-0.11.6.tgz'))),
  ).toBe(publication.sha256)
}, 120000)

test('build.repo_hygiene', async () => {
  const target = await owned()
  const childManifest = 'packages/opencode/package.json'
  const privateRoot = 'tools/common-auth-build'
  const privateLock = `${privateRoot}/bun.lock`
  await copy(target, [
    'biome.jsonc',
    'package.json',
    'lefthook.yml',
    '.gitattributes',
    '.gitignore',
    childManifest,
    'packages/opencode/scripts/build-tui.ts',
    'packages/opencode/scripts/embed-common-auth.ts',
    // The root embed:check also checks core's embedded output, through
    // core's call into the same emitter.
    'packages/core/scripts/embed-common-auth.ts',
    `${privateRoot}/package.json`,
    privateLock,
    ...protectedPaths,
    ...coreProtectedPaths,
  ])
  // Without the child manifest Bun falls back to the root script, recursively
  // delegating to itself. Refuse incomplete fixtures before running a wrapper.
  async function admitChild() {
    const bytes = await readFile(join(target, childManifest), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        throw new Error('build.repo_hygiene: child manifest missing')
      },
    )
    if (
      JSON.parse(bytes).scripts?.['embed:check'] !==
      'bun scripts/build-tui.ts --check'
    )
      throw new Error('build.repo_hygiene: child embed:check misresolved')
  }
  await admitChild()
  const childBytes = await readFile(join(target, childManifest))
  try {
    await rm(join(target, childManifest))
    await expect(admitChild()).rejects.toThrow(
      'build.repo_hygiene: child manifest missing',
    )
    const manifest = JSON.parse(childBytes.toString())
    manifest.scripts['embed:check'] =
      'bun run --cwd packages/opencode embed:check'
    await put(target, childManifest, JSON.stringify(manifest))
    await expect(admitChild()).rejects.toThrow(
      'build.repo_hygiene: child embed:check misresolved',
    )
  } finally {
    await put(target, childManifest, childBytes)
  }
  expect(await readFile(join(target, childManifest))).toEqual(childBytes)
  await admitChild()
  // The real embedding check resolves scripts relative to their own files and
  // requires a private installation contained in this fixture, not vendor links.
  const lockBytes = await readFile(join(target, privateLock))
  const installed = command(join(target, privateRoot), 'bun', [
    'install',
    '--frozen-lockfile',
    '--offline',
    '--ignore-scripts',
    '--cache-dir',
    process.env.COMMON_AUTH_BUN_CACHE ??
      resolve(dirname(process.execPath), '../install/cache'),
  ])
  expect(installed).toMatch(/\d+ packages? installed|Checked \d+ installs/)
  expect(await readFile(join(target, privateLock))).toEqual(lockBytes)
  // Bun's workspace install can keep these two build-script imports under the
  // product package rather than the root vendor directory. Copy only their
  // package contents; never copy the workspace store or link the private tool.
  const buildRequire = createRequire(
    join(root, 'packages/opencode/scripts/build-tui.ts'),
  )
  for (const name of ['esbuild', 'jsonc-parser'])
    await cp(
      dirname(await realpath(buildRequire.resolve(`${name}/package.json`))),
      join(target, 'packages/opencode/node_modules', name),
      { recursive: true, dereference: true },
    )
  await symlink(join(root, 'node_modules'), join(target, 'node_modules'))
  const generated = [
    'packages/opencode/src/tui-raw/canary.js',
    'packages/opencode/src/tui-compiled/canary.js',
  ]
  for (const path of generated)
    await put(target, path, 'export const canary={byte: 1};\n')
  const immutable = [...protectedPaths, ...coreProtectedPaths, ...generated]
  const before = await hashes(target, immutable)
  const handwritten = 'packages/opencode/src/handwritten.ts'
  await put(target, handwritten, 'export const handwritten = 1\n')
  // An altered byte in core's embedded output must also stop the wrapper
  // before Biome runs: core's check compares it with the pinned archive.
  const corePayload = `${coreOutputPath}/quota/map.js`
  const corePayloadBytes = await readFile(join(target, corePayload))
  try {
    await put(
      target,
      corePayload,
      Buffer.concat([corePayloadBytes, Buffer.from('\n')]),
    )
    const alteredCore = spawnSync(process.execPath, ['run', 'format:check'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120000,
    })
    expect(alteredCore.status).toBe(1)
    expect(`${alteredCore.stdout}${alteredCore.stderr}`).toContain(
      'output: bytes quota/map.js',
    )
    expect(`${alteredCore.stdout}${alteredCore.stderr}`).not.toMatch(
      /(?:Formatted|Checked) [1-9]\d* files?/,
    )
  } finally {
    await put(target, corePayload, corePayloadBytes)
  }
  expect(await hashes(target, immutable)).toEqual(before)
  // A success-only embedding command must not satisfy the hygiene fixture:
  // an invalid private lock must stop the real wrapper before Biome runs.
  try {
    await put(
      target,
      privateLock,
      Buffer.concat([lockBytes, Buffer.from('\n')]),
    )
    const invalidLock = spawnSync(process.execPath, ['run', 'format:check'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120000,
    })
    if (invalidLock.status !== 1)
      console.error(
        'Unexpected prerequisite exit',
        invalidLock.status,
        invalidLock.stdout,
        invalidLock.stderr,
      )
    expect(invalidLock.status).toBe(1)
    expect(`${invalidLock.stdout}${invalidLock.stderr}`).toContain(
      'build.prerequisite_order: private Bun lock mismatch',
    )
    expect(`${invalidLock.stdout}${invalidLock.stderr}`).not.toMatch(
      /(?:Formatted|Checked) [1-9]\d* files?/,
    )
  } finally {
    await put(target, privateLock, lockBytes)
  }
  expect(await readFile(join(target, privateLock))).toEqual(lockBytes)
  expect(await hashes(target, immutable)).toEqual(before)
  for (const script of ['format:check', 'lint', 'format']) {
    await admitChild()
    const output = command(target, 'bun', ['run', script])
    expect(output).toContain(
      'Embedding and private Bun-lock roots verified (Bun 1.4.2)',
    )
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
