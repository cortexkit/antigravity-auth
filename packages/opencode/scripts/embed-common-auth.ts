import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const inputPath =
  'tools/common-auth-build/inputs/cortexkit-common-auth-0.9.4.tgz'
export const outputPath = 'packages/opencode/src/common-auth-embedded'
export const productionPin = Object.freeze({
  sha256: '81397782059d2977061043e627b4b3010959b969e17c66ab63e26b8067f09c20',
  sri: 'sha512-YQvXOEA390gSCRVYM5bFU/eIF/l4aHpY1BcIARjd9LVb5lPsCTicDlA2l6fU2OJO0bZI20tJ+xutpyBqEsMrEw==',
})
export const publicRoots = {
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
}

// Reviewed publication hashes are constants, not derived from an existing output tree.
const canonical: readonly (readonly [string, number, string])[] = [
  [
    'logger/capture-sink.d.ts',
    430,
    '20c88825e86688f16b6c1cd38c56980dacb66778b891ffff436348aeaa4a3849',
  ],
  [
    'logger/capture-sink.js',
    249,
    'b582535e350e6683f3de2cd1e4147f893afcb739f747f2bd1f713aaba513d604',
  ],
  [
    'logger/engine.d.ts',
    4607,
    '646d7438df2aa50853dc8f8220236cee75e480342545d8d94718ea34259ae522',
  ],
  [
    'logger/engine.js',
    7925,
    '3ebcd0e8ad5aca437cee85e4b9087ba15d7efbcb07b5fefff937092f2de3f829',
  ],
  [
    'logger/index.d.ts',
    524,
    'aed1dff9371ca9fd2d3da44ef89a83d6df96274746e18a87058c8551db5a3a9d',
  ],
  [
    'logger/index.js',
    261,
    'ea9861f27c73b0194287ead55622b2a16cba3cacb90ad87e4b60e3bd0cb850c3',
  ],
  [
    'logger/redact.d.ts',
    474,
    '4a74e923b467320e26426f21ed88c8f86ddac42b39acfdbf3e64f97584d132a8',
  ],
  [
    'logger/redact.js',
    3989,
    '32c85066ec28d52043c9c0b56a363fe4d5b01159dd369796353edde360472f10',
  ],
  [
    'rpc/client.d.ts',
    241,
    '42786d690c2e7c264e9476b979f3502810ff3724f2136a013fc5bf7b4efb9150',
  ],
  [
    'rpc/client.js',
    85,
    '982d65b56be71c69bf9c4e74d32257394aee022324bd673655405c6a4e381e26',
  ],
  [
    'rpc/index.d.ts',
    417,
    '62bda8e27c98b193ba0aee81a9e405472688618952907d91c53b9635b1142eef',
  ],
  [
    'rpc/index.js',
    172,
    '31aadda5190c9f8c5dd4b7c0f4bb11ce87fb79715ac4785163008fb5f0062998',
  ],
  [
    'rpc/notifications.d.ts',
    3333,
    'a635624ced52a0a747ee7df1576bf9249a69a22c7c19cff827a50624b246d666',
  ],
  [
    'rpc/notifications.js',
    3786,
    '80fa1e961293ff0dcbba6e1e2264d765f8a7a92916028fd7e21245ac68902171',
  ],
  [
    'rpc/port-file.d.ts',
    1460,
    'f4a59dbd12d85fdad86f80695037a247441c0136064a3dcd4a073d6adf06ccca',
  ],
  [
    'rpc/port-file.js',
    7156,
    '632d8f28c2aff3c61eb5fbc04845b500fa50b07a39a451b1131290fae82a6775',
  ],
  [
    'rpc/rpc-client.d.ts',
    1419,
    '82defb3e489511b50344c372388c09d1d9ec6d773d15e8142107a4acf10d5c89',
  ],
  [
    'rpc/rpc-client.js',
    6893,
    '320e6b717edc780cff665c763344e3a039eb767d367ec4f70a634af7ef4e96e1',
  ],
  [
    'rpc/rpc-server.d.ts',
    2676,
    'cd60d433c1d0d763544b7ee5c78f905bfffb332bc2622586971b90f8e37dc27d',
  ],
  [
    'rpc/rpc-server.js',
    12354,
    'a31758c7d74ded7b781e9b88170fc50c2b3fbd7016413adc92fc6ed039237934',
  ],
  [
    'rpc/server-registry.d.ts',
    507,
    '94289df522440d9f92b7de74185090e8072a18f1b1ad7832584f2b1a0285b691',
  ],
  [
    'rpc/server-registry.js',
    1537,
    '7a7bb67f11f072e2fd655694445458295c5461579bc4e73b11559c9d18d3c93d',
  ],
  [
    'tui/index.d.ts',
    281,
    '9d4555b13b599cdef275f1501154d3802ac237a17ee06fafd34e05a183918921',
  ],
  [
    'tui/index.js',
    950,
    'c9a1e381382128b64eea0b3b049beb1b210cb68e768ea04683662b8b1a73bbb1',
  ],
]
export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')

