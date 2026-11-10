import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { plugin } from 'bun'
import { loadSolidTransform } from '../../tools/common-auth-build/node_modules/@cortexkit/common-auth/dist/tui-build/index.js'

let transform: ReturnType<typeof loadSolidTransform> | undefined

// OpenTUI's normal test preload excludes node_modules. Source-render tests
// must compile the one authored frame with the same public compiler as the TUI.
plugin({
  name: 'sidebar-source-tests',
  setup(build) {
    build.onLoad(
      {
        filter:
          /[/\\]node_modules[/\\]@cortexkit[/\\]opencode-sidebar[/\\]src[/\\]index\.tsx$/,
      },
      async ({ path }) => {
        const entry = realpathSync(
          Bun.resolveSync(
            '@cortexkit/opencode-sidebar',
            resolve(import.meta.dir, '../../packages/opencode'),
          ),
        )
        if (realpathSync(path) !== entry)
          throw new Error('Unexpected sidebar test source')
        transform ??= loadSolidTransform()
        return {
          contents: await (await transform)(await Bun.file(path).text(), {
            filename: path,
            moduleName: '@opentui/solid',
            resolvePath: () => null,
          }),
          loader: 'js',
        }
      },
    )
  },
})
