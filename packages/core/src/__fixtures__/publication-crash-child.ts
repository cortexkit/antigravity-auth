import { publicationPublicModules } from './publication-public-modules.ts'

const { store, fs } = await publicationPublicModules(process.argv[4])

import { readAccountStoreBinding } from '../account-migration.ts'
import {
  type AccountStoreModules,
  createAccountRepositoryFactory,
} from '../account-repository.ts'

const [legacyPath, step] = process.argv.slice(2)
if (
  !legacyPath ||
  !['before-config-write', 'after-config-write', 'after-state-write'].includes(
    step ?? '',
  )
)
  throw new Error('invalid crash fixture inputs')
const binding = await readAccountStoreBinding(legacyPath, { store }, Date.now)
if (binding.status !== 'bound')
  throw new Error('fixture generation is not bound')
const modules: AccountStoreModules = {
  store: {
    ...store,
    openPoolStore(options) {
      return store.openPoolStore({
        ...options,
        lockOptions: { ttlMs: 1000 },
        rowLockOptions: { ttlMs: 1000 },
        onStep(point, info) {
          if (
            info.operation ===
              (step === 'after-state-write' ? 'add' : 'publishRoster') &&
            point === step
          )
            process.exit(91)
        },
      })
    },
  },
  fs: {
    ...fs,
    withLock(path, options, body) {
      return fs.withLock(path, { ...options, ttlMs: 1000 }, body)
    },
  },
}
const repo = createAccountRepositoryFactory(modules)({
  paths: binding.paths,
  now: Date.now,
  exchange: async () => {
    throw new Error('no token exchange')
  },
})
await repo.replacePool([
  {
    id: 'new',
    refreshToken: 'synthetic-new-refresh',
    identity: 'new@example.invalid',
    metadata: {
      addedAt: 1,
      lastUsed: 0,
      email: 'new@example.invalid',
      projectId: 'synthetic-new-project',
      enabled: true,
    },
  },
])
throw new Error('the intended native write point was not reached')
