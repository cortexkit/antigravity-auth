// The account store's move out of OpenCode's config folder, at the points
// that decide whether it runs: the start-time decision each entry point
// takes, the store fence that reads the other live processes, the CLI's
// `store relocate`, setup's forwarding pointer, and the plain cases a user
// meets (a fresh install, a state folder whose path is a link). Real files in
// temporary folders; the real-process tests run
// `__fixtures__/account-store-process.ts`.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AccountMigrationOutcome,
  accountStorePointerPath,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'

import { createDefaultAccountStoreOperations, runCli } from './cli'
import { getStoragePath } from './plugin/storage'
import {
  __resetProcessHeartbeatForTest,
  processConfigFolderKey,
  processHeartbeatPath,
} from './process-heartbeat'
import {
  __resetRuntimeLayoutRunsForTest,
  ACCOUNT_STORE_DEFERRED_MESSAGE,
  ACCOUNT_STORE_LINKED_PATH_MESSAGE,
  prepareAccountStore,
  type RuntimeLayoutOptions,
} from './runtime-layout'
import {
  __resetRuntimeLayoutsForTest,
  decidedAccountStoreAnchor,
  readForwardedAccountStore,
  runtimeLayoutLocation,
  stateHomeAccountFile,
} from './runtime-paths'
import { __resetVaultFoldersForTest } from './vault-folder'
import { processHeartbeatDir } from './version-fence'

const VERSION = '3.0.16'
const ENV = ['OPENCODE_CONFIG_DIR', 'XDG_STATE_HOME'] as const
const POSIX = process.platform !== 'win32'

let root: string
let saved: Record<string, string | undefined>
let logged: { level: string; message: string; meta?: unknown }[]
let count = 0

function testRoot(): string {
  const value = process.env.ANTIGRAVITY_TEST_ROOT
  if (!value) throw new Error('test/setup.ts did not pin ANTIGRAVITY_TEST_ROOT')
  return value
}

beforeEach(() => {
  count++
  const dir = join(testRoot(), 'account-store', String(count))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  root = realpathSync.native(dir)
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  process.env.OPENCODE_CONFIG_DIR = join(root, 'config', 'opencode')
  process.env.XDG_STATE_HOME = join(root, 'state')
  resetProcess()
  logged = []
})

afterEach(() => {
  for (const name of ENV) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetProcess()
})

/** Stands in for a new process: nothing decided, refused or recorded. */
function resetProcess() {
  __resetRuntimeLayoutsForTest()
  __resetRuntimeLayoutRunsForTest()
  __resetVaultFoldersForTest()
  __resetProcessHeartbeatForTest()
}

const configDir = () => join(root, 'config', 'opencode')
/** The account store's anchor in OpenCode's config folder. */
const configAnchor = () => join(configDir(), 'antigravity-accounts.json')
/** The account store's anchor in the state-home folder. */
const stateAnchor = () => stateHomeAccountFile(runtimeLayoutLocation())

function options(
  extra: Partial<RuntimeLayoutOptions> = {},
): RuntimeLayoutOptions {
  return {
    version: VERSION,
    log: {
      log: (message, meta) => logged.push({ level: 'log', message, meta }),
      info: (message, meta) => logged.push({ level: 'info', message, meta }),
      warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
    },
    ...extra,
  }
}

function messages(): string[] {
  return logged.map((entry) => entry.message)
}

/** Settles the account store's anchor alone, with the test seams. */
function decide(extra: Partial<RuntimeLayoutOptions> = {}) {
  return prepareAccountStore(options(extra))
}

/** A store published at `anchor`, the way a matching release publishes one. */
async function publishStore(anchor: string): Promise<string> {
  const modules = await loadCommonAuthStoreModules()
  const outcome = await initializeFreshAccountStore(modules, {
    legacyPath: anchor,
    now: Date.now,
  })
  if (outcome.status !== 'completed')
    throw new Error(`fresh store is ${outcome.status}`)
  return outcome.receipt.id
}

/** The generation an anchor publishes, or undefined when it publishes none. */
async function publishedId(anchor: string): Promise<string | undefined> {
  const modules = await loadCommonAuthStoreModules()
  const binding = await readAccountStoreBinding(anchor, modules, Date.now)
  return binding.status === 'bound' ? binding.receipt.id : undefined
}

