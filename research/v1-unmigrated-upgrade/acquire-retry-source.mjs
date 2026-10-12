import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./official-retry-source/', import.meta.url))
await mkdir(root, { recursive: true })
const inventory = []
for (const [source, filename] of [
  ['packages/opencode/src/session/retry.ts', 'retry.ts.txt'],
  ['packages/opencode/src/provider/error.ts', 'error.ts.txt'],
  ['packages/opencode/package.json', 'package.json.txt'],
]) {
  const url = `https://raw.githubusercontent.com/anomalyco/opencode/v1.17.13/${source}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!response.ok || bytes.length > 128 * 1024) throw new Error(`Release source GET failed: ${url} ${response.status}`)
  await writeFile(`${root}/${filename}`, bytes)
  inventory.push({ url, filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await writeFile(`${root}/inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`)
console.log(JSON.stringify(inventory))
