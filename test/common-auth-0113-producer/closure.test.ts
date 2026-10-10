import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  embedCommonAuth,
  embedCommonAuthPackages,
  embeddingProfiles,
  inputPath,
  outputPath,
  productionPin,
  publicRoots,
  readVerifiedArchive,
  validatePublication,
} from '../../packages/opencode/scripts/embed-common-auth.ts'
import legacy from '../common-auth-094-adoption/embed-build/publication.json'
import closure from './closure.json'
import publication from './publication.json'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const scratch: string[] = []
const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

async function archive() {
  const bytes = await readFile(join(root, inputPath))
  expect(bytes.length).toBe(235492)
  expect(digest(bytes)).toBe(publication.sha256)
  const entries = readVerifiedArchive(bytes, publication)
  validatePublication(entries)
  return entries
}

async function owned() {
  const path = await mkdtemp(join(here, '.producer-'))
  scratch.push(path)
  await mkdir(dirname(join(path, inputPath)), { recursive: true })
  await writeFile(join(path, inputPath), await readFile(join(root, inputPath)))
  return path
}

// Independently scan import specifiers in the published JavaScript and declaration
// text to check the frozen closure. Keep this witness separate from the producer's
// AST graph traversal so the two checks do not validate themselves.
function imports(text: string): string[] {
  return sorted(
    [
      ...text.matchAll(
        /^(?:import|export)\s[^\n]*?\bfrom\s+['"]([^'"\n]+)['"];?\s*$/gm,
      ),
    ].map((match) => match[1]!),
  )
}

function reach(entries: ReadonlyMap<string, Buffer>, starts: string[]) {
  const visited = new Set<string>()
  const pending = [...starts]
  const externals = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    const bytes = entries.get(`package/dist/${file}`)
    if (!bytes) throw new Error(`Missing closure file: ${file}`)
    visited.add(file)
    for (const specifier of imports(bytes.toString())) {
      if (!specifier.startsWith('.')) {
        externals.add(specifier)
        continue
      }
      const resolved = posix.normalize(
        posix.join(posix.dirname(file), specifier),
      )
      if (resolved.startsWith('../'))
        throw new Error(`Closure escaped dist: ${resolved}`)
      pending.push(
        file.endsWith('.d.ts') ? resolved.replace(/\.js$/, '.d.ts') : resolved,
      )
    }
  }
  return { files: sorted(visited), externals: sorted(externals) }
}

afterEach(async () => {
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true })
})