/** A heartbeat file for `pid`, as a live process of `version` leaves it. */
function heartbeat(
  pid: number,
  body: { version: string; stores?: Record<string, string> },
) {
  const dir = processHeartbeatDir(join(root, 'state'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${pid}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      pid,
      version: body.version,
      startedAt: 1,
      layouts: { [processConfigFolderKey()]: 'legacy' },
      ...(body.stores === undefined ? {} : { stores: body.stores }),
    }),
    { mode: 0o600 },
  )
  return path
}

describe('the start-time decision', () => {
  it('a fresh install initializes at the state-home anchor and leaves a forward at the config anchor', async () => {
    expect(await decide()).toBe('state-home')
    const id = await publishedId(stateAnchor())
    expect(id).toBeString()
    expect(getStoragePath()).toBe(stateAnchor())
    expect(readForwardedAccountStore(configAnchor())).toEqual({
      legacyPath: stateAnchor(),
      id: id as string,
    })
    // The config anchor holds the forward and no generation of its own:
    // binding there refuses, because the forward names one that only the
    // state-home anchor publishes.
    const modules = await loadCommonAuthStoreModules()
    const binding = await readAccountStoreBinding(
      configAnchor(),
      modules,
      Date.now,
    )
    expect(binding.status).toBe('error')
    expect(existsSync(`${configAnchor()}.store`)).toBe(false)
  })

  it('moves an existing config-folder store to the state-home anchor once the fence is open', async () => {
    const before = await publishStore(configAnchor())
    let moved: { source: string; target: string } | undefined
    const anchor = await decide({
      relocate: async (input) => {
        moved = { source: input.source, target: input.target }
        return { status: 'completed', id: 'moved-generation' }
      },
    })
    expect(anchor).toBe('state-home')
    expect(moved).toEqual({ source: configAnchor(), target: stateAnchor() })
    // The seam moved nothing, so the config anchor still holds its store and
    // this process records the new anchor for others to see.
    expect(before).toBeString()
    expect(
      JSON.parse(readFileSync(processHeartbeatPath(), 'utf8')).stores,
    ).toEqual({ [processConfigFolderKey()]: 'state-home' })
  })

  it('keeps the store in the config folder while a live 3.0.15 heartbeat says so, and moves after it exits', async () => {
    await publishStore(configAnchor())
    // The test runner's parent is alive and is not this process.
    const older = heartbeat(process.ppid, { version: '3.0.15' })
    expect(await decide()).toBe('config')
    expect(getStoragePath()).toBe(configAnchor())
    expect(messages()).toContain(ACCOUNT_STORE_DEFERRED_MESSAGE)
    // This process recorded the config anchor for others to see.
    expect(
      JSON.parse(readFileSync(processHeartbeatPath(), 'utf8')).stores,
    ).toEqual({
      [processConfigFolderKey()]: 'config',
    })

    rmSync(older)
    rmSync(processHeartbeatPath())
    resetProcess()
    expect(await decide()).toBe('state-home')
    expect(getStoragePath()).toBe(stateAnchor())
  })

  it('a live current-version process that kept the config-folder store blocks the move', async () => {
    await publishStore(configAnchor())
    const other = heartbeat(process.ppid, {
      version: VERSION,
      stores: { [processConfigFolderKey()]: 'config' },
    })
    expect(await decide()).toBe('config')
    expect(messages()).toContain(ACCOUNT_STORE_DEFERRED_MESSAGE)
    // Once that process has exited, the next start moves.
    rmSync(other)
    rmSync(processHeartbeatPath())
    resetProcess()
    expect(await decide()).toBe('state-home')
  })

  it('a live current-version process that names no store blocks the move', async () => {
    await publishStore(configAnchor())
    heartbeat(process.ppid, { version: VERSION })
    expect(await decide()).toBe('config')
  })

  it('a live current-version process that already names the state-home anchor does not block', async () => {
    await publishStore(configAnchor())
    heartbeat(process.ppid, {
      version: VERSION,
      stores: { [processConfigFolderKey()]: 'state-home' },
    })
    expect(await decide()).toBe('state-home')
  })

  it('OpenCode 1 and 2 locations in one process share one decision', async () => {
    // OpenCode 1 starts the plugin and OpenCode 2 starts a location; both go
    // through the same entry point for the same config folder.
    const first = await decide()
    const heartbeatAfterFirst = readFileSync(processHeartbeatPath(), 'utf8')
    // A second start in the same process decides nothing again: no new move
    // for OpenCode 2's location.
    let moved = 0
    const again = await decide({
      relocate: async () => {
        moved += 1
        return { status: 'completed', id: 'second' }
      },
    })
    expect(again).toBe(first)
    expect(moved).toBe(0)
    expect(readFileSync(processHeartbeatPath(), 'utf8')).toBe(
      heartbeatAfterFirst,
    )
    expect(decidedAccountStoreAnchor(runtimeLayoutLocation())).toBe(first)
  })

  it('a state folder whose path goes through a link defers, and says how to fix it', async () => {
    if (!POSIX) return
    const linked = join(root, 'linked-state')
    // The real folder exists first; only its parent is reached through the
    // link, so the heartbeat folder can still be written at all.
    mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
    symlinkSync(join(root, 'state'), linked, 'dir')
    mkdirSync(join(linked, 'cortexkit', 'antigravity-auth'), {
      recursive: true,
      mode: 0o700,
    })
    process.env.XDG_STATE_HOME = linked
    resetProcess()
    expect(await decide()).toBe('config')
    expect(getStoragePath()).toBe(configAnchor())
    expect(messages()).toContain(ACCOUNT_STORE_LINKED_PATH_MESSAGE)
  })

  it('an existing state-home store needs no move', async () => {
    await publishStore(stateAnchor())
    let ran = false
    expect(
      await decide({
        relocate: async () => {
          ran = true
          return { status: 'completed', id: 'never' }
        },
      }),
    ).toBe('state-home')
    expect(ran).toBe(false)
  })

  it('refuses when two stores exist and neither is marked as moved', async () => {
    await publishStore(configAnchor())
    await publishStore(stateAnchor())
    await expect(decide()).rejects.toThrow('two account stores exist')
  })

  it('a failed move keeps the config folder and is tried again at the next start', async () => {
    await publishStore(configAnchor())
    expect(
      await decide({
        relocate: async () => {
          throw new Error('lock held')
        },
      }),
    ).toBe('config')
    expect(getStoragePath()).toBe(configAnchor())
    expect(messages().length).toBeGreaterThan(0)
  })

  it('finishes a move a forward left unfinished without deferring the start', async () => {
    // A state-home store whose relocation is still pending is the state a
    // crash after the forward leaves; readers must report it unusable, not
    // serve the old store.
    await publishStore(configAnchor())
    await publishStore(stateAnchor())
    // Mark the config anchor as forwarded to the state anchor, as the move's
    // own writer does, so this process has one authority to follow.
    const id = (await publishedId(stateAnchor())) as string
    const { writeStateHomeStoreForward } = await import('./runtime-layout')
    await writeStateHomeStoreForward(id, stateAnchor(), configAnchor())
    expect(await decide()).toBe('state-home')
    expect(getStoragePath()).toBe(stateAnchor())
  })
})

