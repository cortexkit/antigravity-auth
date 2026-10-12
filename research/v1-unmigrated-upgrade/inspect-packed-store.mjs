import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [directory, poolPath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
if (manifest.version !== '3.0.0') throw new Error('Store inspection requires packed 3.0.0 core')
const core = await import(pathToFileURL(resolve(directory, manifest.exports['.'].import)).href)
const modules = await core.loadCommonAuthStoreModules()
const binding = await core.readAccountStoreBinding(poolPath, modules)
if (binding.status !== 'bound') throw new Error(`Store inspection: ${binding.status}`)
const repository = core.createAccountRepositoryFactory(modules)({
  paths: binding.paths,
  now: () => Date.now(),
  exchange: async () => { throw new Error('Read-only inspection must never refresh') },
})
try {
  console.log(JSON.stringify(await repository.read()))
} finally {
  await repository.dispose()
}
