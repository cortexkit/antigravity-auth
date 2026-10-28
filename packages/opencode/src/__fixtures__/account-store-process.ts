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
//   the account-store move, so two processes that both ran it are visible;
// - ACCOUNT_STORE_TEST_JOURNAL: a path; when set, the account store's journal
//   beside the state-home anchor is hashed right after the decision, and the
//   digest is written to this path. A later process overwrites it, so a test
//   reads it after each process exits;
// - ACCOUNT_STORE_TEST_REAL_MOVE=1: run the genuine offline relocation
//   instead of the stand-in below (slower, and it publishes a real store).
//
// By default the account-store move is replaced by a seam that records the
// run and reports success: most tests here are about which process decides
// to move. `ACCOUNT_STORE_TEST_REAL_MOVE` switches to the genuine move.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
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
  runStoreMove,
  type StoreMoveInput,
  type StoreMoveResult,
  writeStateHomeStoreForward,
} from '../runtime-layout'
import {
  accountStorePointerPath,
  getVaultDir,
  runtimeLayoutLocation,
  stateHomeAccountFile,
} from '../runtime-paths'

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

/**
 * The SHA-256 of the journal bytes at the store the state-home anchor
 * publishes, or `missing` when nothing is published there.
 */
function journalDigest(): string {
  const location = runtimeLayoutLocation()
  const stateHome = stateHomeAccountFile(location)
  let id: string | undefined
  try {
    const pointer = JSON.parse(
      readFileSync(accountStorePointerPath(stateHome), 'utf8'),
    ) as { id?: unknown }
    if (typeof pointer.id === 'string') id = pointer.id
  } catch {
    return 'missing'
  }
  if (id === undefined) return 'missing'
  // The journal's digest and both files' digests: a finished move is not
  // rewritten, so a later process must leave every one of them unchanged.
  const dir = `${stateHome}.store.${id}.generation`
  const parts: string[] = []
  for (const name of ['migration.json', 'config.json', 'state.json']) {
    try {
      parts.push(
        createHash('sha256')
          .update(readFileSync(`${dir}/${name}`))
          .digest('hex'),
      )
    } catch {
      parts.push('missing')
    }
  }
  return parts.join(':')
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
  const realMove = process.env.ACCOUNT_STORE_TEST_REAL_MOVE === '1'
  // One line per process that started a move, for the tests that count them;
  // the real move runs when ACCOUNT_STORE_TEST_REAL_MOVE asks for it, and
  // otherwise a stand-in writes only the forward at the config anchor.
  const move: (input: StoreMoveInput) => Promise<StoreMoveResult> = async (
    input,
  ) => {
    if (trace) appendFileSync(trace, `relocate ${process.pid}\n`)
    if (realMove) return runStoreMove(input)
    if (!isFile(input.source)) return { status: 'cancelled' }
    await writeStateHomeStoreForward(
      'synthetic-generation',
      input.target,
      input.source,
    )
    return { status: 'completed', id: 'synthetic-generation' }
  }
  try {
    const layout = await prepareRuntimeLayout({
      version: process.env.ACCOUNT_STORE_TEST_VERSION ?? '3.0.16',
      log: quiet,
      relocate: move,
    })
    // The store's journal as this process left it: the digest a test compares
    // across processes to tell a finished move from one that rewrote it.
    const journal = process.env.ACCOUNT_STORE_TEST_JOURNAL
    if (journal) writeFileSync(journal, journalDigest())
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