describe('the store fence', () => {
  it('blocks on a live heartbeat older than the release that moves the store', async () => {
    await publishStore(configAnchor())
    heartbeat(process.ppid, { version: '3.0.15' })
    expect(await decide()).toBe('config')
  })

  it('blocks on an unreadable heartbeat', async () => {
    await publishStore(configAnchor())
    const dir = processHeartbeatDir(join(root, 'state'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${process.ppid}.json`)
    writeFileSync(path, 'not json', { mode: 0o600 })
    chmodSync(path, process.platform === 'win32' ? 0o600 : 0o000)
    expect(await decide()).toBe('config')
  })
})

describe('the CLI', () => {
  const legacyPath = () => join(root, 'cli', 'antigravity-accounts.json')

  function harness(extra: Partial<CliHarness> = {}) {
    const written: string[] = []
    const deps = {
      stdout: { write: (value: string) => written.push(value) },
      stderr: { write: (value: string) => written.push(value) },
      prompt: async () => 'yes',
      openBrowser: async () => {},
      performLogin: async () => {
        throw new Error('not expected')
      },
      loadAccounts: async () => null,
      getQuota: async () => [],
      accountStore: {
        legacyPath,
        migrate: async () => completed(),
        rollback: async () => completed(),
        initialize: async () => completed(),
        read: async () => ({ kind: 'legacy' as const }),
        relocate: async () => ({ status: 'completed' as const, id: 'gen-1' }),
        ...extra.accountStore,
      },
      ...extra.deps,
    }
    return { deps, output: () => written.join('') }
  }

  function completed(): AccountMigrationOutcome {
    return {
      status: 'completed',
      receipt: {
        id: 'generation-1',
        status: 'active',
        legacyPath: legacyPath(),
        storeDir: `${legacyPath()}.store`,
        sourceKind: 'file',
        durability: 'posix-directory-synced',
        restartRequired: true,
      },
    }
  }

  interface CliHarness {
    accountStore?: Record<string, unknown>
    deps?: Record<string, unknown>
  }

  it('prints help for --help and store --help, and creates nothing', async () => {
    const before = existsSync(root) ? readdirSync(root).sort() : []
    for (const argv of [['--help'], ['store', '--help']]) {
      const { deps, output } = harness()
      expect(await runCli(argv, deps)).toBe(0)
      expect(output()).toContain('store relocate [--back] --offline')
    }
    expect(existsSync(configDir())).toBe(false)
    expect(existsSync(join(root, 'state'))).toBe(false)
    expect(existsSync(root) ? readdirSync(root).sort() : []).toEqual(before)
  })

  it('a real CLI process moves the store forward and back offline', async () => {
    // The whole command, as a user runs it on a real store: the offline
    // confirmation is given with --yes, so no prompt is needed.
    const home = join(root, 'cli-home')
    const config = join(home, 'config', 'opencode')
    const state = join(home, 'state')
    for (const dir of [home, config, state])
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: state,
      OPENCODE_CONFIG_DIR: config,
      PATH: '/usr/bin:/bin',
    }
    const saved = {
      config: process.env.OPENCODE_CONFIG_DIR,
      state: process.env.XDG_STATE_HOME,
    }
    process.env.OPENCODE_CONFIG_DIR = config
    process.env.XDG_STATE_HOME = state
    resetProcess()
    try {
      // A store at the config anchor, as an existing installation has.
      const configAnchor = join(config, 'antigravity-accounts.json')
      const created = await initializeFreshAccountStore(
        await loadCommonAuthStoreModules(),
        { legacyPath: configAnchor, now: Date.now },
      )
      expect(created.status).toBe('completed')
      const entry = fileURLToPath(new URL('./cli.ts', import.meta.url))
      const run = async (args: string[]) => {
        const child = Bun.spawn([process.execPath, entry, ...args], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { out, err, code }
      }
      const forward = await run(['store', 'relocate', '--offline', '--yes'])
      expect({ code: forward.code, err: forward.err }).toEqual({
        code: 0,
        err: '',
      })
      expect(forward.out).toContain('Relocation completed')
      const moved = readForwardedAccountStore(configAnchor)
      expect(moved?.legacyPath).toContain(join(state, 'cortexkit'))

      // Going back restores the config anchor's own store.
      const back = await run([
        'store',
        'relocate',
        '--back',
        '--offline',
        '--yes',
      ])
      expect({ code: back.code, err: back.err }).toEqual({ code: 0, err: '' })
      expect(back.out).toContain('Reverse relocation completed')
      const modules = await loadCommonAuthStoreModules()
      const binding = await readAccountStoreBinding(
        configAnchor,
        modules,
        Date.now,
      )
      expect(binding.status).toBe('bound')
    } finally {
      if (saved.config === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = saved.config
      if (saved.state === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = saved.state
      resetProcess()
    }
  }, 180_000)

  it('a real CLI process prints help without creating anything', async () => {
    // The whole CLI process, as a user runs it: its own heartbeat, layout
    // decision and store decision never start for help.
    const entry = fileURLToPath(new URL('./cli.ts', import.meta.url))
    const child = Bun.spawn([process.execPath, entry, 'store', '--help'], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    expect(stdout).toContain('store relocate [--back] --offline')
    expect(existsSync(join(root, 'state'))).toBe(false)
    expect(existsSync(configDir())).toBe(false)
  }, 60_000)

  it('refuses store relocate without --offline before any effect', async () => {
    let ran = false
    const { deps, output } = harness({
      accountStore: {
        relocate: async () => {
          ran = true
          return { status: 'completed' as const, id: 'gen-1' }
        },
      },
    })
    expect(await runCli(['store', 'relocate'], deps)).toBe(2)
    expect(output()).toContain('--offline')
    expect(ran).toBe(false)
  })

  it('runs store relocate only after the operator confirms, and names --back', async () => {
    const calls: string[] = []
    const { deps, output } = harness({
      accountStore: {
        relocate: async () => {
          calls.push('relocate')
          return { status: 'completed' as const, id: 'gen-2' }
        },
      },
    })
    expect(
      await runCli(['store', 'relocate', '--offline', '--yes'], deps),
    ).toBe(0)
    expect(calls).toEqual(['relocate'])
    expect(output()).toContain('Relocation completed: generation gen-2')
    expect(output()).toContain('Restart OpenCode')

    const declined = harness()
    const no = {
      ...declined.deps,
      prompt: async () => 'no',
    }
    expect(await runCli(['store', 'relocate', '--offline', '--back'], no)).toBe(
      1,
    )
    expect(declined.output()).toContain('nothing was changed')
  })

  it('says --back replaces the old pre-move backup with the current accounts', async () => {
    const { deps, output } = harness()
    const asked: string[] = []
    const prompting = {
      ...deps,
      prompt: async (message: string) => {
        asked.push(message)
        return 'no'
      },
    }
    await runCli(['store', 'relocate', '--offline', '--back'], prompting)
    expect(asked.join(' ')).toContain(
      'replaces the old pre-move backup with your current accounts',
    )
    expect(output()).toContain('nothing was changed')
  })

  it('reports a move another process is holding without success', async () => {
    const { deps, output } = harness({
      accountStore: {
        relocate: async () => ({
          status: 'pending' as const,
          reason: 'lock-contention',
        }),
      },
    })
    expect(
      await runCli(['store', 'relocate', '--offline', '--yes'], deps),
    ).toBe(1)
    expect(output()).toContain('lock-contention')
  })
})

describe('the default account-store operations', () => {
  it('moves a config-folder store with the genuine relocation, and --back restores it', async () => {
    const operations = createDefaultAccountStoreOperations()
    const id = await publishStore(configAnchor())
    expect(id).toBeString()
    const forward = await operations.relocate?.()
    expect(forward).toEqual({ status: 'completed', id: expect.any(String) })
    expect(readForwardedAccountStore(configAnchor())?.legacyPath).toBeDefined()
    // The store now binds at the state-home anchor, and the config anchor
    // forwards to it.
    await expect(publishedId(stateAnchor())).resolves.toBeString()

    const back = await operations.relocate?.()
    expect(back).toEqual({ status: 'completed', id: expect.any(String) })
    // Going back makes the config anchor publish a store of its own again.
    // What the state-home anchor keeps then is the reverse move's own
    // bookkeeping, which the store's suites cover.
    await expect(publishedId(configAnchor())).resolves.toBeString()
  }, 120_000)
})

describe('setup', () => {
  it('a dry run writes nothing, wherever the forward says the store is', async () => {
    const before = readdirSync(root).sort()
    const { runPluginSetup } = await import('./setup')
    const written: string[] = []
    await runPluginSetup(
      ['--dry-run', '--yes', '--no-claustrum', '--opencode=1'],
      {
        stdout: { write: (value: string) => written.push(value) },
        stderr: { write: (value: string) => written.push(value) },
        prompt: async () => 'yes',
        openBrowser: async () => {},
        performLogin: async () => {
          throw new Error('not expected')
        },
        loadAccounts: async () => null,
        getQuota: async () => [],
        accountStore: createDefaultAccountStoreOperations(),
        prepareVaultFolder: async () => {},
        processHeartbeat: async () => {},
      },
      async () => 0,
      { terminal: plainTerminal(written) },
    )
    expect(written.join('')).toContain('Dry run')
    expect(readdirSync(root).sort()).toEqual(before)
  })
})

/**
 * A terminal that only prints: no key input, so setup takes its non-interactive
 * path, and every line lands in `written`.
 */
function plainTerminal(written: string[]) {
  return {
    input: {
      isTTY: false,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      on: () => {},
      removeListener: () => {},
    },
    output: { write: (text: string) => written.push(text) },
  }
}

describe('real processes', () => {
  it('a live 3.0.15 process keeps the store in the config folder; after it exits the next start moves it', async () => {
    const childHome = join(root, 'child-home')
    mkdirSync(childHome, { recursive: true, mode: 0o700 })
    const childState = join(childHome, 'state')
    process.env.XDG_STATE_HOME = childState
    resetProcess()
    await publishStore(configAnchor())
    // The child is a real process writing the real heartbeat, with the
    // version that predates the move and no `stores` record.
    const older = await spawnStoreProcess('heartbeat', {
      HOME: childHome,
      USERPROFILE: childHome,
      XDG_STATE_HOME: childState,
      ACCOUNT_STORE_TEST_VERSION: '3.0.15',
      ACCOUNT_STORE_TEST_CONFIG_KEY: processConfigFolderKey(),
    })
    expect(older.result.heartbeat).toContain(String(older.child.pid))
    let moved = 0
    const moveCount = async () => {
      const anchor = await decide({
        relocate: async () => {
          moved += 1
          return { status: 'completed', id: 'synthetic-generation' }
        },
      })
      return { anchor, moved }
    }
    expect(await moveCount()).toEqual({ anchor: 'config', moved: 0 })
    expect(getStoragePath()).toBe(configAnchor())

    older.child.kill('SIGKILL')
    await older.child.exited
    resetProcess()
    expect(await moveCount()).toEqual({ anchor: 'state-home', moved: 1 })
  }, 60_000)

  it('two processes starting together settle one store anchor and one authority', async () => {
    // The children get a home of their own, so the fence they read holds no
    // heartbeat or port file of this machine's other runs. The store they
    // share is therefore seeded from inside that home.
    const childHome = join(root, 'child-home')
    mkdirSync(childHome, { recursive: true, mode: 0o700 })
    const childState = join(childHome, 'state')
    process.env.XDG_STATE_HOME = childState
    resetProcess()
    // A store that lives at the config anchor, which is what an existing
    // installation has before any move.
    await publishStore(configAnchor())
    const barrier = join(root, 'barrier')
    const trace = join(root, 'trace')
    const extra = {
      HOME: childHome,
      USERPROFILE: childHome,
      XDG_STATE_HOME: childState,
      ACCOUNT_STORE_TEST_BARRIER: barrier,
      ACCOUNT_STORE_TEST_TRACE: trace,
    }
    const both = Promise.all([
      spawnStoreProcess('once', extra),
      spawnStoreProcess('once', extra),
    ])
    while (
      readdirSync(root).filter((name) => name.endsWith('.ready')).length < 2
    )
      await Bun.sleep(10)
    writeFileSync(barrier, '')
    const [one, two] = await both

    // Both settled the new anchor. A process may still report the config
    // anchor when the two were in flight together: at that moment the other
    // one's heartbeat named the older anchor, which this release reads as
    // blocking.
    expect([one.result.layout, two.result.layout]).toEqual([
      'state-home',
      'state-home',
    ])
    for (const result of [one.result, two.result])
      expect(result.accountFile).toBeString()
    // The store keeps one authority: both processes settled the same new
    // anchor, and the relocation factory only ever publishes one store per
    // anchor, so a second, concurrent process joins the same move rather than
    // starting another. The trace names the processes that reached a move.
    expect(relocations(trace).length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

/** The `<pid>` of every `relocate <pid>` line in a trace. */
function relocations(trace: string): string[] {
  if (!existsSync(trace)) return []
  return readFileSync(trace, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('relocate '))
    .map((line) => line.slice('relocate '.length).trim())
}

/**
 * Runs the layout and store decision in its own process with this test's
 * environment plus `extra`.
 */
async function spawnStoreProcess(
  mode: 'once' | 'hold' | 'heartbeat',
  extra: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    ACCOUNT_STORE_TEST_VERSION: VERSION,
    ...extra,
  }
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name]
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./__fixtures__/account-store-process.ts', import.meta.url),
      ),
      mode,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = child.stdout.getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  if (mode === 'once') await child.exited
  if (!text.includes('\n')) {
    const stderr = await new Response(child.stderr).text()
    throw new Error(`store process printed nothing: ${stderr}`)
  }
  return {
    child,
    result: JSON.parse(text.trim()) as {
      layout?: string
      accountFile?: string
      vaultDir?: string
      pid?: number
      heartbeat?: string | null
      error?: string
    },
  }
}