test('producer.public_roots_and_exact_closure', async () => {
  const entries = await archive()
  const pkg = JSON.parse(entries.get('package/package.json')!.toString())
  expect(digest(entries.get('package/package.json')!)).toBe(
    publication.manifestSha256,
  )
  expect(String(productionPin.sha256)).toBe(publication.sha256)
  expect(String(productionPin.sri)).toBe(publication.sri)
  expect(publicRoots).toEqual(publication.publicRoots)
  for (const [name, targets] of Object.entries(publication.publicRoots))
    expect(pkg.exports[name]).toEqual(targets)
  const selected = publication.files.map(([path]) => String(path))
  const expectedImports: Record<string, string[]> = closure.imports
  const nonlocal = new Set<string>()
  for (const file of selected) {
    const text = entries.get(`package/dist/${file}`)!.toString()
    expect(text).not.toMatch(/^\s*import\s*['"]/m)
    expect(text).not.toMatch(/\brequire\s*\(/)
    if (file !== 'tui/index.js') expect(text).not.toMatch(/\bimport\s*\(/)
    const observed = imports(text)
    expect(observed).toEqual(sorted(expectedImports[file] ?? []))
    for (const specifier of observed)
      if (!specifier.startsWith('.')) nonlocal.add(specifier)
  }
  expect(
    Object.keys(expectedImports).every((file) => selected.includes(file)),
  ).toBe(true)
  expect(sorted(nonlocal)).toEqual(closure.nonlocalStaticImports)
  const starts = Object.values(publication.publicRoots).flatMap((targets) =>
    [targets.import, targets.types].map((path) => path.replace('./dist/', '')),
  )
  const graph = reach(entries, starts)
  expect(graph.files).toEqual(selected)
  expect(graph.externals).toEqual(closure.nonlocalStaticImports)
  expect(graph.files.length).toBe(137)
  expect(
    graph.files.reduce(
      (sum, file) => sum + entries.get(`package/dist/${file}`)!.length,
      0,
    ),
  ).toBe(698557)
  expect(graph.files.filter((file) => file.startsWith('routing/'))).toEqual(
    closure.routingFiles,
  )
  expect(
    graph.files.some((file) => /^(?:opencode2|tui-build)\//.test(file)),
  ).toBe(false)
  expect(reach(entries, ['commands/index.js']).files).toContain('store/pool.js')
})

test('producer.slim_runtime_reachability', async () => {
  const entries = await archive()
  const client = reach(entries, ['rpc/client.js', 'tui/index.js'])
  expect(client.files).toEqual(closure.slimRuntimeFiles)
  expect(client.externals).toEqual([
    'node:crypto',
    'node:fs/promises',
    'node:net',
    'node:path',
  ])
  expect(client.files).not.toContain('rpc/index.js')
  expect(client.files).not.toContain('rpc/rpc-server.js')
  expect(
    client.files.some((file) =>
      /^(?:store|claustrum|oauth|commands|auth-menu)\//.test(file),
    ),
  ).toBe(false)
  const selector = entries.get('package/dist/tui/index.js')!.toString()
  expect(selector).toContain('import(entry)')
  expect(selector).toContain("encodeURIComponent('@opentui/solid')")
  // rpc/client.d.ts reaches port-file.d.ts -> index.d.ts -> rpc-server.d.ts,
  // whose RpcLogChannel type import returns to index.d.ts. These erased type
  // imports cannot add the RPC server to the TUI runtime closure.
  expect(reach(entries, ['rpc/client.d.ts']).files).toContain(
    'rpc/rpc-server.d.ts',
  )
})

test('producer.legacy_bytes_and_stop_order', async () => {
  const entries = await archive()
  const changed = legacy.files
    .filter(([file, bytes, hash]) => {
      const actual = entries.get(`package/dist/${file}`)!
      return actual.length !== bytes || digest(actual) !== hash
    })
    .map(([file]) => String(file))
  expect(changed).toEqual([
    'rpc/port-file.d.ts',
    'rpc/port-file.js',
    'rpc/rpc-client.d.ts',
    'rpc/rpc-client.js',
    'rpc/rpc-server.js',
  ])
  const server = entries.get('package/dist/rpc/rpc-server.js')!.toString()
  const stop = server.slice(server.indexOf('async stop()'))
  expect(stop.indexOf('server.closeAllConnections?.()')).toBeGreaterThan(0)
  expect(stop.indexOf('server.close(() => resolve())')).toBeGreaterThan(
    stop.indexOf('server.closeAllConnections?.()'),
  )
  expect(stop).toContain('socket.destroy()')
})

test('producer.verbatim_map', async () => {
  const entries = await archive()
  const target = await owned()
  await embedCommonAuth(target)
  await embedCommonAuth(target, true)
  const map = JSON.parse(
    await readFile(join(target, outputPath, 'source-output.json'), 'utf8'),
  )
  expect(map.version).toBe('0.12.0')
  expect(map.artifactStatus).toBe('released')
  expect(map.publicRoots).toEqual(publication.publicRoots)
  expect(map.canonicalFiles).toBe(137)
  expect(map.canonicalBytes).toBe(698557)
  expect(map.tarballSha256).toBe(publication.sha256)
  expect(map.sri).toBe(publication.sri)
  expect(map.transforms).toEqual([])
  expect(map.generator.version).toBe(3)
  expect(map.generator.sha256).toBe(
    digest(await readFile(join(root, map.generator.path))),
  )
  expect(map.notice).toEqual({
    source: 'package/LICENSE',
    output: 'NOTICE.txt',
    sha256: publication.licenseSha256,
  })
  expect(map.files).toEqual(
    publication.files.map(([file, bytes, hash]) => ({
      source: `package/dist/${file}`,
      output: file,
      bytes,
      sourceSha256: hash,
      outputSha256: hash,
      transform: 'verbatim',
    })),
  )
  for (const [file, bytes, hash] of publication.files) {
    const output = await readFile(join(target, outputPath, String(file)))
    expect(output.equals(entries.get(`package/dist/${file}`)!)).toBe(true)
    expect(output.length).toBe(Number(bytes))
    expect(digest(output)).toBe(String(hash))
  }
  expect(
    (await readFile(join(target, outputPath, 'NOTICE.txt'))).equals(
      entries.get('package/LICENSE')!,
    ),
  ).toBe(true)
})

test('producer.symlink_refusal_preserves_bytes', async () => {
  const target = await owned()
  const foreign = join(target, 'foreign')
  await mkdir(foreign)
  await writeFile(join(foreign, 'sentinel'), 'unrelated bytes\r\n')
  await mkdir(dirname(join(target, outputPath)), { recursive: true })
  await symlink(foreign, join(target, outputPath), 'dir')
  const before = await readFile(join(foreign, 'sentinel'))
  for (const check of [false, true]) {
    await expect(embedCommonAuth(target, check)).rejects.toThrow(
      'output: symlink',
    )
    expect(await readFile(join(foreign, 'sentinel'))).toEqual(before)
    expect(await readlink(join(target, outputPath))).toBe(foreign)
    expect(digest(await readFile(join(target, inputPath)))).toBe(
      publication.sha256,
    )
  }
})

test('producer.shared_core_profile_exact_closure', async () => {
  const entries = await archive()
  const target = await owned()
  await embedCommonAuthPackages(['opencode', 'core'], target)
  await embedCommonAuthPackages(['opencode', 'core'], target, true)
  const profile = embeddingProfiles.core
  const starts = Object.values(profile.publicRoots).flatMap((targets) =>
    [targets.import, targets.types].map((path) => path.replace('./dist/', '')),
  )
  const required = reach(entries, starts).files
  const map = JSON.parse(
    await readFile(
      join(target, profile.outputPath, 'source-output.json'),
      'utf8',
    ),
  )
  expect(required.length).toBe(121)
  expect(map.canonicalFiles).toBe(121)
  expect(map.canonicalBytes).toBe(648870)
  expect(map.publicRoots).toEqual(profile.publicRoots)
  expect(map.tarballSha256).toBe(publication.sha256)
  expect(map.files.map((file: { output: string }) => file.output)).toEqual(
    required,
  )
  for (const file of required)
    expect(
      (await readFile(join(target, profile.outputPath, file))).equals(
        entries.get(`package/dist/${file}`)!,
      ),
    ).toBe(true)
  expect(required.some((file) => /^(?:rpc|tui)\//.test(file))).toBe(false)
  expect(
    (await readFile(join(target, profile.outputPath, 'NOTICE.txt'))).equals(
      entries.get('package/LICENSE')!,
    ),
  ).toBe(true)
})

test('producer.multi_target_preflight_preserves_first_target', async () => {
  const target = await owned()
  await mkdir(join(target, outputPath), { recursive: true })
  await writeFile(join(target, outputPath, 'sentinel'), 'previous owned bytes')
  const foreign = join(target, 'foreign')
  await mkdir(foreign)
  await writeFile(join(foreign, 'sentinel'), 'unrelated bytes')
  await mkdir(dirname(join(target, embeddingProfiles.core.outputPath)), {
    recursive: true,
  })
  await symlink(foreign, join(target, embeddingProfiles.core.outputPath), 'dir')
  await expect(
    embedCommonAuthPackages(['opencode', 'core'], target),
  ).rejects.toThrow('output: symlink')
  expect(await readFile(join(target, outputPath, 'sentinel'), 'utf8')).toBe(
    'previous owned bytes',
  )
  expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe(
    'unrelated bytes',
  )
  await expect(embedCommonAuthPackages([], target)).rejects.toThrow(
    'output: expected unique known consumer packages',
  )
  await expect(
    embedCommonAuthPackages(['opencode', 'opencode'], target),
  ).rejects.toThrow('output: expected unique known consumer packages')
})

test('producer.generator_is_data_only', async () => {
  const source = await readFile(
    join(root, 'packages/opencode/scripts/embed-common-auth.ts'),
    'utf8',
  )
  const moduleStrings = sorted(
    [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]!,
    ),
  )
  expect(moduleStrings).toEqual([
    'node:crypto',
    'node:fs/promises',
    'node:path',
    'node:url',
    'node:zlib',
  ])
  expect(source).not.toMatch(
    /\b(?:import\s*\(|require\s*\(|eval\s*\(|new\s+Function\b|fetch\s*\(|spawn\w*\s*\(|exec\w*\s*\()/,
  )
  expect(source).not.toMatch(
    /(?:process\.env|homedir\s*\(|\.aws|\.config|\.ssh|keychain)/,
  )
  const entries = await archive()
  const pkg = JSON.parse(entries.get('package/package.json')!.toString())
  expect(pkg.scripts.prepublishOnly).toBe('bun run build')
  expect(pkg.peerDependencies['@cortexkit/claustrum-client']).toBe('>=0.6.2')
  expect(pkg.peerDependenciesMeta['@cortexkit/claustrum-client'].optional).toBe(
    true,
  )
  // Public ./claustrum needs the real Claustrum/subc-client for its vault runtime.
  // Public ./rpc/client reaches only its three RPC runtime files; TUI does not load a vault client.
  expect(reach(entries, ['claustrum/index.js']).externals).toContain(
    '@cortexkit/claustrum-client',
  )
  expect(
    reach(entries, ['rpc/client.js', 'tui/index.js']).externals,
  ).not.toContain('@cortexkit/claustrum-client')
})
