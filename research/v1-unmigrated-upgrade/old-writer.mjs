import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageDirectory, poolPath, ackPath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
if (manifest.name !== '@cortexkit/antigravity-auth-core' || manifest.version !== '2.2.1') {
  throw new Error('Writer must be the verified published 2.2.1 core')
}
const entry = resolve(packageDirectory, manifest.exports['.'].import)
const core = await import(pathToFileURL(entry).href)
const now = Date.now()
await core.saveAccountStorage(poolPath, {
  version: 4,
  accounts: [{
    email: 'synthetic-upgrade@example.invalid',
    refreshToken: 'synthetic-upgrade-refresh',
    projectId: 'synthetic-upgrade-project',
    managedProjectId: 'synthetic-upgrade-project',
    addedAt: now,
    lastUsed: now,
    enabled: true,
    fingerprint: core.generateFingerprint(),
  }],
  activeIndex: 0,
  activeIndexByFamily: { claude: 0, gemini: 0 },
})
writeFileSync(ackPath, JSON.stringify({ version: manifest.version, entry, poolPath }))
console.log(`Published ${manifest.version} saveAccountStorage wrote ${poolPath}`)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
