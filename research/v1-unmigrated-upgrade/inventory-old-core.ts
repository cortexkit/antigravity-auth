import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256, verifiedArchiveFiles } from '../../packages/e2e-tests/src/opencode-ga-harness.ts'

const root = join(import.meta.dir, 'acquisition')
const metadata = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'))
const archive = readFileSync(join(root, 'antigravity-auth-core-2.2.1.tgz'))
const files = verifiedArchiveFiles(archive, metadata.dist.integrity)
const inventory: Record<string, { bytes: number; sha256: string }> = {}
for (const [name, bytes] of files) {
  inventory[name] = { bytes: bytes.length, sha256: sha256(bytes) }
  const target = join(root, 'unpacked', name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes, { flag: 'wx' })
}
writeFileSync(join(root, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`)
console.log(`Verified and inventoried ${files.size} released archive files; no writer executed`)
