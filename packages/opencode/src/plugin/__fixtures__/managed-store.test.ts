import type { CommonAuthStoreModules } from '@cortexkit/antigravity-auth-core'
import type { TestLifetime } from '../../../../../test/fixtures/test-lifetime.ts'

// Own actual store instances, not module namespaces: constructors must retain
// their prototypes so callers can classify genuine store errors with instanceof.
export function managedStoreModules(
  owner: TestLifetime,
  modules: CommonAuthStoreModules,
): CommonAuthStoreModules {
  return {
    store: {
      ...modules.store,
      openPoolStore(options) {
        const observe = options.onStep
        return owner.manage(
          modules.store.openPoolStore({
            ...options,
            async onStep(step, info) {
              await owner.phase(`${info.operation}:${step}`, () =>
                observe?.(step, info),
              )
            },
          }),
        )
      },
    },
    fs: {
      ...modules.fs,
      withLock: (path, options, body) =>
        owner.operation(
          modules.fs.withLock(path, options, body),
          'fs:withLock',
        ),
      writeJsonAtomic: (path, value, options) =>
        owner.operation(
          modules.fs.writeJsonAtomic(path, value, {
            ...options,
            async beforeRename() {
              await owner.phase('atomic:beforeRename', () =>
                options?.beforeRename?.(),
              )
            },
          }),
          'fs:writeJsonAtomic',
        ),
    },
  }
}
