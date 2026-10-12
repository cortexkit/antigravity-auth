import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./acquisition/', import.meta.url))
await mkdir(root, { recursive: true })
const metadataUrl = 'https://registry.npmjs.org/@cortexkit%2fantigravity-auth-core/2.2.1'
const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(30000) })
if (!metadataResponse.ok) throw new Error(`metadata HTTP ${metadataResponse.status}`)
const metadataBytes = Buffer.from(await metadataResponse.arrayBuffer())
await writeFile(`${root}/metadata.json`, metadataBytes)
const metadata = JSON.parse(metadataBytes.toString('utf8'))
if (metadata.name !== '@cortexkit/antigravity-auth-core' || metadata.version !== '2.2.1') {
  throw new Error('Unexpected released package identity')
}
const archiveUrl = new URL(metadata.dist.tarball)
if (archiveUrl.protocol !== 'https:' || archiveUrl.hostname !== 'registry.npmjs.org') {
  throw new Error('Unexpected released archive origin')
}
const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(30000) })
if (!response.ok) throw new Error(`archive HTTP ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
await writeFile(`${root}/antigravity-auth-core-2.2.1.tgz`, archive)
const sha1 = createHash('sha1').update(archive).digest('hex')
const sri = `sha512-${createHash('sha512').update(archive).digest('base64')}`
if (sha1 !== metadata.dist.shasum || sri !== metadata.dist.integrity) {
  throw new Error('Released archive SHA1/SHA512 SRI mismatch')
}
const receipt = {
  metadataUrl,
  metadataSha256: createHash('sha256').update(metadataBytes).digest('hex'),
  archiveUrl: archiveUrl.href,
  name: metadata.name,
  version: metadata.version,
  gitHead: metadata.gitHead,
  bytes: archive.length,
  sha1,
  integrity: sri,
  sha256: createHash('sha256').update(archive).digest('hex'),
}
await writeFile(`${root}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
