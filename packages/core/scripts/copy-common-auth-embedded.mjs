// Copies the embedded @cortexkit/common-auth entries into the build output.
//
// `src/common-auth-embedded/` holds verbatim JavaScript and declaration files
// from the verified library archive, written by the repository's single
// common-auth emitter. TypeScript does not emit input `.js`/`.d.ts` files, so
// after `tsc` this script copies them to `dist/common-auth-embedded/`, where the
// compiled runtime bindings and the `./common-auth/*` subpath exports load
// them. Every file is checked against the size and SHA-256 recorded in the
// emitter's `source-output.json` before it is copied, and a file that is
// present but unrecorded (or recorded but absent) fails the build, so the
// package can only ship the bytes the emitter verified.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(packageRoot, 'src', 'common-auth-embedded')
const outputRoot = join(packageRoot, 'dist', 'common-auth-embedded')
const recordName = 'source-output.json'

async function listFiles(root) {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await listFiles(path)))
    else if (entry.isFile())
      found.push(relative(sourceRoot, path).split(sep).join('/'))
    else throw new Error(`Embedded entry is not a regular file: ${path}`)
  }
  return found
}

const record = JSON.parse(await readFile(join(sourceRoot, recordName), 'utf8'))
if (!Array.isArray(record.files))
  throw new Error(`${recordName} does not list the embedded files`)

const expected = new Map()
for (const file of record.files) {
  if (
    typeof file?.output !== 'string' ||
    typeof file.bytes !== 'number' ||
    typeof file.outputSha256 !== 'string'
  )
    throw new Error(`${recordName} has a malformed file entry`)
  expected.set(file.output, file)
}

const present = (await listFiles(sourceRoot)).filter(
  (path) => path !== recordName && path !== 'NOTICE.txt',
)
for (const path of present) {
  if (!expected.has(path))
    throw new Error(`Embedded file is not recorded by the emitter: ${path}`)
}
for (const path of expected.keys()) {
  if (!present.includes(path))
    throw new Error(`Recorded embedded file is missing: ${path}`)
}

await rm(outputRoot, { recursive: true, force: true })
for (const [path, file] of expected) {
  const source = join(sourceRoot, path)
  const bytes = await readFile(source)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== file.bytes || sha256 !== file.outputSha256)
    throw new Error(`Embedded file differs from the emitter record: ${path}`)
  const target = join(outputRoot, path)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}
for (const extra of [recordName, 'NOTICE.txt']) {
  const source = join(sourceRoot, extra)
  const exists = await readFile(source).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  if (exists) await copyFile(source, join(outputRoot, extra))
}
console.log(`Copied ${expected.size} embedded common-auth files`)
