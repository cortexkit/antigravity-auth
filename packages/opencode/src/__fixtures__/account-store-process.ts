// One plugin process settling its vault layout and its account store's
// anchor, for the store-relocation tests.
//
// Modes (first argument):
// - `once`: run `prepareRuntimeLayout` with the inherited environment, print
//   one JSON line with the layout, the vault folder, the account file it
//   resolved and the store move the process ran (if any), and exit;
// - `hold`: the same, then stay alive until killed (a live process on that
//   anchor);
// - `heartbeat`: never decide; write a heartbeat that names the given
//   version and `stores` map, the way a live process of that version
//   leaves it, print one JSON line and stay alive until killed.
//
// Environment:
// - ACCOUNT_STORE_TEST_VERSION: the version deciding (default 3.0.16);
// - ACCOUNT_STORE_TEST_CONFIG_KEY: the config folder key `heartbeat` records
//   its layouts and stores under;
// - ACCOUNT_STORE_TEST_HEARTBEAT_STORES: for `heartbeat`, the JSON `stores`
//   map to write; absent writes no `stores` at all, as an older version does;
// - ACCOUNT_STORE_TEST_BARRIER: a path; the process writes
//   `<path>.<pid>.ready` and waits for `<path>` to exist before it decides;
// - ACCOUNT_STORE_TEST_TRACE: a path; one line is appended for every run of
//   the account-store move, so two processes that both ran it are visible.
//
// The account-store move itself is replaced by a seam that records the run
// and reports success: these tests are about which process decides to move,
// and the genuine move has its own suites (`store-relocation.test.ts` runs
// the real one through `runStoreMove`).
import {
  appendFileSync,
  existsSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { getStoragePath } from '../plugin/storage'
import {
  processConfigFolderKey,
  removeProcessHeartbeat,
  startProcessHeartbeat,
} from '../process-heartbeat'
import {
  prepareRuntimeLayout,
  writeStateHomeStoreForward,
} from '../runtime-layout'
import { getVaultDir } from '../runtime-paths'

const mode = process.argv[2] ?? 'once'
const barrier = process.env.ACCOUNT_STORE_TEST_BARRIER
const trace = process.env.ACCOUNT_STORE_TEST_TRACE
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const quiet = {
  info(message: string) {
    writeSync(2, `ACCOUNT_STORE_LOG=${message}\n`)
  },
  warn(message: string) {
    writeSync(2, `ACCOUNT_STORE_WARN=${message}\n`)
  },
}

let line: Record<string, unknown>
if (mode === 'heartbeat') {
  const stores = process.env.ACCOUNT_STORE_TEST_HEARTBEAT_STORES
  const handle = await startProcessHeartbeat({
    version: process.env.ACCOUNT_STORE_TEST_VERSION ?? '3.0.15',
    logger: quiet,
    layouts: {
      [process.env.ACCOUNT_STORE_TEST_CONFIG_KEY ?? processConfigFolderKey()]:
        'legacy',
    },
    ...(stores === undefined
      ? {}
      : { stores: JSON.parse(stores) as Record<string, 'config'> }),
  })
  line = { pid: process.pid, heartbeat: handle.path ?? null }
  // A process killed outright leaves its file; one asked to stop removes it.
  process.once('SIGTERM', () => {
    void removeProcessHeartbeat(quiet).finally(() => process.exit(0))
  })
} else {
  if (barrier) {
    writeFileSync(`${barrier}.${process.pid}.ready`, '')
    while (!existsSync(barrier)) await Bun.sleep(5)
  }
  try {
    const layout = await prepareRuntimeLayout({
      version: process.env.ACCOUNT_STORE_TEST_VERSION ?? '3.0.16',
      log: quiet,
      relocate: async (input) => {
        // Stands in for the genuine move: it writes the forward at the config
        // anchor the way a finished move does, so a process deciding after it
        // sees the store at the new anchor and runs no move of its own. The
        // trace records every process that reached a move.
        if (trace) appendFileSync(trace, `relocate ${process.pid}\n`)
        if (!isFile(input.source)) return { status: 'cancelled' }
        await writeStateHomeStoreForward(
          'synthetic-generation',
          input.target,
          input.source,
        )
        return { status: 'completed', id: 'synthetic-generation' }
      },
    })
    line = {
      layout,
      pid: process.pid,
      vaultDir: getVaultDir(),
      accountFile: getStoragePath(),
    }
  } catch (error) {
    line = { error: error instanceof Error ? error.message : String(error) }
  }
}
process.stdout.write(`${JSON.stringify(line)}\n`)
if (mode === 'hold' || mode === 'heartbeat') setInterval(() => {}, 60_000)
