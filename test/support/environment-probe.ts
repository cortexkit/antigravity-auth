import { mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { dirname, join } from 'node:path'

if (process.argv[2] === 'cache') {
  // The updater uses the OS home rather than XDG_CACHE_HOME. Supply an owned
  // OS-home dependency before importing its module-level path constants.
  const home = process.env.HOME as string
  mock.module('node:os', () => ({ ...os, homedir: () => home }))
  const constants = await import(
    '../../packages/opencode/src/hooks/auto-update-checker/constants.ts'
  )
  const { CACHE_DIR, USER_OPENCODE_CONFIG, INSTALLED_PACKAGE_JSON } = constants
  if (
    !CACHE_DIR.startsWith(`${home}/`) ||
    !USER_OPENCODE_CONFIG.startsWith(`${dirname(home)}/`)
  )
    throw new Error('refusing updater probe outside owned filesystem')
  const packageName = '@cortexkit/opencode-antigravity-auth'
  for (const path of [
    USER_OPENCODE_CONFIG,
    INSTALLED_PACKAGE_JSON,
    join(CACHE_DIR, 'package.json'),
  ])
    mkdirSync(dirname(path), { recursive: true })
  const config = JSON.stringify({ plugin: [packageName] })
  writeFileSync(USER_OPENCODE_CONFIG, config)
  writeFileSync(INSTALLED_PACKAGE_JSON, JSON.stringify({ version: '1.2.5' }))
  writeFileSync(
    join(CACHE_DIR, 'package.json'),
    JSON.stringify({
      dependencies: { [packageName]: '1.2.5', unrelated: '9.9.9' },
    }),
  )
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return Response.json({ latest: '1.2.6' })
  }) as typeof fetch
  let notified!: (value: unknown) => void
  const notification = new Promise((resolve) => {
    notified = resolve
  })
  const { createAutoUpdateCheckerHook } = await import(
    '../../packages/opencode/src/hooks/auto-update-checker/index.ts'
  )
  const client = {
    tui: {
      showToast: async (value: unknown) => {
        notified(value)
      },
    },
  }
  const hook = createAutoUpdateCheckerHook(
    client as Parameters<typeof createAutoUpdateCheckerHook>[0],
    process.cwd(),
    { autoUpdate: true, showStartupToast: false },
  )
  await hook.event({
    event: { type: 'session.created', properties: { info: {} } },
  } as Parameters<typeof hook.event>[0])
  const toast = await notification
  console.log(
    JSON.stringify({
      requests,
      toast,
      installed: existsSync(INSTALLED_PACKAGE_JSON),
      dependencies: JSON.parse(
        readFileSync(join(CACHE_DIR, 'package.json'), 'utf8'),
      ).dependencies,
      config: readFileSync(USER_OPENCODE_CONFIG, 'utf8'),
    }),
  )
} else {
  const { getSidebarStateFile } = await import(
    '../../packages/opencode/src/sidebar-state.ts'
  )
  const { getRpcDir } = await import(
    '../../packages/opencode/src/rpc/rpc-dir.ts'
  )
  const { defaultFilesystemRoots } = await import(
    '../../packages/opencode/src/plugin/dependencies.ts'
  )
  const { resolveTuiLogPath } = await import(
    '../../packages/opencode/src/tui/file-logger.ts'
  )
  const { getUserConfigPath } = await import(
    '../../packages/opencode/src/plugin/config/loader.ts'
  )
  const { getOpencodeConfigDir } = await import(
    '../../packages/opencode/src/plugin/config/updater.ts'
  )
  const { getConfigDir } = await import(
    '../../packages/opencode/src/plugin/storage.ts'
  )
  const { USER_OPENCODE_CONFIG } = await import(
    '../../packages/opencode/src/hooks/auto-update-checker/constants.ts'
  )
  console.log(
    JSON.stringify({
      sidebar: getSidebarStateFile(),
      rpc: getRpcDir(process.cwd()),
      roots: defaultFilesystemRoots(),
      log: resolveTuiLogPath(),
      config: getUserConfigPath(),
      updater: getOpencodeConfigDir(),
      storage: getConfigDir(),
      userConfig: USER_OPENCODE_CONFIG,
    }),
  )
}