function field(header: Buffer, start: number, end: number): string {
  const bytes = header.subarray(start, end)
  const zero = bytes.indexOf(0)
  return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('utf8')
}

function octal(value: string): number {
  if (!/^[0-7]+$/.test(value.trim()))
    throw new Error('archive: invalid numeric field')
  const number = Number.parseInt(value.trim(), 8)
  if (!Number.isSafeInteger(number))
    throw new Error('archive: numeric overflow')
  return number
}

/** No filesystem traversal occurs: headers are decoded into an in-memory map only.
 * Test fixtures have independent pins; the production entry never accepts an override.
 */
export function readVerifiedArchive(
  compressed: Buffer,
  pin: Readonly<{ sha256: string; sri: string }>,
): Map<string, Buffer> {
  if (sha256(compressed) !== pin.sha256)
    throw new Error('integrity: SHA256 mismatch')
  const sri = `sha512-${createHash('sha512').update(compressed).digest('base64')}`
  if (sri !== pin.sri) throw new Error('integrity: SHA512 SRI mismatch')
  const tar = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 })
  const entries = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (
        tar.length - offset < 1024 ||
        !tar.subarray(offset).every((byte) => byte === 0)
      )
        throw new Error('archive: invalid end marker')
      return entries
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (octal(field(header, 148, 156)) !== checksum)
      throw new Error('archive: checksum mismatch')
    if (field(header, 257, 263) !== 'ustar')
      throw new Error('archive: unsupported header')
    const prefix = field(header, 345, 500)
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`
    if (
      !name.startsWith('package/') ||
      name.includes('\\') ||
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('archive: unsafe path')
    if (entries.has(name)) throw new Error('archive: duplicate path')
    const kind = header[156]
    if (kind === 50) throw new Error('archive: symlink')
    if (kind === 49) throw new Error('archive: hardlink')
    if (kind !== 48 && kind !== 0) throw new Error('archive: nonregular entry')
    if (field(header, 157, 257))
      throw new Error('archive: unexpected link target')
    const size = octal(field(header, 124, 136))
    const end = offset + 512 + size
    if (end > tar.length) throw new Error('archive: truncated payload')
    entries.set(name, tar.subarray(offset + 512, end))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('archive: missing end marker')
}

export function validatePublication(
  entries: ReadonlyMap<string, Buffer>,
): void {
  const pkg = JSON.parse(
    entries.get('package/package.json')?.toString() ?? 'null',
  )
  if (pkg?.name !== '@cortexkit/common-auth')
    throw new Error('publication: identity')
  if (pkg.version !== '0.9.4') throw new Error('publication: version')
  for (const [root, targets] of Object.entries(publicRoots)) {
    if (JSON.stringify(pkg.exports?.[root]) !== JSON.stringify(targets))
      throw new Error(`publication: exports ${root}`)
  }
  if (
    pkg.license !== 'MIT' ||
    sha256(entries.get('package/LICENSE') ?? '') !==
      'bf737fd6a5d9da55873eb7ea481fd9e875bcfefc13ed42766a1964c6040c5581'
  )
    throw new Error('publication: license')
  if (
    sha256(`${[...entries.keys()].sort().join('\n')}\n`) !==
    'cf6914e4de5bb2628779090c554c73747e8a19ddbd7ccec073b39a8d6723ac73'
  )
    throw new Error('publication: inventory')
  for (const [path, bytes, hash] of canonical) {
    const data = entries.get(`package/dist/${path}`)
    if (!data || data.length !== bytes || sha256(data) !== hash)
      throw new Error(`publication: bytes ${path}`)
  }
  if (
    sha256(entries.get('package/package.json') ?? '') !==
    'e6751b60f1b180e3dfcac358c32d9f831a33186720f565f7ddb5c2030a772cb3'
  )
    throw new Error('publication: manifest bytes')
}

async function inventory(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory())
      result.push(...(await inventory(join(directory, entry.name), `${path}/`)))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`output: nonregular entry ${path}`)
  }
  return result.sort()
}

async function refuseSymlinks(root: string, path: string): Promise<void> {
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stat?.isSymbolicLink()) throw new Error(`output: symlink ${current}`)
  }
}

export async function embedCommonAuth(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  check = false,
): Promise<void> {
  // The fixed input is read first. A failed acquisition cannot consume stale outputs.
  const entries = readVerifiedArchive(
    await readFile(join(root, inputPath)),
    productionPin,
  )
  validatePublication(entries)
  const files = canonical.map(([output, bytes, hash]) => ({
    source: `package/dist/${output}`,
    output,
    bytes,
    sourceSha256: hash,
    outputSha256: hash,
    transform: 'verbatim',
  }))
  const manifest = {
    schema: 1,
    package: '@cortexkit/common-auth',
    version: '0.9.4',
    publicRoots,
    input: inputPath,
    tarballSha256: productionPin.sha256,
    sri: productionPin.sri,
    canonicalFiles: 24,
    canonicalBytes: 61726,
    generator: {
      path: 'packages/opencode/scripts/embed-common-auth.ts',
      version: 1,
      sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    },
    files,
    transforms: [],
    notice: {
      source: 'package/LICENSE',
      output: 'NOTICE.txt',
      sha256: sha256(entries.get('package/LICENSE')!),
    },
  }
  const outputs = new Map<string, Buffer>(
    files.map((file) => [file.output, entries.get(file.source)!]),
  )
  outputs.set(
    'source-output.json',
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  )
  outputs.set('NOTICE.txt', entries.get('package/LICENSE')!)
  await refuseSymlinks(root, outputPath)
  const destination = join(root, outputPath)
  if (check) {
    if (
      JSON.stringify(await inventory(destination)) !==
      JSON.stringify([...outputs.keys()].sort())
    )
      throw new Error('output: inventory mismatch')
    for (const [path, bytes] of outputs) {
      if (!(await readFile(join(destination, path))).equals(bytes))
        throw new Error(`output: bytes ${path}`)
    }
  } else {
    // Destruction and copying start only after every input assertion has succeeded.
    await rm(destination, { force: true, recursive: true })
    for (const [path, bytes] of outputs) {
      await mkdir(dirname(join(destination, path)), { recursive: true })
      await writeFile(join(destination, path), bytes)
    }
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== '--check'))
    throw new Error('Usage: bun embed-common-auth.ts [--check]')
  await embedCommonAuth(undefined, process.argv.includes('--check'))
  console.log(
    'common-auth 0.9.4: verified 24 canonical files (61726 bytes) and MIT notice',
  )
}
